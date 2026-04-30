import { useKitTransactionSigner } from '@solana/connector/react';
import { address, createSolanaRpc, type Instruction } from '@solana/kit';
import { findAssociatedTokenPda, getCreateAssociatedTokenIdempotentInstruction } from '@solana-program/token';
import { TOKEN_2022_PROGRAM_ADDRESS } from '@solana-program/token-2022';
import {
    fetchMaybeSubscriptionAuthority,
    findSubscriptionAuthorityPda,
    getCancelSubscriptionOverlayInstructionAsync,
    getCloseSubscriptionAuthorityOverlayInstructionAsync,
    getCreateFixedDelegationOverlayInstructionAsync,
    getCreatePlanOverlayInstructionAsync,
    getCreateRecurringDelegationOverlayInstructionAsync,
    getDeletePlanOverlayInstruction,
    getInitSubscriptionAuthorityOverlayInstructionAsync,
    getRevokeDelegationOverlayInstruction,
    getRevokeSubscriptionOverlayInstruction,
    getSubscribeOverlayInstructionAsync,
    getTransferFixedOverlayInstructionAsync,
    getTransferRecurringOverlayInstructionAsync,
    getTransferSubscriptionOverlayInstructionAsync,
    getUpdatePlanOverlayInstruction,
    PlanStatus,
    ZERO_ADDRESS,
} from '@subscriptions/client';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast as sonnerToast } from 'sonner';

import { useClusterConfig } from '@/hooks/use-cluster-config';
import { getBlockTimestamp } from '@/hooks/use-time-travel';
import { useProgramAddress } from '@/hooks/use-token-config';
import { type ConfirmedPlanTransfer, createAllPlanPaymentCollectionResult } from '@/lib/collect-all-results';
import {
    type CollectableSubscriber,
    filterPayableSubscribers,
    sendBatchedSubscriberInstructions,
    type SubscriberPaymentFailure,
    type SubscriberTransfer,
} from '@/lib/collect-utils';
import { packInstructionBatches } from '@/lib/tx-packer';
import { invalidateWithDelay } from '@/lib/utils';

import { useWalletTransactionSignAndSend } from '../components/solana/use-wallet-transaction-sign-and-send';
import { useTransactionToast } from '../components/use-transaction-toast';

export function useSubscriptionsMutations() {
    const { signer } = useKitTransactionSigner();
    const signAndSend = useWalletTransactionSignAndSend();
    const queryClient = useQueryClient();
    const toast = useTransactionToast();
    const { url: rpcUrl } = useClusterConfig();
    const programAddress = useProgramAddress();

    const progId = programAddress ? address(programAddress) : undefined;

    const initSubscriptionAuthority = useMutation({
        mutationFn: async ({
            tokenMint,
            userAta,
            tokenProgram,
        }: {
            tokenMint: string;
            tokenProgram: string;
            userAta: string;
        }) => {
            if (!signer) throw new Error('Wallet not connected');
            if (!progId) throw new Error('Program address not configured');

            const instruction = await getInitSubscriptionAuthorityOverlayInstructionAsync({
                owner: signer,
                programAddress: progId,
                tokenMint: address(tokenMint),
                tokenProgram: address(tokenProgram),
                userAta: address(userAta),
            });

            const signature = await signAndSend([instruction], signer);
            return { signature };
        },
        onError: error => toast.onError(error),
        onSuccess: res => {
            toast.onSuccess(res.signature);
            queryClient.invalidateQueries({ queryKey: ['subscriptionAuthority'] });
            invalidateWithDelay(queryClient, [
                ['subscriptionAuthorityStatus'],
                ['get-token-accounts'],
                ['delegations'],
            ]);
        },
    });

    const closeSubscriptionAuthority = useMutation({
        mutationFn: async ({ tokenMint, payer }: { payer?: string; tokenMint: string }) => {
            if (!signer) throw new Error('Wallet not connected');
            if (!progId) throw new Error('Program address not configured');

            let storedPayer = payer;
            if (!storedPayer) {
                const rpc = createSolanaRpc(rpcUrl);
                const [pda] = await findSubscriptionAuthorityPda(
                    { tokenMint: address(tokenMint), user: signer.address },
                    { programAddress: progId },
                );
                const maybe = await fetchMaybeSubscriptionAuthority(rpc, pda);
                if (maybe.exists) storedPayer = maybe.data.payer;
            }
            const receiver = storedPayer && storedPayer !== signer.address ? address(storedPayer) : undefined;

            const instruction = await getCloseSubscriptionAuthorityOverlayInstructionAsync({
                programAddress: progId,
                receiver,
                tokenMint: address(tokenMint),
                user: signer,
            });

            const signature = await signAndSend([instruction], signer);
            return { signature };
        },
        onError: error => toast.onError(error),
        onSuccess: res => {
            toast.onSuccess(res.signature);
            invalidateWithDelay(queryClient, [
                ['subscriptionAuthorityStatus'],
                ['delegations'],
                ['get-token-accounts'],
            ]);
        },
    });

    const createFixedDelegation = useMutation({
        mutationFn: async ({
            tokenMint,
            delegatee,
            nonce,
            amount,
            expiryTs,
        }: {
            amount: bigint | number;
            delegatee: string;
            expiryTs: bigint | number;
            nonce: bigint | number;
            tokenMint: string;
        }) => {
            if (!signer) throw new Error('Wallet not connected');
            if (!progId) throw new Error('Program address not configured');

            const instruction = await getCreateFixedDelegationOverlayInstructionAsync({
                amount,
                delegatee: address(delegatee),
                delegator: signer,
                expiryTs,
                nonce,
                programAddress: progId,
                tokenMint: address(tokenMint),
            });

            const signature = await signAndSend([instruction], signer);
            return { signature };
        },
        onError: error => toast.onError(error),
        onSuccess: res => {
            toast.onSuccess(res.signature);
            queryClient.invalidateQueries({ queryKey: ['delegations'] });
        },
    });

    const createRecurringDelegation = useMutation({
        mutationFn: async ({
            tokenMint,
            delegatee,
            nonce,
            amountPerPeriod,
            periodLengthS,
            expiryTs,
            startTs,
        }: {
            amountPerPeriod: bigint | number;
            delegatee: string;
            expiryTs: bigint | number;
            nonce: bigint | number;
            periodLengthS: bigint | number;
            startTs?: bigint | number;
            tokenMint: string;
        }) => {
            if (!signer) throw new Error('Wallet not connected');
            if (!progId) throw new Error('Program address not configured');

            const instruction = await getCreateRecurringDelegationOverlayInstructionAsync({
                amountPerPeriod,
                delegatee: address(delegatee),
                delegator: signer,
                expiryTs,
                nonce,
                periodLengthS,
                programAddress: progId,
                startTs: startTs ?? (await getBlockTimestamp(rpcUrl)),
                tokenMint: address(tokenMint),
            });

            const signature = await signAndSend([instruction], signer);
            return { signature };
        },
        onError: error => toast.onError(error),
        onSuccess: res => {
            toast.onSuccess(res.signature);
            queryClient.invalidateQueries({ queryKey: ['delegations'] });
        },
    });

    const revokeDelegation = useMutation({
        mutationFn: async ({ delegationAccount, payer }: { delegationAccount: string; payer: string }) => {
            if (!signer) throw new Error('Wallet not connected');

            const receiver = payer !== signer.address ? address(payer) : undefined;

            const instruction = getRevokeDelegationOverlayInstruction({
                authority: signer,
                delegationAccount: address(delegationAccount),
                programAddress: progId,
                receiver,
            });

            const signature = await signAndSend([instruction], signer);
            return { signature };
        },
        onError: error => toast.onError(error),
        onSuccess: res => {
            toast.onSuccess(res.signature);
            queryClient.invalidateQueries({ queryKey: ['delegations'] });
        },
    });

    type TransferParams = {
        amount: bigint;
        delegationAccount: string;
        delegator: string;
        receiverAta?: string;
        tokenMint: string;
    };

    const buildTransferIxs = async (params: TransferParams, kind: 'fixed' | 'recurring') => {
        if (!signer) throw new Error('Wallet not connected');
        if (!progId) throw new Error('Program address not configured');

        const mint = address(params.tokenMint);
        const delegatorAddr = address(params.delegator);
        const [delegatorAta] = await findAssociatedTokenPda({
            mint,
            owner: delegatorAddr,
            tokenProgram: TOKEN_2022_PROGRAM_ADDRESS,
        });
        const receiver = params.receiverAta
            ? address(params.receiverAta)
            : (
                  await findAssociatedTokenPda({
                      mint,
                      owner: signer.address,
                      tokenProgram: TOKEN_2022_PROGRAM_ADDRESS,
                  })
              )[0];

        const createAtaIx = getCreateAssociatedTokenIdempotentInstruction({
            ata: receiver,
            mint,
            owner: signer.address,
            payer: signer,
            tokenProgram: TOKEN_2022_PROGRAM_ADDRESS,
        });

        const buildFn =
            kind === 'fixed' ? getTransferFixedOverlayInstructionAsync : getTransferRecurringOverlayInstructionAsync;
        const transferIx = await buildFn({
            amount: params.amount,
            delegatee: signer,
            delegationPda: address(params.delegationAccount),
            delegator: delegatorAddr,
            delegatorAta,
            programAddress: progId,
            receiverAta: receiver,
            tokenMint: mint,
            tokenProgram: TOKEN_2022_PROGRAM_ADDRESS,
        });

        return { instructions: [createAtaIx, transferIx], signer };
    };

    const transferFixed = useMutation({
        mutationFn: async (params: TransferParams) => {
            const { instructions, signer: txSigner } = await buildTransferIxs(params, 'fixed');
            const signature = await signAndSend(instructions, txSigner);
            return { signature };
        },
        onError: error => toast.onError(error),
        onSuccess: res => {
            toast.onSuccess(res.signature);
            queryClient.invalidateQueries({ queryKey: ['delegations'] });
            invalidateWithDelay(queryClient, [['get-token-accounts']]);
        },
    });

    const transferRecurring = useMutation({
        mutationFn: async (params: TransferParams) => {
            const { instructions, signer: txSigner } = await buildTransferIxs(params, 'recurring');
            const signature = await signAndSend(instructions, txSigner);
            return { signature };
        },
        onError: error => toast.onError(error),
        onSuccess: res => {
            toast.onSuccess(res.signature);
            queryClient.invalidateQueries({ queryKey: ['delegations'] });
            invalidateWithDelay(queryClient, [['get-token-accounts']]);
        },
    });

    const createPlan = useMutation({
        mutationFn: async ({
            planId,
            mint,
            amount,
            periodHours,
            endTs,
            destinations,
            pullers,
            metadataUri,
        }: {
            amount: bigint;
            destinations: string[];
            endTs: number;
            metadataUri: string;
            mint: string;
            periodHours: number;
            planId: bigint;
            pullers: string[];
        }) => {
            if (!signer) throw new Error('Wallet not connected');
            if (!progId) throw new Error('Program address not configured');

            const instruction = await getCreatePlanOverlayInstructionAsync({
                amount,
                destinations: destinations.map(d => address(d)),
                endTs: BigInt(endTs),
                metadataUri,
                mint: address(mint),
                owner: signer,
                periodHours: BigInt(periodHours),
                planId,
                programAddress: progId,
                pullers: pullers.map(p => address(p)),
                tokenProgram: TOKEN_2022_PROGRAM_ADDRESS,
            });

            const signature = await signAndSend([instruction], signer);
            return { signature };
        },
        onError: error => toast.onError(error),
        onSuccess: res => {
            toast.onSuccess(res.signature);
            queryClient.invalidateQueries({ queryKey: ['plans'] });
        },
    });

    const updatePlan = useMutation({
        mutationFn: async ({
            planPda,
            status,
            endTs,
            metadataUri,
            pullers = [],
        }: {
            endTs: number;
            metadataUri: string;
            planPda: string;
            pullers?: string[];
            status: PlanStatus;
        }) => {
            if (!signer) throw new Error('Wallet not connected');

            const instruction = getUpdatePlanOverlayInstruction({
                endTs: BigInt(endTs),
                metadataUri,
                owner: signer,
                planPda: address(planPda),
                programAddress: progId,
                pullers: pullers.map(p => address(p)),
                status,
            });

            const signature = await signAndSend([instruction], signer);
            return { signature };
        },
        onError: error => toast.onError(error),
        onSuccess: res => {
            toast.onSuccess(res.signature);
            queryClient.invalidateQueries({ queryKey: ['plans'] });
        },
    });

    const deletePlan = useMutation({
        mutationFn: async ({ planPda }: { planPda: string }) => {
            if (!signer) throw new Error('Wallet not connected');

            const instruction = getDeletePlanOverlayInstruction({
                owner: signer,
                planPda: address(planPda),
                programAddress: progId,
            });

            const signature = await signAndSend([instruction], signer);
            return { signature };
        },
        onError: error => toast.onError(error),
        onSuccess: res => {
            toast.onSuccess(res.signature);
            queryClient.invalidateQueries({ queryKey: ['plans'] });
        },
    });

    const subscribe = useMutation({
        mutationFn: async ({
            merchant,
            planId,
            tokenMint,
            expectedAmount,
            expectedPeriodHours,
            expectedCreatedAt,
        }: {
            expectedAmount: bigint;
            expectedCreatedAt: bigint;
            expectedPeriodHours: bigint;
            merchant: string;
            planId: bigint;
            tokenMint: string;
        }) => {
            if (!signer) throw new Error('Wallet not connected');
            if (!progId) throw new Error('Program address not configured');

            const instruction = await getSubscribeOverlayInstructionAsync({
                expectedAmount,
                expectedCreatedAt,
                expectedPeriodHours,
                merchant: address(merchant),
                planId,
                programAddress: progId,
                subscriber: signer,
                tokenMint: address(tokenMint),
            });

            const signature = await signAndSend([instruction], signer);
            return { signature };
        },
        onError: error => toast.onError(error),
        onSuccess: res => {
            toast.onSuccess(res.signature);
            queryClient.invalidateQueries({ queryKey: ['subscriptions'] });
        },
    });

    const cancelSubscription = useMutation({
        mutationFn: async ({ planPda, subscriptionPda }: { planPda: string; subscriptionPda: string }) => {
            if (!signer) throw new Error('Wallet not connected');
            if (!progId) throw new Error('Program address not configured');

            const instruction = await getCancelSubscriptionOverlayInstructionAsync({
                planPda: address(planPda),
                programAddress: progId,
                subscriber: signer,
                subscriptionPda: address(subscriptionPda),
            });

            const signature = await signAndSend([instruction], signer);
            return { signature };
        },
        onError: error => toast.onError(error),
        onSuccess: res => {
            toast.onSuccess(res.signature);
            queryClient.invalidateQueries({ queryKey: ['subscriptions'] });
        },
    });

    const revokeSubscription = useMutation({
        mutationFn: async ({
            subscriptionPda,
            planPda,
            payer,
        }: {
            payer: string;
            planPda: string;
            subscriptionPda: string;
        }) => {
            if (!signer) throw new Error('Wallet not connected');

            const receiver = payer !== signer.address ? address(payer) : undefined;

            const instruction = getRevokeSubscriptionOverlayInstruction({
                authority: signer,
                planPda: address(planPda),
                programAddress: progId,
                receiver,
                subscriptionPda: address(subscriptionPda),
            });

            const signature = await signAndSend([instruction], signer);
            return { signature };
        },
        onError: error => toast.onError(error),
        onSuccess: res => {
            toast.onSuccess(res.signature);
            queryClient.invalidateQueries({ queryKey: ['subscriptions'] });
        },
    });

    const cancelAndRevokeSubscription = useMutation({
        mutationFn: async ({
            planPda,
            subscriptionPda,
            payer,
        }: {
            payer: string;
            planPda: string;
            subscriptionPda: string;
        }) => {
            if (!signer) throw new Error('Wallet not connected');
            if (!progId) throw new Error('Program address not configured');

            const receiver = payer !== signer.address ? address(payer) : undefined;

            const cancelIx = await getCancelSubscriptionOverlayInstructionAsync({
                planPda: address(planPda),
                programAddress: progId,
                subscriber: signer,
                subscriptionPda: address(subscriptionPda),
            });

            const revokeIx = getRevokeSubscriptionOverlayInstruction({
                authority: signer,
                planPda: address(planPda),
                programAddress: progId,
                receiver,
                subscriptionPda: address(subscriptionPda),
            });

            const signature = await signAndSend([cancelIx, revokeIx], signer);
            return { signature };
        },
        onError: error => toast.onError(error),
        onSuccess: res => {
            toast.onSuccess(res.signature);
            queryClient.invalidateQueries({ queryKey: ['subscriptions'] });
        },
    });

    const collectSubscriptionPayments = useMutation({
        mutationFn: async ({
            planAddress,
            subscribers,
            mint,
            destinations,
        }: {
            destinations: string[];
            mint: string;
            planAddress: string;
            subscribers: Array<{ amount: bigint; delegator: string; subscriptionAddress: string }>;
        }) => {
            if (!signer) throw new Error('Wallet not connected');
            if (!progId) throw new Error('Program address not configured');

            const mintAddr = address(mint);
            const planPda = address(planAddress);
            const rpc = createSolanaRpc(rpcUrl);

            const firstDest = destinations.find(d => d !== ZERO_ADDRESS);
            const receiverOwner = firstDest ? address(firstDest) : signer.address;
            const [receiverAta] = await findAssociatedTokenPda({
                mint: mintAddr,
                owner: receiverOwner,
                tokenProgram: TOKEN_2022_PROGRAM_ADDRESS,
            });

            const createAtaIx = getCreateAssociatedTokenIdempotentInstruction({
                ata: receiverAta,
                mint: mintAddr,
                owner: receiverOwner,
                payer: signer,
                tokenProgram: TOKEN_2022_PROGRAM_ADDRESS,
            });

            const { payable, failures: preflightFailures } = await filterPayableSubscribers({
                mint: mintAddr,
                programAddress: progId,
                rpc,
                subscribers,
                tokenProgram: TOKEN_2022_PROGRAM_ADDRESS,
            });

            const transferEntries: SubscriberTransfer[] = await Promise.all(
                payable.map(async sub => {
                    const instruction = await getTransferSubscriptionOverlayInstructionAsync({
                        amount: sub.amount,
                        caller: signer,
                        delegator: address(sub.delegator),
                        planPda,
                        programAddress: progId,
                        receiverAta,
                        subscriptionPda: address(sub.subscriptionAddress),
                        tokenMint: mintAddr,
                        tokenProgram: TOKEN_2022_PROGRAM_ADDRESS,
                    });
                    return { instruction, subscriber: sub };
                }),
            );

            const signatures: string[] = [];
            const transfers: Array<{ amount: bigint; signature: string; subscriptionAddress: string }> = [];
            const failures: SubscriberPaymentFailure[] = [...preflightFailures];
            let collected = 0;

            if (transferEntries.length > 0) {
                signatures.push(await signAndSend([createAtaIx], signer));
                const result = await sendBatchedSubscriberInstructions({
                    feePayer: signer,
                    sendInstructions: instructions => signAndSend(instructions, signer),
                    transfers: transferEntries,
                });
                signatures.push(...result.signatures);
                failures.push(...result.failures);
                collected = result.collected;
                transfers.push(
                    ...result.confirmed.map(({ subscriber, signature }) => ({
                        amount: subscriber.amount,
                        signature,
                        subscriptionAddress: subscriber.subscriptionAddress,
                    })),
                );
            }

            return {
                collected,
                failures,
                partial: failures.length > 0,
                signatures,
                total: subscribers.length,
                transfers,
            };
        },
        onError: error => toast.onError(error),
        onSuccess: res => {
            if (res.signatures[0]) toast.onSuccess(res.signatures[0]);
            if (res.failures.length > 0) {
                sonnerToast.warning(
                    `Skipped ${res.failures.length} unpayable subscriber payment${res.failures.length === 1 ? '' : 's'}`,
                );
                console.warn(`Skipped ${res.failures.length} unpayable subscriber payments`, res.failures);
            }
            invalidateWithDelay(queryClient, [['subscriberCounts'], ['get-token-accounts']]);
        },
    });

    const collectAllPlanPayments = useMutation({
        mutationFn: async ({
            plans,
        }: {
            plans: Array<{
                destinations: string[];
                mint: string;
                planAddress: string;
                subscribers: Array<{ amount: bigint; delegator: string; subscriptionAddress: string }>;
            }>;
        }) => {
            if (!signer) throw new Error('Wallet not connected');
            if (!progId) throw new Error('Program address not configured');

            type PlanTransferSubscriber = CollectableSubscriber & { planAddress: string };

            const rpc = createSolanaRpc(rpcUrl);
            const ataIxs: Instruction[] = [];
            const transferEntries: SubscriberTransfer<PlanTransferSubscriber>[] = [];
            const seenAtas = new Set<string>();
            const preflightFailures: SubscriberPaymentFailure<PlanTransferSubscriber>[] = [];
            const planTotals = plans.map(plan => ({
                planAddress: plan.planAddress,
                total: plan.subscribers.length,
            }));

            for (const plan of plans) {
                const mintAddr = address(plan.mint);
                const planPda = address(plan.planAddress);
                const subscribersWithPlan = plan.subscribers.map(sub => ({
                    ...sub,
                    planAddress: plan.planAddress,
                }));
                const { payable, failures } = await filterPayableSubscribers({
                    mint: mintAddr,
                    programAddress: progId,
                    rpc,
                    subscribers: subscribersWithPlan,
                    tokenProgram: TOKEN_2022_PROGRAM_ADDRESS,
                });
                preflightFailures.push(...failures);
                if (payable.length === 0) continue;

                const firstDest = plan.destinations.find(d => d !== ZERO_ADDRESS);
                const receiverOwner = firstDest ? address(firstDest) : signer.address;
                const [receiverAta] = await findAssociatedTokenPda({
                    mint: mintAddr,
                    owner: receiverOwner,
                    tokenProgram: TOKEN_2022_PROGRAM_ADDRESS,
                });

                const ataKey = receiverAta.toString();
                if (!seenAtas.has(ataKey)) {
                    seenAtas.add(ataKey);
                    ataIxs.push(
                        getCreateAssociatedTokenIdempotentInstruction({
                            ata: receiverAta,
                            mint: mintAddr,
                            owner: receiverOwner,
                            payer: signer,
                            tokenProgram: TOKEN_2022_PROGRAM_ADDRESS,
                        }),
                    );
                }

                for (const sub of payable) {
                    const instruction = await getTransferSubscriptionOverlayInstructionAsync({
                        amount: sub.amount,
                        caller: signer,
                        delegator: address(sub.delegator),
                        planPda,
                        programAddress: progId,
                        receiverAta,
                        subscriptionPda: address(sub.subscriptionAddress),
                        tokenMint: mintAddr,
                        tokenProgram: TOKEN_2022_PROGRAM_ADDRESS,
                    });
                    transferEntries.push({ instruction, subscriber: sub });
                }
            }

            const signatures: string[] = [];
            const confirmedTransfers: ConfirmedPlanTransfer[] = [];
            const failures: SubscriberPaymentFailure<PlanTransferSubscriber>[] = [...preflightFailures];

            if (transferEntries.length > 0) {
                const ataBatches = packInstructionBatches(ataIxs, signer);
                for (const batch of ataBatches) {
                    signatures.push(await signAndSend(batch, signer));
                }

                const result = await sendBatchedSubscriberInstructions({
                    feePayer: signer,
                    sendInstructions: instructions => signAndSend(instructions, signer),
                    transfers: transferEntries,
                });
                signatures.push(...result.signatures);
                failures.push(...result.failures);
                confirmedTransfers.push(
                    ...result.confirmed.map(({ subscriber, signature }) => ({
                        amount: subscriber.amount,
                        batchIndex: signatures.indexOf(signature),
                        delegator: subscriber.delegator,
                        planAddress: subscriber.planAddress,
                        signature,
                        subscriptionAddress: subscriber.subscriptionAddress,
                    })),
                );
            }

            return {
                ...createAllPlanPaymentCollectionResult(
                    planTotals,
                    confirmedTransfers,
                    signatures,
                    failures.length > 0,
                ),
                failures,
            };
        },
        onError: error => toast.onError(error),
        onSuccess: res => {
            if (res.signatures[0]) toast.onSuccess(res.signatures[0]);
            if (res.failures.length > 0) {
                sonnerToast.warning(
                    `Skipped ${res.failures.length} unpayable subscriber payment${res.failures.length === 1 ? '' : 's'}`,
                );
                console.warn(`Skipped ${res.failures.length} unpayable subscriber payments`, res.failures);
            }
            invalidateWithDelay(queryClient, [['subscriberCounts'], ['get-token-accounts']]);
        },
    });

    const revokeMultipleDelegations = useMutation({
        mutationFn: async ({ delegations }: { delegations: Array<{ address: string; payer: string }> }) => {
            if (!signer) throw new Error('Wallet not connected');
            if (!progId) throw new Error('Program address not configured');

            const revokeIxs = delegations.map(({ address: account, payer }) => {
                const receiver = payer !== signer.address ? address(payer) : undefined;
                return getRevokeDelegationOverlayInstruction({
                    authority: signer,
                    delegationAccount: address(account),
                    programAddress: progId,
                    receiver,
                });
            });

            const batches = packInstructionBatches(revokeIxs, signer);
            const signatures: string[] = [];

            for (const batch of batches) {
                signatures.push(await signAndSend(batch, signer));
            }

            return { revoked: delegations.length, signatures };
        },
        onError: error => toast.onError(error),
        onSuccess: res => {
            toast.onSuccess(res.signatures[0]);
            invalidateWithDelay(queryClient, [
                ['delegations'],
                ['subscriptionAuthorityStatus'],
                ['get-token-accounts'],
            ]);
        },
    });

    return {
        cancelAndRevokeSubscription,
        cancelSubscription,
        closeSubscriptionAuthority,
        collectAllPlanPayments,
        collectSubscriptionPayments,
        createFixedDelegation,
        createPlan,
        createRecurringDelegation,
        deletePlan,
        initSubscriptionAuthority,
        revokeDelegation,
        revokeMultipleDelegations,
        revokeSubscription,
        subscribe,
        transferFixed,
        transferRecurring,
        updatePlan,
    };
}
