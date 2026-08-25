import { getAddressEncoder, getProgramDerivedAddress, getUtf8Encoder } from '@solana/kit';
import { generateKeyPairSigner } from '@solana/kit';
import { describe, expect, test } from 'vitest';
import { SUBSCRIPTIONS_PROGRAM_ADDRESS } from '../src/generated/index.ts';
import { buildPendingTransferContext, DelegationKind } from '../src/transfer-context.ts';

const INITIATOR_OFFSET = 3;
const ADDRESS_LEN = 32;

describe('pending transfer context', () => {
    test('addresses the PDA the program creates during the transfer', async () => {
        const [authority, initiator, delegation, mint] = await Promise.all([
            generateKeyPairSigner(),
            generateKeyPairSigner(),
            generateKeyPairSigner(),
            generateKeyPairSigner(),
        ]);

        const context = await buildPendingTransferContext({
            amount: 1_000n,
            delegation: delegation.address,
            delegationKind: DelegationKind.FixedDelegation,
            initiator: initiator.address,
            mint: mint.address,
            subscriptionAuthority: authority.address,
        });

        const [expected] = await getProgramDerivedAddress({
            programAddress: SUBSCRIPTIONS_PROGRAM_ADDRESS,
            seeds: [getUtf8Encoder().encode('TransferContext'), getAddressEncoder().encode(authority.address)],
        });
        expect(context.address).toBe(expected);
    });

    test('places the initiator where hook seeds expect it', async () => {
        const [authority, initiator, delegation, mint] = await Promise.all([
            generateKeyPairSigner(),
            generateKeyPairSigner(),
            generateKeyPairSigner(),
            generateKeyPairSigner(),
        ]);

        const context = await buildPendingTransferContext({
            amount: 1_000n,
            delegation: delegation.address,
            delegationKind: DelegationKind.RecurringDelegation,
            initiator: initiator.address,
            mint: mint.address,
            subscriptionAuthority: authority.address,
        });

        const initiatorBytes = context.data.subarray(INITIATOR_OFFSET, INITIATOR_OFFSET + ADDRESS_LEN);
        expect(Array.from(initiatorBytes)).toEqual(Array.from(getAddressEncoder().encode(initiator.address)));
        expect(context.data[0]).toBe(6);
    });
});
