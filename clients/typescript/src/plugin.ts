/**
 * `subscriptionsProgram()` — `@solana/kit` plugin that wraps the Codama-generated
 * `subscriptionsProgram()` plugin with higher-level instruction overlays
 * (PDA derivation, event-account resolution [`eventAuthority` + `selfProgram`
 * from the active `programAddress`], sponsor `payer` trailing accounts, ATA
 * derivation, validators) and a `queries` namespace for common account fetches.
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
 * import { subscriptionsProgram } from '@solana/subscriptions';
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
import { addSelfPlanAndSendFunctions, type SelfPlanAndSendFunctions } from '@solana/program-client-core';
import { findAssociatedTokenPda } from '@solana-program/token';

import { fetchDelegationsByDelegatee, fetchDelegationsByDelegator } from './accounts/delegations.js';
import { fetchPlansForOwner } from './accounts/plans.js';
import {
    fetchMaybeSubscriptionAuthority,
    fetchPlan,
    findEventAuthorityPda,
    findFixedDelegationPda,
    findPlanPda,
    findRecurringDelegationPda,
    findSubscriptionAuthorityPda,
    findUpToDelegationPda,
    getCancelSubscriptionInstructionAsync,
    getCloseSubscriptionAuthorityInstruction,
    getCreateFixedDelegationInstruction,
    getCreatePlanInstruction,
    getCreateRecurringDelegationInstruction,
    getCreateUpToDelegationInstruction,
    getDeletePlanInstruction,
    getInitSubscriptionAuthorityInstructionAsync,
    getResumeSubscriptionInstructionAsync,
    getRevokeDelegationInstruction,
    getRevokeSubscriptionAuthorityInstruction,
    getSubscribeInstructionAsync,
    getTransferFixedInstruction,
    getTransferRecurringInstruction,
    getTransferSubscriptionInstruction,
    getTransferUpToInstruction,
    getUpdatePlanInstruction,
    type PlanStatus,
    SUBSCRIPTIONS_PROGRAM_ADDRESS,
    type SubscriptionsPlugin as GeneratedSubscriptionsPlugin,
    type SubscriptionsPluginRequirements as GeneratedSubscriptionsPluginRequirements,
    subscriptionsProgram as generatedSubscriptionsProgram,
} from './generated/index.js';
import { resolveTransferHookAccounts, type TransferHookAccount } from './transfer-hook.js';
import type { Delegation } from './types/delegation.js';
import type { PlanWithAddress } from './types/plan.js';
import { assertMetadataUri, assertPositive, assertSafeU64, padPlanDestinations, padPlanPullers } from './validators.js';

type WithProgramAddress = { programAddress?: Address };

/** Mark `K` keys of `T` as optional (used to relax overlay inputs that the
 * plugin can fill from `client.identity` / `client.payer`). */
type MakeOptional<T, K extends keyof T> = Omit<T, K> & { [P in K]?: T[P] };

function pdaConfig(programAddress?: Address) {
    return programAddress ? { programAddress } : {};
}

async function eventAccounts(programAddress?: Address) {
    const [eventAuthority] = await findEventAuthorityPda(pdaConfig(programAddress));
    return { eventAuthority, selfProgram: programAddress ?? SUBSCRIPTIONS_PROGRAM_ADDRESS };
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
        ...((instruction as Instruction & { accounts?: readonly unknown[] }).accounts ?? []),
        ...trailing,
    ];
    return { ...instruction, accounts };
}

function appendPayer<I extends Instruction>(instruction: I, payer: TransactionSigner | undefined): I {
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

export type InitSubscriptionAuthorityInput = WithProgramAddress & {
    owner: TransactionSigner;
    payer?: TransactionSigner;
    tokenMint: Address;
    tokenProgram: Address;
    userAta: Address;
};

export type CloseSubscriptionAuthorityInput = WithProgramAddress & {
    receiver?: Address;
    tokenMint: Address;
    user: TransactionSigner;
};

export type RevokeSubscriptionAuthorityInput = WithProgramAddress & {
    /** Rent recipient for closing the SubscriptionAuthority PDA. Required when the authority's stored payer differs from `user`, and must equal that stored payer. */
    receiver?: Address;
    tokenMint: Address;
    tokenProgram: Address;
    user: TransactionSigner;
};

export type CreateFixedDelegationInput = WithProgramAddress & {
    amount: bigint | number;
    delegatee: Address;
    delegator: TransactionSigner;
    expectedSubscriptionAuthorityInitId?: bigint | number;
    expiryTs: bigint | number;
    nonce: bigint | number;
    payer?: TransactionSigner;
    tokenMint: Address;
};

export type CreateRecurringDelegationInput = WithProgramAddress & {
    amountPerPeriod: bigint | number;
    delegatee: Address;
    delegator: TransactionSigner;
    expectedSubscriptionAuthorityInitId?: bigint | number;
    expiryTs: bigint | number;
    nonce: bigint | number;
    payer?: TransactionSigner;
    periodLengthS: bigint | number;
    /** Unix timestamp when the first period begins. Pass 0 to start when the
     * transaction lands on chain (requires a non-zero `expiryTs`). */
    startTs: bigint | number;
    tokenMint: Address;
};

export type CreateUpToDelegationInput = WithProgramAddress & {
    delegatee: Address;
    delegator: TransactionSigner;
    expectedSubscriptionAuthorityInitId?: bigint | number;
    expiryTs: bigint | number;
    maxAmount: bigint | number;
    nonce: bigint | number;
    payer?: TransactionSigner;
    recipient: Address;
    tokenMint: Address;
};

export type RevokeDelegationInput = WithProgramAddress & {
    authority: TransactionSigner;
    delegationAccount: Address;
    receiver?: Address;
};

export type RevokeSubscriptionInput = WithProgramAddress & {
    authority: TransactionSigner;
    planPda: Address;
    receiver?: Address;
    subscriptionPda: Address;
};

export type TransferDelegationInput = WithProgramAddress & {
    amount: bigint | number;
    delegatee: TransactionSigner;
    delegationPda: Address;
    delegator: Address;
    delegatorAta: Address;
    receiverAta: Address;
    tokenMint: Address;
    tokenProgram: Address;
    /** Token-2022 transfer-hook accounts. Leave unset: the plugin client resolves
     * them from the mint's hook. Set to override resolution, or when calling the
     * overlay instruction directly (which does not auto-resolve). */
    transferHookAccounts?: TransferHookAccount[];
};

export type TransferSubscriptionInput = WithProgramAddress & {
    amount: bigint | number;
    caller: TransactionSigner;
    delegator: Address;
    planPda: Address;
    receiverAta: Address;
    subscriptionPda: Address;
    tokenMint: Address;
    tokenProgram: Address;
    /** Token-2022 transfer-hook accounts. Leave unset: the plugin client resolves
     * them from the mint's hook. Set to override resolution, or when calling the
     * overlay instruction directly (which does not auto-resolve). */
    transferHookAccounts?: TransferHookAccount[];
};

export type CreatePlanInput = WithProgramAddress & {
    amount: bigint | number;
    destinations: Address[];
    endTs: bigint | number;
    metadataUri: string;
    mint: Address;
    owner: TransactionSigner;
    payer?: TransactionSigner;
    periodHours: bigint | number;
    planId: bigint | number;
    pullers: Address[];
    tokenProgram?: Address;
};

export type UpdatePlanInput = WithProgramAddress & {
    endTs: bigint | number;
    metadataUri: string;
    owner: TransactionSigner;
    planPda: Address;
    pullers: Address[];
    status: PlanStatus;
};

export type DeletePlanInput = WithProgramAddress & {
    owner: TransactionSigner;
    planPda: Address;
};

export type SubscribeInput = WithProgramAddress & {
    /**
     * Live plan terms snapshot the subscriber consents to. If omitted, the
     * caller must use the plugin client's `subscribe` (which fetches the live
     * plan via rpc); the standalone overlay cannot fetch on its own.
     */
    expectedAmount?: bigint | number;
    expectedCreatedAt?: bigint | number;
    expectedPeriodHours?: bigint | number;
    expectedSubscriptionAuthorityInitId?: bigint | number;
    merchant: Address;
    payer?: TransactionSigner;
    planId: bigint | number;
    subscriber: TransactionSigner;
    tokenMint: Address;
};

export type CancelSubscriptionInput = WithProgramAddress & {
    planPda: Address;
    subscriber: TransactionSigner;
    subscriptionPda?: Address;
};

export type ResumeSubscriptionInput = WithProgramAddress & {
    planPda: Address;
    subscriber: TransactionSigner;
    subscriptionPda?: Address;
    tokenMint: Address;
};

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
                tokenProgram: input.tokenProgram,
                userAta: input.userAta,
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
        { tokenMint: input.tokenMint, user: input.user.address },
        pdaConfig(input.programAddress),
    );
    let ix: Instruction = getCloseSubscriptionAuthorityInstruction(
        { subscriptionAuthority, user: input.user },
        pdaConfig(input.programAddress),
    );
    if (input.receiver) {
        ix = withTrailing(ix, [{ address: input.receiver, role: AccountRole.WRITABLE }]);
    }
    return ix;
}

export async function getRevokeSubscriptionAuthorityOverlayInstructionAsync(
    input: RevokeSubscriptionAuthorityInput,
): Promise<Instruction> {
    const [userAta] = await findAssociatedTokenPda({
        mint: input.tokenMint,
        owner: input.user.address,
        tokenProgram: input.tokenProgram,
    });
    const [subscriptionAuthority] = await findSubscriptionAuthorityPda(
        { tokenMint: input.tokenMint, user: input.user.address },
        pdaConfig(input.programAddress),
    );
    let ix: Instruction = getRevokeSubscriptionAuthorityInstruction(
        {
            subscriptionAuthority,
            tokenMint: input.tokenMint,
            tokenProgram: input.tokenProgram,
            user: input.user,
            userAta,
        },
        pdaConfig(input.programAddress),
    );
    if (input.receiver) {
        ix = withTrailing(ix, [{ address: input.receiver, role: AccountRole.WRITABLE }]);
    }
    return ix;
}

export async function getCreateFixedDelegationOverlayInstructionAsync(
    input: CreateFixedDelegationInput,
): Promise<Instruction> {
    assertPositive(input.amount, 'amount');
    if (input.expectedSubscriptionAuthorityInitId === undefined) {
        throw new Error(
            'getCreateFixedDelegationOverlayInstructionAsync requires expectedSubscriptionAuthorityInitId. Use the plugin client `subscriptions.instructions.createFixedDelegation(...)` to auto-fetch from the live authority.',
        );
    }
    const [subscriptionAuthority] = await findSubscriptionAuthorityPda(
        { tokenMint: input.tokenMint, user: input.delegator.address },
        pdaConfig(input.programAddress),
    );
    const [delegationPda] = await findFixedDelegationPda(
        {
            delegatee: input.delegatee,
            delegator: input.delegator.address,
            nonce: input.nonce,
            subscriptionAuthority,
        },
        pdaConfig(input.programAddress),
    );
    return appendPayer(
        getCreateFixedDelegationInstruction(
            {
                delegatee: input.delegatee,
                delegationAccount: delegationPda,
                delegator: input.delegator,
                fixedDelegation: {
                    amount: input.amount,
                    expectedSubscriptionAuthorityInitId: input.expectedSubscriptionAuthorityInitId,
                    expiryTs: input.expiryTs,
                    nonce: input.nonce,
                },
                subscriptionAuthority,
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
    if (input.expectedSubscriptionAuthorityInitId === undefined) {
        throw new Error(
            'getCreateRecurringDelegationOverlayInstructionAsync requires expectedSubscriptionAuthorityInitId. Use the plugin client `subscriptions.instructions.createRecurringDelegation(...)` to auto-fetch from the live authority.',
        );
    }
    const [subscriptionAuthority] = await findSubscriptionAuthorityPda(
        { tokenMint: input.tokenMint, user: input.delegator.address },
        pdaConfig(input.programAddress),
    );
    const [delegationPda] = await findRecurringDelegationPda(
        {
            delegatee: input.delegatee,
            delegator: input.delegator.address,
            nonce: input.nonce,
            subscriptionAuthority,
        },
        pdaConfig(input.programAddress),
    );
    return appendPayer(
        getCreateRecurringDelegationInstruction(
            {
                delegatee: input.delegatee,
                delegationAccount: delegationPda,
                delegator: input.delegator,
                recurringDelegation: {
                    amountPerPeriod: input.amountPerPeriod,
                    expectedSubscriptionAuthorityInitId: input.expectedSubscriptionAuthorityInitId,
                    expiryTs: input.expiryTs,
                    nonce: input.nonce,
                    periodLengthS: input.periodLengthS,
                    startTs: input.startTs,
                },
                subscriptionAuthority,
            },
            pdaConfig(input.programAddress),
        ),
        input.payer,
    );
}

export async function getCreateUpToDelegationOverlayInstructionAsync(
    input: CreateUpToDelegationInput,
): Promise<Instruction> {
    assertPositive(input.maxAmount, 'maxAmount');
    if (input.expectedSubscriptionAuthorityInitId === undefined) {
        throw new Error(
            'getCreateUpToDelegationOverlayInstructionAsync requires expectedSubscriptionAuthorityInitId. Use the plugin client `subscriptions.instructions.createUpToDelegation(...)` to auto-fetch from the live authority.',
        );
    }
    const [subscriptionAuthority] = await findSubscriptionAuthorityPda(
        { tokenMint: input.tokenMint, user: input.delegator.address },
        pdaConfig(input.programAddress),
    );
    const [delegationPda] = await findUpToDelegationPda(
        {
            delegatee: input.delegatee,
            delegator: input.delegator.address,
            nonce: input.nonce,
            subscriptionAuthority,
        },
        pdaConfig(input.programAddress),
    );
    return appendPayer(
        getCreateUpToDelegationInstruction(
            {
                delegatee: input.delegatee,
                delegationAccount: delegationPda,
                delegator: input.delegator,
                subscriptionAuthority,
                upToDelegation: {
                    expectedSubscriptionAuthorityInitId: input.expectedSubscriptionAuthorityInitId,
                    expiryTs: input.expiryTs,
                    maxAmount: input.maxAmount,
                    nonce: input.nonce,
                    recipient: input.recipient,
                },
            },
            pdaConfig(input.programAddress),
        ),
        input.payer,
    );
}

/** Revoke a fixed/recurring delegation. For subscription PDAs use {@link getRevokeSubscriptionOverlayInstruction}. */
export function getRevokeDelegationOverlayInstruction(input: RevokeDelegationInput): Instruction {
    let ix: Instruction = getRevokeDelegationInstruction(
        {
            authority: input.authority,
            delegationAccount: input.delegationAccount,
        },
        pdaConfig(input.programAddress),
    );
    if (input.receiver) {
        ix = withTrailing(ix, [{ address: input.receiver, role: AccountRole.WRITABLE }]);
    }
    return ix;
}

/**
 * Revoke a subscription PDA. Trailing-account layout: `[planPda, receiver?]`.
 * For fixed/recurring delegations use {@link getRevokeDelegationOverlayInstruction}.
 */
export function getRevokeSubscriptionOverlayInstruction(input: RevokeSubscriptionInput): Instruction {
    const trailing: { address: Address; role: number }[] = [{ address: input.planPda, role: AccountRole.READONLY }];
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
        | typeof getTransferRecurringInstruction
        | typeof getTransferUpToInstruction,
): Promise<Instruction> {
    assertSafeU64(input.amount, 'amount');
    const [subscriptionAuthority] = await findSubscriptionAuthorityPda(
        { tokenMint: input.tokenMint, user: input.delegator },
        pdaConfig(input.programAddress),
    );
    return withTrailing(
        getInstruction(
            {
                ...(await eventAccounts(input.programAddress)),
                delegatee: input.delegatee,
                delegationPda: input.delegationPda,
                delegatorAta: input.delegatorAta,
                receiverAta: input.receiverAta,
                subscriptionAuthority,
                tokenMint: input.tokenMint,
                tokenProgram: input.tokenProgram,
                transferData: {
                    amount: input.amount,
                    delegator: input.delegator,
                    mint: input.tokenMint,
                },
            },
            pdaConfig(input.programAddress),
        ),
        input.transferHookAccounts ?? [],
    );
}

export function getTransferFixedOverlayInstructionAsync(input: TransferDelegationInput): Promise<Instruction> {
    assertPositive(input.amount, 'amount');
    return getTransferDelegationOverlayInstructionAsync(input, getTransferFixedInstruction);
}

export function getTransferRecurringOverlayInstructionAsync(input: TransferDelegationInput): Promise<Instruction> {
    assertPositive(input.amount, 'amount');
    return getTransferDelegationOverlayInstructionAsync(input, getTransferRecurringInstruction);
}

export function getTransferUpToOverlayInstructionAsync(input: TransferDelegationInput): Promise<Instruction> {
    return getTransferDelegationOverlayInstructionAsync(input, getTransferUpToInstruction);
}

export async function getTransferSubscriptionOverlayInstructionAsync(
    input: TransferSubscriptionInput,
): Promise<Instruction> {
    assertPositive(input.amount, 'amount');
    const [subscriptionAuthority] = await findSubscriptionAuthorityPda(
        { tokenMint: input.tokenMint, user: input.delegator },
        pdaConfig(input.programAddress),
    );
    const [delegatorAta] = await findAssociatedTokenPda({
        mint: input.tokenMint,
        owner: input.delegator,
        tokenProgram: input.tokenProgram,
    });
    return withTrailing(
        getTransferSubscriptionInstruction(
            {
                ...(await eventAccounts(input.programAddress)),
                caller: input.caller,
                delegatorAta,
                planPda: input.planPda,
                receiverAta: input.receiverAta,
                subscriptionAuthority,
                subscriptionPda: input.subscriptionPda,
                tokenMint: input.tokenMint,
                tokenProgram: input.tokenProgram,
                transferData: {
                    amount: input.amount,
                    delegator: input.delegator,
                    mint: input.tokenMint,
                },
            },
            pdaConfig(input.programAddress),
        ),
        input.transferHookAccounts ?? [],
    );
}

export async function getCreatePlanOverlayInstructionAsync(input: CreatePlanInput): Promise<Instruction> {
    assertPositive(input.amount, 'amount');
    assertPositive(input.periodHours, 'periodHours');
    assertSafeU64(input.planId, 'planId');
    assertMetadataUri(input.metadataUri);
    const destinations = padPlanDestinations(input.destinations);
    const pullers = padPlanPullers(input.pullers);

    const [planPda] = await findPlanPda(
        { owner: input.owner.address, planId: input.planId },
        pdaConfig(input.programAddress),
    );

    return appendPayer(
        getCreatePlanInstruction(
            {
                merchant: input.owner,
                planData: {
                    destinations,
                    endTs: input.endTs,
                    metadataUri: input.metadataUri,
                    mint: input.mint,
                    planId: input.planId,
                    pullers,
                    terms: {
                        amount: input.amount,
                        createdAt: 0n,
                        periodHours: input.periodHours,
                    },
                },
                planPda,
                tokenMint: input.mint,
                tokenProgram: input.tokenProgram,
            },
            pdaConfig(input.programAddress),
        ),
        input.payer,
    );
}

export async function getUpdatePlanOverlayInstruction(input: UpdatePlanInput): Promise<Instruction> {
    assertMetadataUri(input.metadataUri);
    const pullers = padPlanPullers(input.pullers);
    return getUpdatePlanInstruction(
        {
            ...(await eventAccounts(input.programAddress)),
            owner: input.owner,
            planPda: input.planPda,
            updatePlanData: {
                endTs: input.endTs,
                metadataUri: input.metadataUri,
                pullers,
                status: input.status,
            },
        },
        pdaConfig(input.programAddress),
    );
}

export function getDeletePlanOverlayInstruction(input: DeletePlanInput): Instruction {
    return getDeletePlanInstruction({ owner: input.owner, planPda: input.planPda }, pdaConfig(input.programAddress));
}

export async function getSubscribeOverlayInstructionAsync(input: SubscribeInput): Promise<Instruction> {
    if (
        input.expectedAmount === undefined ||
        input.expectedPeriodHours === undefined ||
        input.expectedCreatedAt === undefined ||
        input.expectedSubscriptionAuthorityInitId === undefined
    ) {
        throw new Error(
            'getSubscribeOverlayInstructionAsync requires expectedAmount, expectedPeriodHours, expectedCreatedAt, and expectedSubscriptionAuthorityInitId. Use the plugin client `subscriptions.instructions.subscribe(...)` to auto-fetch from the live plan and authority.',
        );
    }
    assertSafeU64(input.planId, 'planId');
    const [planPda, planBump] = await findPlanPda(
        { owner: input.merchant, planId: input.planId },
        pdaConfig(input.programAddress),
    );
    const [subscriptionAuthorityPda] = await findSubscriptionAuthorityPda(
        { tokenMint: input.tokenMint, user: input.subscriber.address },
        pdaConfig(input.programAddress),
    );
    return appendPayer(
        await getSubscribeInstructionAsync(
            {
                ...(await eventAccounts(input.programAddress)),
                merchant: input.merchant,
                planPda,
                subscribeData: {
                    expectedAmount: input.expectedAmount,
                    expectedCreatedAt: input.expectedCreatedAt,
                    expectedMint: input.tokenMint,
                    expectedPeriodHours: input.expectedPeriodHours,
                    expectedSubscriptionAuthorityInitId: input.expectedSubscriptionAuthorityInitId,
                    planBump,
                    planId: input.planId,
                },
                subscriber: input.subscriber,
                subscriptionAuthorityPda,
            },
            pdaConfig(input.programAddress),
        ),
        input.payer,
    );
}

export async function getCancelSubscriptionOverlayInstructionAsync(
    input: CancelSubscriptionInput,
): Promise<Instruction> {
    return await getCancelSubscriptionInstructionAsync(
        {
            ...(await eventAccounts(input.programAddress)),
            planPda: input.planPda,
            subscriber: input.subscriber,
            subscriptionPda: input.subscriptionPda,
        },
        pdaConfig(input.programAddress),
    );
}

export async function getResumeSubscriptionOverlayInstructionAsync(
    input: ResumeSubscriptionInput,
): Promise<Instruction> {
    const [subscriptionAuthority] = await findSubscriptionAuthorityPda(
        { tokenMint: input.tokenMint, user: input.subscriber.address },
        pdaConfig(input.programAddress),
    );
    return await getResumeSubscriptionInstructionAsync(
        {
            ...(await eventAccounts(input.programAddress)),
            planPda: input.planPda,
            subscriber: input.subscriber,
            subscriptionAuthority,
            subscriptionPda: input.subscriptionPda,
        },
        pdaConfig(input.programAddress),
    );
}

// ============================================================================
// Plugin
// ============================================================================

export type SubscriptionsPluginRequirements = ClientWithIdentity &
    ClientWithPayer &
    ClientWithRpc<GetProgramAccountsApi> &
    GeneratedSubscriptionsPluginRequirements;

type Self<T> = SelfPlanAndSendFunctions & T;

export type SubscriptionsPluginInstructions = {
    cancelSubscription: (input: MakeOptional<CancelSubscriptionInput, 'subscriber'>) => Self<Promise<Instruction>>;
    closeSubscriptionAuthority: (
        input: MakeOptional<CloseSubscriptionAuthorityInput, 'user'>,
    ) => Self<Promise<Instruction>>;
    createFixedDelegation: (
        input: MakeOptional<CreateFixedDelegationInput, 'delegator' | 'payer'>,
    ) => Self<Promise<Instruction>>;
    createPlan: (input: MakeOptional<CreatePlanInput, 'owner'>) => Self<Promise<Instruction>>;
    createRecurringDelegation: (
        input: MakeOptional<CreateRecurringDelegationInput, 'delegator' | 'payer'>,
    ) => Self<Promise<Instruction>>;
    createUpToDelegation: (
        input: MakeOptional<CreateUpToDelegationInput, 'delegator' | 'payer'>,
    ) => Self<Promise<Instruction>>;
    deletePlan: (input: MakeOptional<DeletePlanInput, 'owner'>) => Self<Instruction>;
    initSubscriptionAuthority: (
        input: MakeOptional<InitSubscriptionAuthorityInput, 'owner' | 'payer'>,
    ) => Self<Promise<Instruction>>;
    resumeSubscription: (input: MakeOptional<ResumeSubscriptionInput, 'subscriber'>) => Self<Promise<Instruction>>;
    revokeDelegation: (input: MakeOptional<RevokeDelegationInput, 'authority'>) => Self<Instruction>;
    revokeSubscription: (input: MakeOptional<RevokeSubscriptionInput, 'authority'>) => Self<Instruction>;
    revokeSubscriptionAuthority: (
        input: MakeOptional<RevokeSubscriptionAuthorityInput, 'user'>,
    ) => Self<Promise<Instruction>>;
    subscribe: (input: MakeOptional<SubscribeInput, 'payer' | 'subscriber'>) => Self<Promise<Instruction>>;
    transferFixed: (input: MakeOptional<TransferDelegationInput, 'delegatee'>) => Self<Promise<Instruction>>;
    transferRecurring: (input: MakeOptional<TransferDelegationInput, 'delegatee'>) => Self<Promise<Instruction>>;
    transferSubscription: (input: MakeOptional<TransferSubscriptionInput, 'caller'>) => Self<Promise<Instruction>>;
    transferUpTo: (input: MakeOptional<TransferDelegationInput, 'delegatee'>) => Self<Promise<Instruction>>;
    updatePlan: (input: MakeOptional<UpdatePlanInput, 'owner'>) => Self<Promise<Instruction>>;
};

export type SubscriptionsPluginQueries = {
    /** Counts of active delegations grouped by kind. */
    activeDelegationSummary: (wallet: Address) => Promise<{
        fixed: number;
        recurring: number;
        subscriptions: number;
        total: number;
    }>;
    /** All delegations where `wallet` is the delegatee. */
    delegationsByDelegatee: (wallet: Address) => Promise<Delegation[]>;
    /** All delegations where `wallet` is the delegator. */
    delegationsByDelegator: (wallet: Address) => Promise<Delegation[]>;
    /** Whether the SubscriptionAuthority PDA exists for `(user, tokenMint)`. */
    isSubscriptionAuthorityInitialized: (
        user: Address,
        tokenMint: Address,
        programAddress?: Address,
    ) => Promise<{ initialized: boolean; pda: Address }>;
    /** Plans owned by `owner`. */
    plansForOwner: (owner: Address) => Promise<PlanWithAddress[]>;
};

export type SubscriptionsPlugin = Omit<GeneratedSubscriptionsPlugin, 'instructions'> & {
    instructions: SubscriptionsPluginInstructions;
    queries: SubscriptionsPluginQueries;
};

export function subscriptionsProgram() {
    return <T extends SubscriptionsPluginRequirements>(client: T) => {
        return pipe(client, generatedSubscriptionsProgram(), c => {
            const queries: SubscriptionsPluginQueries = {
                activeDelegationSummary: async wallet => {
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
                delegationsByDelegatee: wallet => fetchDelegationsByDelegatee(c.rpc, wallet),
                delegationsByDelegator: wallet => fetchDelegationsByDelegator(c.rpc, wallet),
                isSubscriptionAuthorityInitialized: async (user, tokenMint, programAddress) => {
                    const [pda] = await findSubscriptionAuthorityPda({ tokenMint, user }, pdaConfig(programAddress));
                    const account = await fetchMaybeSubscriptionAuthority(c.rpc, pda);
                    return { initialized: account.exists, pda };
                },
                plansForOwner: owner => fetchPlansForOwner(c.rpc, owner),
            };

            const resolveExpectedSubscriptionAuthorityInitId = async (
                tokenMint: Address,
                user: Address,
                programAddress: Address | undefined,
                expectedSubscriptionAuthorityInitId: bigint | number | undefined,
            ) => {
                if (expectedSubscriptionAuthorityInitId !== undefined) {
                    return expectedSubscriptionAuthorityInitId;
                }
                const [subscriptionAuthorityPda] = await findSubscriptionAuthorityPda(
                    { tokenMint, user },
                    pdaConfig(programAddress),
                );
                const subscriptionAuthority = await fetchMaybeSubscriptionAuthority(c.rpc, subscriptionAuthorityPda);
                if (!subscriptionAuthority.exists) {
                    throw new Error('SubscriptionAuthority is not initialized for this delegator and token mint.');
                }
                return subscriptionAuthority.data.initId;
            };

            const resolveDelegationHookAccounts = async (input: Omit<TransferDelegationInput, 'delegatee'>) => {
                const [subscriptionAuthority] = await findSubscriptionAuthorityPda(
                    { tokenMint: input.tokenMint, user: input.delegator },
                    pdaConfig(input.programAddress),
                );
                return await resolveTransferHookAccounts(c.rpc, {
                    amount: input.amount,
                    authority: subscriptionAuthority,
                    destination: input.receiverAta,
                    mint: input.tokenMint,
                    source: input.delegatorAta,
                    tokenProgram: input.tokenProgram,
                    transferHookAccounts: input.transferHookAccounts,
                });
            };

            const instructions: SubscriptionsPluginInstructions = {
                cancelSubscription: input =>
                    addSelfPlanAndSendFunctions(
                        client,
                        getCancelSubscriptionOverlayInstructionAsync({
                            ...input,
                            subscriber: input.subscriber ?? client.identity,
                        }),
                    ),
                closeSubscriptionAuthority: input =>
                    addSelfPlanAndSendFunctions(
                        client,
                        getCloseSubscriptionAuthorityOverlayInstructionAsync({
                            ...input,
                            user: input.user ?? client.identity,
                        }),
                    ),
                createFixedDelegation: input =>
                    addSelfPlanAndSendFunctions(
                        client,
                        (async () => {
                            const delegator = input.delegator ?? client.identity;
                            const expectedSubscriptionAuthorityInitId =
                                await resolveExpectedSubscriptionAuthorityInitId(
                                    input.tokenMint,
                                    delegator.address,
                                    input.programAddress,
                                    input.expectedSubscriptionAuthorityInitId,
                                );
                            return await getCreateFixedDelegationOverlayInstructionAsync({
                                ...input,
                                delegator,
                                expectedSubscriptionAuthorityInitId,
                                payer: input.payer ?? (client.payer === client.identity ? undefined : client.payer),
                            });
                        })(),
                    ),
                createPlan: input =>
                    addSelfPlanAndSendFunctions(
                        client,
                        getCreatePlanOverlayInstructionAsync({
                            ...input,
                            owner: input.owner ?? client.identity,
                            payer: input.payer ?? (client.payer === client.identity ? undefined : client.payer),
                        }),
                    ),
                createRecurringDelegation: input =>
                    addSelfPlanAndSendFunctions(
                        client,
                        (async () => {
                            const delegator = input.delegator ?? client.identity;
                            const expectedSubscriptionAuthorityInitId =
                                await resolveExpectedSubscriptionAuthorityInitId(
                                    input.tokenMint,
                                    delegator.address,
                                    input.programAddress,
                                    input.expectedSubscriptionAuthorityInitId,
                                );
                            return await getCreateRecurringDelegationOverlayInstructionAsync({
                                ...input,
                                delegator,
                                expectedSubscriptionAuthorityInitId,
                                payer: input.payer ?? (client.payer === client.identity ? undefined : client.payer),
                            });
                        })(),
                    ),
                createUpToDelegation: input =>
                    addSelfPlanAndSendFunctions(
                        client,
                        (async () => {
                            const delegator = input.delegator ?? client.identity;
                            const expectedSubscriptionAuthorityInitId =
                                await resolveExpectedSubscriptionAuthorityInitId(
                                    input.tokenMint,
                                    delegator.address,
                                    input.programAddress,
                                    input.expectedSubscriptionAuthorityInitId,
                                );
                            return await getCreateUpToDelegationOverlayInstructionAsync({
                                ...input,
                                delegator,
                                expectedSubscriptionAuthorityInitId,
                                payer: input.payer ?? (client.payer === client.identity ? undefined : client.payer),
                            });
                        })(),
                    ),
                deletePlan: input =>
                    addSelfPlanAndSendFunctions(
                        client,
                        getDeletePlanOverlayInstruction({
                            ...input,
                            owner: input.owner ?? client.identity,
                        }),
                    ),
                initSubscriptionAuthority: input =>
                    addSelfPlanAndSendFunctions(
                        client,
                        getInitSubscriptionAuthorityOverlayInstructionAsync({
                            ...input,
                            owner: input.owner ?? client.identity,
                            payer: input.payer ?? (client.payer === client.identity ? undefined : client.payer),
                        }),
                    ),
                resumeSubscription: input =>
                    addSelfPlanAndSendFunctions(
                        client,
                        getResumeSubscriptionOverlayInstructionAsync({
                            ...input,
                            subscriber: input.subscriber ?? client.identity,
                        }),
                    ),
                revokeDelegation: input =>
                    addSelfPlanAndSendFunctions(
                        client,
                        getRevokeDelegationOverlayInstruction({
                            ...input,
                            authority: input.authority ?? client.identity,
                        }),
                    ),
                revokeSubscription: input =>
                    addSelfPlanAndSendFunctions(
                        client,
                        getRevokeSubscriptionOverlayInstruction({
                            ...input,
                            authority: input.authority ?? client.identity,
                        }),
                    ),
                revokeSubscriptionAuthority: input =>
                    addSelfPlanAndSendFunctions(
                        client,
                        getRevokeSubscriptionAuthorityOverlayInstructionAsync({
                            ...input,
                            user: input.user ?? client.identity,
                        }),
                    ),
                subscribe: input =>
                    addSelfPlanAndSendFunctions(
                        client,
                        (async () => {
                            const subscriber = input.subscriber ?? client.identity;
                            assertSafeU64(input.planId, 'planId');
                            let {
                                expectedAmount,
                                expectedCreatedAt,
                                expectedPeriodHours,
                                expectedSubscriptionAuthorityInitId,
                            } = input;
                            if (
                                expectedAmount === undefined ||
                                expectedPeriodHours === undefined ||
                                expectedCreatedAt === undefined
                            ) {
                                const [planPda] = await findPlanPda(
                                    { owner: input.merchant, planId: input.planId },
                                    pdaConfig(input.programAddress),
                                );
                                const plan = await fetchPlan(c.rpc, planPda);
                                expectedAmount = expectedAmount ?? plan.data.data.terms.amount;
                                expectedPeriodHours = expectedPeriodHours ?? plan.data.data.terms.periodHours;
                                expectedCreatedAt = expectedCreatedAt ?? plan.data.data.terms.createdAt;
                            }
                            if (expectedSubscriptionAuthorityInitId === undefined) {
                                const [subscriptionAuthorityPda] = await findSubscriptionAuthorityPda(
                                    { tokenMint: input.tokenMint, user: subscriber.address },
                                    pdaConfig(input.programAddress),
                                );
                                const subscriptionAuthority = await fetchMaybeSubscriptionAuthority(
                                    c.rpc,
                                    subscriptionAuthorityPda,
                                );
                                if (!subscriptionAuthority.exists) {
                                    throw new Error(
                                        'SubscriptionAuthority is not initialized for this subscriber and token mint.',
                                    );
                                }
                                expectedSubscriptionAuthorityInitId = subscriptionAuthority.data.initId;
                            }
                            return await getSubscribeOverlayInstructionAsync({
                                ...input,
                                expectedAmount,
                                expectedCreatedAt,
                                expectedPeriodHours,
                                expectedSubscriptionAuthorityInitId,
                                payer: input.payer ?? (client.payer === client.identity ? undefined : client.payer),
                                subscriber,
                            });
                        })(),
                    ),
                transferFixed: input =>
                    addSelfPlanAndSendFunctions(
                        client,
                        (async () =>
                            await getTransferFixedOverlayInstructionAsync({
                                ...input,
                                delegatee: input.delegatee ?? client.identity,
                                transferHookAccounts: await resolveDelegationHookAccounts(input),
                            }))(),
                    ),
                transferRecurring: input =>
                    addSelfPlanAndSendFunctions(
                        client,
                        (async () =>
                            await getTransferRecurringOverlayInstructionAsync({
                                ...input,
                                delegatee: input.delegatee ?? client.identity,
                                transferHookAccounts: await resolveDelegationHookAccounts(input),
                            }))(),
                    ),
                transferSubscription: input =>
                    addSelfPlanAndSendFunctions(
                        client,
                        (async () => {
                            const [subscriptionAuthority] = await findSubscriptionAuthorityPda(
                                { tokenMint: input.tokenMint, user: input.delegator },
                                pdaConfig(input.programAddress),
                            );
                            const [delegatorAta] = await findAssociatedTokenPda({
                                mint: input.tokenMint,
                                owner: input.delegator,
                                tokenProgram: input.tokenProgram,
                            });
                            const transferHookAccounts = await resolveTransferHookAccounts(c.rpc, {
                                amount: input.amount,
                                authority: subscriptionAuthority,
                                destination: input.receiverAta,
                                mint: input.tokenMint,
                                source: delegatorAta,
                                tokenProgram: input.tokenProgram,
                                transferHookAccounts: input.transferHookAccounts,
                            });
                            return await getTransferSubscriptionOverlayInstructionAsync({
                                ...input,
                                caller: input.caller ?? client.identity,
                                transferHookAccounts,
                            });
                        })(),
                    ),
                transferUpTo: input =>
                    addSelfPlanAndSendFunctions(
                        client,
                        (async () =>
                            await getTransferUpToOverlayInstructionAsync({
                                ...input,
                                delegatee: input.delegatee ?? client.identity,
                                transferHookAccounts: await resolveDelegationHookAccounts(input),
                            }))(),
                    ),
                updatePlan: input =>
                    addSelfPlanAndSendFunctions(
                        client,
                        getUpdatePlanOverlayInstruction({
                            ...input,
                            owner: input.owner ?? client.identity,
                        }),
                    ),
            };

            return {
                ...c,
                subscriptions: {
                    ...c.subscriptions,
                    instructions,
                    queries,
                },
            };
        });
    };
}
