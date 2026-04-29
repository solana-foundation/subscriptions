export interface DelegationApprovalStateInput {
  readonly isInitialized: boolean
  readonly isApproved: boolean
  readonly outgoingDelegationCount: number
}

export interface DelegationApprovalState {
  readonly canCreateDelegations: boolean
  readonly canCloseSubscriptionAuthority: boolean
  readonly shouldShowOutgoingDelegations: boolean
  readonly shouldShowApprovalPromptAsContent: boolean
  readonly shouldShowApprovalRecoveryBanner: boolean
}

export function getDelegationApprovalState({
  isInitialized,
  isApproved,
  outgoingDelegationCount,
}: DelegationApprovalStateInput): DelegationApprovalState {
  const hasOutgoingDelegations = outgoingDelegationCount > 0
  const hasCleanupSurface = isInitialized || hasOutgoingDelegations

  return {
    canCreateDelegations: isApproved,
    canCloseSubscriptionAuthority: isInitialized,
    shouldShowOutgoingDelegations: isApproved || hasCleanupSurface,
    shouldShowApprovalPromptAsContent: !isApproved && !hasCleanupSurface,
    shouldShowApprovalRecoveryBanner: !isApproved && hasCleanupSurface,
  }
}
