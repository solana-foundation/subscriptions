import type {
  Address,
  Base58EncodedBytes,
  GetProgramAccountsApi,
  Rpc,
} from '@solana/kit';
import { DELEGATOR_OFFSET, SUBSCRIPTION_SIZE } from '../constants.js';
import {
  decodeSubscriptionDelegation,
  SUBSCRIPTIONS_PROGRAM_ADDRESS,
  type SubscriptionDelegation,
} from '../generated/index.js';
import { toEncodedAccount } from './decode.js';

/**
 * Fetches all subscription delegation accounts for a given subscriber wallet.
 *
 * @param rpc - An RPC client supporting `getProgramAccounts`.
 * @param user - The subscriber's (delegator's) wallet address.
 * @returns Decoded subscription delegations paired with their on-chain addresses.
 */
export async function fetchSubscriptionsForUser(
  rpc: Rpc<GetProgramAccountsApi>,
  user: Address,
  programAddress?: Address,
): Promise<Array<{ address: Address; data: SubscriptionDelegation }>> {
  const progAddr = programAddress ?? SUBSCRIPTIONS_PROGRAM_ADDRESS;
  const response = await rpc
    .getProgramAccounts(progAddr, {
      encoding: 'base64',
      filters: [
        { dataSize: BigInt(SUBSCRIPTION_SIZE) },
        {
          memcmp: {
            offset: BigInt(DELEGATOR_OFFSET),
            bytes: user as string as Base58EncodedBytes,
            encoding: 'base58',
          },
        },
      ],
    })
    .send();

  return response.map((account) => {
    // biome-ignore lint/suspicious/noExplicitAny: RPC response shape
    const raw = account as any;
    const encoded = toEncodedAccount(raw, progAddr);
    const decoded = decodeSubscriptionDelegation(encoded);
    return { address: raw.pubkey as Address, data: decoded.data };
  });
}
