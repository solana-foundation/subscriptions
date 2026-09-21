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

import { AccountDiscriminator, getTransferContextEncoder, SUBSCRIPTIONS_PROGRAM_ADDRESS } from './generated/index.js';

const TRANSFER_CONTEXT_SEED = 'TransferContext';
const TRANSFER_CONTEXT_VERSION = 1;

export type PendingTransferContextInput = {
    delegation: Address;
    delegationKind: AccountDiscriminator;
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
        discriminator: AccountDiscriminator.TransferContext,
        initiator: input.initiator,
        version: TRANSFER_CONTEXT_VERSION,
    });

    return { address, data, initiator: input.initiator };
}
