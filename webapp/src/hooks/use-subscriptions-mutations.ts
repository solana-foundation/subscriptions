import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast as sonnerToast } from "sonner";
import { address, createSolanaRpc, type Instruction } from "@solana/kit";
import {
  findAssociatedTokenPda,
  getCreateAssociatedTokenIdempotentInstruction,
} from "@solana-program/token";
import { TOKEN_2022_PROGRAM_ADDRESS } from "@solana-program/token-2022";
import {
  getInitSubscriptionAuthorityOverlayInstructionAsync,
  getCloseSubscriptionAuthorityOverlayInstructionAsync,
  getCreateFixedDelegationOverlayInstructionAsync,
  getCreateRecurringDelegationOverlayInstructionAsync,
  getRevokeDelegationOverlayInstruction,
  getRevokeSubscriptionOverlayInstruction,
  getTransferFixedOverlayInstructionAsync,
  getTransferRecurringOverlayInstructionAsync,
  getTransferSubscriptionOverlayInstructionAsync,
  getCreatePlanOverlayInstructionAsync,
  getUpdatePlanOverlayInstruction,
  getDeletePlanOverlayInstruction,
  getSubscribeOverlayInstructionAsync,
  getCancelSubscriptionOverlayInstructionAsync,
  fetchMaybeSubscriptionAuthority,
  findSubscriptionAuthorityPda,
  ZERO_ADDRESS,
  PlanStatus,
} from "@subscriptions/client";
import { useClusterConfig } from "@/hooks/use-cluster-config";
import { useWalletUiSigner } from "../components/solana/use-wallet-ui-signer";
import { useWalletTransactionSignAndSend } from "../components/solana/use-wallet-transaction-sign-and-send";
import { useTransactionToast } from "../components/use-transaction-toast";
import { invalidateWithDelay } from "@/lib/utils";
import { createAllPlanPaymentCollectionResult, type ConfirmedPlanTransfer } from "@/lib/collect-all-results";
import { packInstructionBatches } from "@/lib/tx-packer";
import {
  filterPayableSubscribers,
  sendBatchedSubscriberInstructions,
  type CollectableSubscriber,
  type SubscriberPaymentFailure,
  type SubscriberTransfer,
} from "@/lib/collect-utils";
import { getBlockTimestamp } from "@/hooks/use-time-travel";
import { useProgramAddress } from "@/hooks/use-token-config";

export function useSubscriptionsMutations() {
  const signer = useWalletUiSigner();
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
      userAta: string;
      tokenProgram: string;
    }) => {
      if (!signer) throw new Error("Wallet not connected");
      if (!progId) throw new Error("Program address not configured");

      const instruction = await getInitSubscriptionAuthorityOverlayInstructionAsync({
        owner: signer,
        tokenMint: address(tokenMint),
        userAta: address(userAta),
        tokenProgram: address(tokenProgram),
        programAddress: progId,
      });

      const signature = await signAndSend([instruction], signer);
      return { signature };
    },
    onSuccess: (res) => {
      toast.onSuccess(res.signature);
      queryClient.invalidateQueries({ queryKey: ["subscriptionAuthority"] });
      invalidateWithDelay(queryClient, [
        ["subscriptionAuthorityStatus"],
        ["get-token-accounts"],
        ["delegations"],
      ]);
    },
    onError: (error) => toast.onError(error),
  });

  const closeSubscriptionAuthority = useMutation({
    mutationFn: async ({ tokenMint, payer }: { tokenMint: string; payer?: string }) => {
      if (!signer) throw new Error("Wallet not connected");
      if (!progId) throw new Error("Program address not configured");

      let storedPayer = payer;
      if (!storedPayer) {
        const rpc = createSolanaRpc(rpcUrl);
        const [pda] = await findSubscriptionAuthorityPda(
          { user: signer.address, tokenMint: address(tokenMint) },
          { programAddress: progId },
        );
        const maybe = await fetchMaybeSubscriptionAuthority(rpc, pda);
        if (maybe.exists) storedPayer = maybe.data.payer;
      }
      const receiver = storedPayer && storedPayer !== signer.address ? address(storedPayer) : undefined;

      const instruction = await getCloseSubscriptionAuthorityOverlayInstructionAsync({
        user: signer,
        tokenMint: address(tokenMint),
        receiver,
        programAddress: progId,
      });

      const signature = await signAndSend([instruction], signer);
      return { signature };
    },
    onSuccess: (res) => {
      toast.onSuccess(res.signature);
      invalidateWithDelay(queryClient, [
        ["subscriptionAuthorityStatus"],
        ["delegations"],
        ["get-token-accounts"],
      ]);
    },
    onError: (error) => toast.onError(error),
  });

  const createFixedDelegation = useMutation({
    mutationFn: async ({
      tokenMint,
      delegatee,
      nonce,
      amount,
      expiryTs,
    }: {
      tokenMint: string;
      delegatee: string;
      nonce: number | bigint;
      amount: number | bigint;
      expiryTs: number | bigint;
    }) => {
      if (!signer) throw new Error("Wallet not connected");
      if (!progId) throw new Error("Program address not configured");

      const instruction = await getCreateFixedDelegationOverlayInstructionAsync({
        delegator: signer,
        tokenMint: address(tokenMint),
        delegatee: address(delegatee),
        nonce,
        amount,
        expiryTs,
        programAddress: progId,
      });

      const signature = await signAndSend([instruction], signer);
      return { signature };
    },
    onSuccess: (res) => {
      toast.onSuccess(res.signature);
      queryClient.invalidateQueries({ queryKey: ["delegations"] });
    },
    onError: (error) => toast.onError(error),
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
      tokenMint: string;
      delegatee: string;
      nonce: number | bigint;
      amountPerPeriod: number | bigint;
      periodLengthS: number | bigint;
      expiryTs: number | bigint;
      startTs?: number | bigint;
    }) => {
      if (!signer) throw new Error("Wallet not connected");
      if (!progId) throw new Error("Program address not configured");

      const instruction = await getCreateRecurringDelegationOverlayInstructionAsync({
        delegator: signer,
        tokenMint: address(tokenMint),
        delegatee: address(delegatee),
        nonce,
        amountPerPeriod,
        periodLengthS,
        startTs: startTs ?? await getBlockTimestamp(rpcUrl),
        expiryTs,
        programAddress: progId,
      });

      const signature = await signAndSend([instruction], signer);
      return { signature };
    },
    onSuccess: (res) => {
      toast.onSuccess(res.signature);
      queryClient.invalidateQueries({ queryKey: ["delegations"] });
    },
    onError: (error) => toast.onError(error),
  });

  const revokeDelegation = useMutation({
    mutationFn: async ({
      delegationAccount,
      payer,
    }: {
      delegationAccount: string;
      payer: string;
    }) => {
      if (!signer) throw new Error("Wallet not connected");

      const receiver = payer !== signer.address ? address(payer) : undefined;

      const instruction = getRevokeDelegationOverlayInstruction({
        authority: signer,
        delegationAccount: address(delegationAccount),
        receiver,
        programAddress: progId,
      });

      const signature = await signAndSend([instruction], signer);
      return { signature };
    },
    onSuccess: (res) => {
      toast.onSuccess(res.signature);
      queryClient.invalidateQueries({ queryKey: ["delegations"] });
    },
    onError: (error) => toast.onError(error),
  });

  type TransferParams = {
    tokenMint: string;
    delegationAccount: string;
    delegator: string;
    amount: bigint;
    receiverAta?: string;
  };

  const buildTransferIxs = async (
    params: TransferParams,
    kind: "fixed" | "recurring",
  ) => {
    if (!signer) throw new Error("Wallet not connected");
    if (!progId) throw new Error("Program address not configured");

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
      payer: signer,
      ata: receiver,
      owner: signer.address,
      mint,
      tokenProgram: TOKEN_2022_PROGRAM_ADDRESS,
    });

    const buildFn =
      kind === "fixed"
        ? getTransferFixedOverlayInstructionAsync
        : getTransferRecurringOverlayInstructionAsync;
    const transferIx = await buildFn({
      delegatee: signer,
      delegator: delegatorAddr,
      delegatorAta,
      tokenMint: mint,
      delegationPda: address(params.delegationAccount),
      amount: params.amount,
      receiverAta: receiver,
      tokenProgram: TOKEN_2022_PROGRAM_ADDRESS,
      programAddress: progId,
    });

    return { instructions: [createAtaIx, transferIx], signer };
  };

  const transferFixed = useMutation({
    mutationFn: async (params: TransferParams) => {
      const { instructions, signer: txSigner } =
        await buildTransferIxs(params, "fixed");
      const signature = await signAndSend(instructions, txSigner);
      return { signature };
    },
    onSuccess: (res) => {
      toast.onSuccess(res.signature);
      queryClient.invalidateQueries({ queryKey: ["delegations"] });
      invalidateWithDelay(queryClient, [["get-token-accounts"]]);
    },
    onError: (error) => toast.onError(error),
  });

  const transferRecurring = useMutation({
    mutationFn: async (params: TransferParams) => {
      const { instructions, signer: txSigner } =
        await buildTransferIxs(params, "recurring");
      const signature = await signAndSend(instructions, txSigner);
      return { signature };
    },
    onSuccess: (res) => {
      toast.onSuccess(res.signature);
      queryClient.invalidateQueries({ queryKey: ["delegations"] });
      invalidateWithDelay(queryClient, [["get-token-accounts"]]);
    },
    onError: (error) => toast.onError(error),
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
      planId: bigint;
      mint: string;
      amount: bigint;
      periodHours: number;
      endTs: number;
      destinations: string[];
      pullers: string[];
      metadataUri: string;
    }) => {
      if (!signer) throw new Error("Wallet not connected");
      if (!progId) throw new Error("Program address not configured");

      const instruction = await getCreatePlanOverlayInstructionAsync({
        owner: signer,
        planId,
        mint: address(mint),
        amount,
        periodHours: BigInt(periodHours),
        endTs: BigInt(endTs),
        destinations: destinations.map((d) => address(d)),
        pullers: pullers.map((p) => address(p)),
        metadataUri,
        tokenProgram: TOKEN_2022_PROGRAM_ADDRESS,
        programAddress: progId,
      });

      const signature = await signAndSend([instruction], signer);
      return { signature };
    },
    onSuccess: (res) => {
      toast.onSuccess(res.signature);
      queryClient.invalidateQueries({ queryKey: ["plans"] });
    },
    onError: (error) => toast.onError(error),
  });

  const updatePlan = useMutation({
    mutationFn: async ({
      planPda,
      status,
      endTs,
      metadataUri,
      pullers = [],
    }: {
      planPda: string;
      status: PlanStatus;
      endTs: number;
      metadataUri: string;
      pullers?: string[];
    }) => {
      if (!signer) throw new Error("Wallet not connected");

      const instruction = getUpdatePlanOverlayInstruction({
        owner: signer,
        planPda: address(planPda),
        status,
        endTs: BigInt(endTs),
        metadataUri,
        pullers: pullers.map((p) => address(p)),
        programAddress: progId,
      });

      const signature = await signAndSend([instruction], signer);
      return { signature };
    },
    onSuccess: (res) => {
      toast.onSuccess(res.signature);
      queryClient.invalidateQueries({ queryKey: ["plans"] });
    },
    onError: (error) => toast.onError(error),
  });

  const deletePlan = useMutation({
    mutationFn: async ({ planPda }: { planPda: string }) => {
      if (!signer) throw new Error("Wallet not connected");

      const instruction = getDeletePlanOverlayInstruction({
        owner: signer,
        planPda: address(planPda),
        programAddress: progId,
      });

      const signature = await signAndSend([instruction], signer);
      return { signature };
    },
    onSuccess: (res) => {
      toast.onSuccess(res.signature);
      queryClient.invalidateQueries({ queryKey: ["plans"] });
    },
    onError: (error) => toast.onError(error),
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
      merchant: string;
      planId: bigint;
      tokenMint: string;
      expectedAmount: bigint;
      expectedPeriodHours: bigint;
      expectedCreatedAt: bigint;
    }) => {
      if (!signer) throw new Error("Wallet not connected");
      if (!progId) throw new Error("Program address not configured");

      const instruction = await getSubscribeOverlayInstructionAsync({
        subscriber: signer,
        merchant: address(merchant),
        planId,
        tokenMint: address(tokenMint),
        expectedAmount,
        expectedPeriodHours,
        expectedCreatedAt,
        programAddress: progId,
      });

      const signature = await signAndSend([instruction], signer);
      return { signature };
    },
    onSuccess: (res) => {
      toast.onSuccess(res.signature);
      queryClient.invalidateQueries({ queryKey: ["subscriptions"] });
    },
    onError: (error) => toast.onError(error),
  });

  const cancelSubscription = useMutation({
    mutationFn: async ({
      planPda,
      subscriptionPda,
    }: {
      planPda: string;
      subscriptionPda: string;
    }) => {
      if (!signer) throw new Error("Wallet not connected");
      if (!progId) throw new Error("Program address not configured");

      const instruction = await getCancelSubscriptionOverlayInstructionAsync({
        subscriber: signer,
        planPda: address(planPda),
        subscriptionPda: address(subscriptionPda),
        programAddress: progId,
      });

      const signature = await signAndSend([instruction], signer);
      return { signature };
    },
    onSuccess: (res) => {
      toast.onSuccess(res.signature);
      queryClient.invalidateQueries({ queryKey: ["subscriptions"] });
    },
    onError: (error) => toast.onError(error),
  });

  const revokeSubscription = useMutation({
    mutationFn: async ({
      subscriptionPda,
      planPda,
      payer,
    }: {
      subscriptionPda: string;
      planPda: string;
      payer: string;
    }) => {
      if (!signer) throw new Error("Wallet not connected");

      const receiver = payer !== signer.address ? address(payer) : undefined;

      const instruction = getRevokeSubscriptionOverlayInstruction({
        authority: signer,
        subscriptionPda: address(subscriptionPda),
        planPda: address(planPda),
        receiver,
        programAddress: progId,
      });

      const signature = await signAndSend([instruction], signer);
      return { signature };
    },
    onSuccess: (res) => {
      toast.onSuccess(res.signature);
      queryClient.invalidateQueries({ queryKey: ["subscriptions"] });
    },
    onError: (error) => toast.onError(error),
  });

  const cancelAndRevokeSubscription = useMutation({
    mutationFn: async ({
      planPda,
      subscriptionPda,
      payer,
    }: {
      planPda: string;
      subscriptionPda: string;
      payer: string;
    }) => {
      if (!signer) throw new Error("Wallet not connected");
      if (!progId) throw new Error("Program address not configured");

      const receiver = payer !== signer.address ? address(payer) : undefined;

      const cancelIx = await getCancelSubscriptionOverlayInstructionAsync({
        subscriber: signer,
        planPda: address(planPda),
        subscriptionPda: address(subscriptionPda),
        programAddress: progId,
      });

      const revokeIx = getRevokeSubscriptionOverlayInstruction({
        authority: signer,
        subscriptionPda: address(subscriptionPda),
        planPda: address(planPda),
        receiver,
        programAddress: progId,
      });

      const signature = await signAndSend([cancelIx, revokeIx], signer);
      return { signature };
    },
    onSuccess: (res) => {
      toast.onSuccess(res.signature);
      queryClient.invalidateQueries({ queryKey: ["subscriptions"] });
    },
    onError: (error) => toast.onError(error),
  });

  const collectSubscriptionPayments = useMutation({
    mutationFn: async ({
      planAddress,
      subscribers,
      mint,
      destinations,
    }: {
      planAddress: string;
      subscribers: Array<{ subscriptionAddress: string; delegator: string; amount: bigint }>;
      mint: string;
      destinations: string[];
    }) => {
      if (!signer) throw new Error("Wallet not connected");
      if (!progId) throw new Error("Program address not configured");

      const mintAddr = address(mint);
      const planPda = address(planAddress);
      const rpc = createSolanaRpc(rpcUrl);

      const firstDest = destinations.find((d) => d !== ZERO_ADDRESS);
      const receiverOwner = firstDest ? address(firstDest) : signer.address;
      const [receiverAta] = await findAssociatedTokenPda({
        mint: mintAddr,
        owner: receiverOwner,
        tokenProgram: TOKEN_2022_PROGRAM_ADDRESS,
      });

      const createAtaIx = getCreateAssociatedTokenIdempotentInstruction({
        payer: signer,
        ata: receiverAta,
        owner: receiverOwner,
        mint: mintAddr,
        tokenProgram: TOKEN_2022_PROGRAM_ADDRESS,
      });

      const { payable, failures: preflightFailures } = await filterPayableSubscribers({
        rpc,
        subscribers,
        mint: mintAddr,
        tokenProgram: TOKEN_2022_PROGRAM_ADDRESS,
        programAddress: progId,
      });

      const transferEntries: SubscriberTransfer[] = await Promise.all(
        payable.map(async (sub) => {
          const instruction = await getTransferSubscriptionOverlayInstructionAsync({
            caller: signer,
            delegator: address(sub.delegator),
            tokenMint: mintAddr,
            subscriptionPda: address(sub.subscriptionAddress),
            planPda,
            amount: sub.amount,
            receiverAta,
            tokenProgram: TOKEN_2022_PROGRAM_ADDRESS,
            programAddress: progId,
          });
          return { subscriber: sub, instruction };
        })
      );

      const signatures: string[] = [];
      const transfers: Array<{ subscriptionAddress: string; amount: bigint; signature: string }> = [];
      const failures: SubscriberPaymentFailure[] = [...preflightFailures];
      let collected = 0;

      if (transferEntries.length > 0) {
        signatures.push(await signAndSend([createAtaIx], signer));
        const result = await sendBatchedSubscriberInstructions({
          transfers: transferEntries,
          feePayer: signer,
          sendInstructions: (instructions) => signAndSend(instructions, signer),
        });
        signatures.push(...result.signatures);
        failures.push(...result.failures);
        collected = result.collected;
        transfers.push(
          ...result.confirmed.map(({ subscriber, signature }) => ({
            subscriptionAddress: subscriber.subscriptionAddress,
            amount: subscriber.amount,
            signature,
          })),
        );
      }

      return {
        signatures,
        collected,
        total: subscribers.length,
        partial: failures.length > 0,
        failures,
        transfers,
      };
    },
    onSuccess: (res) => {
      if (res.signatures[0]) toast.onSuccess(res.signatures[0]);
      if (res.failures.length > 0) {
        sonnerToast.warning(`Skipped ${res.failures.length} unpayable subscriber payment${res.failures.length === 1 ? "" : "s"}`);
        console.warn(`Skipped ${res.failures.length} unpayable subscriber payments`, res.failures);
      }
      invalidateWithDelay(queryClient, [
        ["subscriberCounts"],
        ["get-token-accounts"],
      ]);
    },
    onError: (error) => toast.onError(error),
  });

  const collectAllPlanPayments = useMutation({
    mutationFn: async ({
      plans,
    }: {
      plans: Array<{
        planAddress: string;
        subscribers: Array<{ subscriptionAddress: string; delegator: string; amount: bigint }>;
        mint: string;
        destinations: string[];
      }>;
    }) => {
      if (!signer) throw new Error("Wallet not connected");
      if (!progId) throw new Error("Program address not configured");

      type PlanTransferSubscriber = CollectableSubscriber & { planAddress: string };

      const rpc = createSolanaRpc(rpcUrl);
      const ataIxs: Instruction[] = [];
      const transferEntries: SubscriberTransfer<PlanTransferSubscriber>[] = [];
      const seenAtas = new Set<string>();
      const preflightFailures: SubscriberPaymentFailure<PlanTransferSubscriber>[] = [];
      const planTotals = plans.map((plan) => ({
        planAddress: plan.planAddress,
        total: plan.subscribers.length,
      }));

      for (const plan of plans) {
        const mintAddr = address(plan.mint);
        const planPda = address(plan.planAddress);
        const subscribersWithPlan = plan.subscribers.map((sub) => ({
          ...sub,
          planAddress: plan.planAddress,
        }));
        const { payable, failures } = await filterPayableSubscribers({
          rpc,
          subscribers: subscribersWithPlan,
          mint: mintAddr,
          tokenProgram: TOKEN_2022_PROGRAM_ADDRESS,
          programAddress: progId,
        });
        preflightFailures.push(...failures);
        if (payable.length === 0) continue;

        const firstDest = plan.destinations.find((d) => d !== ZERO_ADDRESS);
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
              payer: signer,
              ata: receiverAta,
              owner: receiverOwner,
              mint: mintAddr,
              tokenProgram: TOKEN_2022_PROGRAM_ADDRESS,
            }),
          );
        }

        for (const sub of payable) {
          const instruction = await getTransferSubscriptionOverlayInstructionAsync({
            caller: signer,
            delegator: address(sub.delegator),
            tokenMint: mintAddr,
            subscriptionPda: address(sub.subscriptionAddress),
            planPda,
            amount: sub.amount,
            receiverAta,
            tokenProgram: TOKEN_2022_PROGRAM_ADDRESS,
            programAddress: progId,
          });
          transferEntries.push({ subscriber: sub, instruction });
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
          transfers: transferEntries,
          feePayer: signer,
          sendInstructions: (instructions) => signAndSend(instructions, signer),
        });
        signatures.push(...result.signatures);
        failures.push(...result.failures);
        confirmedTransfers.push(
          ...result.confirmed.map(({ subscriber, signature }) => ({
            planAddress: subscriber.planAddress,
            subscriptionAddress: subscriber.subscriptionAddress,
            delegator: subscriber.delegator,
            amount: subscriber.amount,
            batchIndex: signatures.indexOf(signature),
            signature,
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
    onSuccess: (res) => {
      if (res.signatures[0]) toast.onSuccess(res.signatures[0]);
      if (res.failures.length > 0) {
        sonnerToast.warning(`Skipped ${res.failures.length} unpayable subscriber payment${res.failures.length === 1 ? "" : "s"}`);
        console.warn(`Skipped ${res.failures.length} unpayable subscriber payments`, res.failures);
      }
      invalidateWithDelay(queryClient, [
        ["subscriberCounts"],
        ["get-token-accounts"],
      ]);
    },
    onError: (error) => toast.onError(error),
  });

  const revokeMultipleDelegations = useMutation({
    mutationFn: async ({
      delegations,
    }: {
      delegations: Array<{ address: string; payer: string }>;
    }) => {
      if (!signer) throw new Error("Wallet not connected");
      if (!progId) throw new Error("Program address not configured");

      const revokeIxs = delegations.map(({ address: account, payer }) => {
        const receiver = payer !== signer.address ? address(payer) : undefined;
        return getRevokeDelegationOverlayInstruction({
          authority: signer,
          delegationAccount: address(account),
          receiver,
          programAddress: progId,
        });
      });

      const batches = packInstructionBatches(revokeIxs, signer);
      const signatures: string[] = [];

      for (const batch of batches) {
        signatures.push(await signAndSend(batch, signer));
      }

      return { signatures, revoked: delegations.length };
    },
    onSuccess: (res) => {
      toast.onSuccess(res.signatures[0]);
      invalidateWithDelay(queryClient, [
        ["delegations"],
        ["subscriptionAuthorityStatus"],
        ["get-token-accounts"],
      ]);
    },
    onError: (error) => toast.onError(error),
  });

  return {
    initSubscriptionAuthority,
    closeSubscriptionAuthority,
    createFixedDelegation,
    createRecurringDelegation,
    revokeDelegation,
    transferFixed,
    transferRecurring,
    createPlan,
    updatePlan,
    deletePlan,
    subscribe,
    cancelSubscription,
    revokeSubscription,
    cancelAndRevokeSubscription,
    collectSubscriptionPayments,
    collectAllPlanPayments,
    revokeMultipleDelegations,
  };
}
