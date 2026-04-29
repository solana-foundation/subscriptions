import { useMemo } from 'react';
import type { Instruction, TransactionSendingSigner } from '@solana/kit';
import {
    appendTransactionMessageInstructions,
    createSolanaRpc,
    createTransactionMessage,
    compileTransaction,
    getBase64EncodedWireTransaction,
    pipe,
    setTransactionMessageFeePayerSigner,
    setTransactionMessageLifetimeUsingBlockhash,
    signAndSendTransactionMessageWithSigners,
    getBase58Decoder,
} from '@solana/kit';
import { useClusterConfig } from '@/hooks/use-cluster-config';

/**
 * Hook to build, sign via wallet, and send transactions.
 * Mirrors the working perena pattern:
 * - build a full kit transaction message
 * - (best-effort) simulate via RPC
 * - request wallet sign+send
 */
export function useWalletTransactionSignAndSend() {
    const clusterConfig = useClusterConfig();
    const rpc = useMemo(() => createSolanaRpc(clusterConfig.url), [clusterConfig.url]);

    return async (ix: Instruction | Instruction[], signer: TransactionSendingSigner): Promise<string> => {
        const { value: latestBlockhash } = await rpc.getLatestBlockhash().send();
        const instructions = Array.isArray(ix) ? ix : [ix];

        const transaction = pipe(
            createTransactionMessage({ version: 0 }),
            tx => setTransactionMessageFeePayerSigner(signer, tx),
            tx => setTransactionMessageLifetimeUsingBlockhash(latestBlockhash, tx),
            tx => appendTransactionMessageInstructions(instructions, tx),
        );

        // Best-effort simulate before asking wallet to sign+send
        try {
            const compiledTx = compileTransaction(transaction);
            const base64Tx = getBase64EncodedWireTransaction(compiledTx);
            const simulationResult = await rpc.simulateTransaction(base64Tx, { encoding: 'base64' }).send();

            if (simulationResult.value.err) {
                const errorDetails = simulationResult.value.logs?.join('\n') ?? '';
                throw new Error(
                    `Transaction simulation failed: ${JSON.stringify(simulationResult.value.err)}\n${errorDetails}`,
                );
            }
        } catch (simulationError) {
            if (
                simulationError instanceof Error &&
                simulationError.message.startsWith('Transaction simulation failed:')
            ) {
                throw simulationError;
            }
        }

        const signatureBytes = await signAndSendTransactionMessageWithSigners(transaction);
        return getBase58Decoder().decode(signatureBytes);
    };
}
