/**
 * Initializes test environment for webapp development
 * Idempotent - checks on-chain state before creating resources
 */

import { createSolanaRpc, address } from 'gill'
import { execFileSync } from 'child_process'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { readConfig, addToken, clearConfig, setProgramAddress } from './config-manager'
import { createMockUsdc } from './helpers'

const __dirname = dirname(fileURLToPath(import.meta.url))
const KEYPAIR_PATH = join(__dirname, '../../keys/subscriptions-keypair.json')

function getProgramId(): string {
  return execFileSync('solana-keygen', ['pubkey', KEYPAIR_PATH], { encoding: 'utf-8' }).trim()
}

const RPC_URL = process.env.RPC_URL ?? 'http://127.0.0.1:8899'
const NETWORK = process.env.NETWORK ?? 'localnet'

async function main() {
  console.log(`Initializing test environment for ${NETWORK}...`)

  try {
    const rpc = createSolanaRpc(RPC_URL)

    console.log(`Connecting to ${RPC_URL}...`)
    await rpc.getLatestBlockhash().send()
    await new Promise((r) => setTimeout(r, 1000))
    console.log('RPC ready')

    const existingConfig = await readConfig()
    const networkTokens = existingConfig.networks[NETWORK]?.tokens ?? []
    let usdcMintString = networkTokens.find((t) => t.symbol === 'USDC')?.mint
    let needsNewMint = true

    if (usdcMintString) {
      try {
        const accountInfo = await rpc.getAccountInfo(address(usdcMintString)).send()
        if (accountInfo.value) {
          console.log('Existing mock USDC mint found on-chain:', usdcMintString)
          needsNewMint = false
        }
      } catch {
        console.log('Configured USDC mint not found on-chain, will create new one')
      }
    }

    if (needsNewMint) {
      console.log('Creating new mock USDC mint...')
      usdcMintString = await createMockUsdc()
      console.log('New mock USDC created:', usdcMintString)
    }

    console.log('Updating configuration...')
    await clearConfig(NETWORK)
    const programId = getProgramId()
    console.log('Program ID (from keypair):', programId)
    await setProgramAddress(NETWORK, programId)

    await addToken(NETWORK, {
      symbol: 'USDC',
      name: 'Mock USDC',
      mint: usdcMintString!,
      decimals: 6,
      type: 'test',
      description: 'Mock USDC for local development',
    })

    console.log('Test environment ready!')
    console.log('')
    console.log('USDC Mint:', usdcMintString)
  } catch (error) {
    console.error('Failed to initialize:', error)
    process.exit(1)
  }
}

main()
