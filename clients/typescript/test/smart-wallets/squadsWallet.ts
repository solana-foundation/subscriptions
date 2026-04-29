import type { Address, Instruction } from '@solana/kit';
import {
    type Connection,
    Keypair,
    LAMPORTS_PER_SOL,
    PublicKey,
    sendAndConfirmTransaction,
    Transaction,
    TransactionMessage,
} from '@solana/web3.js';
import * as squads from '@sqds/multisig';
import type { SmartWallet } from './SmartWallet.ts';
import { toWeb3Instruction } from './utils.ts';

type SquadsWalletConfig = {
    connection: Connection;
    feePayer: Keypair;
    members: Keypair[];
    approvalsRequired: number;
    vaultIndex?: number;
    programId?: PublicKey;
};

class SquadsSmartWallet implements SmartWallet {
    public readonly name = 'squads';
    public readonly address: Address;
    private readonly connection: Connection;
    private readonly feePayer: Keypair;
    private readonly members: Keypair[];
    private readonly approvalsRequired: number;
    private readonly multisigPda: PublicKey;
    private readonly vaultIndex: number;
    private readonly programId: PublicKey;
    private nextTransactionIndex = 1n;

    constructor(config: {
        connection: Connection;
        feePayer: Keypair;
        members: Keypair[];
        approvalsRequired: number;
        multisigPda: PublicKey;
        vaultIndex: number;
        programId: PublicKey;
    }) {
        this.connection = config.connection;
        this.feePayer = config.feePayer;
        this.members = config.members;
        this.approvalsRequired = config.approvalsRequired;
        this.multisigPda = config.multisigPda;
        this.vaultIndex = config.vaultIndex;
        this.programId = config.programId;

        const [vaultPda] = squads.getVaultPda({
            multisigPda: this.multisigPda,
            index: this.vaultIndex,
            programId: this.programId,
        });
        this.address = vaultPda.toBase58() as Address;
    }

    async sendInstructions(instructions: Instruction[]): Promise<string> {
        const creator = this.members[0];

        const transactionIndex = this.nextTransactionIndex;
        this.nextTransactionIndex += 1n;

        const message = new TransactionMessage({
            payerKey: new PublicKey(this.address),
            recentBlockhash: (await this.connection.getLatestBlockhash()).blockhash,
            instructions: instructions.map(toWeb3Instruction),
        });

        await squads.rpc.vaultTransactionCreate({
            connection: this.connection,
            feePayer: this.feePayer,
            multisigPda: this.multisigPda,
            transactionIndex,
            creator: this.feePayer.publicKey,
            vaultIndex: 0,
            ephemeralSigners: 0,
            transactionMessage: message,
        });

        await squads.rpc.proposalCreate({
            connection: this.connection,
            feePayer: this.feePayer,
            creator,
            multisigPda: this.multisigPda,
            transactionIndex,
            isDraft: false,
            programId: this.programId,
        });

        for (const member of this.members.slice(0, this.approvalsRequired)) {
            await squads.rpc.proposalApprove({
                connection: this.connection,
                feePayer: this.feePayer,
                member,
                multisigPda: this.multisigPda,
                transactionIndex,
                programId: this.programId,
            });
        }

        return squads.rpc.vaultTransactionExecute({
            connection: this.connection,
            feePayer: this.feePayer,
            multisigPda: this.multisigPda,
            transactionIndex,
            member: creator.publicKey,
            signers: [creator],
            programId: this.programId,
        });
    }
}

async function ensureProgramConfig({
    connection,
    feePayer,
    programId,
}: {
    connection: Connection;
    feePayer: Keypair;
    programId: PublicKey;
}): Promise<{ programConfigPda: PublicKey; treasury: PublicKey }> {
    const [programConfigPda] = squads.getProgramConfigPda({ programId });
    const existing = await connection.getAccountInfo(programConfigPda);
    if (existing) {
        const programConfig = await squads.accounts.ProgramConfig.fromAccountAddress(connection, programConfigPda);
        return { programConfigPda, treasury: programConfig.treasury };
    }

    const initIx = squads.generated.createProgramConfigInitInstruction(
        {
            programConfig: programConfigPda,
            initializer: feePayer.publicKey,
        },
        {
            args: {
                authority: feePayer.publicKey,
                multisigCreationFee: 0n,
                treasury: feePayer.publicKey,
            },
        },
        programId,
    );

    const tx = new Transaction().add(initIx);
    tx.feePayer = feePayer.publicKey;
    tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
    tx.sign(feePayer);
    await sendAndConfirmTransaction(connection, tx, [feePayer]);

    return { programConfigPda, treasury: feePayer.publicKey };
}

export async function createSquadsWallet(config: SquadsWalletConfig): Promise<SmartWallet> {
    const programId = config.programId ?? squads.PROGRAM_ID;
    const vaultIndex = config.vaultIndex ?? 0;
    const approvalsRequired = config.approvalsRequired;

    const { treasury } = await ensureProgramConfig({
        connection: config.connection,
        feePayer: config.feePayer,
        programId,
    });

    const createKey = Keypair.generate();
    const airdropSig = await config.connection.requestAirdrop(createKey.publicKey, LAMPORTS_PER_SOL);
    await config.connection.confirmTransaction(airdropSig, 'confirmed');
    const [multisigPda] = squads.getMultisigPda({
        createKey: createKey.publicKey,
        programId,
    });

    const members = config.members.map(member => ({
        key: member.publicKey,
        permissions: squads.types.Permissions.all(),
    }));

    const creator = config.members[0];
    await squads.rpc.multisigCreateV2({
        connection: config.connection,
        treasury,
        createKey,
        creator,
        multisigPda,
        configAuthority: config.feePayer.publicKey,
        threshold: approvalsRequired,
        members,
        timeLock: 0,
        rentCollector: null,
        programId,
    });

    return new SquadsSmartWallet({
        connection: config.connection,
        feePayer: config.feePayer,
        members: config.members,
        approvalsRequired,
        multisigPda,
        vaultIndex,
        programId,
    });
}
