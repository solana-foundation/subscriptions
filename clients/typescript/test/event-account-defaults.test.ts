import { generateKeyPairSigner } from '@solana/kit';
import { describe, expect, test } from 'vitest';

import {
    findEventAuthorityPda,
    getCancelSubscriptionInstructionAsync,
    getCancelSubscriptionNowInstructionAsync,
} from '../src/index.ts';

describe('generated event-emitting builders resolve event accounts from the active program address', () => {
    test('cancelSubscription defaults eventAuthority + selfProgram to a custom programAddress', async () => {
        const programAddress = (await generateKeyPairSigner()).address;
        const subscriber = await generateKeyPairSigner();
        const planPda = (await generateKeyPairSigner()).address;

        const ix = await getCancelSubscriptionInstructionAsync({ planPda, subscriber }, { programAddress });

        const accountAddresses = ix.accounts.map(a => a.address);
        const [eventAuthorityForCustom] = await findEventAuthorityPda({ programAddress });
        const [eventAuthorityForDefault] = await findEventAuthorityPda();

        expect(ix.programAddress).toBe(programAddress);
        expect(accountAddresses).toContain(eventAuthorityForCustom);
        expect(accountAddresses).toContain(programAddress);
        expect(accountAddresses).not.toContain(eventAuthorityForDefault);
    });

    test('cancelSubscriptionNow defaults eventAuthority + selfProgram to a custom programAddress', async () => {
        const programAddress = (await generateKeyPairSigner()).address;
        const subscriber = await generateKeyPairSigner();
        const merchant = await generateKeyPairSigner();
        const planPda = (await generateKeyPairSigner()).address;

        const ix = await getCancelSubscriptionNowInstructionAsync(
            { merchant, planPda, subscriber, cancelSubscriptionNowData: { expectedCurrentPeriodStartTs: 0n } },
            { programAddress },
        );

        const accountAddresses = ix.accounts.map(a => a.address);
        const [eventAuthorityForCustom] = await findEventAuthorityPda({ programAddress });
        const [eventAuthorityForDefault] = await findEventAuthorityPda();

        expect(ix.programAddress).toBe(programAddress);
        expect(accountAddresses).toContain(eventAuthorityForCustom);
        expect(accountAddresses).toContain(programAddress);
        expect(accountAddresses).not.toContain(eventAuthorityForDefault);
    });
});
