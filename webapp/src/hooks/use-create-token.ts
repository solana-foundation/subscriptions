import { useMutation } from '@tanstack/react-query'
import {
  appendTransactionMessageInstructions,
  createSignerFromKeyPair,
  createTransactionMessage,
  generateKeyPair,
  pipe,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signAndSendTransactionMessageWithSigners,
  type TransactionSendingSigner,
  type Address,
} from '@solana/kit'
import {
  TOKEN_2022_PROGRAM_ADDRESS,
  getInitializeMint2Instruction,
  getMintSize,
  getMintToInstruction,
} from '@solana-program/token-2022'
import {
  findAssociatedTokenPda,
  getCreateAssociatedTokenIdempotentInstruction,
} from '@solana-program/token'
import { useWalletUiSigner } from '@/components/solana/use-wallet-ui-signer'
import { useRpc } from '@/hooks/use-rpc'
import { useTransactionToast } from '@/components/use-transaction-toast'
import { buildCreateAccountIx, SYSTEM_PROGRAM } from '@/lib/bpf-loader-browser'

export function useCreateToken() {
  const walletSigner = useWalletUiSigner()
  const toast = useTransactionToast()
  const rpc = useRpc()

  const createToken = useMutation({
    mutationFn: async ({ decimals = 6 }: { decimals?: number } = {}) => {
      if (!walletSigner) throw new Error('Wallet not connected')
      const signer = walletSigner as TransactionSendingSigner

      const mintKp = await createSignerFromKeyPair(await generateKeyPair())
      const mintSize = getMintSize()
      const rentLamports = await rpc.getMinimumBalanceForRentExemption(BigInt(mintSize)).send()
      const { value: latestBlockhash } = await rpc.getLatestBlockhash().send()

      const createAccIx = buildCreateAccountIx(
        signer,
        mintKp,
        rentLamports,
        mintSize,
        TOKEN_2022_PROGRAM_ADDRESS as Address,
      )

      const initMintIx = getInitializeMint2Instruction({
        mint: mintKp.address,
        decimals,
        mintAuthority: signer.address,
        freezeAuthority: signer.address,
      })

      const tx = pipe(
        createTransactionMessage({ version: 0 }),
        m => setTransactionMessageFeePayerSigner(signer, m),
        m => setTransactionMessageLifetimeUsingBlockhash(latestBlockhash, m),
        m => appendTransactionMessageInstructions([createAccIx, initMintIx], m),
      )

      await signAndSendTransactionMessageWithSigners(tx)

      return { mint: mintKp.address as Address }
    },
    onSuccess: () => { toast.onSuccess('Token mint created') },
    onError: (e) => toast.onError(e),
  })

  const mintTo = useMutation({
    mutationFn: async ({ mint, amount, recipient }: { mint: Address; amount: bigint; recipient?: Address }) => {
      if (!walletSigner) throw new Error('Wallet not connected')
      const signer = walletSigner as TransactionSendingSigner
      const owner = recipient ?? signer.address

      const [ata] = await findAssociatedTokenPda({
        owner,
        mint,
        tokenProgram: TOKEN_2022_PROGRAM_ADDRESS as Address,
      })

      const { value: latestBlockhash } = await rpc.getLatestBlockhash().send()

      const createAtaIx = getCreateAssociatedTokenIdempotentInstruction({
        payer: signer,
        owner,
        ata,
        mint,
        tokenProgram: TOKEN_2022_PROGRAM_ADDRESS as Address,
        systemProgram: SYSTEM_PROGRAM as Address,
      })

      const mintToIx = getMintToInstruction({
        mint,
        token: ata,
        mintAuthority: signer,
        amount,
      })

      const tx = pipe(
        createTransactionMessage({ version: 0 }),
        m => setTransactionMessageFeePayerSigner(signer, m),
        m => setTransactionMessageLifetimeUsingBlockhash(latestBlockhash, m),
        m => appendTransactionMessageInstructions([createAtaIx, mintToIx], m),
      )

      await signAndSendTransactionMessageWithSigners(tx)
      return { ata }
    },
    onSuccess: () => { toast.onSuccess('Tokens minted') },
    onError: (e) => toast.onError(e),
  })

  return { createToken, mintTo }
}
