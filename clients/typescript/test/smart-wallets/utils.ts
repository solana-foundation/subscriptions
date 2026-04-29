import type { Instruction } from '@solana/kit';
import {
    type Connection,
    type Keypair,
    PublicKey,
    type Signer,
    sendAndConfirmTransaction,
    Transaction,
    TransactionInstruction,
} from '@solana/web3.js';
import { type KitInstruction, SolInstruction } from '@swig-wallet/kit';

export type SmartWalletInstruction = Instruction | KitInstruction;

export function toWeb3Instruction(instruction: SmartWalletInstruction): TransactionInstruction {
    const solInstruction = SolInstruction.from(instruction as unknown);
    const web3Instruction = solInstruction.toWeb3Instruction();

    return new TransactionInstruction({
        programId: new PublicKey(web3Instruction.programId.toBytes()),
        keys: web3Instruction.keys.map(meta => ({
            pubkey: new PublicKey(meta.pubkey.toBytes()),
            isSigner: meta.isSigner,
            isWritable: meta.isWritable,
        })),
        data: Buffer.from(web3Instruction.data),
    });
}

export async function sendWeb3Instructions(
    connection: Connection,
    feePayer: Keypair,
    signers: Signer[],
    instructions: SmartWalletInstruction[],
): Promise<string> {
    const { blockhash } = await connection.getLatestBlockhash();

    const transaction = new Transaction({
        feePayer: feePayer.publicKey,
        recentBlockhash: blockhash,
    });
    instructions.map(toWeb3Instruction).forEach(ix => {
        transaction.add(ix);
    });

    return sendAndConfirmTransaction(connection, transaction, [feePayer, ...signers]);
}
