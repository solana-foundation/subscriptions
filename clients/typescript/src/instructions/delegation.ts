import {
  AccountRole,
  type Address,
  type Instruction,
  type TransactionSigner,
} from 'gill';
import { ValidationError } from '../errors/types.js';
import {
  getCloseMultiDelegateInstruction,
  getCreateFixedDelegationInstruction,
  getCreateRecurringDelegationInstruction,
  getInitMultiDelegateInstruction,
  getRevokeDelegationInstruction,
} from '../generated/index.js';
import { getDelegationPDA, getMultiDelegatePDA } from '../pdas.js';

/**
 * Builds an `initMultiDelegate` instruction, deriving the MultiDelegate PDA automatically.
 *
 * @param params.owner - The wallet that owns the multi-delegate account.
 * @param params.tokenMint - SPL token mint address.
 * @param params.userAta - Owner's associated token account for the mint.
 * @param params.tokenProgram - Token program (typically Token-2022).
 * @param params.payer - Optional sponsor that funds the rent. Defaults to `owner` when omitted.
 * @returns The instruction array and the derived `multiDelegatePda`.
 */
export async function buildInitMultiDelegate(params: {
  owner: TransactionSigner;
  tokenMint: Address;
  userAta: Address;
  tokenProgram: Address;
  payer?: TransactionSigner;
  programAddress?: Address;
}): Promise<{ instructions: Instruction[]; multiDelegatePda: Address }> {
  const { owner, tokenMint, userAta, tokenProgram, payer, programAddress } =
    params;
  const config = programAddress ? { programAddress } : undefined;
  const [multiDelegatePda] = await getMultiDelegatePDA(
    owner.address,
    tokenMint,
    programAddress,
  );

  const instruction = getInitMultiDelegateInstruction(
    {
      owner,
      multiDelegate: multiDelegatePda,
      tokenMint,
      userAta,
      tokenProgram,
    },
    config,
  );

  if (payer) {
    const accounts = [
      ...instruction.accounts,
      {
        address: payer.address,
        role: AccountRole.WRITABLE_SIGNER,
        signer: payer,
      },
    ];
    return {
      instructions: [{ ...instruction, accounts }],
      multiDelegatePda,
    };
  }

  return { instructions: [instruction], multiDelegatePda };
}

/**
 * Builds a `createFixedDelegation` instruction, deriving MultiDelegate and Delegation PDAs.
 *
 * @param params.delegator - The wallet creating the delegation.
 * @param params.tokenMint - SPL token mint address.
 * @param params.delegatee - Address authorized to pull tokens.
 * @param params.nonce - Unique nonce distinguishing multiple delegations to the same delegatee.
 * @param params.amount - Total token amount the delegatee may transfer.
 * @param params.expiryTs - Unix timestamp after which the delegation expires (0 for no expiry).
 * @returns The instruction array and the derived `delegationPda`.
 * @throws {ValidationError} If amount is zero or negative.
 */
export async function buildCreateFixedDelegation(params: {
  delegator: TransactionSigner;
  tokenMint: Address;
  delegatee: Address;
  nonce: number | bigint;
  amount: number | bigint;
  expiryTs: number | bigint;
  payer?: TransactionSigner;
  programAddress?: Address;
}): Promise<{ instructions: Instruction[]; delegationPda: Address }> {
  const {
    delegator,
    tokenMint,
    delegatee,
    nonce,
    amount,
    expiryTs,
    payer,
    programAddress,
  } = params;
  const config = programAddress ? { programAddress } : undefined;

  if (BigInt(amount) <= 0n)
    throw new ValidationError('amount must be greater than zero');

  const [multiDelegate] = await getMultiDelegatePDA(
    delegator.address,
    tokenMint,
    programAddress,
  );
  const [delegationPda] = await getDelegationPDA(
    multiDelegate,
    delegator.address,
    delegatee,
    nonce,
    programAddress,
  );

  const instruction = getCreateFixedDelegationInstruction(
    {
      delegator,
      multiDelegate,
      delegationAccount: delegationPda,
      delegatee,
      fixedDelegation: { nonce, amount, expiryTs },
    },
    config,
  );

  if (payer) {
    const accounts = [
      ...instruction.accounts,
      {
        address: payer.address,
        role: AccountRole.WRITABLE_SIGNER,
        signer: payer,
      },
    ];
    return {
      instructions: [{ ...instruction, accounts }],
      delegationPda,
    };
  }

  return { instructions: [instruction], delegationPda };
}

/**
 * Builds a `createRecurringDelegation` instruction, deriving MultiDelegate and Delegation PDAs.
 *
 * @param params.delegator - The wallet creating the delegation.
 * @param params.tokenMint - SPL token mint address.
 * @param params.delegatee - Address authorized to pull tokens each period.
 * @param params.nonce - Unique nonce distinguishing multiple delegations to the same delegatee.
 * @param params.amountPerPeriod - Token amount the delegatee may transfer per period.
 * @param params.periodLengthS - Period length in seconds.
 * @param params.startTs - Unix timestamp when the first period begins.
 * @param params.expiryTs - Unix timestamp after which the delegation expires (0 for no expiry).
 * @returns The instruction array and the derived `delegationPda`.
 * @throws {ValidationError} If amountPerPeriod or periodLengthS is zero or negative.
 */
export async function buildCreateRecurringDelegation(params: {
  delegator: TransactionSigner;
  tokenMint: Address;
  delegatee: Address;
  nonce: number | bigint;
  amountPerPeriod: number | bigint;
  periodLengthS: number | bigint;
  startTs: number | bigint;
  expiryTs: number | bigint;
  payer?: TransactionSigner;
  programAddress?: Address;
}): Promise<{ instructions: Instruction[]; delegationPda: Address }> {
  const {
    delegator,
    tokenMint,
    delegatee,
    nonce,
    amountPerPeriod,
    periodLengthS,
    startTs,
    expiryTs,
    payer,
    programAddress,
  } = params;
  const config = programAddress ? { programAddress } : undefined;

  if (BigInt(amountPerPeriod) <= 0n)
    throw new ValidationError('amountPerPeriod must be greater than zero');
  if (BigInt(periodLengthS) <= 0n)
    throw new ValidationError('periodLengthS must be greater than zero');

  const [multiDelegate] = await getMultiDelegatePDA(
    delegator.address,
    tokenMint,
    programAddress,
  );
  const [delegationPda] = await getDelegationPDA(
    multiDelegate,
    delegator.address,
    delegatee,
    nonce,
    programAddress,
  );

  const instruction = getCreateRecurringDelegationInstruction(
    {
      delegator,
      multiDelegate,
      delegationAccount: delegationPda,
      delegatee,
      recurringDelegation: {
        nonce,
        amountPerPeriod,
        periodLengthS,
        startTs,
        expiryTs,
      },
    },
    config,
  );

  if (payer) {
    const accounts = [
      ...instruction.accounts,
      {
        address: payer.address,
        role: AccountRole.WRITABLE_SIGNER,
        signer: payer,
      },
    ];
    return {
      instructions: [{ ...instruction, accounts }],
      delegationPda,
    };
  }

  return { instructions: [instruction], delegationPda };
}

/**
 * Builds a `revokeDelegation` instruction for **fixed or recurring**
 * delegations. For subscription PDAs use {@link buildRevokeSubscription}.
 *
 * Trailing-account layout for fixed/recurring: `[receiver?]`. `receiver` is
 * only required when the recorded payer differs from `authority` (e.g., the
 * delegator is revoking a sponsor-funded delegation, or the sponsor is
 * revoking an expired delegation).
 *
 * @param params.authority - The delegator or sponsor authorized to revoke.
 * @param params.delegationAccount - Address of the fixed/recurring delegation PDA.
 * @param params.receiver - Rent destination when the recorded payer differs
 *   from the authority. Must equal the stored `header.payer`.
 * @returns The instruction array.
 */
export function buildRevokeDelegation(params: {
  authority: TransactionSigner;
  delegationAccount: Address;
  receiver?: Address;
  programAddress?: Address;
}): { instructions: Instruction[] } {
  const config = params.programAddress
    ? { programAddress: params.programAddress }
    : undefined;
  const instruction = getRevokeDelegationInstruction(
    {
      authority: params.authority,
      delegationAccount: params.delegationAccount,
    },
    config,
  );

  if (params.receiver) {
    const accounts = [
      ...instruction.accounts,
      { address: params.receiver, role: AccountRole.WRITABLE },
    ];
    return { instructions: [{ ...instruction, accounts }] };
  }

  return { instructions: [instruction] };
}

/**
 * Builds a `revokeDelegation` instruction for **subscription** PDAs. Wraps
 * the same on-chain instruction as {@link buildRevokeDelegation} but appends
 * the subscription-specific trailing accounts (`[planPda, receiver?]`).
 *
 * For fixed/recurring delegations, use {@link buildRevokeDelegation} — passing
 * `planPda` to the program for a fixed/recurring revoke would be misread as a
 * `receiver` and fail with `Unauthorized`.
 *
 * @param params.authority - Subscriber (delegator) or sponsor (recorded `header.payer`).
 * @param params.subscriptionPda - Address of the subscription PDA to revoke.
 * @param params.planPda - Required. The plan PDA the subscription is bound to.
 *   Used by the program for the binding check and plan-ended / plan-closed
 *   detection on the sponsor path. Pass the plan PDA address even if the plan
 *   has been closed by the merchant — the program inspects ownership directly.
 * @param params.receiver - Rent destination when the recorded payer differs
 *   from the authority. Must equal the stored `header.payer`.
 * @returns The instruction array.
 */
export function buildRevokeSubscription(params: {
  authority: TransactionSigner;
  subscriptionPda: Address;
  planPda: Address;
  receiver?: Address;
  programAddress?: Address;
}): { instructions: Instruction[] } {
  const config = params.programAddress
    ? { programAddress: params.programAddress }
    : undefined;
  const instruction = getRevokeDelegationInstruction(
    {
      authority: params.authority,
      delegationAccount: params.subscriptionPda,
    },
    config,
  );

  const trailing: Array<{ address: Address; role: number }> = [
    { address: params.planPda, role: AccountRole.READONLY },
  ];
  if (params.receiver) {
    trailing.push({ address: params.receiver, role: AccountRole.WRITABLE });
  }

  const accounts = [...instruction.accounts, ...trailing];
  return { instructions: [{ ...instruction, accounts }] };
}

/**
 * Builds a `closeMultiDelegate` instruction, deriving the MultiDelegate PDA automatically.
 * Closes the multi-delegate account and reclaims its rent.
 *
 * @param params.user - The wallet that owns the multi-delegate account.
 * @param params.tokenMint - SPL token mint associated with the account.
 * @param params.receiver - Required when the MultiDelegate was sponsor-funded
 *   (i.e., the stored `payer` differs from `user`). Must equal the stored payer
 *   address. The caller is responsible for fetching the on-chain MultiDelegate
 *   account to determine whether a receiver is needed.
 * @returns The instruction array.
 */
export async function buildCloseMultiDelegate(params: {
  user: TransactionSigner;
  tokenMint: Address;
  receiver?: Address;
  programAddress?: Address;
}): Promise<{ instructions: Instruction[] }> {
  const config = params.programAddress
    ? { programAddress: params.programAddress }
    : undefined;
  const [multiDelegate] = await getMultiDelegatePDA(
    params.user.address,
    params.tokenMint,
    params.programAddress,
  );

  const instruction = getCloseMultiDelegateInstruction(
    {
      user: params.user,
      multiDelegate,
    },
    config,
  );

  if (params.receiver) {
    const accounts = [
      ...instruction.accounts,
      { address: params.receiver, role: AccountRole.WRITABLE },
    ];
    return { instructions: [{ ...instruction, accounts }] };
  }

  return { instructions: [instruction] };
}
