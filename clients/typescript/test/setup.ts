import { type Address, createClient, generateKeyPairSigner, type KeyPairSigner, lamports } from '@solana/kit';
import { signer } from '@solana/kit-plugin-signer';
import { surfpool } from '@solana/surfpool/kit';
import {
    AccountState,
    findAssociatedTokenPda,
    getMintEncoder,
    getMintSize,
    getTokenEncoder,
    getTokenSize,
    TOKEN_PROGRAM_ADDRESS,
    tokenProgram,
} from '@solana-program/token';
import { expect } from 'vitest';
import { subscriptionsProgram } from '../src/index.js';
import {
    createSmartWallets as createAdapterSmartWallets,
    type SmartWallet,
    type SmartWalletChoice,
} from './smart-wallets/index.ts';
import { KeyPairWallet, type Wallet } from './utils/wallet.js';

export const SURFPOOL_PORT = 8899;
export const SURFPOOL_RPC_URL = `http://127.0.0.1:${SURFPOOL_PORT}`;
export const DEFAULT_TEST_BALANCE = 1_000_000n;
export const ONE_HOUR_IN_SECONDS = 3600;
export const ONE_DAY_IN_SECONDS = 86400;
const SYSVAR_CLOCK_ADDRESS = 'SysvarC1ock11111111111111111111111111111111' as Address;
const SYSVAR_CLOCK_UNIX_TIMESTAMP_OFFSET = 32;

export type SmartWalletName = 'swig' | 'squads';

function normalizeSmartWalletChoice(rawChoice: string): SmartWalletChoice {
    const normalized = rawChoice.toLowerCase();
    if (normalized === 'swig' || normalized === 'squads' || normalized === 'all' || normalized === 'none') {
        return normalized;
    }
    throw new Error(`Invalid SMART_WALLET value: ${rawChoice}. Use swig, squads, none, or all.`);
}

export function getSmartWalletList(): SmartWalletName[] {
    const choice = normalizeSmartWalletChoice(process.env.SMART_WALLET ?? 'all');
    if (choice === 'none') {
        return [];
    }
    if (choice === 'all') {
        return ['squads', 'swig'];
    }
    return [choice];
}

/**
 * Build the Kit plugin client used by the test suite.
 *
 * The `surfpool` plugin attaches to the already-running detached validator at
 * {@link SURFPOOL_RPC_URL}, deriving its WebSocket subscriptions URL and
 * exposing surfnet cheatcodes on `client.cheatcodes`. Transactions skip
 * preflight for speed.
 */
async function createTestClient(payer: KeyPairSigner) {
    return createClient()
        .use(signer(payer))
        .use(surfpool({ rpcUrl: SURFPOOL_RPC_URL, skipPreflight: true }))
        .use(tokenProgram())
        .use(subscriptionsProgram());
}

type KitClient = Awaited<ReturnType<typeof createTestClient>>;

export type WalletProvider = {
    name: string;
    createWallet(testSuite: IntegrationTest): Promise<Wallet>;
};

export function getWalletProviders(): WalletProvider[] {
    const providers: WalletProvider[] = [
        {
            name: 'keypair',
            createWallet: async (t: IntegrationTest) => new KeyPairWallet(t.payerKeypair, t.client),
        },
    ];

    for (const walletName of getSmartWalletList()) {
        providers.push({
            name: walletName,
            createWallet: async (t: IntegrationTest) => t.getSmartWallet(walletName),
        });
    }

    return providers;
}

export async function getSmartWallet(
    testSuite: IntegrationTest,
    name: SmartWalletName | 'squad',
): Promise<SmartWallet> {
    return testSuite.getSmartWallet(name);
}

/**
 * IntegrationTest class that provides test fixtures and helper methods
 * for integration testing the Subscriptions program.
 */
export class IntegrationTest {
    /** The `@solana/kit` plugin client under test. */
    public readonly client: KitClient;

    /** Direct RPC access for queries and assertions */
    public readonly rpc: KitClient['rpc'];

    /** Pre-funded payer wrapped as a Wallet — the primary owner/delegator identity */
    public readonly payer: Wallet;

    /** Raw keypair signer for the payer — use for TransactionSigner params and funding ops */
    public readonly payerKeypair: KeyPairSigner;

    /** Pre-created SPL token mint (6 decimals, payer is mint authority) */
    public readonly tokenMint: Address;

    /** Token program address used for the default tokenMint */
    public readonly tokenProgram: Address;

    private readonly smartWalletsByName = new Map<SmartWalletName, SmartWallet>();

    private constructor(client: KitClient, payer: KeyPairSigner, tokenMint: Address, tokenProgram: Address) {
        this.client = client;
        this.rpc = client.rpc;
        this.payerKeypair = payer;
        this.payer = new KeyPairWallet(payer, client);
        this.tokenMint = tokenMint;
        this.tokenProgram = tokenProgram;
    }

    /**
     * Factory method to create a new IntegrationTest instance.
     * This initializes a payer with 10 SOL and creates a default token mint.
     */
    static async create(): Promise<IntegrationTest> {
        await isSurfnetRunning();
        // Generate payer outside the kit client so we can airdrop before installing
        // the rpc plugin asks for a payer-with-balance.
        const payer = await generateKeyPairSigner();
        const client = await createTestClient(payer);

        await airdropToAddress(client, payer.address, 10_000_000_000n);

        const tokenMint = await createMint(client, payer, 6);

        return new IntegrationTest(client, payer, tokenMint, TOKEN_PROGRAM_ADDRESS);
    }

    /**
     * Creates a new token mint with the payer as the mint authority.
     */
    async createTokenMint(decimals: number = 6): Promise<Address> {
        return createMint(this.client, this.payerKeypair, decimals);
    }

    /**
     * Creates an Associated Token Account for the given owner and mints tokens to it.
     */
    async createAtaWithBalance(mint: Address, owner: Address, amount: bigint, decimals: number = 6): Promise<Address> {
        return createAtaWithTokens(this.client, mint, owner, amount, decimals);
    }

    async createFundedKeypair(lamportsAmount: bigint = 1_000_000_000n): Promise<KeyPairSigner> {
        return createFundedKeypair(this.client, lamportsAmount);
    }

    async createFundedWallet(lamportsAmount: bigint = 1_000_000_000n): Promise<Wallet> {
        const keypair = await createFundedKeypair(this.client, lamportsAmount);
        return new KeyPairWallet(keypair, this.client);
    }

    async airdropToAddress(address: Address, lamportsAmount: bigint = 1_000_000_000n): Promise<void> {
        await airdropToAddress(this.client, address, lamportsAmount);
    }

    async getValidatorTime(): Promise<bigint> {
        const clockTime = await getClockSysvarTime(this.rpc);
        if (clockTime != null) return clockTime;

        const slot = await this.rpc.getSlot().send();
        const blockTime = await this.rpc.getBlockTime(slot).send();
        const wall = BigInt(Math.floor(Date.now() / 1000));
        if (blockTime != null) {
            const ts = BigInt(blockTime);
            if (ts + 60n >= wall) return ts;
        }
        return wall;
    }

    async minPlanEndTs(periodHours: bigint): Promise<bigint> {
        const TX_PROPAGATION_BUFFER = 60n;
        const now = await this.getValidatorTime();
        return now + periodHours * 3600n + TX_PROPAGATION_BUFFER;
    }

    async timeTravel(targetTimestampSec: number): Promise<void> {
        await this.client.cheatcodes.timeTravel({ absoluteTimestamp: targetTimestampSec * 1000 }).send();
    }

    private smartWalletsInitialized = false;

    private async ensureSmartWalletsInitialized(): Promise<void> {
        if (this.smartWalletsInitialized) {
            return;
        }
        this.smartWalletsInitialized = true;

        const choice = normalizeSmartWalletChoice(process.env.SMART_WALLET ?? 'all');
        if (choice === 'none') {
            return;
        }

        const wallets = await createAdapterSmartWallets({
            client: this.client,
            choice,
            airdrop: (address, lamportsAmount) => this.airdropToAddress(address, lamportsAmount),
        });

        wallets.forEach(wallet => {
            if (wallet.name === 'swig' || wallet.name === 'squads') {
                this.smartWalletsByName.set(wallet.name, wallet);
            }
        });
    }

    async getSmartWallet(name: SmartWalletName | 'squad'): Promise<SmartWallet> {
        const normalizedName: SmartWalletName = name === 'squad' ? 'squads' : name;
        const requestedWallets = getSmartWalletList();
        if (!requestedWallets.includes(normalizedName)) {
            throw new Error(
                `Wallet "${normalizedName}" is not enabled. Selected wallets: ${requestedWallets.join(', ')}`,
            );
        }

        await this.ensureSmartWalletsInitialized();
        const wallet = this.smartWalletsByName.get(normalizedName);
        if (!wallet) {
            throw new Error(`Smart wallet "${normalizedName}" was not created.`);
        }
        return wallet;
    }

    async createSmartWallets(): Promise<SmartWallet[]> {
        await this.ensureSmartWalletsInitialized();
        return getSmartWalletList().map(name => {
            const wallet = this.smartWalletsByName.get(name);
            if (!wallet) {
                throw new Error(`Smart wallet "${name}" was not created.`);
            }
            return wallet;
        });
    }
}

// ============================================================================
// Private Helper Functions
// ============================================================================

async function getClockSysvarTime(rpc: KitClient['rpc']): Promise<bigint | null> {
    const account = await rpc.getAccountInfo(SYSVAR_CLOCK_ADDRESS, { encoding: 'base64' }).send();
    const encodedData = account.value?.data;
    if (!Array.isArray(encodedData) || typeof encodedData[0] !== 'string') {
        return null;
    }

    const clockData = Buffer.from(encodedData[0], 'base64');
    if (clockData.length < SYSVAR_CLOCK_UNIX_TIMESTAMP_OFFSET + 8) {
        return null;
    }
    return clockData.readBigInt64LE(SYSVAR_CLOCK_UNIX_TIMESTAMP_OFFSET);
}

async function isSurfnetRunning(): Promise<string> {
    try {
        const response = await fetch(SURFPOOL_RPC_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                jsonrpc: '2.0',
                id: 1,
                method: 'getHealth',
            }),
        });

        if (response.ok) {
            const data = (await response.json()) as { result?: string };
            if (data.result === 'ok') {
                return SURFPOOL_RPC_URL;
            }
        }

        throw new Error('Surfpool returned unhealthy status');
    } catch (_error) {
        throw new Error(`Surfpool is not running at ${SURFPOOL_RPC_URL}. Please start it with: surfpool start`);
    }
}

async function createFundedKeypair(client: KitClient, lamportsAmount: bigint): Promise<KeyPairSigner> {
    const keypair = await generateKeyPairSigner();
    await airdropToAddress(client, keypair.address, lamportsAmount);
    return keypair;
}

async function airdropToAddress(client: KitClient, address: Address, lamportsAmount: bigint): Promise<void> {
    await client.airdrop(address, lamports(lamportsAmount));
}

async function createMint(client: KitClient, payer: KeyPairSigner, decimals: number): Promise<Address> {
    const mint = await generateKeyPairSigner();
    await client.cheatcodes
        .setAccount(mint.address, {
            data: Buffer.from(
                getMintEncoder().encode({
                    mintAuthority: payer.address,
                    supply: 0n,
                    decimals,
                    isInitialized: true,
                    freezeAuthority: payer.address,
                }),
            ).toString('hex'),
            lamports: await rentLamports(client.rpc, getMintSize()),
            owner: TOKEN_PROGRAM_ADDRESS,
        })
        .send();
    return mint.address;
}

async function createAtaWithTokens(
    client: KitClient,
    mint: Address,
    owner: Address,
    amount: bigint,
    _decimals: number,
): Promise<Address> {
    const [ata] = await findAssociatedTokenPda({
        mint,
        owner,
        tokenProgram: TOKEN_PROGRAM_ADDRESS,
    });
    await client.cheatcodes
        .setAccount(ata, {
            data: Buffer.from(
                getTokenEncoder().encode({
                    mint,
                    owner,
                    amount,
                    delegate: null,
                    state: AccountState.Initialized,
                    isNative: null,
                    delegatedAmount: 0n,
                    closeAuthority: null,
                }),
            ).toString('hex'),
            lamports: await rentLamports(client.rpc, getTokenSize()),
            owner: TOKEN_PROGRAM_ADDRESS,
        })
        .send();
    return ata;
}

async function rentLamports(rpc: KitClient['rpc'], space: number): Promise<number> {
    const value = await rpc.getMinimumBalanceForRentExemption(BigInt(space)).send();
    if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
        throw new Error(`rent for ${space} bytes exceeds Number.MAX_SAFE_INTEGER`);
    }
    return Number(value);
}

function extractErrorCode(error: unknown): number | null {
    if (error == null) return null;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- error introspection
    const ctx = (error as any)?.context;
    if (ctx?.code != null) return Number(ctx.code);
    const msg = error instanceof Error ? error.message : String(error);
    const hex = /custom program error: 0x([0-9a-fA-F]+)/.exec(msg);
    if (hex?.[1]) return Number.parseInt(hex[1], 16);
    const dec = /custom program error: #(\d+)/.exec(msg);
    if (dec?.[1]) return Number(dec[1]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- error introspection
    const logs = (error as any)?.logs;
    if (Array.isArray(logs)) {
        for (const log of logs as string[]) {
            const m = /custom program error: 0x([0-9a-fA-F]+)/.exec(log);
            if (m?.[1]) return Number.parseInt(m[1], 16);
        }
    }
    if (error instanceof Error && error.cause) {
        return extractErrorCode(error.cause);
    }
    return null;
}

export async function expectProgramError(promise: Promise<unknown>, expectedCode: number): Promise<void> {
    try {
        await promise;
        throw new Error(`Expected program error 0x${expectedCode.toString(16)} but tx succeeded`);
    } catch (error: unknown) {
        if (error instanceof Error && error.message.startsWith('Expected program error')) {
            throw error;
        }
        const code = extractErrorCode(error);
        if (code != null) {
            expect(code).toBe(expectedCode);
            return;
        }
        throw error;
    }
}

// ============================================================================
// Backward Compatibility
// ============================================================================

export async function initTestSuite(): Promise<IntegrationTest> {
    return IntegrationTest.create();
}
