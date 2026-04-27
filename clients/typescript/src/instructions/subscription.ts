import {
  AccountRole,
  type Address,
  type Instruction,
  type TransactionSigner,
} from 'gill';
import {
  getCancelSubscriptionInstructionAsync,
  getSubscribeInstructionAsync,
} from '../generated/index.js';
import {
  getPlanPDA,
  getSubscriptionAuthorityPDA,
  getSubscriptionPDA,
} from '../pdas.js';

/**
 * Builds a `subscribe` instruction, deriving Plan, SubscriptionAuthority, and Subscription PDAs.
 *
 * @param params.subscriber - The wallet subscribing to the plan.
 * @param params.merchant - The plan owner's address.
 * @param params.planId - Numeric identifier of the plan to subscribe to.
 * @param params.tokenMint - SPL token mint the plan uses.
 * @param params.payer - Optional sponsor that funds the subscription PDA rent.
 *   When provided, the sponsor is recorded as the subscription's `header.payer`
 *   and receives rent on close. Defaults to `subscriber` when omitted.
 * @returns The instruction array and the derived `subscriptionPda`.
 */
export async function buildSubscribe(params: {
  subscriber: TransactionSigner;
  merchant: Address;
  planId: number | bigint;
  tokenMint: Address;
  payer?: TransactionSigner;
  programAddress?: Address;
}): Promise<{ instructions: Instruction[]; subscriptionPda: Address }> {
  const { subscriber, merchant, planId, tokenMint, payer, programAddress } =
    params;
  const config = programAddress ? { programAddress } : undefined;

  const [planPda, planBump] = await getPlanPDA(
    merchant,
    planId,
    programAddress,
  );
  const [subscriptionAuthorityPda] = await getSubscriptionAuthorityPDA(
    subscriber.address,
    tokenMint,
    programAddress,
  );
  const [subscriptionPda] = await getSubscriptionPDA(
    planPda,
    subscriber.address,
    programAddress,
  );

  const instruction = await getSubscribeInstructionAsync(
    {
      subscriber,
      merchant,
      planPda,
      subscriptionPda,
      subscriptionAuthorityPda,
      subscribeData: { planId, planBump },
    },
    config,
  );

  if (payer) {
    const accounts = [
      ...instruction.accounts,
      {
        address: payer.address,
        role: AccountRole.WRITABLE_SIGNER,
        signer: payer,
      },
    ];
    return {
      instructions: [{ ...instruction, accounts }],
      subscriptionPda,
    };
  }

  return { instructions: [instruction], subscriptionPda };
}

/**
 * Builds a `cancelSubscription` instruction that marks a subscription for expiry.
 *
 * @param params.subscriber - The wallet that owns the subscription.
 * @param params.planPda - Address of the associated plan account.
 * @param params.subscriptionPda - Address of the subscription account to cancel.
 * @returns The instruction array.
 */
export async function buildCancelSubscription(params: {
  subscriber: TransactionSigner;
  planPda: Address;
  subscriptionPda: Address;
  programAddress?: Address;
}): Promise<{ instructions: Instruction[] }> {
  const config = params.programAddress
    ? { programAddress: params.programAddress }
    : undefined;
  const instruction = await getCancelSubscriptionInstructionAsync(
    {
      subscriber: params.subscriber,
      planPda: params.planPda,
      subscriptionPda: params.subscriptionPda,
    },
    config,
  );

  return { instructions: [instruction] };
}
