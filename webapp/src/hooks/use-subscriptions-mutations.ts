import { useMutation, useQueryClient } from "@tanstack/react-query";
import { address } from "gill";
import {
  findAssociatedTokenPda,
  TOKEN_2022_PROGRAM_ADDRESS,
  getCreateAssociatedTokenIdempotentInstruction,
} from "gill/programs/token";
import {
  buildInitSubscriptionAuthority,
  buildCloseSubscriptionAuthority,
  buildCreateFixedDelegation,
  buildCreateRecurringDelegation,
  buildRevokeDelegation,
  buildTransferFixed,
  buildTransferRecurring,
  buildTransferSubscription,
  buildCreatePlan,
  buildUpdatePlan,
  buildDeletePlan,
  buildSubscribe,
  buildCancelSubscription,
  ZERO_ADDRESS,
  PlanStatus,
} from "@subscriptions/client";
import { useClusterConfig } from "@/hooks/use-cluster-config";
import { useWalletUiSigner } from "../components/solana/use-wallet-ui-signer";
import { useWalletTransactionSignAndSend } from "../components/solana/use-wallet-transaction-sign-and-send";
import { useTransactionToast } from "../components/use-transaction-toast";
import { invalidateWithDelay } from "@/lib/utils";
import { packInstructionBatches } from "@/lib/tx-packer";
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

      const { instructions } = await buildInitSubscriptionAuthority({
        owner: signer,
        tokenMint: address(tokenMint),
        userAta: address(userAta),
        tokenProgram: address(tokenProgram),
        programAddress: progId,
      });

      const signature = await signAndSend(instructions, signer);
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
    mutationFn: async ({ tokenMint }: { tokenMint: string }) => {
      if (!signer) throw new Error("Wallet not connected");
      if (!progId) throw new Error("Program address not configured");

      const { instructions } = await buildCloseSubscriptionAuthority({
        user: signer,
        tokenMint: address(tokenMint),
        programAddress: progId,
      });

      const signature = await signAndSend(instructions, signer);
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

      const { instructions } = await buildCreateFixedDelegation({
        delegator: signer,
        tokenMint: address(tokenMint),
        delegatee: address(delegatee),
        nonce,
        amount,
        expiryTs,
        programAddress: progId,
      });

      const signature = await signAndSend(instructions, signer);
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

      const { instructions } = await buildCreateRecurringDelegation({
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

      const signature = await signAndSend(instructions, signer);
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
    }: {
      delegationAccount: string;
    }) => {
      if (!signer) throw new Error("Wallet not connected");

      const { instructions } = buildRevokeDelegation({
        authority: signer,
        delegationAccount: address(delegationAccount),
        programAddress: progId,
      });

      const signature = await signAndSend(instructions, signer);
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

    const buildFn = kind === "fixed" ? buildTransferFixed : buildTransferRecurring;
    const { instructions: transferIxs } = await buildFn({
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

    return { instructions: [createAtaIx, ...transferIxs], signer };
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

      const { instructions } = await buildCreatePlan({
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

      const signature = await signAndSend(instructions, signer);
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

      const { instructions } = buildUpdatePlan({
        owner: signer,
        planPda: address(planPda),
        status,
        endTs: BigInt(endTs),
        metadataUri,
        pullers: pullers.map((p) => address(p)),
        programAddress: progId,
      });

      const signature = await signAndSend(instructions, signer);
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

      const { instructions } = buildDeletePlan({
        owner: signer,
        planPda: address(planPda),
        programAddress: progId,
      });

      const signature = await signAndSend(instructions, signer);
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

      const { instructions } = await buildSubscribe({
        subscriber: signer,
        merchant: address(merchant),
        planId,
        tokenMint: address(tokenMint),
        expectedAmount,
        expectedPeriodHours,
        expectedCreatedAt,
        programAddress: progId,
      });

      const signature = await signAndSend(instructions, signer);
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

      const { instructions } = await buildCancelSubscription({
        subscriber: signer,
        planPda: address(planPda),
        subscriptionPda: address(subscriptionPda),
        programAddress: progId,
      });

      const signature = await signAndSend(instructions, signer);
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
    }: {
      subscriptionPda: string;
    }) => {
      if (!signer) throw new Error("Wallet not connected");

      const { instructions } = buildRevokeDelegation({
        authority: signer,
        delegationAccount: address(subscriptionPda),
        programAddress: progId,
      });

      const signature = await signAndSend(instructions, signer);
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
    }: {
      planPda: string;
      subscriptionPda: string;
    }) => {
      if (!signer) throw new Error("Wallet not connected");
      if (!progId) throw new Error("Program address not configured");

      const { instructions: cancelIxs } = await buildCancelSubscription({
        subscriber: signer,
        planPda: address(planPda),
        subscriptionPda: address(subscriptionPda),
        programAddress: progId,
      });

      const { instructions: revokeIxs } = buildRevokeDelegation({
        authority: signer,
        delegationAccount: address(subscriptionPda),
        programAddress: progId,
      });

      const signature = await signAndSend([...cancelIxs, ...revokeIxs], signer);
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

      const transferIxs = await Promise.all(
        subscribers.map(async (sub) => {
          const { instructions } = await buildTransferSubscription({
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
          return instructions[0];
        })
      );

      const signatures: string[] = [];
      let collected = 0;
      const batches = packInstructionBatches(transferIxs, signer, [createAtaIx]);

      for (let b = 0; b < batches.length; b++) {
        try {
          signatures.push(await signAndSend(batches[b], signer));
          collected += batches[b].length - (b === 0 ? 1 : 0);
        } catch (err) {
          if (collected === 0) throw err;
          console.warn(
            `Batch failed after collecting ${collected}/${subscribers.length}:`,
            err instanceof Error ? err.message : err,
          );
          return { signatures, collected, partial: true };
        }
      }

      return { signatures, collected, partial: false };
    },
    onSuccess: (res) => {
      toast.onSuccess(res.signatures[0]);
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

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const ataIxs: any[] = [];
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const transferIxs: any[] = [];
      const seenAtas = new Set<string>();

      for (const plan of plans) {
        const mintAddr = address(plan.mint);
        const planPda = address(plan.planAddress);
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

        for (const sub of plan.subscribers) {
          const { instructions } = await buildTransferSubscription({
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
          transferIxs.push(instructions[0]);
        }
      }

      const signatures: string[] = [];
      let collected = 0;
      const batches = packInstructionBatches(transferIxs, signer, ataIxs);

      for (let b = 0; b < batches.length; b++) {
        try {
          signatures.push(await signAndSend(batches[b], signer));
          collected += batches[b].length - (b === 0 ? ataIxs.length : 0);
        } catch (err) {
          if (collected === 0) throw err;
          console.warn(
            `Batch failed after collecting ${collected}/${transferIxs.length}:`,
            err instanceof Error ? err.message : err,
          );
          return { signatures, collected, total: transferIxs.length, partial: true };
        }
      }

      return { signatures, collected, total: transferIxs.length, partial: false };
    },
    onSuccess: (res) => {
      toast.onSuccess(res.signatures[0]);
      invalidateWithDelay(queryClient, [
        ["subscriberCounts"],
        ["get-token-accounts"],
      ]);
    },
    onError: (error) => toast.onError(error),
  });

  const revokeMultipleDelegations = useMutation({
    mutationFn: async ({ delegationAccounts, tokenMint }: { delegationAccounts: string[]; tokenMint: string }) => {
      if (!signer) throw new Error("Wallet not connected");
      if (!progId) throw new Error("Program address not configured");

      const revokeIxs = delegationAccounts.map((account) => {
        const { instructions } = buildRevokeDelegation({
          authority: signer,
          delegationAccount: address(account),
          programAddress: progId,
        });
        return instructions[0];
      });

      const { instructions: closeIxs } = await buildCloseSubscriptionAuthority({
        user: signer,
        tokenMint: address(tokenMint),
        programAddress: progId,
      });

      const allIxs = [...revokeIxs, ...closeIxs];
      const batches = packInstructionBatches(allIxs, signer);
      const signatures: string[] = [];

      for (const batch of batches) {
        signatures.push(await signAndSend(batch, signer));
      }

      return { signatures, revoked: delegationAccounts.length };
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
