export type ConfirmedPlanTransfer = {
  planAddress: string
  subscriptionAddress: string
  delegator: string
  amount: bigint
  batchIndex: number
  signature: string
}

export type PlanCollectionTotal = {
  planAddress: string
  total: number
}

export type PlanPaymentCollectionResult = {
  planAddress: string
  collected: number
  total: number
  partial: boolean
  signatures: string[]
  transfers: ConfirmedPlanTransfer[]
}

export type AllPlanPaymentCollectionResult = {
  signatures: string[]
  collected: number
  total: number
  partial: boolean
  plans: Record<string, PlanPaymentCollectionResult>
  transfers: ConfirmedPlanTransfer[]
}

export function createAllPlanPaymentCollectionResult(
  planTotals: PlanCollectionTotal[],
  transfers: ConfirmedPlanTransfer[],
  signatures: string[],
  partial: boolean,
): AllPlanPaymentCollectionResult {
  const plans: Record<string, PlanPaymentCollectionResult> = {}

  for (const { planAddress, total } of planTotals) {
    const existing = plans[planAddress]
    if (existing) {
      existing.total += total
    } else {
      plans[planAddress] = {
        planAddress,
        collected: 0,
        total,
        partial: false,
        signatures: [],
        transfers: [],
      }
    }
  }

  for (const transfer of transfers) {
    plans[transfer.planAddress] ??= {
      planAddress: transfer.planAddress,
      collected: 0,
      total: 0,
      partial: false,
      signatures: [],
      transfers: [],
    }

    const plan = plans[transfer.planAddress]
    plan.collected += 1
    plan.transfers.push(transfer)
    if (!plan.signatures.includes(transfer.signature)) {
      plan.signatures.push(transfer.signature)
    }
  }

  for (const plan of Object.values(plans)) {
    plan.collected = Math.min(plan.collected, plan.total)
    plan.partial = plan.collected < plan.total
  }

  const total = planTotals.reduce((sum, plan) => sum + plan.total, 0)
  const collected = Object.values(plans).reduce((sum, plan) => sum + plan.collected, 0)

  return {
    signatures,
    collected,
    total,
    partial: partial || collected < total,
    plans,
    transfers,
  }
}
