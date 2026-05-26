import { useKitTransactionSigner } from '@solana/connector/react';
import {
    address,
    appendTransactionMessageInstructions,
    type Blockhash,
    compileTransaction,
    createKeyPairFromBytes,
    createSignerFromKeyPair,
    createTransactionMessage,
    generateKeyPair,
    getAddressEncoder,
    getBase58Decoder,
    getBase64EncodedWireTransaction,
    type Instruction,
    type KeyPairSigner,
    pipe,
    setTransactionMessageFeePayerSigner,
    setTransactionMessageLifetimeUsingBlockhash,
    signTransactionMessageWithSigners,
    type TransactionSigner,
} from '@solana/kit';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useCallback, useRef, useState } from 'react';

const buildV0Tx = (
    feePayer: TransactionSigner,
    latestBlockhash: { blockhash: Blockhash; lastValidBlockHeight: bigint },
    instructions: Instruction[],
) =>
    pipe(
        createTransactionMessage({ version: 0 }),
        m => setTransactionMessageFeePayerSigner(feePayer, m),
        m => setTransactionMessageLifetimeUsingBlockhash(latestBlockhash, m),
        m => appendTransactionMessageInstructions(instructions, m),
    );
import { useTransactionToast } from '@/components/use-transaction-toast';
import { useClusterConfig } from '@/hooks/use-cluster-config';
import { useRpc } from '@/hooks/use-rpc';
import { api, type DeployPlan } from '@/lib/api-client';
import {
    BPF_LOADER_UPGRADEABLE,
    buildCloseBufferIx,
    buildCreateAccountIx,
    buildDeployIx,
    buildInitializeBufferIx,
    buildSetAuthorityIx,
    buildTransferIx,
    buildUpgradeIx,
    buildWriteIx,
    CHUNK_SIZE,
    deriveProgramDataAddress,
} from '@/lib/bpf-loader-browser';
import { extractErrorMessage } from '@/lib/error-utils';

export interface DeployProgress {
    current: number;
    message: string;
    phase: 'deploying' | 'done' | 'error' | 'funding' | 'init' | 'preparing' | 'writing';
    total: number;
}

interface DeployMutationInput {
    isUpgrade: boolean;
    programAddress?: string;
    programKeypairBytes?: Uint8Array;
    resumeFrom?: number;
}

async function createKeypairSigner(bytes: Uint8Array): Promise<KeyPairSigner> {
    const kp = await createKeyPairFromBytes(bytes);
    return await createSignerFromKeyPair(kp);
}

export function useProgramDeploy() {
    const { signer: walletSigner } = useKitTransactionSigner();
    const { url: rpcUrl, id: clusterId } = useClusterConfig();
    const queryClient = useQueryClient();
    const toast = useTransactionToast();
    const rpc = useRpc();
    const [progress, setProgress] = useState<DeployProgress>({
        current: 0,
        message: '',
        phase: 'preparing',
        total: 0,
    });
    const lastPlanRef = useRef<DeployPlan | null>(null);
    const bufferSignerRef = useRef<KeyPairSigner | null>(null);
    const feePayerRef = useRef<KeyPairSigner | null>(null);

    const resetProgress = useCallback(() => {
        setProgress({ current: 0, message: '', phase: 'preparing', total: 0 });
    }, []);

    const clearRecoveryRefs = useCallback(() => {
        lastPlanRef.current = null;
        bufferSignerRef.current = null;
        feePayerRef.current = null;
    }, []);

    async function fetchOrResumePlan(
        signer: TransactionSigner,
        isUpgrade: boolean,
        programAddress?: string,
        resumeFrom?: number,
    ): Promise<{ bufferKpSigner: KeyPairSigner; plan: DeployPlan }> {
        if (resumeFrom !== undefined && lastPlanRef.current && bufferSignerRef.current) {
            return { bufferKpSigner: bufferSignerRef.current, plan: lastPlanRef.current };
        }
        if (lastPlanRef.current || bufferSignerRef.current || feePayerRef.current) {
            throw new Error('Close the failed buffer before starting a new deployment.');
        }
        const plan = await api.program.prepareDeploy({
            isUpgrade,
            payerAddress: signer.address,
            programAddress,
            rpcUrl,
        });
        const bufferKpSigner = await createKeypairSigner(new Uint8Array(plan.bufferKeypair));
        lastPlanRef.current = plan;
        bufferSignerRef.current = bufferKpSigner;
        return { bufferKpSigner, plan };
    }

    async function fundBufferAndFeePayer(
        signer: TransactionSigner,
        plan: DeployPlan,
        bufferKpSigner: KeyPairSigner,
        feePayerKp: KeyPairSigner,
        totalChunks: number,
        startChunk: number,
    ) {
        const soSize = plan.soSize;
        const bufferSize = soSize + 45;
        const remainingChunks = totalChunks - startChunk;
        const feePayerRent = await rpc.getMinimumBalanceForRentExemption(0n).send();
        const feeBudget = feePayerRent + BigInt(remainingChunks + 2) * 10_000n;

        if (startChunk === 0) {
            const rentLamports = await rpc.getMinimumBalanceForRentExemption(BigInt(bufferSize)).send();
            const totalNeeded = rentLamports + feeBudget + 10_000n;

            const walletBalance = await rpc.getBalance(signer.address).send();
            const solNeeded = Number(totalNeeded) / 1e9;
            const solAvailable = Number(walletBalance.value) / 1e9;
            if (walletBalance.value < totalNeeded) {
                throw new Error(
                    `Insufficient SOL: need ~${solNeeded.toFixed(4)} SOL for buffer rent + fees, but wallet has ${solAvailable.toFixed(4)} SOL. ` +
                        `Request devnet SOL from a faucet first.`,
                );
            }

            setProgress({
                current: 0,
                message: `Funding accounts (~${solNeeded.toFixed(4)} SOL, approve in wallet)...`,
                phase: 'funding',
                total: totalChunks,
            });

            const { value: latestBlockhash } = await rpc.getLatestBlockhash().send();

            const fundFeePayerIx = buildTransferIx(signer, feePayerKp.address, feeBudget);
            const createAccIx = buildCreateAccountIx(
                signer,
                bufferKpSigner,
                rentLamports,
                bufferSize,
                BPF_LOADER_UPGRADEABLE,
            );
            const initBufferIx = buildInitializeBufferIx(bufferKpSigner.address, bufferKpSigner.address);

            const initTx = buildV0Tx(signer, latestBlockhash, [fundFeePayerIx, createAccIx, initBufferIx]);
            const signedInitTx = await signTransactionMessageWithSigners(initTx);
            await rpc.sendTransaction(getBase64EncodedWireTransaction(signedInitTx), { encoding: 'base64' }).send();

            setProgress({ current: 0, message: 'Waiting for confirmation...', phase: 'funding', total: totalChunks });
            for (let attempt = 0; attempt < 60; attempt++) {
                const acctInfo = await rpc.getAccountInfo(bufferKpSigner.address, { encoding: 'base64' }).send();
                if (acctInfo.value) break;
                if (attempt === 59) throw new Error('Buffer account not confirmed after 60s');
                await new Promise(r => setTimeout(r, 1000));
            }
        } else {
            const fpBalance = await rpc.getBalance(feePayerKp.address).send();
            if (fpBalance.value < feeBudget) {
                setProgress({
                    current: 0,
                    message: 'Funding fee payer for resume (approve in wallet)...',
                    phase: 'funding',
                    total: totalChunks,
                });
                const { value: latestBlockhash } = await rpc.getLatestBlockhash().send();
                const fundTx = buildV0Tx(signer, latestBlockhash, [
                    buildTransferIx(signer, feePayerKp.address, feeBudget),
                ]);
                const signedFundTx = await signTransactionMessageWithSigners(fundTx);
                await rpc.sendTransaction(getBase64EncodedWireTransaction(signedFundTx), { encoding: 'base64' }).send();
                for (let attempt = 0; attempt < 30; attempt++) {
                    const bal = await rpc.getBalance(feePayerKp.address).send();
                    if (bal.value >= feeBudget) break;
                    if (attempt === 29) throw new Error('Fee payer funding not confirmed after 30s');
                    await new Promise(r => setTimeout(r, 1000));
                }
            }
        }
    }

    async function writeChunks(
        plan: DeployPlan,
        bufferKpSigner: KeyPairSigner,
        feePayerKp: KeyPairSigner,
        startChunk: number,
        totalChunks: number,
    ) {
        let bh = (await rpc.getLatestBlockhash().send()).value;
        for (let i = startChunk; i < totalChunks; i++) {
            setProgress({
                current: i + 1,
                message: `Writing program data: ${i + 1}/${totalChunks}`,
                phase: 'writing',
                total: totalChunks,
            });

            if (i > startChunk && (i - startChunk) % 30 === 0) {
                bh = (await rpc.getLatestBlockhash().send()).value;
            }

            const offset = i * CHUNK_SIZE;
            let chunkBytes: Uint8Array;
            try {
                chunkBytes = Uint8Array.from(atob(plan.chunks[i]), c => c.charCodeAt(0));
            } catch (e) {
                throw new Error(
                    `Failed to decode chunk ${i}/${totalChunks}: ${e instanceof Error ? e.message : String(e)}`,
                );
            }
            const writeIx = buildWriteIx(bufferKpSigner.address, bufferKpSigner, offset, chunkBytes);

            for (let attempt = 0; attempt < 3; attempt++) {
                try {
                    const writeTx = buildV0Tx(feePayerKp, bh, [writeIx]);
                    const signedWriteTx = await signTransactionMessageWithSigners(writeTx);
                    const wireWriteTx = getBase64EncodedWireTransaction(signedWriteTx);
                    await rpc.sendTransaction(wireWriteTx, { encoding: 'base64' }).send();
                    break;
                } catch (e) {
                    if (attempt === 2) throw e;
                    await new Promise(r => setTimeout(r, 1000 * (attempt + 1)));
                    bh = (await rpc.getLatestBlockhash().send()).value;
                }
            }
        }
    }

    async function transferBufferAuthority(
        signer: TransactionSigner,
        bufferKpSigner: KeyPairSigner,
        feePayerKp: KeyPairSigner,
    ) {
        const authBh = (await rpc.getLatestBlockhash().send()).value;
        const setAuthIx = buildSetAuthorityIx(bufferKpSigner.address, bufferKpSigner, signer.address);
        const setAuthTx = buildV0Tx(feePayerKp, authBh, [setAuthIx]);
        const signedSetAuthTx = await signTransactionMessageWithSigners(setAuthTx);
        const wireSetAuthTx = getBase64EncodedWireTransaction(signedSetAuthTx);
        await rpc.sendTransaction(wireSetAuthTx, { encoding: 'base64' }).send();
        const expectedAuth = getAddressEncoder().encode(address(signer.address));
        for (let attempt = 0; attempt < 30; attempt++) {
            const acctInfo = await rpc.getAccountInfo(bufferKpSigner.address, { encoding: 'base64' }).send();
            if (acctInfo.value) {
                const data = Uint8Array.from(atob(acctInfo.value.data[0] as string), c => c.charCodeAt(0));
                if (data.length >= 37 && data[4] === 1) {
                    const onChainAuth = data.slice(5, 37);
                    if (onChainAuth.every((b, i) => b === expectedAuth[i])) break;
                }
            }
            if (attempt === 29) throw new Error('Buffer authority transfer not confirmed after 30s');
            await new Promise(r => setTimeout(r, 1000));
        }
    }

    async function getBufferAuthority(bufferAddress: string): Promise<string | null> {
        const acctInfo = await rpc.getAccountInfo(address(bufferAddress), { encoding: 'base64' }).send();
        if (!acctInfo.value) return null;

        const data = Uint8Array.from(atob(acctInfo.value.data[0] as string), c => c.charCodeAt(0));
        if (data.length < 37 || data[4] !== 1) {
            throw new Error('Buffer account is not in a recoverable buffer state');
        }

        return getBase58Decoder().decode(data.slice(5, 37));
    }

    async function finalizeDeployment(
        signer: TransactionSigner,
        plan: DeployPlan,
        bufferKpSigner: KeyPairSigner,
        isUpgrade: boolean,
        programKeypairBytes?: Uint8Array,
    ) {
        const freshBlockhash = (await rpc.getLatestBlockhash().send()).value;
        const programAddr = address(plan.programAddress);
        const programDataPDA = await deriveProgramDataAddress(programAddr);

        let finalTx;
        if (isUpgrade) {
            const upgradeIx = buildUpgradeIx(
                programDataPDA,
                programAddr,
                bufferKpSigner.address,
                signer.address,
                signer,
            );
            finalTx = buildV0Tx(signer, freshBlockhash, [upgradeIx]);
        } else {
            if (!programKeypairBytes) throw new Error('Program keypair required for initial deploy');
            const programKpSigner = await createKeypairSigner(programKeypairBytes);
            if (programKpSigner.address !== programAddr) {
                throw new Error('Program keypair does not match deploy plan address');
            }
            const programRent = await rpc.getMinimumBalanceForRentExemption(36n).send();
            const createProgramIx = buildCreateAccountIx(
                signer,
                programKpSigner,
                programRent,
                36,
                BPF_LOADER_UPGRADEABLE,
            );
            const deployIx = buildDeployIx(
                signer,
                programDataPDA,
                programKpSigner,
                bufferKpSigner.address,
                signer,
                plan.soSize * 2,
            );
            finalTx = buildV0Tx(signer, freshBlockhash, [createProgramIx, deployIx]);
        }

        try {
            const compiled = compileTransaction(finalTx);
            const wireBase64 = getBase64EncodedWireTransaction(compiled);
            const simResult = await rpc.simulateTransaction(wireBase64, { encoding: 'base64' }).send();
            if (simResult.value.err) {
                const logs = simResult.value.logs?.join('\n') ?? '';
                throw new Error(`Simulation failed: ${JSON.stringify(simResult.value.err)}\n${logs}`);
            }
        } catch (simErr) {
            if (simErr instanceof Error && simErr.message.startsWith('Simulation failed:')) throw simErr;
            console.warn('Pre-simulation skipped:', simErr);
        }

        const signedFinalTx = await signTransactionMessageWithSigners(finalTx);
        const finalSignature = await rpc
            .sendTransaction(getBase64EncodedWireTransaction(signedFinalTx), { encoding: 'base64' })
            .send();
        return String(finalSignature);
    }

    async function reclaimFeePayerSol(feePayerKp: KeyPairSigner, signer: TransactionSigner) {
        try {
            const fpBal = await rpc.getBalance(feePayerKp.address).send();
            if (fpBal.value > 5000n) {
                const reclaimBh = (await rpc.getLatestBlockhash().send()).value;
                const reclaimIx = buildTransferIx(feePayerKp, signer.address, fpBal.value - 5000n);
                const reclaimTx = buildV0Tx(feePayerKp, reclaimBh, [reclaimIx]);
                const signedReclaim = await signTransactionMessageWithSigners(reclaimTx);
                await rpc
                    .sendTransaction(getBase64EncodedWireTransaction(signedReclaim), { encoding: 'base64' })
                    .send();
            }
        } catch (e) {
            console.warn('Fee payer reclaim failed:', e instanceof Error ? e.message : String(e));
        }
    }

    const closeBuffer = useMutation({
        mutationFn: async () => {
            if (!walletSigner) throw new Error('Wallet not connected');
            const signer = walletSigner;
            const bufferKp = bufferSignerRef.current;
            const feePayerKp = feePayerRef.current;

            if (!bufferKp && !feePayerKp) throw new Error('No deploy recovery state found');

            if (bufferKp) {
                const currentAuthority = await getBufferAuthority(bufferKp.address);

                if (currentAuthority) {
                    const authority = currentAuthority === signer.address ? signer : bufferKp;
                    if (authority.address !== currentAuthority) {
                        throw new Error(`Cannot close buffer because its authority is ${currentAuthority}`);
                    }

                    const { value: latestBlockhash } = await rpc.getLatestBlockhash().send();

                    const closeIx = buildCloseBufferIx(bufferKp.address, signer.address, authority);
                    const closeTx = buildV0Tx(signer, latestBlockhash, [closeIx]);
                    const signedCloseTx = await signTransactionMessageWithSigners(closeTx);
                    await rpc
                        .sendTransaction(getBase64EncodedWireTransaction(signedCloseTx), { encoding: 'base64' })
                        .send();
                }
            }

            if (feePayerKp) await reclaimFeePayerSol(feePayerKp, signer);
            clearRecoveryRefs();
        },
        onError: e => toast.onError(e),
        onSuccess: () => {
            toast.onSuccess('Deploy recovery SOL reclaimed');
        },
    });

    const deploy = useMutation({
        mutationFn: async ({ isUpgrade, programAddress, programKeypairBytes, resumeFrom }: DeployMutationInput) => {
            if (!walletSigner) throw new Error('Wallet not connected');
            if (!isUpgrade && (!programAddress || !programKeypairBytes)) {
                throw new Error('Program keypair required for initial deploy');
            }
            const signer = walletSigner;

            setProgress({ current: 0, message: 'Fetching program data...', phase: 'preparing', total: 0 });

            const { plan, bufferKpSigner } = await fetchOrResumePlan(signer, isUpgrade, programAddress, resumeFrom);
            lastPlanRef.current = plan;
            bufferSignerRef.current = bufferKpSigner;

            const totalChunks = plan.totalChunks;
            const startChunk = resumeFrom ?? 0;

            let feePayerKp: KeyPairSigner;
            if (feePayerRef.current) {
                feePayerKp = feePayerRef.current;
            } else {
                feePayerKp = await createSignerFromKeyPair(await generateKeyPair());
                feePayerRef.current = feePayerKp;
            }

            await fundBufferAndFeePayer(signer, plan, bufferKpSigner, feePayerKp, totalChunks, startChunk);

            await writeChunks(plan, bufferKpSigner, feePayerKp, startChunk, totalChunks);

            setProgress({
                current: totalChunks,
                message: 'Transferring buffer authority...',
                phase: 'deploying',
                total: totalChunks,
            });

            try {
                await transferBufferAuthority(signer, bufferKpSigner, feePayerKp);

                setProgress({
                    current: totalChunks,
                    message: isUpgrade
                        ? 'Finalizing upgrade (approve in wallet)...'
                        : 'Finalizing deployment (approve in wallet)...',
                    phase: 'deploying',
                    total: totalChunks,
                });

                const signature = await finalizeDeployment(
                    signer,
                    plan,
                    bufferKpSigner,
                    isUpgrade,
                    programKeypairBytes,
                );

                await reclaimFeePayerSol(feePayerKp, signer);

                setProgress({
                    current: totalChunks,
                    message: 'Deployment complete!',
                    phase: 'done',
                    total: totalChunks,
                });

                clearRecoveryRefs();

                return { programAddress: plan.programAddress, signature };
            } catch (error) {
                await reclaimFeePayerSol(feePayerKp, signer);
                throw error;
            }
        },
        onError: error => {
            console.error('Deploy/upgrade error:', error);
            const msg = extractErrorMessage(error);
            setProgress(prev => ({
                ...prev,
                message: msg,
                phase: 'error',
            }));
            toast.onError(error);
        },
        onSuccess: res => {
            toast.onSuccess(res.signature);
            queryClient.invalidateQueries({ queryKey: ['program-status', clusterId] });
        },
    });

    return { closeBuffer, deploy, progress, resetProgress };
}
