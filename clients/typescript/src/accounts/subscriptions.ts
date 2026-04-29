import type { Address, Base58EncodedBytes, GetProgramAccountsApi, Rpc } from '@solana/kit';

import { DELEGATOR_OFFSET, SUBSCRIPTION_SIZE } from '../constants.js';
import {
    decodeSubscriptionDelegation,
    type SubscriptionDelegation,
    SUBSCRIPTIONS_PROGRAM_ADDRESS,
} from '../generated/index.js';
import type { RawProgramAccount } from './decode.js';
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
                        bytes: user as string as Base58EncodedBytes,
                        encoding: 'base58',
                        offset: BigInt(DELEGATOR_OFFSET),
                    },
                },
            ],
        })
        .send();

    return response.map(account => {
        const raw = account as unknown as RawProgramAccount;
        const encoded = toEncodedAccount(raw, progAddr);
        const decoded = decodeSubscriptionDelegation(encoded);
        return { address: raw.pubkey, data: decoded.data };
    });
}
