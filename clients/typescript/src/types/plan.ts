import type { Address } from '@solana/kit';

import type { Plan } from '../generated/index.js';

/** A plan account with its on-chain address. */
export type PlanWithAddress = { address: Address; data: Plan };
