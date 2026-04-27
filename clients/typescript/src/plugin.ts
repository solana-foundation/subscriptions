/**
 * `subscriptionsProgram()` — `@solana/kit` plugin that wraps the Codama-generated
 * `subscriptionsProgram()` plugin with higher-level instruction overlays
 * (PDA derivation, sponsor `payer` trailing accounts, ATA derivation, validators)
 * and a `queries` namespace for common account fetches.
 *
 * Each overlay defaults its actor field (`owner` / `delegator` / `subscriber`
 * / `authority` / `delegatee` / `caller`) to `client.identity`, and any
 * `payer` slot to `client.payer`. Sponsor flows install separate signers via
 * `payer()` + `identity()` instead of `signer()`.
 *
 * @example Same signer for everything
 * ```ts
 * import { createClient } from '@solana/kit';
 * import { signer } from '@solana/kit-plugin-signer';
 * import { solanaLocalRpc } from '@solana/kit-plugin-rpc';
 * import { subscriptionsProgram } from '@subscriptions/client';
 *
 * const client = createClient()
 *   .use(signer(mySigner))
 *   .use(solanaLocalRpc())
 *   .use(subscriptionsProgram());
 *
 * await client.subscriptions.instructions
 *   .createPlan({ planId, mint, amount, periodHours, endTs, destinations, pullers, metadataUri })
 *   .sendTransaction();
 * ```
 *
 * @example Sponsor pays fees + rent on behalf of the user
 * ```ts
 * import { payer, identity } from '@solana/kit-plugin-signer';
 *
 * const client = createClient()
 *   .use(payer(sponsorSigner))    // pays gas + rent
 *   .use(identity(userSigner))    // signs as delegator
 *   .use(solanaLocalRpc())
 *   .use(subscriptionsProgram());
 *
 * await client.subscriptions.instructions
 *   .createFixedDelegation({ delegatee, nonce, amount, expiryTs, tokenMint })
 *   .sendTransaction();
 * ```
 */

import {
  AccountRole,
  type Address,
  type ClientWithIdentity,
  type ClientWithPayer,
  type ClientWithRpc,
  type GetProgramAccountsApi,
  type Instruction,
  pipe,
  type TransactionSigner,
} from '@solana/kit';
import {
  addSelfPlanAndSendFunctions,
  type SelfPlanAndSendFunctions,
} from '@solana/program-client-core';
import { findAssociatedTokenPda } from '@solana-program/token';
import {
  fetchDelegationsByDelegatee,
  fetchDelegationsByDelegator,
} from './accounts/delegations.js';
import { fetchPlansForOwner } from './accounts/plans.js';
import {
  fetchMaybeSubscriptionAuthority,
  fetchPlan,
  findFixedDelegationPda,
  findPlanPda,
  findRecurringDelegationPda,
  findSubscriptionAuthorityPda,
  type SubscriptionsPlugin as GeneratedSubscriptionsPlugin,
  type SubscriptionsPluginRequirements as GeneratedSubscriptionsPluginRequirements,
  subscriptionsProgram as generatedSubscriptionsProgram,
  getCancelSubscriptionInstructionAsync,
  getCloseSubscriptionAuthorityInstruction,
  getCreateFixedDelegationInstruction,
  getCreatePlanInstruction,
  getCreateRecurringDelegationInstruction,
  getDeletePlanInstruction,
  getInitSubscriptionAuthorityInstructionAsync,
  getRevokeDelegationInstruction,
  getSubscribeInstructionAsync,
  getTransferFixedInstruction,
  getTransferRecurringInstruction,
  getTransferSubscriptionInstruction,
  getUpdatePlanInstruction,
  type PlanStatus,
} from './generated/index.js';
import type { Delegation } from './types/delegation.js';
import type { PlanWithAddress } from './types/plan.js';
import {
  assertMetadataUri,
  assertPositive,
  padPlanDestinations,
  padPlanPullers,
} from './validators.js';

type WithProgramAddress = { programAddress?: Address };

/** Mark `K` keys of `T` as optional (used to relax overlay inputs that the
 * plugin can fill from `client.identity` / `client.payer`). */
type MakeOptional<T, K extends keyof T> = Omit<T, K> & { [P in K]?: T[P] };

function pdaConfig(programAddress?: Address) {
  return programAddress ? { programAddress } : {};
}

function withTrailing<I extends Instruction>(
  instruction: I,
  trailing: Array<{
    address: Address;
    role: number;
    signer?: TransactionSigner;
  }>,
): I {
  if (trailing.length === 0) return instruction;
  const accounts = [
    ...((instruction as Instruction & { accounts?: readonly unknown[] })
      .accounts ?? []),
    ...trailing,
  ];
  return { ...instruction, accounts } as I;
}

function appendPayer<I extends Instruction>(
  instruction: I,
  payer: TransactionSigner | undefined,
): I {
  if (!payer) return instruction;
  return withTrailing(instruction, [
    {
      address: payer.address,
      role: AccountRole.WRITABLE_SIGNER,
      signer: payer,
    },
  ]);
}

// ============================================================================
// Instruction overlay inputs
// ============================================================================

export type InitSubscriptionAuthorityInput = {
  owner: TransactionSigner;
  tokenMint: Address;
  userAta: Address;
  tokenProgram: Address;
  payer?: TransactionSigner;
} & WithProgramAddress;

export type CloseSubscriptionAuthorityInput = {
  user: TransactionSigner;
  tokenMint: Address;
  receiver?: Address;
} & WithProgramAddress;

export type CreateFixedDelegationInput = {
  delegator: TransactionSigner;
  tokenMint: Address;
  delegatee: Address;
  nonce: number | bigint;
  amount: number | bigint;
  expiryTs: number | bigint;
  payer?: TransactionSigner;
} & WithProgramAddress;

export type CreateRecurringDelegationInput = {
  delegator: TransactionSigner;
  tokenMint: Address;
  delegatee: Address;
  nonce: number | bigint;
  amountPerPeriod: number | bigint;
  periodLengthS: number | bigint;
  startTs: number | bigint;
  expiryTs: number | bigint;
  payer?: TransactionSigner;
} & WithProgramAddress;

export type RevokeDelegationInput = {
  authority: TransactionSigner;
  delegationAccount: Address;
  receiver?: Address;
} & WithProgramAddress;

export type RevokeSubscriptionInput = {
  authority: TransactionSigner;
  subscriptionPda: Address;
  planPda: Address;
  receiver?: Address;
} & WithProgramAddress;

export type TransferDelegationInput = {
  delegatee: TransactionSigner;
  delegator: Address;
  delegatorAta: Address;
  tokenMint: Address;
  delegationPda: Address;
  amount: number | bigint;
  receiverAta: Address;
  tokenProgram: Address;
} & WithProgramAddress;

export type TransferSubscriptionInput = {
  caller: TransactionSigner;
  delegator: Address;
  tokenMint: Address;
  subscriptionPda: Address;
  planPda: Address;
  amount: number | bigint;
  receiverAta: Address;
  tokenProgram: Address;
} & WithProgramAddress;

export type CreatePlanInput = {
  owner: TransactionSigner;
  planId: number | bigint;
  mint: Address;
  amount: number | bigint;
  periodHours: number | bigint;
  endTs: number | bigint;
  destinations: Address[];
  pullers: Address[];
  metadataUri: string;
  tokenProgram?: Address;
} & WithProgramAddress;

export type UpdatePlanInput = {
  owner: TransactionSigner;
  planPda: Address;
  status: PlanStatus;
  endTs: number | bigint;
  metadataUri: string;
  pullers?: Address[];
} & WithProgramAddress;

export type DeletePlanInput = {
  owner: TransactionSigner;
  planPda: Address;
} & WithProgramAddress;

export type SubscribeInput = {
  subscriber: TransactionSigner;
  merchant: Address;
  planId: number | bigint;
  tokenMint: Address;
  /**
   * Live plan terms snapshot the subscriber consents to. If omitted, the
   * caller must use the plugin client's `subscribe` (which fetches the live
   * plan via rpc); the standalone overlay cannot fetch on its own.
   */
  expectedAmount?: number | bigint;
  expectedPeriodHours?: number | bigint;
  expectedCreatedAt?: number | bigint;
  payer?: TransactionSigner;
} & WithProgramAddress;

export type CancelSubscriptionInput = {
  subscriber: TransactionSigner;
  planPda: Address;
  subscriptionPda?: Address;
} & WithProgramAddress;

// ============================================================================
// Overlay instruction builders (return Instruction / Promise<Instruction>)
// ============================================================================

export async function getInitSubscriptionAuthorityOverlayInstructionAsync(
  input: InitSubscriptionAuthorityInput,
): Promise<Instruction> {
  return appendPayer(
    await getInitSubscriptionAuthorityInstructionAsync(
      {
        owner: input.owner,
        tokenMint: input.tokenMint,
        userAta: input.userAta,
        tokenProgram: input.tokenProgram,
      },
      pdaConfig(input.programAddress),
    ),
    input.payer,
  );
}

export async function getCloseSubscriptionAuthorityOverlayInstructionAsync(
  input: CloseSubscriptionAuthorityInput,
): Promise<Instruction> {
  const [subscriptionAuthority] = await findSubscriptionAuthorityPda(
    { user: input.user.address, tokenMint: input.tokenMint },
    pdaConfig(input.programAddress),
  );
  let ix: Instruction = getCloseSubscriptionAuthorityInstruction(
    { user: input.user, subscriptionAuthority },
    pdaConfig(input.programAddress),
  );
  if (input.receiver) {
    ix = withTrailing(ix, [
      { address: input.receiver, role: AccountRole.WRITABLE },
    ]);
  }
  return ix;
}

export async function getCreateFixedDelegationOverlayInstructionAsync(
  input: CreateFixedDelegationInput,
): Promise<Instruction> {
  assertPositive(input.amount, 'amount');
  const [subscriptionAuthority] = await findSubscriptionAuthorityPda(
    { user: input.delegator.address, tokenMint: input.tokenMint },
    pdaConfig(input.programAddress),
  );
  const [delegationPda] = await findFixedDelegationPda(
    {
      subscriptionAuthority,
      delegator: input.delegator.address,
      delegatee: input.delegatee,
      nonce: input.nonce,
    },
    pdaConfig(input.programAddress),
  );
  return appendPayer(
    getCreateFixedDelegationInstruction(
      {
        delegator: input.delegator,
        subscriptionAuthority,
        delegationAccount: delegationPda,
        delegatee: input.delegatee,
        fixedDelegation: {
          nonce: input.nonce,
          amount: input.amount,
          expiryTs: input.expiryTs,
        },
      },
      pdaConfig(input.programAddress),
    ),
    input.payer,
  );
}

export async function getCreateRecurringDelegationOverlayInstructionAsync(
  input: CreateRecurringDelegationInput,
): Promise<Instruction> {
  assertPositive(input.amountPerPeriod, 'amountPerPeriod');
  assertPositive(input.periodLengthS, 'periodLengthS');
  const [subscriptionAuthority] = await findSubscriptionAuthorityPda(
    { user: input.delegator.address, tokenMint: input.tokenMint },
    pdaConfig(input.programAddress),
  );
  const [delegationPda] = await findRecurringDelegationPda(
    {
      subscriptionAuthority,
      delegator: input.delegator.address,
      delegatee: input.delegatee,
      nonce: input.nonce,
    },
    pdaConfig(input.programAddress),
  );
  return appendPayer(
    getCreateRecurringDelegationInstruction(
      {
        delegator: input.delegator,
        subscriptionAuthority,
        delegationAccount: delegationPda,
        delegatee: input.delegatee,
        recurringDelegation: {
          nonce: input.nonce,
          amountPerPeriod: input.amountPerPeriod,
          periodLengthS: input.periodLengthS,
          startTs: input.startTs,
          expiryTs: input.expiryTs,
        },
      },
      pdaConfig(input.programAddress),
    ),
    input.payer,
  );
}

/** Revoke a fixed/recurring delegation. For subscription PDAs use {@link getRevokeSubscriptionOverlayInstruction}. */
export function getRevokeDelegationOverlayInstruction(
  input: RevokeDelegationInput,
): Instruction {
  let ix: Instruction = getRevokeDelegationInstruction(
    {
      authority: input.authority,
      delegationAccount: input.delegationAccount,
    },
    pdaConfig(input.programAddress),
  );
  if (input.receiver) {
    ix = withTrailing(ix, [
      { address: input.receiver, role: AccountRole.WRITABLE },
    ]);
  }
  return ix;
}

/**
 * Revoke a subscription PDA. Trailing-account layout: `[planPda, receiver?]`.
 * For fixed/recurring delegations use {@link getRevokeDelegationOverlayInstruction}.
 */
export function getRevokeSubscriptionOverlayInstruction(
  input: RevokeSubscriptionInput,
): Instruction {
  const trailing: { address: Address; role: number }[] = [
    { address: input.planPda, role: AccountRole.READONLY },
  ];
  if (input.receiver) {
    trailing.push({ address: input.receiver, role: AccountRole.WRITABLE });
  }
  return withTrailing(
    getRevokeDelegationInstruction(
      {
        authority: input.authority,
        delegationAccount: input.subscriptionPda,
      },
      pdaConfig(input.programAddress),
    ),
    trailing,
  );
}

async function getTransferDelegationOverlayInstructionAsync(
  input: TransferDelegationInput,
  getInstruction:
    | typeof getTransferFixedInstruction
    | typeof getTransferRecurringInstruction,
): Promise<Instruction> {
  assertPositive(input.amount, 'amount');
  const [subscriptionAuthority] = await findSubscriptionAuthorityPda(
    { user: input.delegator, tokenMint: input.tokenMint },
    pdaConfig(input.programAddress),
  );
  return getInstruction(
    {
      delegationPda: input.delegationPda,
      subscriptionAuthority,
      delegatorAta: input.delegatorAta,
      receiverAta: input.receiverAta,
      tokenProgram: input.tokenProgram,
      delegatee: input.delegatee,
      transferData: {
        amount: input.amount,
        delegator: input.delegator,
        mint: input.tokenMint,
      },
    },
    pdaConfig(input.programAddress),
  );
}

export function getTransferFixedOverlayInstructionAsync(
  input: TransferDelegationInput,
): Promise<Instruction> {
  return getTransferDelegationOverlayInstructionAsync(
    input,
    getTransferFixedInstruction,
  );
}

export function getTransferRecurringOverlayInstructionAsync(
  input: TransferDelegationInput,
): Promise<Instruction> {
  return getTransferDelegationOverlayInstructionAsync(
    input,
    getTransferRecurringInstruction,
  );
}

export async function getTransferSubscriptionOverlayInstructionAsync(
  input: TransferSubscriptionInput,
): Promise<Instruction> {
  assertPositive(input.amount, 'amount');
  const [subscriptionAuthority] = await findSubscriptionAuthorityPda(
    { user: input.delegator, tokenMint: input.tokenMint },
    pdaConfig(input.programAddress),
  );
  const [delegatorAta] = await findAssociatedTokenPda({
    mint: input.tokenMint,
    owner: input.delegator,
    tokenProgram: input.tokenProgram,
  });
  return getTransferSubscriptionInstruction(
    {
      subscriptionPda: input.subscriptionPda,
      planPda: input.planPda,
      subscriptionAuthority,
      delegatorAta,
      receiverAta: input.receiverAta,
      caller: input.caller,
      tokenProgram: input.tokenProgram,
      transferData: {
        amount: input.amount,
        delegator: input.delegator,
        mint: input.tokenMint,
      },
    },
    pdaConfig(input.programAddress),
  );
}

export async function getCreatePlanOverlayInstructionAsync(
  input: CreatePlanInput,
): Promise<Instruction> {
  assertPositive(input.amount, 'amount');
  assertPositive(input.periodHours, 'periodHours');
  assertMetadataUri(input.metadataUri);
  const destinations = padPlanDestinations(input.destinations);
  const pullers = padPlanPullers(input.pullers);

  const [planPda] = await findPlanPda(
    { owner: input.owner.address, planId: input.planId },
    pdaConfig(input.programAddress),
  );

  return getCreatePlanInstruction(
    {
      merchant: input.owner,
      planPda,
      tokenMint: input.mint,
      tokenProgram: input.tokenProgram,
      planData: {
        planId: input.planId,
        mint: input.mint,
        terms: {
          amount: input.amount,
          periodHours: input.periodHours,
          createdAt: 0n,
        },
        endTs: input.endTs,
        destinations,
        pullers,
        metadataUri: input.metadataUri,
      },
    },
    pdaConfig(input.programAddress),
  );
}

export function getUpdatePlanOverlayInstruction(
  input: UpdatePlanInput,
): Instruction {
  assertMetadataUri(input.metadataUri);
  const pullers = padPlanPullers(input.pullers ?? []);
  return getUpdatePlanInstruction(
    {
      owner: input.owner,
      planPda: input.planPda,
      updatePlanData: {
        status: input.status,
        endTs: input.endTs,
        pullers,
        metadataUri: input.metadataUri,
      },
    },
    pdaConfig(input.programAddress),
  );
}

export function getDeletePlanOverlayInstruction(
  input: DeletePlanInput,
): Instruction {
  return getDeletePlanInstruction(
    { owner: input.owner, planPda: input.planPda },
    pdaConfig(input.programAddress),
  );
}

export async function getSubscribeOverlayInstructionAsync(
  input: SubscribeInput,
): Promise<Instruction> {
  if (
    input.expectedAmount === undefined ||
    input.expectedPeriodHours === undefined ||
    input.expectedCreatedAt === undefined
  ) {
    throw new Error(
      'getSubscribeOverlayInstructionAsync requires expectedAmount, expectedPeriodHours, and expectedCreatedAt. Use the plugin client `subscriptions.instructions.subscribe(...)` to auto-fetch from the live plan.',
    );
  }
  const [planPda, planBump] = await findPlanPda(
    { owner: input.merchant, planId: input.planId },
    pdaConfig(input.programAddress),
  );
  const [subscriptionAuthorityPda] = await findSubscriptionAuthorityPda(
    { user: input.subscriber.address, tokenMint: input.tokenMint },
    pdaConfig(input.programAddress),
  );
  return appendPayer(
    await getSubscribeInstructionAsync(
      {
        subscriber: input.subscriber,
        merchant: input.merchant,
        planPda,
        subscriptionAuthorityPda,
        subscribeData: {
          planId: input.planId,
          planBump,
          expectedMint: input.tokenMint,
          expectedAmount: input.expectedAmount,
          expectedPeriodHours: input.expectedPeriodHours,
          expectedCreatedAt: input.expectedCreatedAt,
        },
      },
      pdaConfig(input.programAddress),
    ),
    input.payer,
  );
}

export function getCancelSubscriptionOverlayInstructionAsync(
  input: CancelSubscriptionInput,
): Promise<Instruction> {
  return getCancelSubscriptionInstructionAsync(
    {
      subscriber: input.subscriber,
      planPda: input.planPda,
      subscriptionPda: input.subscriptionPda,
    },
    pdaConfig(input.programAddress),
  );
}

// ============================================================================
// Plugin
// ============================================================================

export type SubscriptionsPluginRequirements =
  GeneratedSubscriptionsPluginRequirements &
    ClientWithIdentity &
    ClientWithPayer &
    ClientWithRpc<GetProgramAccountsApi>;

type Self<T> = T & SelfPlanAndSendFunctions;

export type SubscriptionsPluginInstructions = {
  initSubscriptionAuthority: (
    input: MakeOptional<InitSubscriptionAuthorityInput, 'owner' | 'payer'>,
  ) => Self<Promise<Instruction>>;
  closeSubscriptionAuthority: (
    input: MakeOptional<CloseSubscriptionAuthorityInput, 'user'>,
  ) => Self<Promise<Instruction>>;
  createFixedDelegation: (
    input: MakeOptional<CreateFixedDelegationInput, 'delegator' | 'payer'>,
  ) => Self<Promise<Instruction>>;
  createRecurringDelegation: (
    input: MakeOptional<CreateRecurringDelegationInput, 'delegator' | 'payer'>,
  ) => Self<Promise<Instruction>>;
  revokeDelegation: (
    input: MakeOptional<RevokeDelegationInput, 'authority'>,
  ) => Self<Instruction>;
  revokeSubscription: (
    input: MakeOptional<RevokeSubscriptionInput, 'authority'>,
  ) => Self<Instruction>;
  transferFixed: (
    input: MakeOptional<TransferDelegationInput, 'delegatee'>,
  ) => Self<Promise<Instruction>>;
  transferRecurring: (
    input: MakeOptional<TransferDelegationInput, 'delegatee'>,
  ) => Self<Promise<Instruction>>;
  transferSubscription: (
    input: MakeOptional<TransferSubscriptionInput, 'caller'>,
  ) => Self<Promise<Instruction>>;
  createPlan: (
    input: MakeOptional<CreatePlanInput, 'owner'>,
  ) => Self<Promise<Instruction>>;
  updatePlan: (
    input: MakeOptional<UpdatePlanInput, 'owner'>,
  ) => Self<Instruction>;
  deletePlan: (
    input: MakeOptional<DeletePlanInput, 'owner'>,
  ) => Self<Instruction>;
  subscribe: (
    input: MakeOptional<SubscribeInput, 'subscriber' | 'payer'>,
  ) => Self<Promise<Instruction>>;
  cancelSubscription: (
    input: MakeOptional<CancelSubscriptionInput, 'subscriber'>,
  ) => Self<Promise<Instruction>>;
};

export type SubscriptionsPluginQueries = {
  /** All delegations where `wallet` is the delegator. */
  delegationsByDelegator: (wallet: Address) => Promise<Delegation[]>;
  /** All delegations where `wallet` is the delegatee. */
  delegationsByDelegatee: (wallet: Address) => Promise<Delegation[]>;
  /** Plans owned by `owner`. */
  plansForOwner: (owner: Address) => Promise<PlanWithAddress[]>;
  /** Counts of active delegations grouped by kind. */
  activeDelegationSummary: (wallet: Address) => Promise<{
    fixed: number;
    recurring: number;
    subscriptions: number;
    total: number;
  }>;
  /** Whether the SubscriptionAuthority PDA exists for `(user, tokenMint)`. */
  isSubscriptionAuthorityInitialized: (
    user: Address,
    tokenMint: Address,
    programAddress?: Address,
  ) => Promise<{ initialized: boolean; pda: Address }>;
};

export type SubscriptionsPlugin = Omit<
  GeneratedSubscriptionsPlugin,
  'instructions'
> & {
  instructions: SubscriptionsPluginInstructions;
  queries: SubscriptionsPluginQueries;
};

export function subscriptionsProgram() {
  return <T extends SubscriptionsPluginRequirements>(client: T) => {
    return pipe(client, generatedSubscriptionsProgram(), (c) => {
      const queries: SubscriptionsPluginQueries = {
        delegationsByDelegator: (wallet) =>
          fetchDelegationsByDelegator(c.rpc, wallet),
        delegationsByDelegatee: (wallet) =>
          fetchDelegationsByDelegatee(c.rpc, wallet),
        plansForOwner: (owner) => fetchPlansForOwner(c.rpc, owner),
        activeDelegationSummary: async (wallet) => {
          const delegations = await fetchDelegationsByDelegator(c.rpc, wallet);
          let fixed = 0;
          let recurring = 0;
          let subscriptions = 0;
          for (const d of delegations) {
            if (d.kind === 'fixed') fixed++;
            else if (d.kind === 'recurring') recurring++;
            else if (d.kind === 'subscription') subscriptions++;
          }
          return { fixed, recurring, subscriptions, total: delegations.length };
        },
        isSubscriptionAuthorityInitialized: async (
          user,
          tokenMint,
          programAddress,
        ) => {
          const [pda] = await findSubscriptionAuthorityPda(
            { user, tokenMint },
            pdaConfig(programAddress),
          );
          const account = await fetchMaybeSubscriptionAuthority(c.rpc, pda);
          return { initialized: account.exists, pda };
        },
      };

      const instructions: SubscriptionsPluginInstructions = {
        initSubscriptionAuthority: (input) =>
          addSelfPlanAndSendFunctions(
            client,
            getInitSubscriptionAuthorityOverlayInstructionAsync({
              ...input,
              owner: input.owner ?? client.identity,
              payer:
                input.payer ??
                (client.payer === client.identity ? undefined : client.payer),
            }),
          ),
        closeSubscriptionAuthority: (input) =>
          addSelfPlanAndSendFunctions(
            client,
            getCloseSubscriptionAuthorityOverlayInstructionAsync({
              ...input,
              user: input.user ?? client.identity,
            }),
          ),
        createFixedDelegation: (input) =>
          addSelfPlanAndSendFunctions(
            client,
            getCreateFixedDelegationOverlayInstructionAsync({
              ...input,
              delegator: input.delegator ?? client.identity,
              payer:
                input.payer ??
                (client.payer === client.identity ? undefined : client.payer),
            }),
          ),
        createRecurringDelegation: (input) =>
          addSelfPlanAndSendFunctions(
            client,
            getCreateRecurringDelegationOverlayInstructionAsync({
              ...input,
              delegator: input.delegator ?? client.identity,
              payer:
                input.payer ??
                (client.payer === client.identity ? undefined : client.payer),
            }),
          ),
        revokeDelegation: (input) =>
          addSelfPlanAndSendFunctions(
            client,
            getRevokeDelegationOverlayInstruction({
              ...input,
              authority: input.authority ?? client.identity,
            }),
          ),
        revokeSubscription: (input) =>
          addSelfPlanAndSendFunctions(
            client,
            getRevokeSubscriptionOverlayInstruction({
              ...input,
              authority: input.authority ?? client.identity,
            }),
          ),
        transferFixed: (input) =>
          addSelfPlanAndSendFunctions(
            client,
            getTransferFixedOverlayInstructionAsync({
              ...input,
              delegatee: input.delegatee ?? client.identity,
            }),
          ),
        transferRecurring: (input) =>
          addSelfPlanAndSendFunctions(
            client,
            getTransferRecurringOverlayInstructionAsync({
              ...input,
              delegatee: input.delegatee ?? client.identity,
            }),
          ),
        transferSubscription: (input) =>
          addSelfPlanAndSendFunctions(
            client,
            getTransferSubscriptionOverlayInstructionAsync({
              ...input,
              caller: input.caller ?? client.identity,
            }),
          ),
        createPlan: (input) =>
          addSelfPlanAndSendFunctions(
            client,
            getCreatePlanOverlayInstructionAsync({
              ...input,
              owner: input.owner ?? client.identity,
            }),
          ),
        updatePlan: (input) =>
          addSelfPlanAndSendFunctions(
            client,
            getUpdatePlanOverlayInstruction({
              ...input,
              owner: input.owner ?? client.identity,
            }),
          ),
        deletePlan: (input) =>
          addSelfPlanAndSendFunctions(
            client,
            getDeletePlanOverlayInstruction({
              ...input,
              owner: input.owner ?? client.identity,
            }),
          ),
        subscribe: (input) =>
          addSelfPlanAndSendFunctions(
            client,
            (async () => {
              let { expectedAmount, expectedPeriodHours, expectedCreatedAt } =
                input;
              if (
                expectedAmount === undefined ||
                expectedPeriodHours === undefined ||
                expectedCreatedAt === undefined
              ) {
                const subscriber = input.subscriber ?? client.identity;
                const [planPda] = await findPlanPda(
                  { owner: input.merchant, planId: input.planId },
                  pdaConfig(input.programAddress),
                );
                const plan = await fetchPlan(c.rpc, planPda);
                expectedAmount = expectedAmount ?? plan.data.data.terms.amount;
                expectedPeriodHours =
                  expectedPeriodHours ?? plan.data.data.terms.periodHours;
                expectedCreatedAt =
                  expectedCreatedAt ?? plan.data.data.terms.createdAt;
                return getSubscribeOverlayInstructionAsync({
                  ...input,
                  subscriber,
                  expectedAmount,
                  expectedPeriodHours,
                  expectedCreatedAt,
                  payer:
                    input.payer ??
                    (client.payer === client.identity
                      ? undefined
                      : client.payer),
                });
              }
              return getSubscribeOverlayInstructionAsync({
                ...input,
                subscriber: input.subscriber ?? client.identity,
                expectedAmount,
                expectedPeriodHours,
                expectedCreatedAt,
                payer:
                  input.payer ??
                  (client.payer === client.identity ? undefined : client.payer),
              });
            })(),
          ),
        cancelSubscription: (input) =>
          addSelfPlanAndSendFunctions(
            client,
            getCancelSubscriptionOverlayInstructionAsync({
              ...input,
              subscriber: input.subscriber ?? client.identity,
            }),
          ),
      };

      return {
        ...c,
        subscriptions: <SubscriptionsPlugin>{
          ...c.subscriptions,
          instructions,
          queries,
        },
      };
    });
  };
}
