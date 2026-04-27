// Client facade

export type { RawProgramAccount } from './accounts/decode.js';
export {
  decodeDelegationAccount,
  decodePlanAccount,
  toEncodedAccount,
} from './accounts/decode.js';
// Account fetchers
export {
  fetchDelegationsByDelegatee,
  fetchDelegationsByDelegator,
} from './accounts/delegations.js';
export { fetchPlansForOwner } from './accounts/plans.js';
export { fetchSubscriptionsForUser } from './accounts/subscriptions.js';
export { MultiDelegatorClient } from './client.js';
// Constants
export * from './constants.js';
export { parseProgramError } from './errors/map.js';
// Errors
export {
  MultiDelegatorSDKError,
  ProgramError,
  ValidationError,
} from './errors/types.js';
// Re-export generated types and utilities for power users
export * from './generated/index.js';
// Instruction builders
export {
  buildCloseMultiDelegate,
  buildCreateFixedDelegation,
  buildCreateRecurringDelegation,
  buildInitMultiDelegate,
  buildRevokeDelegation,
  buildRevokeSubscription,
} from './instructions/delegation.js';
export {
  buildCreatePlan,
  buildDeletePlan,
  buildUpdatePlan,
} from './instructions/plan.js';
export {
  buildCancelSubscription,
  buildSubscribe,
} from './instructions/subscription.js';
export type { TransferParams } from './instructions/transfer.js';
export {
  buildTransferFixed,
  buildTransferRecurring,
  buildTransferSubscription,
} from './instructions/transfer.js';
// PDAs
export * from './pdas.js';
// Types
export type {
  SolanaClient,
  TransactionResult,
} from './types/common.js';
export type { Delegation } from './types/delegation.js';
export {
  isFixedDelegation,
  isRecurringDelegation,
  isSubscriptionDelegation,
} from './types/delegation.js';
export type { PlanWithAddress } from './types/plan.js';
