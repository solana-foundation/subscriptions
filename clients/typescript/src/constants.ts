import { SUBSCRIPTIONS_PROGRAM_ADDRESS } from './generated/index.js';

/** Deployed program address, sourced from Codama-generated bindings. */
export const PROGRAM_ID = SUBSCRIPTIONS_PROGRAM_ADDRESS;

/** Current on-chain account schema version. */
export const CURRENT_PROGRAM_VERSION = 1;

/** Default zero address used for padding arrays (e.g. empty puller/destination slots). */
export const ZERO_ADDRESS =
    '11111111111111111111111111111111' as import('@solana/kit').Address<'11111111111111111111111111111111'>;

/** Byte offset of the account discriminator in the Header struct. */
export const DISCRIMINATOR_OFFSET = 0;
/** Byte offset of the delegator pubkey in the Header struct. */
export const DELEGATOR_OFFSET = 3;
/** Byte offset of the delegatee pubkey in the Header struct. */
export const DELEGATEE_OFFSET = 35;

/** Byte size of a u64 value (used in nonce encoding). */
export const U64_BYTE_SIZE = 8;

/** PDA seed for SubscriptionAuthority accounts. */
export const SUBSCRIPTION_AUTHORITY_SEED = 'SubscriptionAuthority';

/** PDA seed for delegation accounts (FixedDelegation, RecurringDelegation). */
export const DELEGATION_SEED = 'delegation';

/** PDA seed for Plan accounts. */
export const PLAN_SEED = 'plan';
/** PDA seed for SubscriptionDelegation accounts. */
export const SUBSCRIPTION_SEED = 'subscription';
/** PDA seed for the event authority (self-CPI). */
export const EVENT_AUTHORITY_SEED = 'event_authority';

/** On-chain Plan account size in bytes: discriminator(1) + owner(32) + bump(1) + status(1) + planData(456). */
export const PLAN_SIZE = 491;
/** On-chain SubscriptionDelegation account size in bytes: header(107) + terms(24) + pulled(8) + periodStart(8) + expiresAt(8). */
export const SUBSCRIPTION_SIZE = 155;

/** Byte offset of the owner pubkey in a Plan account. */
export const PLAN_OWNER_OFFSET = 1;

/** Maximum number of destination addresses in a Plan. */
export const MAX_PLAN_DESTINATIONS = 4;
/** Maximum number of puller addresses in a Plan. */
export const MAX_PLAN_PULLERS = 4;
/** Maximum byte length of a Plan's metadata URI. */
export const METADATA_URI_LEN = 128;

/** On-chain delegation variant identifier (matches the `kind` tag in the `Delegation` union). */
export type DelegationKindId = 'fixed' | 'recurring' | 'subscription';
