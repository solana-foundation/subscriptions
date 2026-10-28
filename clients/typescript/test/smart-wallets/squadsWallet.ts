import { createHash } from 'node:crypto';
import { type Address, AccountRole, type Instruction } from '@solana/kit';
import { type Connection, Keypair, PublicKey, TransactionMessage } from '@solana/web3.js';
import type { SmartWallet } from './SmartWallet.ts';
import { sendWeb3Instructions, toWeb3Instruction } from './utils.ts';

const SQUADS_PROGRAM_ID = new PublicKey('SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf');
const SYSTEM_PROGRAM_ADDRESS = '11111111111111111111111111111111' as Address;
const ALL_PERMISSIONS = 0b111;
const PROGRAM_CONFIG_TREASURY_OFFSET = 48;

type SquadsWalletConfig = {
    connection: Connection;
    feePayer: Keypair;
    members: Keypair[];
    approvalsRequired: number;
};

function findPda(seeds: (Buffer | PublicKey | string)[]): PublicKey {
    const bytes = seeds.map(seed => (seed instanceof PublicKey ? seed.toBuffer() : Buffer.from(seed)));
    return PublicKey.findProgramAddressSync([Buffer.from('multisig'), ...bytes], SQUADS_PROGRAM_ID)[0];
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

function optionPubkey(value: PublicKey | null): Buffer {
    return value ? Buffer.concat([u8(1), value.toBuffer()]) : u8(0);
}

const NONE = u8(0);

function squadsInstruction(
    name: string,
    accounts: [PublicKey | Address, AccountRole][],
    args: Buffer[] = [],
): Instruction {
    const discriminator = createHash('sha256').update(`global:${name}`).digest().subarray(0, 8);
    return {
        accounts: accounts.map(([address, role]) => ({ address: address.toString() as Address, role })),
        data: Buffer.concat([discriminator, ...args]),
        programAddress: SQUADS_PROGRAM_ID.toBase58() as Address,
    };
}

function serializeVaultMessage(message: TransactionMessage): {
    bytes: Buffer;
    remainingAccounts: [PublicKey, AccountRole][];
} {
    const compiled = message.compileToV0Message();
    const { numReadonlySignedAccounts, numReadonlyUnsignedAccounts, numRequiredSignatures } = compiled.header;
    const keys = compiled.staticAccountKeys;
    const numWritableSigners = numRequiredSignatures - numReadonlySignedAccounts;
    const numWritableNonSigners = keys.length - numRequiredSignatures - numReadonlyUnsignedAccounts;

    const bytes = Buffer.concat([
        u8(numRequiredSignatures),
        u8(numWritableSigners),
        u8(numWritableNonSigners),
        u8(keys.length),
        ...keys.map(key => key.toBuffer()),
        u8(compiled.compiledInstructions.length),
        ...compiled.compiledInstructions.flatMap(ix => [
            u8(ix.programIdIndex),
            u8(ix.accountKeyIndexes.length),
            Buffer.from(ix.accountKeyIndexes),
            u16(ix.data.length),
            Buffer.from(ix.data),
        ]),
        u8(0),
    ]);

    const remainingAccounts = keys.map((key, index): [PublicKey, AccountRole] => {
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
    private readonly connection: Connection;
    private readonly feePayer: Keypair;
    private readonly members: Keypair[];
    private readonly approvalsRequired: number;
    private readonly multisigPda: PublicKey;
    private readonly vaultPda: PublicKey;
    private nextTransactionIndex = 1n;

    constructor(config: {
        connection: Connection;
        feePayer: Keypair;
        members: Keypair[];
        approvalsRequired: number;
        multisigPda: PublicKey;
    }) {
        this.connection = config.connection;
        this.feePayer = config.feePayer;
        this.members = config.members;
        this.approvalsRequired = config.approvalsRequired;
        this.multisigPda = config.multisigPda;
        this.vaultPda = findPda([this.multisigPda, 'vault', u8(0)]);
        this.address = this.vaultPda.toBase58() as Address;
    }

    async sendInstructions(instructions: Instruction[]): Promise<string> {
        const creator = this.members[0];
        const feePayer = this.feePayer.publicKey;

        const transactionIndex = this.nextTransactionIndex;
        this.nextTransactionIndex += 1n;
        const transactionPda = findPda([this.multisigPda, 'transaction', u64(transactionIndex)]);
        const proposalPda = findPda([this.multisigPda, 'transaction', u64(transactionIndex), 'proposal']);

        const message = new TransactionMessage({
            instructions: instructions.map(toWeb3Instruction),
            payerKey: this.vaultPda,
            recentBlockhash: (await this.connection.getLatestBlockhash()).blockhash,
        });
        const { bytes, remainingAccounts } = serializeVaultMessage(message);

        await sendWeb3Instructions(
            this.connection,
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

        await sendWeb3Instructions(
            this.connection,
            this.feePayer,
            [creator],
            [
                squadsInstruction(
                    'proposal_create',
                    [
                        [this.multisigPda, AccountRole.READONLY],
                        [proposalPda, AccountRole.WRITABLE],
                        [creator.publicKey, AccountRole.READONLY_SIGNER],
                        [feePayer, AccountRole.WRITABLE_SIGNER],
                        [SYSTEM_PROGRAM_ADDRESS, AccountRole.READONLY],
                    ],
                    [u64(transactionIndex), u8(0)],
                ),
            ],
        );

        for (const member of this.members.slice(0, this.approvalsRequired)) {
            await sendWeb3Instructions(
                this.connection,
                this.feePayer,
                [member],
                [
                    squadsInstruction(
                        'proposal_approve',
                        [
                            [this.multisigPda, AccountRole.READONLY],
                            [member.publicKey, AccountRole.WRITABLE_SIGNER],
                            [proposalPda, AccountRole.WRITABLE],
                        ],
                        [NONE],
                    ),
                ],
            );
        }

        return sendWeb3Instructions(
            this.connection,
            this.feePayer,
            [creator],
            [
                squadsInstruction('vault_transaction_execute', [
                    [this.multisigPda, AccountRole.READONLY],
                    [proposalPda, AccountRole.WRITABLE],
                    [transactionPda, AccountRole.READONLY],
                    [creator.publicKey, AccountRole.READONLY_SIGNER],
                    ...remainingAccounts,
                ]),
            ],
        );
    }
}

export async function createSquadsWallet(config: SquadsWalletConfig): Promise<SmartWallet> {
    const programConfigPda = findPda(['program_config']);
    const programConfig = await config.connection.getAccountInfo(programConfigPda);
    if (!programConfig) {
        throw new Error(`Squads program config ${programConfigPda.toBase58()} not found; run against a mainnet fork`);
    }
    const treasury = new PublicKey(
        programConfig.data.subarray(PROGRAM_CONFIG_TREASURY_OFFSET, PROGRAM_CONFIG_TREASURY_OFFSET + 32),
    );

    const createKey = Keypair.generate();
    const multisigPda = findPda(['multisig', createKey.publicKey]);
    const creator = config.members[0];

    await sendWeb3Instructions(
        config.connection,
        creator,
        [createKey],
        [
            squadsInstruction(
                'multisig_create_v2',
                [
                    [programConfigPda, AccountRole.READONLY],
                    [treasury, AccountRole.WRITABLE],
                    [multisigPda, AccountRole.WRITABLE],
                    [createKey.publicKey, AccountRole.READONLY_SIGNER],
                    [creator.publicKey, AccountRole.WRITABLE_SIGNER],
                    [SYSTEM_PROGRAM_ADDRESS, AccountRole.READONLY],
                ],
                [
                    optionPubkey(config.feePayer.publicKey),
                    u16(config.approvalsRequired),
                    u32(config.members.length),
                    ...config.members.map(member => Buffer.concat([member.publicKey.toBuffer(), u8(ALL_PERMISSIONS)])),
                    u32(0),
                    optionPubkey(null),
                    NONE,
                ],
            ),
        ],
    );

    return new SquadsSmartWallet({
        approvalsRequired: config.approvalsRequired,
        connection: config.connection,
        feePayer: config.feePayer,
        members: config.members,
        multisigPda,
    });
}
