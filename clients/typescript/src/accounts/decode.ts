import type {
  AccountInfoBase,
  AccountInfoWithBase64EncodedData,
  AccountInfoWithPubkey,
  Address,
  EncodedAccount,
} from '@solana/kit';
import { getBase64Encoder } from '@solana/kit';
import { DISCRIMINATOR_OFFSET } from '../constants.js';
import {
  AccountDiscriminator,
  decodeFixedDelegation,
  decodeRecurringDelegation,
  decodeSubscriptionDelegation,
} from '../generated/index.js';
import type { Delegation } from '../types/delegation.js';

/** Raw account shape returned by `getProgramAccounts` RPC calls. */
export type RawProgramAccount = AccountInfoWithPubkey<
  AccountInfoBase & AccountInfoWithBase64EncodedData
>;

/**
 * Converts a {@link RawProgramAccount} into  Kit's `EncodedAccount` format for use with Codama decoders.
 *
 * @param raw - The raw account as returned by `getProgramAccounts`.
 * @param programAddress - The program address that owns the account.
 * @returns An `EncodedAccount` with base64-decoded data.
 */
export function toEncodedAccount(
  raw: RawProgramAccount,
  programAddress: Address,
): EncodedAccount {
  const base64Encoder = getBase64Encoder();
  const data = base64Encoder.encode(raw.account.data[0]);
  return {
    address: raw.pubkey,
    data,
    executable: raw.account.executable,
    lamports: raw.account.lamports,
    programAddress,
    space: raw.account.space,
  } as EncodedAccount;
}

/**
 * Decodes a raw program account into a {@link Delegation} by inspecting the discriminator byte.
 *
 * @param raw - The raw account as returned by `getProgramAccounts`.
 * @param programAddress - The program address that owns the account.
 * @returns The decoded {@link Delegation}, or `null` if the discriminator is unrecognized.
 */
export function decodeDelegationAccount(
  raw: RawProgramAccount,
  programAddress: Address,
): Delegation | null {
  const encoded = toEncodedAccount(raw, programAddress);
  const kind = encoded.data[DISCRIMINATOR_OFFSET];

  switch (kind) {
    case AccountDiscriminator.FixedDelegation: {
      const decoded = decodeFixedDelegation(encoded);
      return {
        kind: 'fixed',
        address: raw.pubkey,
        data: decoded.data,
      };
    }
    case AccountDiscriminator.RecurringDelegation: {
      const decoded = decodeRecurringDelegation(encoded);
      return {
        kind: 'recurring',
        address: raw.pubkey,
        data: decoded.data,
      };
    }
    case AccountDiscriminator.SubscriptionDelegation: {
      const decoded = decodeSubscriptionDelegation(encoded);
      return {
        kind: 'subscription',
        address: raw.pubkey,
        data: decoded.data,
      };
    }
    default:
      console.warn(`Unknown delegation discriminator: ${kind}`);
      return null;
  }
}
