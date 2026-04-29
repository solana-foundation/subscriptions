import type { Address, Base58EncodedBytes, GetProgramAccountsApi, Rpc } from '@solana/kit';

import { DELEGATEE_OFFSET, DELEGATOR_OFFSET } from '../constants.js';
import { SUBSCRIPTIONS_PROGRAM_ADDRESS } from '../generated/index.js';
import type { Delegation } from '../types/delegation.js';
import type { RawProgramAccount } from './decode.js';
import { decodeDelegationAccount } from './decode.js';

/**
 * Fetches all delegation accounts (fixed, recurring, and subscription) for a delegator.
 *
 * @param rpc - An RPC client supporting `getProgramAccounts`.
 * @param wallet - The delegator's wallet address.
 * @returns All decoded delegations owned by the wallet.
 */
export async function fetchDelegationsByDelegator(
    rpc: Rpc<GetProgramAccountsApi>,
    wallet: Address,
    programAddress?: Address,
): Promise<Delegation[]> {
    return await fetchDelegationsByOffset(rpc, wallet, DELEGATOR_OFFSET, programAddress);
}

/**
 * Fetches all delegation accounts (fixed, recurring, and subscription) for a delegatee.
 *
 * @param rpc - An RPC client supporting `getProgramAccounts`.
 * @param wallet - The delegatee's wallet address.
 * @param programAddress - Optional program address override.
 * @returns All decoded delegations where the wallet is the delegatee.
 */
export async function fetchDelegationsByDelegatee(
    rpc: Rpc<GetProgramAccountsApi>,
    wallet: Address,
    programAddress?: Address,
): Promise<Delegation[]> {
    return await fetchDelegationsByOffset(rpc, wallet, DELEGATEE_OFFSET, programAddress);
}

async function fetchDelegationsByOffset(
    rpc: Rpc<GetProgramAccountsApi>,
    wallet: Address,
    offset: number,
    programAddress?: Address,
): Promise<Delegation[]> {
    const progAddr = programAddress ?? SUBSCRIPTIONS_PROGRAM_ADDRESS;
    const response = await rpc
        .getProgramAccounts(progAddr, {
            encoding: 'base64',
            filters: [
                {
                    memcmp: {
                        bytes: wallet as string as Base58EncodedBytes,
                        encoding: 'base58',
                        offset: BigInt(offset),
                    },
                },
            ],
        })
        .send();

    return response
        .map(account => decodeDelegationAccount(account as unknown as RawProgramAccount, progAddr))
        .filter((d): d is Delegation => d !== null);
}
