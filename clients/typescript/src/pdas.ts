import {
  type Address,
  getAddressEncoder,
  getProgramDerivedAddress,
} from 'gill';
import {
  DELEGATION_SEED,
  EVENT_AUTHORITY_SEED,
  SUBSCRIPTION_AUTHORITY_SEED,
  PLAN_SEED,
  PROGRAM_ID,
  SUBSCRIPTION_SEED,
  U64_BYTE_SIZE,
} from './constants.js';

const addressEncoder = getAddressEncoder();
const textEncoder = new TextEncoder();

function encodeU64Le(value: number | bigint): Uint8Array {
  const bytes = new Uint8Array(U64_BYTE_SIZE);
  new DataView(bytes.buffer).setBigUint64(0, BigInt(value), true);
  return bytes;
}

/**
 * Derives the SubscriptionAuthority PDA for a user and token mint.
 *
 * @param user - Wallet address of the delegate owner.
 * @param tokenMint - SPL token mint address.
 * @param programId - Program address override (defaults to {@link PROGRAM_ID}).
 * @returns A tuple of `[pda, bump]`.
 */
export async function getSubscriptionAuthorityPDA(
  user: Address,
  tokenMint: Address,
  programId?: Address,
): Promise<[Address, number]> {
  const seeds = [
    textEncoder.encode(SUBSCRIPTION_AUTHORITY_SEED),
    addressEncoder.encode(user),
    addressEncoder.encode(tokenMint),
  ];

  const [pda, bump] = await getProgramDerivedAddress({
    programAddress: programId ?? PROGRAM_ID,
    seeds,
  });
  return [pda, bump];
}

/**
 * Derives the delegation PDA for fixed or recurring delegations.
 *
 * @param subscriptionAuthority - The SubscriptionAuthority PDA address.
 * @param delegator - Wallet address of the delegator.
 * @param delegatee - Wallet address of the delegatee.
 * @param nonce - Unique nonce allowing multiple delegations between the same pair.
 * @param programId - Program address override (defaults to {@link PROGRAM_ID}).
 * @returns A tuple of `[pda, bump]`.
 */
export async function getDelegationPDA(
  subscriptionAuthority: Address,
  delegator: Address,
  delegatee: Address,
  nonce: number | bigint,
  programId?: Address,
): Promise<[Address, number]> {
  const seeds = [
    textEncoder.encode(DELEGATION_SEED),
    addressEncoder.encode(subscriptionAuthority),
    addressEncoder.encode(delegator),
    addressEncoder.encode(delegatee),
    encodeU64Le(nonce),
  ];

  const [pda, bump] = await getProgramDerivedAddress({
    programAddress: programId ?? PROGRAM_ID,
    seeds,
  });
  return [pda, bump];
}

/**
 * Derives the Plan PDA for a merchant and plan identifier.
 *
 * @param owner - Wallet address of the plan owner (merchant).
 * @param planId - Unique plan identifier.
 * @param programId - Program address override (defaults to {@link PROGRAM_ID}).
 * @returns A tuple of `[pda, bump]`.
 */
export async function getPlanPDA(
  owner: Address,
  planId: number | bigint,
  programId?: Address,
): Promise<[Address, number]> {
  const seeds = [
    textEncoder.encode(PLAN_SEED),
    addressEncoder.encode(owner),
    encodeU64Le(planId),
  ];

  const [pda, bump] = await getProgramDerivedAddress({
    programAddress: programId ?? PROGRAM_ID,
    seeds,
  });
  return [pda, bump];
}

/**
 * Derives the event authority PDA used for self-CPI event emission.
 *
 * @param programId - Program address override (defaults to {@link PROGRAM_ID}).
 * @returns A tuple of `[pda, bump]`.
 */
export async function getEventAuthorityPDA(
  programId?: Address,
): Promise<[Address, number]> {
  const seeds = [textEncoder.encode(EVENT_AUTHORITY_SEED)];

  const [pda, bump] = await getProgramDerivedAddress({
    programAddress: programId ?? PROGRAM_ID,
    seeds,
  });
  return [pda, bump];
}

/**
 * Derives the SubscriptionDelegation PDA for a plan and subscriber.
 *
 * @param planPda - The Plan PDA address.
 * @param subscriber - Wallet address of the subscriber.
 * @param programId - Program address override (defaults to {@link PROGRAM_ID}).
 * @returns A tuple of `[pda, bump]`.
 */
export async function getSubscriptionPDA(
  planPda: Address,
  subscriber: Address,
  programId?: Address,
): Promise<[Address, number]> {
  const seeds = [
    textEncoder.encode(SUBSCRIPTION_SEED),
    addressEncoder.encode(planPda),
    addressEncoder.encode(subscriber),
  ];

  const [pda, bump] = await getProgramDerivedAddress({
    programAddress: programId ?? PROGRAM_ID,
    seeds,
  });
  return [pda, bump];
}
