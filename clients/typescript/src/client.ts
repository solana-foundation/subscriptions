import type { Address, Instruction, TransactionSigner } from 'gill';
import { createTransaction, signTransactionMessageWithSigners } from 'gill';
import {
  fetchDelegationsByDelegatee,
  fetchDelegationsByDelegator,
} from './accounts/delegations.js';
import { fetchPlansForOwner } from './accounts/plans.js';
import type { PlanStatus } from './generated/index.js';
import { fetchMaybeSubscriptionAuthority } from './generated/index.js';
import {
  buildCloseSubscriptionAuthority,
  buildCreateFixedDelegation,
  buildCreateRecurringDelegation,
  buildInitSubscriptionAuthority,
  buildRevokeDelegation,
  buildRevokeSubscription,
} from './instructions/delegation.js';
import {
  buildCreatePlan,
  buildDeletePlan,
  buildUpdatePlan,
} from './instructions/plan.js';
import {
  buildCancelSubscription,
  buildSubscribe,
} from './instructions/subscription.js';
import {
  buildTransferFixed,
  buildTransferRecurring,
  buildTransferSubscription,
} from './instructions/transfer.js';
import { getSubscriptionAuthorityPDA } from './pdas.js';
import type { SolanaClient, TransactionResult } from './types/common.js';
import type { Delegation } from './types/delegation.js';
import type { PlanWithAddress } from './types/plan.js';

/**
 * High-level client that composes instruction builders and transaction sending.
 * For lower-level control, use the build* instruction builders and fetch* account fetchers directly.
 */
export class SubscriptionsClient {
  private readonly client: SolanaClient;
  constructor(client: SolanaClient) {
    this.client = client;
  }

  private async buildAndSendTransaction(
    instructions: Instruction[],
    feePayer: TransactionSigner,
  ): Promise<string> {
    const { value: latestBlockhash } = await this.client.rpc
      .getLatestBlockhash()
      .send();

    const transactionMessage = createTransaction({
      instructions,
      feePayer,
      latestBlockhash,
    });
    const signedTransaction =
      await signTransactionMessageWithSigners(transactionMessage);
    return this.client.sendAndConfirmTransaction(signedTransaction);
  }

  /** Initialize a SubscriptionAuthority PDA for the owner's token account.
   *
   * When `payer` is supplied, the sponsor funds rent and is also used as the
   * transaction fee payer so the owner spends zero SOL.
   */
  async initSubscriptionAuthority(params: {
    owner: TransactionSigner;
    tokenMint: Address;
    userAta: Address;
    tokenProgram: Address;
    payer?: TransactionSigner;
  }): Promise<TransactionResult> {
    const { instructions } = await buildInitSubscriptionAuthority(params);
    const signature = await this.buildAndSendTransaction(
      instructions,
      params.payer ?? params.owner,
    );
    return { signature };
  }

  /**
   * Close a SubscriptionAuthority PDA, returning rent to the recorded payer.
   *
   * When the SubscriptionAuthority was sponsor-funded (stored `payer` differs from
   * `user`), pass `receiver` set to the sponsor's address so the program can
   * route rent back to them. Caller is responsible for fetching the on-chain
   * SubscriptionAuthority to determine whether `receiver` is required.
   *
   * Closing invalidates all existing delegations on re-initialization
   * (init_id mismatch). This can serve as an emergency kill switch to
   * immediately cut off all delegatees in a single transaction.
   */
  async closeSubscriptionAuthority(params: {
    user: TransactionSigner;
    tokenMint: Address;
    receiver?: Address;
  }): Promise<TransactionResult> {
    try {
      const delegations = await this.getDelegationsForWallet(
        params.user.address,
      );
      if (delegations.length > 0) {
        console.warn(
          `Warning: ${delegations.length} active delegation(s) found across all mints. ` +
            `Delegations for this mint will become permanently non-transferable if re-initialized.`,
        );
      }
    } catch (e) {
      console.warn('Could not check active delegations before closing:', e);
    }

    const { instructions } = await buildCloseSubscriptionAuthority(params);
    const signature = await this.buildAndSendTransaction(
      instructions,
      params.user,
    );
    return { signature };
  }

  /** Create a fixed (one-time) delegation.
   *
   * When `payer` is supplied, the sponsor funds the delegation PDA rent and
   * the transaction fee.
   */
  async createFixedDelegation(params: {
    delegator: TransactionSigner;
    tokenMint: Address;
    delegatee: Address;
    nonce: number | bigint;
    amount: number | bigint;
    expiryTs: number | bigint;
    payer?: TransactionSigner;
  }): Promise<TransactionResult> {
    const { instructions } = await buildCreateFixedDelegation(params);
    const signature = await this.buildAndSendTransaction(
      instructions,
      params.payer ?? params.delegator,
    );
    return { signature };
  }

  /** Create a recurring delegation with periodic allowance.
   *
   * When `payer` is supplied, the sponsor funds the delegation PDA rent and
   * the transaction fee.
   */
  async createRecurringDelegation(params: {
    delegator: TransactionSigner;
    tokenMint: Address;
    delegatee: Address;
    nonce: number | bigint;
    amountPerPeriod: number | bigint;
    periodLengthS: number | bigint;
    startTs: number | bigint;
    expiryTs: number | bigint;
    payer?: TransactionSigner;
  }): Promise<TransactionResult> {
    const { instructions } = await buildCreateRecurringDelegation(params);
    const signature = await this.buildAndSendTransaction(
      instructions,
      params.payer ?? params.delegator,
    );
    return { signature };
  }

  /** Revoke (close) a fixed or recurring delegation account, returning rent
   * to the original payer. For subscription PDAs, use {@link revokeSubscription}.
   */
  async revokeDelegation(params: {
    authority: TransactionSigner;
    delegationAccount: Address;
    receiver?: Address;
  }): Promise<TransactionResult> {
    const { instructions } = buildRevokeDelegation(params);
    const signature = await this.buildAndSendTransaction(
      instructions,
      params.authority,
    );
    return { signature };
  }

  /** Revoke (close) a subscription PDA, returning rent to the original payer.
   *
   * `planPda` is required so the program can bind the subscription and detect
   * plan-ended / plan-closed conditions for the sponsor path. Pass `receiver`
   * when the recorded payer differs from the authority.
   */
  async revokeSubscription(params: {
    authority: TransactionSigner;
    subscriptionPda: Address;
    planPda: Address;
    receiver?: Address;
  }): Promise<TransactionResult> {
    const { instructions } = buildRevokeSubscription(params);
    const signature = await this.buildAndSendTransaction(
      instructions,
      params.authority,
    );
    return { signature };
  }

  /** Transfer tokens from a fixed delegation. */
  async transferFixed(params: {
    delegatee: TransactionSigner;
    delegator: Address;
    delegatorAta: Address;
    tokenMint: Address;
    delegationPda: Address;
    amount: number | bigint;
    receiverAta: Address;
    tokenProgram: Address;
  }): Promise<TransactionResult> {
    const { instructions } = await buildTransferFixed(params);
    const signature = await this.buildAndSendTransaction(
      instructions,
      params.delegatee,
    );
    return { signature };
  }

  /** Transfer tokens from a recurring delegation. */
  async transferRecurring(params: {
    delegatee: TransactionSigner;
    delegator: Address;
    delegatorAta: Address;
    tokenMint: Address;
    delegationPda: Address;
    amount: number | bigint;
    receiverAta: Address;
    tokenProgram: Address;
  }): Promise<TransactionResult> {
    const { instructions } = await buildTransferRecurring(params);
    const signature = await this.buildAndSendTransaction(
      instructions,
      params.delegatee,
    );
    return { signature };
  }

  /** Transfer tokens from a subscription delegation. */
  async transferSubscription(params: {
    caller: TransactionSigner;
    delegator: Address;
    tokenMint: Address;
    subscriptionPda: Address;
    planPda: Address;
    amount: number | bigint;
    receiverAta: Address;
    tokenProgram: Address;
  }): Promise<TransactionResult> {
    const { instructions } = await buildTransferSubscription(params);
    const signature = await this.buildAndSendTransaction(
      instructions,
      params.caller,
    );
    return { signature };
  }

  /** Check if the SubscriptionAuthority PDA is initialized for a user and token mint. */
  async isSubscriptionAuthorityInitialized(
    user: Address,
    tokenMint: Address,
  ): Promise<{ initialized: boolean; pda: Address }> {
    const [pda] = await getSubscriptionAuthorityPDA(user, tokenMint);
    const account = await fetchMaybeSubscriptionAuthority(this.client.rpc, pda);
    return { initialized: account.exists, pda };
  }

  /** Create a subscription plan. */
  async createPlan(params: {
    owner: TransactionSigner;
    planId: number | bigint;
    mint: Address;
    amount: number | bigint;
    periodHours: number | bigint;
    endTs: number | bigint;
    destinations: Address[];
    pullers: Address[];
    metadataUri: string;
  }): Promise<TransactionResult & { planPda: Address }> {
    const { instructions, planPda } = await buildCreatePlan(params);
    const signature = await this.buildAndSendTransaction(
      instructions,
      params.owner,
    );
    return { signature, planPda };
  }

  /** Update a subscription plan's status, endTs, metadata, or pullers. */
  async updatePlan(params: {
    owner: TransactionSigner;
    planPda: Address;
    status: PlanStatus;
    endTs: number | bigint;
    metadataUri: string;
    pullers?: Address[];
  }): Promise<TransactionResult> {
    const { instructions } = buildUpdatePlan(params);
    const signature = await this.buildAndSendTransaction(
      instructions,
      params.owner,
    );
    return { signature };
  }

  /** Subscribe to a plan.
   *
   * When `payer` is supplied, the sponsor funds the subscription PDA rent and
   * the transaction fee, so the subscriber spends zero SOL. The sponsor is
   * also recorded as the subscription's `header.payer` and receives rent on
   * close.
   */
  async subscribe(params: {
    subscriber: TransactionSigner;
    merchant: Address;
    planId: number | bigint;
    tokenMint: Address;
    payer?: TransactionSigner;
  }): Promise<TransactionResult & { subscriptionPda: Address }> {
    const { instructions, subscriptionPda } = await buildSubscribe(params);
    const signature = await this.buildAndSendTransaction(
      instructions,
      params.payer ?? params.subscriber,
    );
    return { signature, subscriptionPda };
  }

  /** Cancel a subscription. */
  async cancelSubscription(params: {
    subscriber: TransactionSigner;
    planPda: Address;
    subscriptionPda: Address;
  }): Promise<TransactionResult> {
    const { instructions } = await buildCancelSubscription(params);
    const signature = await this.buildAndSendTransaction(
      instructions,
      params.subscriber,
    );
    return { signature };
  }

  /** Delete an expired plan, recovering rent. */
  async deletePlan(params: {
    owner: TransactionSigner;
    planPda: Address;
  }): Promise<TransactionResult> {
    const { instructions } = buildDeletePlan(params);
    const signature = await this.buildAndSendTransaction(
      instructions,
      params.owner,
    );
    return { signature };
  }

  /** Fetch all delegations (fixed, recurring, subscription) where wallet is the delegator. */
  async getDelegationsForWallet(wallet: Address): Promise<Delegation[]> {
    return fetchDelegationsByDelegator(this.client.rpc, wallet);
  }

  /** Fetch all delegations (fixed, recurring, subscription) where wallet is the delegatee. */
  async getDelegationsAsDelegatee(wallet: Address): Promise<Delegation[]> {
    return fetchDelegationsByDelegatee(this.client.rpc, wallet);
  }

  /** Fetch all plans owned by the given address. */
  async getPlansForOwner(owner: Address): Promise<PlanWithAddress[]> {
    return fetchPlansForOwner(this.client.rpc, owner);
  }

  /**
   * Returns a summary of active delegations and subscriptions for a wallet.
   * Useful for checking outstanding commitments before closing a SubscriptionAuthority.
   */
  async getActiveDelegationSummary(wallet: Address): Promise<{
    fixed: number;
    recurring: number;
    subscriptions: number;
    total: number;
  }> {
    const delegations = await fetchDelegationsByDelegator(
      this.client.rpc,
      wallet,
    );

    let fixed = 0;
    let recurring = 0;
    let subscriptions = 0;
    for (const d of delegations) {
      if (d.kind === 'fixed') fixed++;
      else if (d.kind === 'recurring') recurring++;
      else if (d.kind === 'subscription') subscriptions++;
    }

    return {
      fixed,
      recurring,
      subscriptions,
      total: delegations.length,
    };
  }
}
