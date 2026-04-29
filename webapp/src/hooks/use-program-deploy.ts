import { useState, useCallback, useRef } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import {
  address,
  appendTransactionMessageInstructions,
  createKeyPairFromBytes,
  createSignerFromKeyPair,
  createTransactionMessage,
  generateKeyPair,
  pipe,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signAndSendTransactionMessageWithSigners,
  signTransactionMessageWithSigners,
  compileTransaction,
  getBase64EncodedWireTransaction,
  getBase58Decoder,
  getAddressEncoder,
  type Blockhash,
  type Instruction,
  type TransactionSigner,
  type TransactionSendingSigner,
  type KeyPairSigner,
} from '@solana/kit'

const buildV0Tx = (
  feePayer: TransactionSigner,
  latestBlockhash: { blockhash: Blockhash; lastValidBlockHeight: bigint },
  instructions: Instruction[],
) =>
  pipe(
    createTransactionMessage({ version: 0 }),
    m => setTransactionMessageFeePayerSigner(feePayer, m),
    m => setTransactionMessageLifetimeUsingBlockhash(latestBlockhash, m),
    m => appendTransactionMessageInstructions(instructions, m),
  )
import { useClusterConfig } from '@/hooks/use-cluster-config'
import { useRpc } from '@/hooks/use-rpc'
import { useWalletUiSigner } from '@/components/solana/use-wallet-ui-signer'
import { useTransactionToast } from '@/components/use-transaction-toast'
import { api, type DeployPlan } from '@/lib/api-client'
import { extractErrorMessage } from '@/lib/error-utils'
import {
  BPF_LOADER_UPGRADEABLE,
  buildCreateAccountIx,
  buildInitializeBufferIx,
  buildWriteIx,
  buildDeployIx,
  buildUpgradeIx,
  buildSetAuthorityIx,
  buildCloseBufferIx,
  buildTransferIx,
  deriveProgramDataAddress,
  CHUNK_SIZE,
} from '@/lib/bpf-loader-browser'

export interface DeployProgress {
  phase: 'preparing' | 'funding' | 'init' | 'writing' | 'deploying' | 'done' | 'error'
  current: number
  total: number
  message: string
}

async function createKeypairSigner(bytes: Uint8Array): Promise<KeyPairSigner> {
  const kp = await createKeyPairFromBytes(bytes)
  return createSignerFromKeyPair(kp)
}

export function useProgramDeploy() {
  const walletSigner = useWalletUiSigner()
  const { url: rpcUrl, id: clusterId } = useClusterConfig()
  const queryClient = useQueryClient()
  const toast = useTransactionToast()
  const rpc = useRpc()
  const [progress, setProgress] = useState<DeployProgress>({
    phase: 'preparing', current: 0, total: 0, message: '',
  })
  const lastPlanRef = useRef<DeployPlan | null>(null)
  const bufferSignerRef = useRef<KeyPairSigner | null>(null)
  const feePayerRef = useRef<KeyPairSigner | null>(null)

  const resetProgress = useCallback(() => {
    setProgress({ phase: 'preparing', current: 0, total: 0, message: '' })
    lastPlanRef.current = null
    bufferSignerRef.current = null
    feePayerRef.current = null
  }, [])

  async function fetchOrResumePlan(
    signer: TransactionSendingSigner,
    isUpgrade: boolean,
    resumeFrom?: number,
  ): Promise<{ plan: DeployPlan; bufferKpSigner: KeyPairSigner }> {
    if (resumeFrom !== undefined && lastPlanRef.current && bufferSignerRef.current) {
      return { plan: lastPlanRef.current, bufferKpSigner: bufferSignerRef.current }
    }
    const plan = await api.program.prepareDeploy({
      payerAddress: signer.address,
      rpcUrl,
      isUpgrade,
    })
    const bufferKpSigner = await createKeypairSigner(new Uint8Array(plan.bufferKeypair))
    lastPlanRef.current = plan
    bufferSignerRef.current = bufferKpSigner
    return { plan, bufferKpSigner }
  }

  async function fundBufferAndFeePayer(
    signer: TransactionSendingSigner,
    plan: DeployPlan,
    bufferKpSigner: KeyPairSigner,
    feePayerKp: KeyPairSigner,
    totalChunks: number,
    startChunk: number,
  ) {
    const soSize = plan.soSize
    const bufferSize = soSize + 45
    const remainingChunks = totalChunks - startChunk
    const feePayerRent = await rpc.getMinimumBalanceForRentExemption(0n).send()
    const feeBudget = feePayerRent + BigInt(remainingChunks + 2) * 10_000n

    if (startChunk === 0) {
      const rentLamports = await rpc.getMinimumBalanceForRentExemption(BigInt(bufferSize)).send()
      const totalNeeded = rentLamports + feeBudget + 10_000n

      const walletBalance = await rpc.getBalance(signer.address).send()
      const solNeeded = Number(totalNeeded) / 1e9
      const solAvailable = Number(walletBalance.value) / 1e9
      if (walletBalance.value < totalNeeded) {
        throw new Error(
          `Insufficient SOL: need ~${solNeeded.toFixed(4)} SOL for buffer rent + fees, but wallet has ${solAvailable.toFixed(4)} SOL. ` +
          `Request devnet SOL from a faucet first.`
        )
      }

      setProgress({ phase: 'funding', current: 0, total: totalChunks, message: `Funding accounts (~${solNeeded.toFixed(4)} SOL, approve in wallet)...` })

      const { value: latestBlockhash } = await rpc.getLatestBlockhash().send()

      const fundFeePayerIx = buildTransferIx(signer, feePayerKp.address, feeBudget)
      const createAccIx = buildCreateAccountIx(signer, bufferKpSigner, rentLamports, bufferSize, BPF_LOADER_UPGRADEABLE)
      const initBufferIx = buildInitializeBufferIx(bufferKpSigner.address, bufferKpSigner.address)

      const initTx = buildV0Tx(signer, latestBlockhash, [fundFeePayerIx, createAccIx, initBufferIx])
      await signAndSendTransactionMessageWithSigners(initTx)

      setProgress({ phase: 'funding', current: 0, total: totalChunks, message: 'Waiting for confirmation...' })
      for (let attempt = 0; attempt < 60; attempt++) {
        const acctInfo = await rpc.getAccountInfo(bufferKpSigner.address, { encoding: 'base64' }).send()
        if (acctInfo.value) break
        if (attempt === 59) throw new Error('Buffer account not confirmed after 60s')
        await new Promise(r => setTimeout(r, 1000))
      }
    } else {
      const fpBalance = await rpc.getBalance(feePayerKp.address).send()
      if (fpBalance.value < feeBudget) {
        setProgress({ phase: 'funding', current: 0, total: totalChunks, message: 'Funding fee payer for resume (approve in wallet)...' })
        const { value: latestBlockhash } = await rpc.getLatestBlockhash().send()
        const fundTx = buildV0Tx(signer, latestBlockhash, [buildTransferIx(signer, feePayerKp.address, feeBudget)])
        await signAndSendTransactionMessageWithSigners(fundTx)
        for (let attempt = 0; attempt < 30; attempt++) {
          const bal = await rpc.getBalance(feePayerKp.address).send()
          if (bal.value >= feeBudget) break
          if (attempt === 29) throw new Error('Fee payer funding not confirmed after 30s')
          await new Promise(r => setTimeout(r, 1000))
        }
      }
    }
  }

  async function writeChunks(
    plan: DeployPlan,
    bufferKpSigner: KeyPairSigner,
    feePayerKp: KeyPairSigner,
    startChunk: number,
    totalChunks: number,
  ) {
    let bh = (await rpc.getLatestBlockhash().send()).value
    for (let i = startChunk; i < totalChunks; i++) {
      setProgress({
        phase: 'writing', current: i + 1, total: totalChunks,
        message: `Writing program data: ${i + 1}/${totalChunks}`,
      })

      if (i > startChunk && (i - startChunk) % 30 === 0) {
        bh = (await rpc.getLatestBlockhash().send()).value
      }

      const offset = i * CHUNK_SIZE
      let chunkBytes: Uint8Array
      try {
        chunkBytes = Uint8Array.from(atob(plan.chunks[i]), c => c.charCodeAt(0))
      } catch (e) {
        throw new Error(`Failed to decode chunk ${i}/${totalChunks}: ${e instanceof Error ? e.message : String(e)}`)
      }
      const writeIx = buildWriteIx(bufferKpSigner.address, bufferKpSigner, offset, chunkBytes)

      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const writeTx = buildV0Tx(feePayerKp, bh, [writeIx])
          const signedWriteTx = await signTransactionMessageWithSigners(writeTx)
          const wireWriteTx = getBase64EncodedWireTransaction(signedWriteTx)
          await rpc.sendTransaction(wireWriteTx, { encoding: 'base64' }).send()
          break
        } catch (e) {
          if (attempt === 2) throw e
          await new Promise(r => setTimeout(r, 1000 * (attempt + 1)))
          bh = (await rpc.getLatestBlockhash().send()).value
        }
      }
    }
  }

  async function transferBufferAuthority(
    signer: TransactionSendingSigner,
    bufferKpSigner: KeyPairSigner,
    feePayerKp: KeyPairSigner,
  ) {
    const authBh = (await rpc.getLatestBlockhash().send()).value
    const setAuthIx = buildSetAuthorityIx(bufferKpSigner.address, bufferKpSigner, signer.address)
    const setAuthTx = buildV0Tx(feePayerKp, authBh, [setAuthIx])
    const signedSetAuthTx = await signTransactionMessageWithSigners(setAuthTx)
    const wireSetAuthTx = getBase64EncodedWireTransaction(signedSetAuthTx)
    await rpc.sendTransaction(wireSetAuthTx, { encoding: 'base64' }).send()
    const expectedAuth = getAddressEncoder().encode(address(signer.address))
    for (let attempt = 0; attempt < 30; attempt++) {
      const acctInfo = await rpc.getAccountInfo(bufferKpSigner.address, { encoding: 'base64' }).send()
      if (acctInfo.value) {
        const data = Uint8Array.from(atob(acctInfo.value.data[0] as string), c => c.charCodeAt(0))
        if (data.length >= 37 && data[4] === 1) {
          const onChainAuth = data.slice(5, 37)
          if (onChainAuth.every((b, i) => b === expectedAuth[i])) break
        }
      }
      if (attempt === 29) throw new Error('Buffer authority transfer not confirmed after 30s')
      await new Promise(r => setTimeout(r, 1000))
    }
  }

  async function finalizeDeployment(
    signer: TransactionSendingSigner,
    plan: DeployPlan,
    bufferKpSigner: KeyPairSigner,
    isUpgrade: boolean,
  ) {
    const freshBlockhash = (await rpc.getLatestBlockhash().send()).value
    const programAddr = address(plan.programAddress)
    const programDataPDA = await deriveProgramDataAddress(programAddr)

    let finalTx
    if (isUpgrade) {
      const upgradeIx = buildUpgradeIx(programDataPDA, programAddr, bufferKpSigner.address, signer.address, signer)
      finalTx = buildV0Tx(signer, freshBlockhash, [upgradeIx])
    } else {
      if (!plan.programKeypair) throw new Error('Program keypair required for initial deploy')
      const programKpSigner = await createKeypairSigner(new Uint8Array(plan.programKeypair))
      const programRent = await rpc.getMinimumBalanceForRentExemption(36n).send()
      const createProgramIx = buildCreateAccountIx(signer, programKpSigner, programRent, 36, BPF_LOADER_UPGRADEABLE)
      const deployIx = buildDeployIx(signer, programDataPDA, programKpSigner, bufferKpSigner.address, signer, plan.soSize * 2)
      finalTx = buildV0Tx(signer, freshBlockhash, [createProgramIx, deployIx])
    }

    try {
      const compiled = compileTransaction(finalTx)
      const wireBase64 = getBase64EncodedWireTransaction(compiled)
      const simResult = await rpc.simulateTransaction(wireBase64, { encoding: 'base64' }).send()
      if (simResult.value.err) {
        const logs = simResult.value.logs?.join('\n') ?? ''
        throw new Error(`Simulation failed: ${JSON.stringify(simResult.value.err)}\n${logs}`)
      }
    } catch (simErr) {
      if (simErr instanceof Error && simErr.message.startsWith('Simulation failed:')) throw simErr
      console.warn('Pre-simulation skipped:', simErr)
    }

    const finalSigBytes = await signAndSendTransactionMessageWithSigners(finalTx)
    return getBase58Decoder().decode(finalSigBytes)
  }

  async function reclaimFeePayerSol(
    feePayerKp: KeyPairSigner,
    signer: TransactionSendingSigner,
  ) {
    try {
      const fpBal = await rpc.getBalance(feePayerKp.address).send()
      if (fpBal.value > 5000n) {
        const reclaimBh = (await rpc.getLatestBlockhash().send()).value
        const reclaimIx = buildTransferIx(feePayerKp, signer.address, fpBal.value - 5000n)
        const reclaimTx = buildV0Tx(feePayerKp, reclaimBh, [reclaimIx])
        const signedReclaim = await signTransactionMessageWithSigners(reclaimTx)
        await rpc.sendTransaction(getBase64EncodedWireTransaction(signedReclaim), { encoding: 'base64' }).send()
      }
    } catch (e) {
      console.warn('Fee payer reclaim failed:', e instanceof Error ? e.message : String(e))
    }
  }

  const closeBuffer = useMutation({
    mutationFn: async () => {
      if (!walletSigner || !bufferSignerRef.current) throw new Error('No buffer to close')
      const signer = walletSigner as TransactionSendingSigner
      const bufferKp = bufferSignerRef.current

      const { value: latestBlockhash } = await rpc.getLatestBlockhash().send()

      const closeIx = buildCloseBufferIx(bufferKp.address, signer.address, bufferKp)
      const closeTx = buildV0Tx(signer, latestBlockhash, [closeIx])
      await signAndSendTransactionMessageWithSigners(closeTx)
      bufferSignerRef.current = null
    },
    onSuccess: () => { toast.onSuccess('Buffer closed, SOL reclaimed') },
    onError: (e) => toast.onError(e),
  })

  const deploy = useMutation({
    mutationFn: async ({ isUpgrade, resumeFrom }: { isUpgrade: boolean; resumeFrom?: number }) => {
      if (!walletSigner) throw new Error('Wallet not connected')
      const signer = walletSigner as TransactionSendingSigner

      setProgress({ phase: 'preparing', current: 0, total: 0, message: 'Fetching program data...' })

      const { plan, bufferKpSigner } = await fetchOrResumePlan(signer, isUpgrade, resumeFrom)
      lastPlanRef.current = plan
      bufferSignerRef.current = bufferKpSigner

      const totalChunks = plan.totalChunks
      const startChunk = resumeFrom ?? 0

      let feePayerKp: KeyPairSigner
      if (feePayerRef.current) {
        feePayerKp = feePayerRef.current
      } else {
        feePayerKp = await createSignerFromKeyPair(await generateKeyPair())
        feePayerRef.current = feePayerKp
      }

      await fundBufferAndFeePayer(signer, plan, bufferKpSigner, feePayerKp, totalChunks, startChunk)

      await writeChunks(plan, bufferKpSigner, feePayerKp, startChunk, totalChunks)

      setProgress({
        phase: 'deploying', current: totalChunks, total: totalChunks,
        message: 'Transferring buffer authority...',
      })

      await transferBufferAuthority(signer, bufferKpSigner, feePayerKp)

      setProgress({
        phase: 'deploying', current: totalChunks, total: totalChunks,
        message: isUpgrade ? 'Finalizing upgrade (approve in wallet)...' : 'Finalizing deployment (approve in wallet)...',
      })

      const signature = await finalizeDeployment(signer, plan, bufferKpSigner, isUpgrade)

      await reclaimFeePayerSol(feePayerKp, signer)

      setProgress({
        phase: 'done', current: totalChunks, total: totalChunks,
        message: 'Deployment complete!',
      })

      bufferSignerRef.current = null
      lastPlanRef.current = null
      feePayerRef.current = null

      return { signature, programAddress: plan.programAddress }
    },
    onSuccess: (res) => {
      toast.onSuccess(res.signature)
      queryClient.invalidateQueries({ queryKey: ['program-status', clusterId] })
    },
    onError: (error) => {
      console.error('Deploy/upgrade error:', error)
      const msg = extractErrorMessage(error)
      setProgress(prev => ({
        ...prev,
        phase: 'error',
        message: msg,
      }))
      toast.onError(error)
    },
  })

  return { deploy, progress, resetProgress, closeBuffer }
}
