import {
    address,
    getAddressEncoder,
    getProgramDerivedAddress,
    type Address,
    type Instruction,
    type TransactionSigner,
} from '@solana/kit';
import { findAssociatedTokenPda } from '@solana-program/token';
import { packInstructionBatches } from './tx-packer';

const SUBSCRIPTION_AUTHORITY_SEED = 'SubscriptionAuthority';
const FAILURE_CACHE_STORAGE_KEY = 'collect-payments-subscriber-failures';

const addressEncoder = getAddressEncoder();
const textEncoder = new TextEncoder();

export interface EligibleSubscriber {
    subscriptionAddress: string;
    delegator: string;
    collectAmount: bigint;
}

export interface PlanTermsFingerprint {
    amount: bigint;
    periodHours: bigint;
    createdAt: bigint;
}

export interface PlanSubscriberForCollection {
    subscriptionAddress: string;
    delegator: string;
    terms: PlanTermsFingerprint;
    amountPulledInPeriod: bigint;
    currentPeriodStartTs: bigint;
    expiresAtTs: bigint;
}

export interface CollectableSubscriber {
    subscriptionAddress: string;
    delegator: string;
    amount: bigint;
}

export interface SubscriberTransfer<TSubscriber extends CollectableSubscriber = CollectableSubscriber> {
    subscriber: TSubscriber;
    instruction: Instruction;
}

export interface ConfirmedSubscriberTransfer<TSubscriber extends CollectableSubscriber = CollectableSubscriber> {
    subscriber: TSubscriber;
    signature: string;
}

export type SubscriberPaymentFailureReason =
    | 'known-unpayable-token-state'
    | 'missing-token-account'
    | 'invalid-token-account'
    | 'wrong-mint'
    | 'wrong-owner'
    | 'insufficient-balance'
    | 'wrong-delegate'
    | 'insufficient-delegated-amount'
    | 'transfer-failed';

export interface SubscriberPaymentFailure<TSubscriber extends CollectableSubscriber = CollectableSubscriber> {
    subscriber: TSubscriber;
    reason: SubscriberPaymentFailureReason;
    message: string;
}

export interface PayableSubscribersResult<TSubscriber extends CollectableSubscriber = CollectableSubscriber> {
    payable: TSubscriber[];
    failures: SubscriberPaymentFailure<TSubscriber>[];
}

export interface SubscriberInstructionSendResult<TSubscriber extends CollectableSubscriber = CollectableSubscriber> {
    signatures: string[];
    confirmed: ConfirmedSubscriberTransfer<TSubscriber>[];
    collected: number;
    failures: SubscriberPaymentFailure<TSubscriber>[];
}

interface TokenAccountRpc {
    getAccountInfo(
        account: Address,
        config: { encoding: 'jsonParsed'; commitment: 'confirmed' },
    ): {
        send(): Promise<{ value: unknown }>;
    };
}

interface ParsedTokenAccount {
    mint: string;
    owner: string;
    balance: bigint;
    delegate: string | null;
    delegatedAmount: bigint;
}

interface CachedFailure {
    reason: SubscriberPaymentFailureReason;
    message: string;
    stateHash: string;
    failedAt: number;
}

export function hasMatchingPlanTerms(sub: PlanSubscriberForCollection, planTerms: PlanTermsFingerprint): boolean {
    return (
        sub.terms.amount === planTerms.amount &&
        sub.terms.periodHours === planTerms.periodHours &&
        sub.terms.createdAt === planTerms.createdAt
    );
}

export function getStalePlanSubscribers<T extends PlanSubscriberForCollection>(
    subscribers: T[],
    planTerms: PlanTermsFingerprint,
): T[] {
    return subscribers.filter(sub => !hasMatchingPlanTerms(sub, planTerms));
}

export function computeEligibleSubscribers(
    subscribers: PlanSubscriberForCollection[],
    planTerms: PlanTermsFingerprint,
    currentTs: number,
): EligibleSubscriber[] {
    if (planTerms.amount <= 0n || planTerms.periodHours <= 0n) return [];

    const eligible: EligibleSubscriber[] = [];

    for (const sub of subscribers) {
        if (sub.expiresAtTs !== 0n && currentTs >= Number(sub.expiresAtTs)) continue;
        if (!hasMatchingPlanTerms(sub, planTerms)) continue;

        const periodEnd = Number(sub.currentPeriodStartTs) + Number(planTerms.periodHours) * 3600;
        const collectAmount = currentTs >= periodEnd ? planTerms.amount : planTerms.amount - sub.amountPulledInPeriod;

        if (collectAmount <= 0n) continue;

        eligible.push({
            subscriptionAddress: sub.subscriptionAddress,
            delegator: sub.delegator,
            collectAmount,
        });
    }

    return eligible;
}

export async function filterPayableSubscribers<TSubscriber extends CollectableSubscriber>({
    rpc,
    subscribers,
    mint,
    tokenProgram,
    programAddress,
}: {
    rpc: TokenAccountRpc;
    subscribers: TSubscriber[];
    mint: Address;
    tokenProgram: Address;
    programAddress: Address;
}): Promise<PayableSubscribersResult<TSubscriber>> {
    const results = await Promise.all(
        subscribers.map(subscriber =>
            checkSubscriberTokenReadiness({
                rpc,
                subscriber,
                mint,
                tokenProgram,
                programAddress,
            }),
        ),
    );

    const payable: TSubscriber[] = [];
    const failures: SubscriberPaymentFailure<TSubscriber>[] = [];

    for (const result of results) {
        if (result.failure) {
            failures.push(result.failure);
        } else {
            payable.push(result.subscriber);
        }
    }

    return { payable, failures };
}

export async function sendBatchedSubscriberInstructions<TSubscriber extends CollectableSubscriber>({
    transfers,
    feePayer,
    sendInstructions,
}: {
    transfers: SubscriberTransfer<TSubscriber>[];
    feePayer: TransactionSigner;
    sendInstructions: (instructions: Instruction[]) => Promise<string>;
}): Promise<SubscriberInstructionSendResult<TSubscriber>> {
    const signatures: string[] = [];
    const confirmed: ConfirmedSubscriberTransfer<TSubscriber>[] = [];
    const failures: SubscriberPaymentFailure<TSubscriber>[] = [];
    let collected = 0;
    const transferByInstruction = new Map<Instruction, SubscriberTransfer<TSubscriber>>();

    for (const transfer of transfers) {
        transferByInstruction.set(transfer.instruction, transfer);
    }

    const batches = packInstructionBatches(
        transfers.map(transfer => transfer.instruction),
        feePayer,
    );

    async function sendGroup(group: SubscriberTransfer<TSubscriber>[]): Promise<void> {
        if (group.length === 0) return;

        try {
            const signature = await sendInstructions(group.map(transfer => transfer.instruction));
            signatures.push(signature);
            collected += group.length;
            for (const transfer of group) {
                confirmed.push({ subscriber: transfer.subscriber, signature });
                clearCachedFailure(transfer.subscriber);
            }
        } catch (err) {
            if (group.length === 1) {
                const [transfer] = group;
                failures.push({
                    subscriber: transfer.subscriber,
                    reason: 'transfer-failed',
                    message: errorMessage(err),
                });
                return;
            }

            const mid = Math.floor(group.length / 2);
            await sendGroup(group.slice(0, mid));
            await sendGroup(group.slice(mid));
        }
    }

    for (const batch of batches) {
        const group = batch
            .map(instruction => transferByInstruction.get(instruction))
            .filter((transfer): transfer is SubscriberTransfer<TSubscriber> => transfer !== undefined);
        await sendGroup(group);
    }

    return { signatures, confirmed, collected, failures };
}

async function checkSubscriberTokenReadiness<TSubscriber extends CollectableSubscriber>({
    rpc,
    subscriber,
    mint,
    tokenProgram,
    programAddress,
}: {
    rpc: TokenAccountRpc;
    subscriber: TSubscriber;
    mint: Address;
    tokenProgram: Address;
    programAddress: Address;
}): Promise<{ subscriber: TSubscriber; failure: SubscriberPaymentFailure<TSubscriber> | null }> {
    const delegator = address(subscriber.delegator);
    const [delegatorAta] = await findAssociatedTokenPda({
        mint,
        owner: delegator,
        tokenProgram,
    });
    const [subscriptionAuthority] = await getSubscriptionAuthorityPda(delegator, mint, programAddress);
    const account = await rpc.getAccountInfo(delegatorAta, { encoding: 'jsonParsed', commitment: 'confirmed' }).send();

    if (!account.value) {
        return failReadiness(
            subscriber,
            'missing-token-account',
            `Subscriber token account ${delegatorAta} does not exist`,
            `missing:${delegatorAta}:${subscriber.amount}`,
        );
    }

    const parsed = parseTokenAccount(account.value);
    if (!parsed) {
        return failReadiness(
            subscriber,
            'invalid-token-account',
            `Subscriber token account ${delegatorAta} is not a parsed token account`,
            `invalid:${delegatorAta}:${subscriber.amount}`,
        );
    }

    const stateHash = tokenStateHash(parsed, subscriber.amount);
    const cached = readCachedFailure(subscriber);
    if (cached?.stateHash === stateHash) {
        return {
            subscriber,
            failure: {
                subscriber,
                reason: 'known-unpayable-token-state',
                message: cached.message,
            },
        };
    }

    if (parsed.mint !== String(mint)) {
        return failReadiness(
            subscriber,
            'wrong-mint',
            'Subscriber token account mint does not match the plan mint',
            stateHash,
        );
    }
    if (parsed.owner !== String(delegator)) {
        return failReadiness(
            subscriber,
            'wrong-owner',
            'Subscriber token account owner does not match the subscriber',
            stateHash,
        );
    }
    if (parsed.balance < subscriber.amount) {
        return failReadiness(
            subscriber,
            'insufficient-balance',
            'Subscriber token account balance is below the collectible amount',
            stateHash,
        );
    }
    if (parsed.delegate !== String(subscriptionAuthority)) {
        return failReadiness(
            subscriber,
            'wrong-delegate',
            'Subscriber token account is not delegated to the subscription authority',
            stateHash,
        );
    }
    if (parsed.delegatedAmount < subscriber.amount) {
        return failReadiness(
            subscriber,
            'insufficient-delegated-amount',
            'Subscriber delegated amount is below the collectible amount',
            stateHash,
        );
    }

    clearCachedFailure(subscriber);
    return { subscriber, failure: null };
}

async function getSubscriptionAuthorityPda(
    user: Address,
    tokenMint: Address,
    programAddress: Address,
): Promise<readonly [Address, number]> {
    return getProgramDerivedAddress({
        programAddress,
        seeds: [
            textEncoder.encode(SUBSCRIPTION_AUTHORITY_SEED),
            addressEncoder.encode(user),
            addressEncoder.encode(tokenMint),
        ],
    });
}

function failReadiness<TSubscriber extends CollectableSubscriber>(
    subscriber: TSubscriber,
    reason: SubscriberPaymentFailureReason,
    message: string,
    stateHash: string,
): { subscriber: TSubscriber; failure: SubscriberPaymentFailure<TSubscriber> } {
    writeCachedFailure(subscriber, { reason, message, stateHash, failedAt: Date.now() });
    return { subscriber, failure: { subscriber, reason, message } };
}

function parseTokenAccount(value: unknown): ParsedTokenAccount | null {
    if (!isRecord(value)) return null;
    const data = value.data;
    if (!isRecord(data)) return null;
    const parsed = data.parsed;
    if (!isRecord(parsed)) return null;
    const info = parsed.info;
    if (!isRecord(info)) return null;

    const mint = stringField(info, 'mint');
    const owner = stringField(info, 'owner');
    const balance = amountField(info, 'tokenAmount');
    if (mint === null || owner === null || balance === null) return null;

    return {
        mint,
        owner,
        balance,
        delegate: stringField(info, 'delegate'),
        delegatedAmount: amountField(info, 'delegatedAmount') ?? 0n,
    };
}

function amountField(record: Record<string, unknown>, key: string): bigint | null {
    const field = record[key];
    if (!isRecord(field) || typeof field.amount !== 'string') return null;
    try {
        return BigInt(field.amount);
    } catch {
        return null;
    }
}

function stringField(record: Record<string, unknown>, key: string): string | null {
    const field = record[key];
    return typeof field === 'string' ? field : null;
}

function tokenStateHash(account: ParsedTokenAccount, amount: bigint): string {
    return [
        account.mint,
        account.owner,
        account.balance.toString(),
        account.delegate ?? '',
        account.delegatedAmount.toString(),
        amount.toString(),
    ].join(':');
}

function errorMessage(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
}

function cacheKey(subscriber: CollectableSubscriber): string {
    return `${subscriber.subscriptionAddress}:${subscriber.delegator}`;
}

function readCachedFailure(subscriber: CollectableSubscriber): CachedFailure | null {
    const cache = readFailureCache();
    return cache[cacheKey(subscriber)] ?? null;
}

function writeCachedFailure(subscriber: CollectableSubscriber, failure: CachedFailure): void {
    const cache = readFailureCache();
    cache[cacheKey(subscriber)] = failure;
    writeFailureCache(cache);
}

function clearCachedFailure(subscriber: CollectableSubscriber): void {
    const cache = readFailureCache();
    const key = cacheKey(subscriber);
    if (!(key in cache)) return;
    delete cache[key];
    writeFailureCache(cache);
}

function readFailureCache(): Record<string, CachedFailure> {
    if (typeof localStorage === 'undefined') return {};
    try {
        const raw = localStorage.getItem(FAILURE_CACHE_STORAGE_KEY);
        if (!raw) return {};
        const parsed: unknown = JSON.parse(raw);
        return isCachedFailureMap(parsed) ? parsed : {};
    } catch {
        return {};
    }
}

function writeFailureCache(cache: Record<string, CachedFailure>): void {
    if (typeof localStorage === 'undefined') return;
    try {
        localStorage.setItem(FAILURE_CACHE_STORAGE_KEY, JSON.stringify(cache));
    } catch {
        return;
    }
}

function isCachedFailureMap(value: unknown): value is Record<string, CachedFailure> {
    if (!isRecord(value)) return false;
    return Object.values(value).every(entry => {
        if (!isRecord(entry)) return false;
        return (
            typeof entry.reason === 'string' &&
            typeof entry.message === 'string' &&
            typeof entry.stateHash === 'string' &&
            typeof entry.failedAt === 'number'
        );
    });
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null;
}
