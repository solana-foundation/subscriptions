import { getCreateAccountInstruction } from '@solana-program/system';
import {
  findAssociatedTokenPda,
  getCreateAssociatedTokenInstructionAsync,
  getInitializeMintInstruction,
  getMintSize,
  getMintToInstruction,
  TOKEN_PROGRAM_ADDRESS,
} from '@solana-program/token';
import {
  type Address,
  appendTransactionMessageInstructions,
  createSolanaClient,
  createTransactionMessage,
  generateKeyPairSigner,
  type KeyPairSigner,
  lamports,
  pipe,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
} from 'gill';
import { expect } from 'vitest';
import { SubscriptionsClient } from '../src/client.js';
import { parseProgramError } from '../src/errors/map.js';
import { KeyPairWallet, type Wallet } from '../src/wallet.js';
import {
  createSmartWallets as createAdapterSmartWallets,
  type SmartWallet,
  type SmartWalletChoice,
} from './smart-wallets/index.ts';

export const SURFPOOL_PORT = 8899;
export const SURFPOOL_RPC_URL = `http://127.0.0.1:${SURFPOOL_PORT}`;
export const DEFAULT_TEST_BALANCE = 1_000_000n;
export const ONE_HOUR_IN_SECONDS = 3600;
export const ONE_DAY_IN_SECONDS = 86400;

type SolanaClient = ReturnType<typeof createSolanaClient>;
export type SmartWalletName = 'swig' | 'squads';

function normalizeSmartWalletChoice(rawChoice: string): SmartWalletChoice {
  const normalized = rawChoice.toLowerCase();
  if (
    normalized === 'swig' ||
    normalized === 'squads' ||
    normalized === 'all' ||
    normalized === 'none'
  ) {
    return normalized;
  }
  throw new Error(
    `Invalid SMART_WALLET value: ${rawChoice}. Use swig, squads, none, or all.`,
  );
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

// Backward-compatible alias for requested naming.
export const getSmartWalletlist = getSmartWalletList;

export type WalletProvider = {
  name: string;
  createWallet(testSuite: IntegrationTest): Promise<Wallet>;
};

export function getWalletProviders(): WalletProvider[] {
  const providers: WalletProvider[] = [
    {
      name: 'keypair',
      createWallet: async (t: IntegrationTest) =>
        new KeyPairWallet(t.payerKeypair, t.client.client),
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
  /** The SubscriptionsClient instance for interacting with the program */
  public readonly client: SubscriptionsClient;

  /** Direct RPC access for queries and assertions */
  public readonly rpc: SolanaClient['rpc'];

  /** Pre-funded payer wrapped as a Wallet — the primary owner/delegator identity */
  public readonly payer: Wallet;

  /** Raw keypair signer for the payer — use for TransactionSigner params and funding ops */
  public readonly payerKeypair: KeyPairSigner;

  /** Pre-created SPL token mint (6 decimals, payer is mint authority) */
  public readonly tokenMint: Address;

  /** Token program address used for the default tokenMint */
  public readonly tokenProgram: Address;

  private solanaClient: SolanaClient;
  private readonly smartWalletsByName = new Map<SmartWalletName, SmartWallet>();

  private constructor(
    solanaClient: SolanaClient,
    client: SubscriptionsClient,
    payer: KeyPairSigner,
    tokenMint: Address,
    tokenProgram: Address,
  ) {
    this.solanaClient = solanaClient;
    this.client = client;
    this.rpc = solanaClient.rpc;
    this.payerKeypair = payer;
    this.payer = new KeyPairWallet(payer, solanaClient);
    this.tokenMint = tokenMint;
    this.tokenProgram = tokenProgram;
  }

  /**
   * Factory method to create a new IntegrationTest instance.
   * This initializes a payer with 10 SOL and creates a default token mint.
   */
  static async create(): Promise<IntegrationTest> {
    await isSurfnetRunning(); // Just verify surfpool is running
    const solanaClient = createSolanaClient({ urlOrMoniker: 'localnet' });
    const client = new SubscriptionsClient(solanaClient);

    // Create and fund payer with 10 SOL
    const payer = await createFundedKeypair(solanaClient, 10_000_000_000n);

    // Create default token mint (payer is mint authority) using TOKEN_PROGRAM_ADDRESS
    const tokenMint = await createMint(solanaClient, payer, 6);

    return new IntegrationTest(
      solanaClient,
      client,
      payer,
      tokenMint,
      TOKEN_PROGRAM_ADDRESS,
    );
  }

  /**
   * Creates a new token mint with the payer as the mint authority.
   * @param decimals - Number of decimals for the mint (default: 6)
   * @returns The address of the newly created mint
   */
  async createTokenMint(decimals: number = 6): Promise<Address> {
    return createMint(this.solanaClient, this.payerKeypair, decimals);
  }

  /**
   * Creates an Associated Token Account for the given owner and mints tokens to it.
   * @param mint - The token mint address
   * @param owner - The owner of the ATA
   * @param amount - The amount of tokens to mint (in base units)
   * @returns The address of the created ATA
   */
  async createAtaWithBalance(
    mint: Address,
    owner: Address,
    amount: bigint,
  ): Promise<Address> {
    return createAtaWithTokens(
      this.solanaClient,
      this.payerKeypair,
      mint,
      owner,
      amount,
    );
  }

  async createFundedKeypair(
    lamportsAmount: bigint = 1_000_000_000n,
  ): Promise<KeyPairSigner> {
    return createFundedKeypair(this.solanaClient, lamportsAmount);
  }

  async createFundedWallet(
    lamportsAmount: bigint = 1_000_000_000n,
  ): Promise<Wallet> {
    const signer = await createFundedKeypair(this.solanaClient, lamportsAmount);
    return new KeyPairWallet(signer, this.solanaClient);
  }

  async airdropToAddress(
    address: Address,
    lamportsAmount: bigint = 1_000_000_000n,
  ): Promise<void> {
    await airdropToAddress(this.solanaClient, address, lamportsAmount);
  }

  async getValidatorTime(): Promise<bigint> {
    // Surfpool occasionally returns a stale genesis-era blockTime briefly
    // after startup; poll until blockTime is at or past wall time so
    // computed expiry/start timestamps don't end up "in the past".
    const wall = BigInt(Math.floor(Date.now() / 1000));
    for (let attempt = 0; attempt < 20; attempt++) {
      const slot = await this.rpc.getSlot().send();
      const blockTime = await this.rpc.getBlockTime(slot).send();
      if (blockTime != null) {
        const ts = BigInt(blockTime);
        if (ts >= wall) return ts;
      }
      await new Promise((r) => setTimeout(r, 200));
    }
    throw new Error('getValidatorTime: blockTime never caught up to wall time');
  }

  async minPlanEndTs(periodHours: bigint): Promise<bigint> {
    const TX_PROPAGATION_BUFFER = 60n;
    const now = await this.getValidatorTime();
    return now + periodHours * 3600n + TX_PROPAGATION_BUFFER;
  }

  async timeTravel(targetTimestampSec: number): Promise<void> {
    const res = await fetch(SURFPOOL_RPC_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'surfnet_timeTravel',
        params: [{ absoluteTimestamp: targetTimestampSec * 1000 }],
      }),
    });
    if (!res.ok) throw new Error(`surfnet_timeTravel failed: ${res.status}`);
    const data = (await res.json()) as { error?: { message: string } };
    if (data.error) throw new Error(data.error.message);
  }

  private smartWalletsInitialized = false;

  private async ensureSmartWalletsInitialized(): Promise<void> {
    if (this.smartWalletsInitialized) {
      return;
    }
    this.smartWalletsInitialized = true;

    const choice = normalizeSmartWalletChoice(
      process.env.SMART_WALLET ?? 'all',
    );
    if (choice === 'none') {
      return;
    }

    const wallets = await createAdapterSmartWallets({
      rpcUrl: SURFPOOL_RPC_URL,
      choice,
      airdrop: (address, lamportsAmount) =>
        this.airdropToAddress(address, lamportsAmount),
    });

    wallets.forEach((wallet) => {
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
    return getSmartWalletList().map((name) => {
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

/**
 * Checks that Surfpool is running and returns the RPC URL.
 *
 * Note: Surfpool should be started separately with `surfpool start`
 * which will auto-deploy the subscriptions program via the runbook.
 *
 * @throws Error if Surfpool is not running
 */
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
    throw new Error(
      `Surfpool is not running at ${SURFPOOL_RPC_URL}. Please start it with: surfpool start`,
    );
  }
}

/**
 * Creates a new keypair and funds it with SOL via airdrop.
 */
async function createFundedKeypair(
  client: SolanaClient,
  lamportsAmount: bigint,
): Promise<KeyPairSigner> {
  const keypair = await generateKeyPairSigner();

  // Request airdrop
  const signature = await client.rpc
    .requestAirdrop(keypair.address, lamports(lamportsAmount))
    .send();

  // Poll until confirmed
  let confirmed = false;
  for (let i = 0; i < 30; i++) {
    const status = await client.rpc.getSignatureStatuses([signature]).send();
    if (
      status.value[0]?.confirmationStatus === 'confirmed' ||
      status.value[0]?.confirmationStatus === 'finalized'
    ) {
      confirmed = true;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  if (!confirmed) {
    throw new Error('Airdrop confirmation timeout');
  }

  return keypair;
}

async function airdropToAddress(
  client: SolanaClient,
  address: Address,
  lamportsAmount: bigint,
): Promise<void> {
  const signature = await client.rpc
    .requestAirdrop(address, lamports(lamportsAmount))
    .send();

  let confirmed = false;
  for (let i = 0; i < 30; i++) {
    const status = await client.rpc.getSignatureStatuses([signature]).send();
    if (
      status.value[0]?.confirmationStatus === 'confirmed' ||
      status.value[0]?.confirmationStatus === 'finalized'
    ) {
      confirmed = true;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  if (!confirmed) {
    throw new Error('Airdrop confirmation timeout');
  }
}

/**
 * Creates a new SPL token mint.
 * @param client - The Solana client
 * @param payer - The payer/mint authority
 * @param decimals - Number of decimals for the mint
 * @returns The address of the created mint
 */
async function createMint(
  client: SolanaClient,
  payer: KeyPairSigner,
  decimals: number,
): Promise<Address> {
  const mint = await generateKeyPairSigner();
  const mintSize = getMintSize();

  const rent = await client.rpc
    .getMinimumBalanceForRentExemption(BigInt(mintSize))
    .send();

  const { value: latestBlockhash } = await client.rpc
    .getLatestBlockhash()
    .send();

  // Create account for the mint
  const createAccountIx = getCreateAccountInstruction({
    payer,
    newAccount: mint,
    lamports: rent,
    space: mintSize,
    programAddress: TOKEN_PROGRAM_ADDRESS,
  });

  // Initialize the mint with payer as mint authority
  const initializeMintIx = getInitializeMintInstruction({
    mint: mint.address,
    decimals,
    mintAuthority: payer.address,
    freezeAuthority: payer.address,
  });

  const transactionMessage = pipe(
    createTransactionMessage({ version: 0 }),
    (tx) => setTransactionMessageFeePayerSigner(payer, tx),
    (tx) => setTransactionMessageLifetimeUsingBlockhash(latestBlockhash, tx),
    (tx) =>
      appendTransactionMessageInstructions(
        [createAccountIx, initializeMintIx],
        tx,
      ),
  );

  const signedTransaction =
    await signTransactionMessageWithSigners(transactionMessage);
  await client.sendAndConfirmTransaction(signedTransaction);

  return mint.address;
}

/**
 * Creates an Associated Token Account and mints tokens to it.
 * @param client - The Solana client
 * @param payer - The payer (must be mint authority to mint tokens)
 * @param mint - The token mint address
 * @param owner - The owner of the ATA
 * @param amount - The amount of tokens to mint
 * @returns The address of the created ATA
 */
async function createAtaWithTokens(
  client: SolanaClient,
  payer: KeyPairSigner,
  mint: Address,
  owner: Address,
  amount: bigint,
): Promise<Address> {
  // Derive the ATA address
  const [ata] = await findAssociatedTokenPda({
    mint,
    owner,
    tokenProgram: TOKEN_PROGRAM_ADDRESS,
  });

  const { value: latestBlockhash } = await client.rpc
    .getLatestBlockhash()
    .send();

  // Create ATA instruction
  const createAtaIx = await getCreateAssociatedTokenInstructionAsync({
    payer,
    mint,
    owner,
  });

  // Mint tokens instruction
  const mintToIx = getMintToInstruction({
    mint,
    token: ata,
    mintAuthority: payer,
    amount,
  });

  const transactionMessage = pipe(
    createTransactionMessage({ version: 0 }),
    (tx) => setTransactionMessageFeePayerSigner(payer, tx),
    (tx) => setTransactionMessageLifetimeUsingBlockhash(latestBlockhash, tx),
    (tx) => appendTransactionMessageInstructions([createAtaIx, mintToIx], tx),
  );

  const signedTransaction =
    await signTransactionMessageWithSigners(transactionMessage);
  await client.sendAndConfirmTransaction(signedTransaction);

  return ata;
}

function extractErrorCode(error: unknown): number | null {
  if (error == null) return null;
  const pe = parseProgramError(error);
  if (pe) return pe.errorCode;
  // biome-ignore lint/suspicious/noExplicitAny: error introspection
  const ctx = (error as any)?.context;
  if (ctx?.code != null) return Number(ctx.code);
  const msg = error instanceof Error ? error.message : String(error);
  const m = /custom program error: #(\d+)/.exec(msg);
  if (m?.[1]) return Number(m[1]);
  if (error instanceof Error && error.cause) {
    return extractErrorCode(error.cause);
  }
  return null;
}

export async function expectProgramError(
  promise: Promise<unknown>,
  expectedCode: number,
): Promise<void> {
  try {
    await promise;
    throw new Error(
      `Expected program error 0x${expectedCode.toString(16)} but tx succeeded`,
    );
  } catch (error: unknown) {
    if (
      error instanceof Error &&
      error.message.startsWith('Expected program error')
    ) {
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

/**
 * Convenience function for backward compatibility.
 * @returns A new IntegrationTest instance
 */
export async function initTestSuite(): Promise<IntegrationTest> {
  return IntegrationTest.create();
}
