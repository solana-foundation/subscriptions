import { getAddressEncoder, getProgramDerivedAddress, getUtf8Encoder } from '@solana/kit';
import { generateKeyPairSigner } from '@solana/kit';
import { describe, expect, test } from 'vitest';
import { AccountDiscriminator, SUBSCRIPTIONS_PROGRAM_ADDRESS } from '../src/generated/index.ts';
import { buildPendingTransferContext } from '../src/transfer-context.ts';

const INITIATOR_OFFSET = 2;
const ADDRESS_LEN = 32;

describe('pending transfer context', () => {
    test('addresses the PDA the program creates during the transfer', async () => {
        const [authority, initiator, delegation] = await Promise.all([
            generateKeyPairSigner(),
            generateKeyPairSigner(),
            generateKeyPairSigner(),
        ]);

        const context = await buildPendingTransferContext({
            delegation: delegation.address,
            delegationKind: AccountDiscriminator.FixedDelegation,
            initiator: initiator.address,
            subscriptionAuthority: authority.address,
        });

        const [expected] = await getProgramDerivedAddress({
            programAddress: SUBSCRIPTIONS_PROGRAM_ADDRESS,
            seeds: [getUtf8Encoder().encode('TransferContext'), getAddressEncoder().encode(authority.address)],
        });
        expect(context.address).toBe(expected);
    });

    test('places the initiator where hook seeds expect it', async () => {
        const [authority, initiator, delegation] = await Promise.all([
            generateKeyPairSigner(),
            generateKeyPairSigner(),
            generateKeyPairSigner(),
        ]);

        const context = await buildPendingTransferContext({
            delegation: delegation.address,
            delegationKind: AccountDiscriminator.RecurringDelegation,
            initiator: initiator.address,
            subscriptionAuthority: authority.address,
        });

        const initiatorBytes = context.data.subarray(INITIATOR_OFFSET, INITIATOR_OFFSET + ADDRESS_LEN);
        expect(Array.from(initiatorBytes)).toEqual(Array.from(getAddressEncoder().encode(initiator.address)));
        expect(context.data[0]).toBe(5);
    });
});
