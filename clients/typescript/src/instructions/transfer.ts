import { findAssociatedTokenPda } from '@solana-program/token';
import type { Address, Instruction, TransactionSigner } from 'gill';
import { ValidationError } from '../errors/types.js';
import {
  getTransferFixedInstructionAsync,
  getTransferRecurringInstructionAsync,
  getTransferSubscriptionInstructionAsync,
} from '../generated/index.js';
import { getSubscriptionAuthorityPDA } from '../pdas.js';

/** Shared parameters for fixed and recurring transfer instruction builders. */
export type TransferParams = {
  delegatee: TransactionSigner;
  delegator: Address;
  delegatorAta: Address;
  tokenMint: Address;
  delegationPda: Address;
  amount: number | bigint;
  receiverAta: Address;
  tokenProgram: Address;
  programAddress?: Address;
};

async function buildTransferInternal(
  params: TransferParams,
  getInstruction: typeof getTransferFixedInstructionAsync,
): Promise<{ instructions: Instruction[] }> {
  if (BigInt(params.amount) <= 0n)
    throw new ValidationError('amount must be greater than zero');

  const config = params.programAddress
    ? { programAddress: params.programAddress }
    : undefined;

  const [subscriptionAuthority] = await getSubscriptionAuthorityPDA(
    params.delegator,
    params.tokenMint,
    params.programAddress,
  );

  const instruction = await getInstruction(
    {
      delegationPda: params.delegationPda,
      subscriptionAuthority,
      delegatorAta: params.delegatorAta,
      receiverAta: params.receiverAta,
      tokenProgram: params.tokenProgram,
      delegatee: params.delegatee,
      transferData: {
        amount: params.amount,
        delegator: params.delegator,
        mint: params.tokenMint,
      },
    },
    config,
  );

  return { instructions: [instruction] };
}

/**
 * Builds a `transferFixed` instruction, deriving the SubscriptionAuthority PDA from the delegator and mint.
 *
 * @param params - Transfer details including delegatee signer, delegator, token accounts, and amount.
 * @returns The instruction array.
 * @throws {ValidationError} If amount is zero or negative.
 */
export async function buildTransferFixed(
  params: TransferParams,
): Promise<{ instructions: Instruction[] }> {
  return buildTransferInternal(params, getTransferFixedInstructionAsync);
}

/**
 * Builds a `transferRecurring` instruction, deriving the SubscriptionAuthority PDA from the delegator and mint.
 *
 * @param params - Transfer details including delegatee signer, delegator, token accounts, and amount.
 * @returns The instruction array.
 * @throws {ValidationError} If amount is zero or negative.
 */
export async function buildTransferRecurring(
  params: TransferParams,
): Promise<{ instructions: Instruction[] }> {
  return buildTransferInternal(params, getTransferRecurringInstructionAsync);
}

/**
 * Builds a `transferSubscription` instruction, deriving SubscriptionAuthority and delegator ATA PDAs.
 *
 * @param params.caller - The signer executing the pull (plan owner or authorized puller).
 * @param params.delegator - The subscriber's wallet address.
 * @param params.tokenMint - SPL token mint address.
 * @param params.subscriptionPda - Address of the subscription account.
 * @param params.planPda - Address of the plan account.
 * @param params.amount - Token amount to transfer.
 * @param params.receiverAta - Destination associated token account.
 * @param params.tokenProgram - Token program (typically Token-2022).
 * @returns The instruction array.
 * @throws {ValidationError} If amount is zero or negative.
 */
export async function buildTransferSubscription(params: {
  caller: TransactionSigner;
  delegator: Address;
  tokenMint: Address;
  subscriptionPda: Address;
  planPda: Address;
  amount: number | bigint;
  receiverAta: Address;
  tokenProgram: Address;
  programAddress?: Address;
}): Promise<{ instructions: Instruction[] }> {
  if (BigInt(params.amount) <= 0n)
    throw new ValidationError('amount must be greater than zero');

  const config = params.programAddress
    ? { programAddress: params.programAddress }
    : undefined;

  const [subscriptionAuthority] = await getSubscriptionAuthorityPDA(
    params.delegator,
    params.tokenMint,
    params.programAddress,
  );
  const [delegatorAta] = await findAssociatedTokenPda({
    mint: params.tokenMint,
    owner: params.delegator,
    tokenProgram: params.tokenProgram,
  });

  const instruction = await getTransferSubscriptionInstructionAsync(
    {
      subscriptionPda: params.subscriptionPda,
      planPda: params.planPda,
      subscriptionAuthority,
      delegatorAta,
      receiverAta: params.receiverAta,
      caller: params.caller,
      tokenProgram: params.tokenProgram,
      transferData: {
        amount: params.amount,
        delegator: params.delegator,
        mint: params.tokenMint,
      },
    },
    config,
  );

  return { instructions: [instruction] };
}
