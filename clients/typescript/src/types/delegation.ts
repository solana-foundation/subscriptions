import type { Address } from '@solana/kit';

import type { FixedDelegation, RecurringDelegation, SubscriptionDelegation } from '../generated/index.js';

/** Discriminated union pairing each delegation variant with its on-chain address. */
export type Delegation =
    | { address: Address; data: FixedDelegation; kind: 'fixed' }
    | { address: Address; data: RecurringDelegation; kind: 'recurring' }
    | { address: Address; data: SubscriptionDelegation; kind: 'subscription' };
