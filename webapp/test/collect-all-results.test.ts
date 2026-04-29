import assert from 'node:assert/strict'
import test from 'node:test'
import {
  createAllPlanPaymentCollectionResult,
  type ConfirmedPlanTransfer,
} from '../src/lib/collect-all-results.ts'

function transfer(
  planAddress: string,
  subscriptionAddress: string,
  signature: string,
  batchIndex: number,
): ConfirmedPlanTransfer {
  return {
    planAddress,
    subscriptionAddress,
    delegator: `${subscriptionAddress}-delegator`,
    amount: 1n,
    batchIndex,
    signature,
  }
}

test('aggregates successful collect-all transfers by plan', () => {
  const result = createAllPlanPaymentCollectionResult(
    [
      { planAddress: 'plan-a', total: 1 },
      { planAddress: 'plan-b', total: 1 },
    ],
    [
      transfer('plan-a', 'sub-a', 'sig-a', 0),
      transfer('plan-b', 'sub-b', 'sig-b', 1),
    ],
    ['sig-a', 'sig-b'],
    false,
  )

  assert.equal(result.collected, 2)
  assert.equal(result.total, 2)
  assert.equal(result.partial, false)
  assert.equal(result.plans['plan-a'].collected, 1)
  assert.equal(result.plans['plan-a'].total, 1)
  assert.deepEqual(result.plans['plan-a'].signatures, ['sig-a'])
  assert.equal(result.plans['plan-b'].collected, 1)
  assert.equal(result.plans['plan-b'].total, 1)
  assert.deepEqual(result.plans['plan-b'].signatures, ['sig-b'])
})

test('does not attach earlier plan signatures to plans skipped by a later failed batch', () => {
  const result = createAllPlanPaymentCollectionResult(
    [
      { planAddress: 'plan-a', total: 1 },
      { planAddress: 'plan-b', total: 1 },
    ],
    [transfer('plan-a', 'sub-a', 'sig-a', 0)],
    ['sig-a'],
    true,
  )

  assert.equal(result.collected, 1)
  assert.equal(result.total, 2)
  assert.equal(result.partial, true)
  assert.equal(result.plans['plan-a'].partial, false)
  assert.deepEqual(result.plans['plan-a'].signatures, ['sig-a'])
  assert.equal(result.plans['plan-b'].collected, 0)
  assert.equal(result.plans['plan-b'].total, 1)
  assert.equal(result.plans['plan-b'].partial, true)
  assert.deepEqual(result.plans['plan-b'].signatures, [])
})

test('omits cached-pending plans skipped before transaction construction', () => {
  const result = createAllPlanPaymentCollectionResult(
    [{ planAddress: 'fresh-plan', total: 1 }],
    [transfer('fresh-plan', 'fresh-sub', 'fresh-sig', 0)],
    ['fresh-sig'],
    false,
  )

  assert.equal(result.collected, 1)
  assert.equal(result.total, 1)
  assert.equal(result.plans['fresh-plan'].collected, 1)
  assert.equal(result.plans['stale-cached-plan'], undefined)
})

test('marks a plan partial only for its own uncollected transfers', () => {
  const result = createAllPlanPaymentCollectionResult(
    [
      { planAddress: 'plan-a', total: 2 },
      { planAddress: 'plan-b', total: 1 },
    ],
    [
      transfer('plan-a', 'sub-a-1', 'sig-a-1', 0),
      transfer('plan-b', 'sub-b', 'sig-b', 0),
    ],
    ['sig-a-1', 'sig-b'],
    true,
  )

  assert.equal(result.plans['plan-a'].collected, 1)
  assert.equal(result.plans['plan-a'].partial, true)
  assert.equal(result.plans['plan-b'].collected, 1)
  assert.equal(result.plans['plan-b'].partial, false)
})
