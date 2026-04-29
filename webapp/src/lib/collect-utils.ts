export interface EligibleSubscriber {
  subscriptionAddress: string
  delegator: string
  collectAmount: bigint
}

export interface PlanTermsFingerprint {
  amount: bigint
  periodHours: bigint
  createdAt: bigint
}

export interface PlanSubscriberForCollection {
  subscriptionAddress: string
  delegator: string
  terms: PlanTermsFingerprint
  amountPulledInPeriod: bigint
  currentPeriodStartTs: bigint
  expiresAtTs: bigint
}

export function hasMatchingPlanTerms(
  sub: PlanSubscriberForCollection,
  planTerms: PlanTermsFingerprint,
): boolean {
  return sub.terms.amount === planTerms.amount
    && sub.terms.periodHours === planTerms.periodHours
    && sub.terms.createdAt === planTerms.createdAt
}

export function getStalePlanSubscribers<T extends PlanSubscriberForCollection>(
  subscribers: T[],
  planTerms: PlanTermsFingerprint,
): T[] {
  return subscribers.filter((sub) => !hasMatchingPlanTerms(sub, planTerms))
}

export function computeEligibleSubscribers(
  subscribers: PlanSubscriberForCollection[],
  planTerms: PlanTermsFingerprint,
  currentTs: number,
): EligibleSubscriber[] {
  if (planTerms.amount <= 0n || planTerms.periodHours <= 0n) return []

  const eligible: EligibleSubscriber[] = []

  for (const sub of subscribers) {
    if (sub.expiresAtTs !== 0n && currentTs >= Number(sub.expiresAtTs)) continue
    if (!hasMatchingPlanTerms(sub, planTerms)) continue

    const periodEnd = Number(sub.currentPeriodStartTs) + Number(planTerms.periodHours) * 3600
    const collectAmount = currentTs >= periodEnd
      ? planTerms.amount
      : planTerms.amount - sub.amountPulledInPeriod

    if (collectAmount <= 0n) continue

    eligible.push({
      subscriptionAddress: sub.subscriptionAddress,
      delegator: sub.delegator,
      collectAmount,
    })
  }

  return eligible
}
