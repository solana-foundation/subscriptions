import { createHash } from 'node:crypto';
import {
    AccountRole,
    type Address,
    address,
    appendTransactionMessageInstructions,
    compileTransactionMessage,
    createNoopSigner,
    createTransactionMessage,
    fetchEncodedAccount,
    generateKeyPairSigner,
    getAddressDecoder,
    getAddressEncoder,
    getProgramDerivedAddress,
    type Instruction,
    type KeyPairSigner,
    pipe,
    setTransactionMessageFeePayer,
    type TransactionSigner,
} from '@solana/kit';
import type { SmartWallet } from './SmartWallet.ts';
import { sendKitInstructions, type SmartWalletClient } from './utils.ts';

const SQUADS_PROGRAM_ADDRESS = address('SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf');
const SYSTEM_PROGRAM_ADDRESS = '11111111111111111111111111111111' as Address;
const ALL_PERMISSIONS = 0b111;
const PROGRAM_CONFIG_TREASURY_OFFSET = 48;

type SquadsWalletConfig = {
    client: SmartWalletClient;
    feePayer: KeyPairSigner;
    members: KeyPairSigner[];
    approvalsRequired: number;
};

function addressBytes(value: Address): Buffer {
    return Buffer.from(getAddressEncoder().encode(value));
}

async function findPda(seeds: (Buffer | string)[]): Promise<Address> {
    const [pda] = await getProgramDerivedAddress({
        programAddress: SQUADS_PROGRAM_ADDRESS,
        seeds: ['multisig', ...seeds],
    });
    return pda;
}

function u8(value: number): Buffer {
    return Buffer.from([value]);
}

function u16(value: number): Buffer {
    const buffer = Buffer.alloc(2);
    buffer.writeUInt16LE(value);
    return buffer;
}

function u32(value: number): Buffer {
    const buffer = Buffer.alloc(4);
    buffer.writeUInt32LE(value);
    return buffer;
}

function u64(value: bigint): Buffer {
    const buffer = Buffer.alloc(8);
    buffer.writeBigUInt64LE(value);
    return buffer;
}

function optionPubkey(value: Address | null): Buffer {
    return value ? Buffer.concat([u8(1), addressBytes(value)]) : u8(0);
}

const NONE = u8(0);

function squadsInstruction(name: string, accounts: [Address, AccountRole][], args: Buffer[] = []): Instruction {
    const discriminator = createHash('sha256').update(`global:${name}`).digest().subarray(0, 8);
    return {
        accounts: accounts.map(([accountAddress, role]) => ({ address: accountAddress, role })),
        data: Buffer.concat([discriminator, ...args]),
        programAddress: SQUADS_PROGRAM_ADDRESS,
    };
}

function serializeVaultMessage(
    vault: Address,
    instructions: Instruction[],
): {
    bytes: Buffer;
    remainingAccounts: [Address, AccountRole][];
} {
    const compiled = compileTransactionMessage(
        pipe(
            createTransactionMessage({ version: 0 }),
            tx => setTransactionMessageFeePayer(vault, tx),
            tx => appendTransactionMessageInstructions(instructions, tx),
        ),
    );
    const {
        numReadonlyNonSignerAccounts,
        numReadonlySignerAccounts,
        numSignerAccounts: numRequiredSignatures,
    } = compiled.header;
    const keys = compiled.staticAccounts;
    const numWritableSigners = numRequiredSignatures - numReadonlySignerAccounts;
    const numWritableNonSigners = keys.length - numRequiredSignatures - numReadonlyNonSignerAccounts;

    const bytes = Buffer.concat([
        u8(numRequiredSignatures),
        u8(numWritableSigners),
        u8(numWritableNonSigners),
        u8(keys.length),
        ...keys.map(addressBytes),
        u8(compiled.instructions.length),
        ...compiled.instructions.flatMap(({ accountIndices = [], data = new Uint8Array(), programAddressIndex }) => [
            u8(programAddressIndex),
            u8(accountIndices.length),
            Buffer.from(accountIndices),
            u16(data.length),
            Buffer.from(data),
        ]),
        u8(0),
    ]);

    const remainingAccounts = keys.map((key, index): [Address, AccountRole] => {
        const isWritable =
            index < numWritableSigners ||
            (index >= numRequiredSignatures && index - numRequiredSignatures < numWritableNonSigners);
        return [key, isWritable ? AccountRole.WRITABLE : AccountRole.READONLY];
    });

    return { bytes, remainingAccounts };
}

class SquadsSmartWallet implements SmartWallet {
    public readonly name = 'squads';
    public readonly address: Address;
    public readonly signer: TransactionSigner;
    private readonly client: SmartWalletClient;
    private readonly feePayer: KeyPairSigner;
    private readonly members: KeyPairSigner[];
    private readonly approvalsRequired: number;
    private readonly multisigPda: Address;
    private nextTransactionIndex = 1n;

    constructor(config: {
        client: SmartWalletClient;
        feePayer: KeyPairSigner;
        members: KeyPairSigner[];
        approvalsRequired: number;
        multisigPda: Address;
        vaultPda: Address;
    }) {
        this.client = config.client;
        this.feePayer = config.feePayer;
        this.members = config.members;
        this.approvalsRequired = config.approvalsRequired;
        this.multisigPda = config.multisigPda;
        this.address = config.vaultPda;
        this.signer = createNoopSigner(this.address);
    }

    async sendInstructions(instructions: Instruction[]): Promise<string> {
        const creator = this.members[0];
        const feePayer = this.feePayer.address;

        const transactionIndex = this.nextTransactionIndex;
        this.nextTransactionIndex += 1n;
        const multisigBytes = addressBytes(this.multisigPda);
        const transactionPda = await findPda([multisigBytes, 'transaction', u64(transactionIndex)]);
        const proposalPda = await findPda([multisigBytes, 'transaction', u64(transactionIndex), 'proposal']);

        const { bytes, remainingAccounts } = serializeVaultMessage(this.address, instructions);

        await sendKitInstructions(
            this.client,
            this.feePayer,
            [],
            [
                squadsInstruction(
                    'vault_transaction_create',
                    [
                        [this.multisigPda, AccountRole.WRITABLE],
                        [transactionPda, AccountRole.WRITABLE],
                        [feePayer, AccountRole.READONLY_SIGNER],
                        [feePayer, AccountRole.WRITABLE_SIGNER],
                        [SYSTEM_PROGRAM_ADDRESS, AccountRole.READONLY],
                    ],
                    [u8(0), u8(0), u32(bytes.length), bytes, NONE],
                ),
            ],
        );

        await sendKitInstructions(
            this.client,
            this.feePayer,
            [creator],
            [
                squadsInstruction(
                    'proposal_create',
                    [
                        [this.multisigPda, AccountRole.READONLY],
                        [proposalPda, AccountRole.WRITABLE],
                        [creator.address, AccountRole.READONLY_SIGNER],
                        [feePayer, AccountRole.WRITABLE_SIGNER],
                        [SYSTEM_PROGRAM_ADDRESS, AccountRole.READONLY],
                    ],
                    [u64(transactionIndex), u8(0)],
                ),
            ],
        );

        for (const member of this.members.slice(0, this.approvalsRequired)) {
            await sendKitInstructions(
                this.client,
                this.feePayer,
                [member],
                [
                    squadsInstruction(
                        'proposal_approve',
                        [
                            [this.multisigPda, AccountRole.READONLY],
                            [member.address, AccountRole.WRITABLE_SIGNER],
                            [proposalPda, AccountRole.WRITABLE],
                        ],
                        [NONE],
                    ),
                ],
            );
        }

        return sendKitInstructions(
            this.client,
            this.feePayer,
            [creator],
            [
                squadsInstruction('vault_transaction_execute', [
                    [this.multisigPda, AccountRole.READONLY],
                    [proposalPda, AccountRole.WRITABLE],
                    [transactionPda, AccountRole.READONLY],
                    [creator.address, AccountRole.READONLY_SIGNER],
                    ...remainingAccounts,
                ]),
            ],
        );
    }
}

export async function createSquadsWallet(config: SquadsWalletConfig): Promise<SmartWallet> {
    const programConfigPda = await findPda(['program_config']);
    const programConfig = await fetchEncodedAccount(config.client.rpc, programConfigPda);
    if (!programConfig.exists) {
        throw new Error(`Squads program config ${programConfigPda} not found; run against a mainnet fork`);
    }
    const treasury = getAddressDecoder().decode(programConfig.data, PROGRAM_CONFIG_TREASURY_OFFSET);

    const createKey = await generateKeyPairSigner();
    const multisigPda = await findPda(['multisig', addressBytes(createKey.address)]);
    const vaultPda = await findPda([addressBytes(multisigPda), 'vault', u8(0)]);
    const creator = config.members[0];

    await sendKitInstructions(
        config.client,
        creator,
        [createKey],
        [
            squadsInstruction(
                'multisig_create_v2',
                [
                    [programConfigPda, AccountRole.READONLY],
                    [treasury, AccountRole.WRITABLE],
                    [multisigPda, AccountRole.WRITABLE],
                    [createKey.address, AccountRole.READONLY_SIGNER],
                    [creator.address, AccountRole.WRITABLE_SIGNER],
                    [SYSTEM_PROGRAM_ADDRESS, AccountRole.READONLY],
                ],
                [
                    optionPubkey(config.feePayer.address),
                    u16(config.approvalsRequired),
                    u32(config.members.length),
                    ...config.members.map(member => Buffer.concat([addressBytes(member.address), u8(ALL_PERMISSIONS)])),
                    u32(0),
                    optionPubkey(null),
                    NONE,
                ],
            ),
        ],
    );

    return new SquadsSmartWallet({
        approvalsRequired: config.approvalsRequired,
        client: config.client,
        feePayer: config.feePayer,
        members: config.members,
        multisigPda,
        vaultPda,
    });
}
