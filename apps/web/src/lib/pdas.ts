import { findAssociatedTokenPda } from '@solana-program/token';
import type { Address } from '@solana/kit';

export async function getAssociatedTokenAddress(
  owner: Address,
  mint: Address,
  tokenProgram: Address,
): Promise<Address> {
  const [ata] = await findAssociatedTokenPda({ mint, owner, tokenProgram });
  return ata;
}
