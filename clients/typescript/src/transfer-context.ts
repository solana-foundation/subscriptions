/**
 * Client-side construction of the ephemeral `TransferContext` a transfer hook
 * resolves during a pull. The program creates and closes it inside the transfer
 * instruction, so no RPC can ever read it: hook seeds over its contents resolve
 * against the bytes the program is about to write.
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
    delegation: Address;
    delegationKind: DelegationKind;
    initiator: Address;
    programAddress?: Address;
    subscriptionAuthority: Address;
};

/** The context address and the bytes it will hold while the hook runs. */
export async function buildPendingTransferContext(
    input: PendingTransferContextInput,
): Promise<{ address: Address; data: ReadonlyUint8Array; initiator: Address }> {
    const programAddress = input.programAddress ?? SUBSCRIPTIONS_PROGRAM_ADDRESS;
    const [address] = await getProgramDerivedAddress({
        programAddress,
        seeds: [
            getUtf8Encoder().encode(TRANSFER_CONTEXT_SEED),
            getAddressEncoder().encode(input.subscriptionAuthority),
        ],
    });

    const data = getTransferContextEncoder().encode({
        delegation: input.delegation,
        delegationKind: input.delegationKind,
        discriminator: TRANSFER_CONTEXT_DISCRIMINATOR,
        initiator: input.initiator,
        version: TRANSFER_CONTEXT_VERSION,
    });

    return { address, data, initiator: input.initiator };
}
