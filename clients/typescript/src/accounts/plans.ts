import type { Address, Base58EncodedBytes, GetProgramAccountsApi, Rpc } from '@solana/kit';

import { PLAN_OWNER_OFFSET, PLAN_SIZE } from '../constants.js';
import { decodePlan, SUBSCRIPTIONS_PROGRAM_ADDRESS } from '../generated/index.js';
import type { PlanWithAddress } from '../types/plan.js';
import type { RawProgramAccount } from './decode.js';
import { toEncodedAccount } from './decode.js';

/**
 * Fetches all plan accounts owned by a given address, filtered by account size.
 *
 * @param rpc - An RPC client supporting `getProgramAccounts`.
 * @param owner - The plan owner's wallet address.
 * @returns All decoded plans belonging to the owner.
 */
export async function fetchPlansForOwner(
    rpc: Rpc<GetProgramAccountsApi>,
    owner: Address,
    programAddress?: Address,
): Promise<PlanWithAddress[]> {
    const progAddr = programAddress ?? SUBSCRIPTIONS_PROGRAM_ADDRESS;
    const response = await rpc
        .getProgramAccounts(progAddr, {
            encoding: 'base64',
            filters: [
                { dataSize: BigInt(PLAN_SIZE) },
                {
                    memcmp: {
                        bytes: owner as string as Base58EncodedBytes,
                        encoding: 'base58',
                        offset: BigInt(PLAN_OWNER_OFFSET),
                    },
                },
            ],
        })
        .send();

    return response.map(account => {
        const encoded = toEncodedAccount(account as unknown as RawProgramAccount, progAddr);
        const { address, data } = decodePlan(encoded);
        return { address, data };
    });
}
