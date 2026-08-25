/**
 * Client-side construction of the ephemeral `TransferContext` a transfer hook
 * resolves during a pull.
 *
 * The program creates this account inside the transfer instruction and closes it
 * again before the instruction returns, so it never exists for an RPC to read.
 * Hook validation lists that seed on its contents (typically the initiator) can
 * still be resolved by handing the resolver the bytes the program is about to
 * write.
 */

import {
    type Address,
    getAddressEncoder,
    getProgramDerivedAddress,
    getUtf8Encoder,
    type ReadonlyUint8Array,
} from '@solana/kit';

import { getTransferContextEncoder, SUBSCRIPTIONS_PROGRAM_ADDRESS } from './generated/index.js';

const TRANSFER_CONTEXT_SEED = 'TransferContext';
const TRANSFER_CONTEXT_DISCRIMINATOR = 6;
const TRANSFER_CONTEXT_VERSION = 1;

/** Account-type discriminator of the delegation authorizing a pull. */
export const DelegationKind = {
    FixedDelegation: 2,
    RecurringDelegation: 3,
    SubscriptionDelegation: 4,
} as const;

export type DelegationKind = (typeof DelegationKind)[keyof typeof DelegationKind];

export type PendingTransferContextInput = {
    amount: bigint | number;
    delegation: Address;
    delegationKind: DelegationKind;
    initiator: Address;
    mint: Address;
    programAddress?: Address;
    subscriptionAuthority: Address;
};

/** The transfer context the program will publish for this pull: its address and
 * the bytes it will hold while the hook runs.
 *
 * `slot` is written on-chain and left zero here, so a hook that seeds on it
 * cannot be resolved client-side. */
export async function buildPendingTransferContext(
    input: PendingTransferContextInput,
): Promise<{ address: Address; data: ReadonlyUint8Array }> {
    const programAddress = input.programAddress ?? SUBSCRIPTIONS_PROGRAM_ADDRESS;
    const [address, bump] = await getProgramDerivedAddress({
        programAddress,
        seeds: [
            getUtf8Encoder().encode(TRANSFER_CONTEXT_SEED),
            getAddressEncoder().encode(input.subscriptionAuthority),
        ],
    });

    const data = getTransferContextEncoder().encode({
        amount: input.amount,
        bump,
        delegation: input.delegation,
        delegationKind: input.delegationKind,
        discriminator: TRANSFER_CONTEXT_DISCRIMINATOR,
        initiator: input.initiator,
        mint: input.mint,
        slot: 0n,
        version: TRANSFER_CONTEXT_VERSION,
    });

    return { address, data };
}
