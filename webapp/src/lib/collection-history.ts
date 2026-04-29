const STORAGE_KEY = 'collect-payments-history'
const MAX_RECORDS = 50

export interface CollectionRecord {
  id: string
  timestamp: number
  planAddress: string
  planName: string
  subscribersCollected: number
  subscribersTotal: number
  amountPerSubscriber?: number
  totalAmount?: string
  transfers?: CollectionTransfer[]
  status: 'success' | 'partial' | 'failed'
  signatures: string[]
  error?: string
}

export interface CollectionTransfer {
  subscriptionAddress: string
  amount: string
  signature: string
}

export interface CollectionTransferInput {
  subscriptionAddress: string
  amount: bigint
  signature: string
}

export function getCollectionHistory(planAddress?: string): CollectionRecord[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return []
    const all: CollectionRecord[] = JSON.parse(raw)
    return planAddress ? all.filter((r) => r.planAddress === planAddress) : all
  } catch (err) {
    console.error('Failed to parse collection history:', err)
    return []
  }
}

export function clearCollectionHistory(): void {
  localStorage.removeItem(STORAGE_KEY)
}

export function addCollectionRecord(record: CollectionRecord): void {
  const existing = getCollectionHistory()
  const updated = [record, ...existing].slice(0, MAX_RECORDS)
  localStorage.setItem(STORAGE_KEY, JSON.stringify(updated))
}

export function createSuccessRecord(
  planAddress: string,
  planName: string,
  transfers: CollectionTransferInput[],
  subscribersTotal: number,
  subscribersAttempted: number,
): CollectionRecord {
  const storedTransfers = transfers.slice(0, subscribersTotal).map((transfer) => ({
    subscriptionAddress: transfer.subscriptionAddress,
    amount: transfer.amount.toString(),
    signature: transfer.signature,
  }))
  const totalAmount = storedTransfers.reduce((sum, transfer) => sum + BigInt(transfer.amount), 0n)
  const subscribersCollected = storedTransfers.length
  const attempted = Math.min(subscribersAttempted, subscribersTotal)

  return {
    id: crypto.randomUUID(),
    timestamp: Math.floor(Date.now() / 1000),
    planAddress,
    planName,
    subscribersCollected,
    subscribersTotal,
    totalAmount: totalAmount.toString(),
    transfers: storedTransfers,
    status: subscribersCollected < attempted ? 'partial' : 'success',
    signatures: Array.from(new Set(storedTransfers.map((transfer) => transfer.signature))),
  }
}

export function createFailureRecord(
  planAddress: string,
  planName: string,
  subscribersTotal: number,
  error: unknown,
): CollectionRecord {
  return {
    id: crypto.randomUUID(),
    timestamp: Math.floor(Date.now() / 1000),
    planAddress,
    planName,
    subscribersCollected: 0,
    subscribersTotal,
    totalAmount: '0',
    transfers: [],
    status: 'failed',
    signatures: [],
    error: error instanceof Error ? error.message : 'Unknown error',
  }
}

export function getCollectionRecordTotalDisplayAmount(
  record: CollectionRecord,
  amountMultiplier: number,
): number {
  if (record.totalAmount !== undefined) {
    return Number(record.totalAmount) / amountMultiplier
  }

  return (record.amountPerSubscriber ?? 0) * record.subscribersCollected
}
