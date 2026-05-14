import { createClient, generateKeyPairSigner, type Address, type KeyPairSigner } from '@solana/kit';
import { solanaDevnetRpc } from '@solana/kit-plugin-rpc';
import { signer, signerFromFile } from '@solana/kit-plugin-signer';
import { findAssociatedTokenPda, TOKEN_PROGRAM_ADDRESS, tokenProgram } from '@solana-program/token';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import {
    fetchFixedDelegation,
    fetchMaybeFixedDelegation,
    fetchMaybeRecurringDelegation,
    fetchMaybeSubscriptionAuthority,
    fetchRecurringDelegation,
    fetchSubscriptionDelegation,
    findFixedDelegationPda,
    findPlanPda,
    findRecurringDelegationPda,
    findSubscriptionAuthorityPda,
    findSubscriptionDelegationPda,
    subscriptionsProgram,
} from '@subscriptions/client';

const RPC_URL = process.env.GUIDE_DEVNET_RPC_URL ?? 'https://api.devnet.solana.com';
const KEYPAIR_PATH = process.env.GUIDE_DEVNET_KEYPAIR ?? path.join(os.homedir(), '.config', 'solana', 'id.json');
const DECIMALS = 6;
const STARTING_TOKEN_BALANCE = 10_000_000n;
const MINIMUM_BALANCE_LAMPORTS = 200_000_000n;
const ACTOR_FUNDING_SOL = '0.05';

type GuideClient = ReturnType<typeof createGuideClient>;

function explorerAddress(address: Address | string) {
    return `https://explorer.solana.com/address/${address}?cluster=devnet`;
}

function explorerTx(signature: string) {
    return `https://explorer.solana.com/tx/${signature}?cluster=devnet`;
}

function logSection(title: string) {
    console.log(`\n## ${title}`);
}

function logAddress(label: string, address: Address | string) {
    console.log(`${label}: ${address}`);
    console.log(`${label} Explorer: ${explorerAddress(address)}`);
}

function logSignature(label: string, signature: unknown) {
    const value = signatureFromResult(signature);
    console.log(`${label}: ${value}`);
    console.log(`${label} Explorer: ${explorerTx(value)}`);
}

function signatureFromResult(result: unknown): string {
    if (typeof result === 'string') return result;
    if (result && typeof result === 'object') {
        const context = (result as { context?: { signature?: unknown } }).context;
        if (typeof context?.signature === 'string') return context.signature;
        const signature = (result as { signature?: unknown }).signature;
        if (typeof signature === 'string') return signature;
    }
    throw new Error(`Unable to extract transaction signature from ${JSON.stringify(result)}`);
}

function createGuideClient(identity: KeyPairSigner) {
    return createClient()
        .use(signer(identity))
        .use(solanaDevnetRpc({ rpcUrl: RPC_URL }))
        .use(tokenProgram())
        .use(subscriptionsProgram());
}

async function createSponsorClient() {
    return (await createClient().use(signerFromFile(KEYPAIR_PATH)))
        .use(solanaDevnetRpc({ rpcUrl: RPC_URL }))
        .use(tokenProgram())
        .use(subscriptionsProgram());
}

async function fundFromSponsor(client: GuideClient, recipient: Address) {
    const balance = await client.rpc.getBalance(recipient).send();
    if (balance.value >= MINIMUM_BALANCE_LAMPORTS) return;

    const output = execFileSync(
        'solana',
        [
            'transfer',
            recipient,
            ACTOR_FUNDING_SOL,
            '--from',
            KEYPAIR_PATH,
            '--url',
            RPC_URL,
            '--allow-unfunded-recipient',
        ],
        { encoding: 'utf-8' },
    );
    const signature = /Signature:\s*(\S+)/.exec(output)?.[1];
    if (signature) logSignature(`fund ${recipient}`, signature);
}

async function assertSponsorFunded(client: GuideClient, sponsor: KeyPairSigner) {
    const balance = await client.rpc.getBalance(sponsor.address).send();
    if (balance.value >= MINIMUM_BALANCE_LAMPORTS) return;

    throw new Error(
        `Devnet sponsor ${sponsor.address} has ${balance.value} lamports. ` +
            `Fund ${KEYPAIR_PATH} on devnet or set GUIDE_DEVNET_KEYPAIR to a funded keypair.`,
    );
}

async function createMint(client: GuideClient, mintAuthority: KeyPairSigner): Promise<Address> {
    const mint = await generateKeyPairSigner();
    const signature = await client.token.instructions
        .createMint({
            decimals: DECIMALS,
            freezeAuthority: null,
            mintAuthority: mintAuthority.address,
            newMint: mint,
        })
        .sendTransaction();
    logAddress('token mint', mint.address);
    logSignature('create mint tx', signature);
    return mint.address;
}

async function mintToAta(client: GuideClient, mint: Address, owner: Address, amount: bigint): Promise<Address> {
    const [ata] = await findAssociatedTokenPda({
        mint,
        owner,
        tokenProgram: TOKEN_PROGRAM_ADDRESS,
    });
    const signature = await client.token.instructions
        .mintToATA({
            amount,
            decimals: DECIMALS,
            mint,
            mintAuthority: client.identity,
            owner,
        })
        .sendTransaction();
    logAddress(`token account for ${owner}`, ata);
    logSignature(`mint ${amount} tokens tx`, signature);
    return ata;
}

async function getTokenBalance(client: GuideClient, ata: Address): Promise<bigint> {
    const balance = await client.rpc.getTokenAccountBalance(ata).send();
    return BigInt(balance.value.amount);
}

async function ensureSubscriptionAuthority(client: GuideClient, user: KeyPairSigner, tokenMint: Address, userAta: Address) {
    const [subscriptionAuthorityPda] = await findSubscriptionAuthorityPda({
        tokenMint,
        user: user.address,
    });

    const subscriptionAuthority = await fetchMaybeSubscriptionAuthority(client.rpc, subscriptionAuthorityPda);
    if (!subscriptionAuthority.exists) {
        const signature = await client.subscriptions.instructions
            .initSubscriptionAuthority({
                tokenMint,
                tokenProgram: TOKEN_PROGRAM_ADDRESS,
                userAta,
            })
            .sendTransaction();
        logSignature('init subscription authority tx', signature);
    }

    logAddress('subscription authority PDA', subscriptionAuthorityPda);
    return subscriptionAuthorityPda;
}

async function closeSubscriptionAuthority(client: GuideClient, user: KeyPairSigner, tokenMint: Address, label = '') {
    const [subscriptionAuthorityPda] = await findSubscriptionAuthorityPda({
        tokenMint,
        user: user.address,
    });
    const signature = await client.subscriptions.instructions
        .closeSubscriptionAuthority({
            tokenMint,
            user,
        })
        .sendTransaction();
    logSignature(`${label}close subscription authority tx`, signature);

    const subscriptionAuthority = await fetchMaybeSubscriptionAuthority(client.rpc, subscriptionAuthorityPda);
    if (subscriptionAuthority.exists) throw new Error(`${label}subscription authority close check failed`);
}

async function testFixedDelegation(sponsorClient: GuideClient) {
    logSection('Fixed Delegation');

    const userSigner = await generateKeyPairSigner();
    const delegateeSigner = await generateKeyPairSigner();
    const userClient = createGuideClient(userSigner);
    const delegateeClient = createGuideClient(delegateeSigner);

    logAddress('user wallet', userSigner.address);
    logAddress('delegatee wallet', delegateeSigner.address);

    await fundFromSponsor(sponsorClient, userSigner.address);
    await fundFromSponsor(sponsorClient, delegateeSigner.address);

    const tokenMint = await createMint(userClient, userSigner);
    const userAta = await mintToAta(userClient, tokenMint, userSigner.address, STARTING_TOKEN_BALANCE);
    const receiverAta = await mintToAta(userClient, tokenMint, delegateeSigner.address, 0n);

    const nonce = BigInt(Date.now());
    const amount = 1_000_000n;
    const expiryTs = BigInt(Math.floor(Date.now() / 1000) + 60 * 60);
    const subscriptionAuthorityPda = await ensureSubscriptionAuthority(userClient, userSigner, tokenMint, userAta);

    const createDelegationSignature = await userClient.subscriptions.instructions
        .createFixedDelegation({
            amount,
            delegatee: delegateeSigner.address,
            expiryTs,
            nonce,
            tokenMint,
        })
        .sendTransaction();
    logSignature('create fixed delegation tx', createDelegationSignature);

    const [delegationPda] = await findFixedDelegationPda({
        delegatee: delegateeSigner.address,
        delegator: userSigner.address,
        nonce,
        subscriptionAuthority: subscriptionAuthorityPda,
    });
    logAddress('fixed delegation PDA', delegationPda);

    const before = await getTokenBalance(userClient, receiverAta);
    const transferSignature = await delegateeClient.subscriptions.instructions
        .transferFixed({
            amount: 100_000n,
            delegatee: delegateeSigner,
            delegationPda,
            delegator: userSigner.address,
            delegatorAta: userAta,
            receiverAta,
            tokenMint,
            tokenProgram: TOKEN_PROGRAM_ADDRESS,
        })
        .sendTransaction();
    logSignature('transfer fixed tx', transferSignature);

    const after = await getTokenBalance(userClient, receiverAta);
    if (after - before !== 100_000n) throw new Error('fixed delegation transfer balance check failed');

    const delegation = await fetchFixedDelegation(userClient.rpc, delegationPda);
    if (delegation.data.amount !== amount - 100_000n) throw new Error('fixed delegation remaining amount check failed');

    const revokeSignature = await userClient.subscriptions.instructions
        .revokeDelegation({
            authority: userSigner,
            delegationAccount: delegationPda,
        })
        .sendTransaction();
    logSignature('revoke fixed delegation tx', revokeSignature);

    const revokedDelegation = await fetchMaybeFixedDelegation(userClient.rpc, delegationPda);
    if (revokedDelegation.exists) throw new Error('fixed delegation revoke check failed');

    await closeSubscriptionAuthority(userClient, userSigner, tokenMint, 'fixed delegation ');
}

async function testSubscriptionAuthorityLifecycle(sponsorClient: GuideClient) {
    logSection('Subscription Authority Lifecycle');

    const userSigner = await generateKeyPairSigner();
    const userClient = createGuideClient(userSigner);
    logAddress('user wallet', userSigner.address);

    await fundFromSponsor(sponsorClient, userSigner.address);

    const tokenMint = await createMint(userClient, userSigner);
    const userAta = await mintToAta(userClient, tokenMint, userSigner.address, STARTING_TOKEN_BALANCE);
    const subscriptionAuthorityPda = await ensureSubscriptionAuthority(userClient, userSigner, tokenMint, userAta);

    const subscriptionAuthority = await fetchMaybeSubscriptionAuthority(userClient.rpc, subscriptionAuthorityPda);
    if (!subscriptionAuthority.exists) throw new Error('subscription authority init check failed');

    await closeSubscriptionAuthority(userClient, userSigner, tokenMint, 'standalone ');
}

async function testRecurringDelegation(sponsorClient: GuideClient) {
    logSection('Recurring Delegation');

    const userSigner = await generateKeyPairSigner();
    const delegateeSigner = await generateKeyPairSigner();
    const userClient = createGuideClient(userSigner);
    const delegateeClient = createGuideClient(delegateeSigner);

    logAddress('user wallet', userSigner.address);
    logAddress('delegatee wallet', delegateeSigner.address);

    await fundFromSponsor(sponsorClient, userSigner.address);
    await fundFromSponsor(sponsorClient, delegateeSigner.address);

    const tokenMint = await createMint(userClient, userSigner);
    const userAta = await mintToAta(userClient, tokenMint, userSigner.address, STARTING_TOKEN_BALANCE);
    const receiverAta = await mintToAta(userClient, tokenMint, delegateeSigner.address, 0n);

    const now = BigInt(Math.floor(Date.now() / 1000));
    const nonce = BigInt(Date.now() + 1);
    const amountPerPeriod = 1_000_000n;
    const periodLengthS = 86_400n;
    const startTs = now;
    const expiryTs = now + periodLengthS * 30n;
    const subscriptionAuthorityPda = await ensureSubscriptionAuthority(userClient, userSigner, tokenMint, userAta);

    const [delegationPda] = await findRecurringDelegationPda({
        delegatee: delegateeSigner.address,
        delegator: userSigner.address,
        nonce,
        subscriptionAuthority: subscriptionAuthorityPda,
    });
    logAddress('recurring delegation PDA', delegationPda);

    const createDelegationSignature = await userClient.subscriptions.instructions
        .createRecurringDelegation({
            amountPerPeriod,
            delegatee: delegateeSigner.address,
            expiryTs,
            nonce,
            periodLengthS,
            startTs,
            tokenMint,
        })
        .sendTransaction();
    logSignature('create recurring delegation tx', createDelegationSignature);

    const before = await getTokenBalance(userClient, receiverAta);
    const transferSignature = await delegateeClient.subscriptions.instructions
        .transferRecurring({
            amount: 100_000n,
            delegatee: delegateeSigner,
            delegationPda,
            delegator: userSigner.address,
            delegatorAta: userAta,
            receiverAta,
            tokenMint,
            tokenProgram: TOKEN_PROGRAM_ADDRESS,
        })
        .sendTransaction();
    logSignature('transfer recurring tx', transferSignature);

    const after = await getTokenBalance(userClient, receiverAta);
    if (after - before !== 100_000n) throw new Error('recurring delegation transfer balance check failed');

    const delegation = await fetchRecurringDelegation(userClient.rpc, delegationPda);
    if (delegation.data.amountPulledInPeriod !== 100_000n) {
        throw new Error('recurring delegation period amount check failed');
    }

    const revokeSignature = await userClient.subscriptions.instructions
        .revokeDelegation({
            authority: userSigner,
            delegationAccount: delegationPda,
        })
        .sendTransaction();
    logSignature('revoke recurring delegation tx', revokeSignature);

    const revokedDelegation = await fetchMaybeRecurringDelegation(userClient.rpc, delegationPda);
    if (revokedDelegation.exists) throw new Error('recurring delegation revoke check failed');

    await closeSubscriptionAuthority(userClient, userSigner, tokenMint, 'recurring delegation ');
}

async function testSubscriptionPlan(sponsorClient: GuideClient) {
    logSection('Subscription Plan');

    const merchantSigner = await generateKeyPairSigner();
    const subscriberSigner = await generateKeyPairSigner();
    const merchantClient = createGuideClient(merchantSigner);
    const subscriberClient = createGuideClient(subscriberSigner);

    logAddress('merchant wallet', merchantSigner.address);
    logAddress('subscriber wallet', subscriberSigner.address);

    await fundFromSponsor(sponsorClient, merchantSigner.address);
    await fundFromSponsor(sponsorClient, subscriberSigner.address);

    const tokenMint = await createMint(merchantClient, merchantSigner);
    const merchantAta = await mintToAta(merchantClient, tokenMint, merchantSigner.address, 0n);
    const subscriberAta = await mintToAta(merchantClient, tokenMint, subscriberSigner.address, STARTING_TOKEN_BALANCE);

    const planId = BigInt(Date.now());
    const amount = 5_000_000n;
    const periodHours = 720n;

    const createPlanSignature = await merchantClient.subscriptions.instructions
        .createPlan({
            amount,
            destinations: [merchantSigner.address],
            endTs: 0n,
            metadataUri: 'https://example.com/plan.json',
            mint: tokenMint,
            periodHours,
            planId,
            pullers: [],
        })
        .sendTransaction();
    logSignature('create plan tx', createPlanSignature);

    const [planPda] = await findPlanPda({
        owner: merchantSigner.address,
        planId,
    });
    logAddress('plan PDA', planPda);

    await ensureSubscriptionAuthority(subscriberClient, subscriberSigner, tokenMint, subscriberAta);

    const subscribeSignature = await subscriberClient.subscriptions.instructions
        .subscribe({
            merchant: merchantSigner.address,
            planId,
            tokenMint,
        })
        .sendTransaction();
    logSignature('subscribe tx', subscribeSignature);

    const [subscriptionPda] = await findSubscriptionDelegationPda({
        planPda,
        subscriber: subscriberSigner.address,
    });
    logAddress('subscription delegation PDA', subscriptionPda);

    const before = await getTokenBalance(merchantClient, merchantAta);
    const transferSignature = await merchantClient.subscriptions.instructions
        .transferSubscription({
            amount: 200_000n,
            caller: merchantSigner,
            delegator: subscriberSigner.address,
            planPda,
            receiverAta: merchantAta,
            subscriptionPda,
            tokenMint,
            tokenProgram: TOKEN_PROGRAM_ADDRESS,
        })
        .sendTransaction();
    logSignature('transfer subscription tx', transferSignature);

    const after = await getTokenBalance(merchantClient, merchantAta);
    if (after - before !== 200_000n) throw new Error('subscription transfer balance check failed');

    const subscription = await fetchSubscriptionDelegation(merchantClient.rpc, subscriptionPda);
    if (subscription.data.amountPulledInPeriod !== 200_000n) {
        throw new Error('subscription pulled amount check failed');
    }

    const cancelSignature = await subscriberClient.subscriptions.instructions
        .cancelSubscription({
            planPda,
            subscriber: subscriberSigner,
            subscriptionPda,
        })
        .sendTransaction();
    logSignature('cancel subscription tx', cancelSignature);

    const subscriptionAfterCancel = await fetchSubscriptionDelegation(subscriberClient.rpc, subscriptionPda);
    if (subscriptionAfterCancel.data.expiresAtTs === 0n) throw new Error('subscription cancel check failed');
}

async function main() {
    const selectedGuide = process.env.GUIDE_DEVNET_FLOW ?? 'all';
    console.log(`RPC: ${RPC_URL}`);
    console.log(`Sponsor keypair: ${KEYPAIR_PATH}`);

    const sponsorClient = await createSponsorClient();
    const sponsor = sponsorClient.identity;
    await assertSponsorFunded(sponsorClient, sponsor);
    logAddress('sponsor wallet', sponsor.address);

    if (selectedGuide === 'all' || selectedGuide === 'authority') await testSubscriptionAuthorityLifecycle(sponsorClient);
    if (selectedGuide === 'all' || selectedGuide === 'fixed') await testFixedDelegation(sponsorClient);
    if (selectedGuide === 'all' || selectedGuide === 'recurring') await testRecurringDelegation(sponsorClient);
    if (selectedGuide === 'all' || selectedGuide === 'plan') await testSubscriptionPlan(sponsorClient);

    console.log('Guide devnet checks passed.');
}

await main();
