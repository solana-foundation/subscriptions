import {
  type Address,
  appendTransactionMessageInstructions,
  type ClientWithRpc,
  createTransactionMessage,
  type GetLatestBlockhashApi,
  getBase64EncodedWireTransaction,
  getSignatureFromTransaction,
  type Instruction,
  pipe,
  type SendTransactionApi,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
  type TransactionSigner,
} from '@solana/kit';

export interface Wallet {
  readonly address: Address;
  sendInstructions(instructions: Instruction[]): Promise<string>;
}

type RpcClient = ClientWithRpc<GetLatestBlockhashApi & SendTransactionApi>;

export class KeyPairWallet implements Wallet {
  readonly address: Address;

  constructor(
    private readonly signer: TransactionSigner,
    private readonly client: RpcClient,
  ) {
    this.address = signer.address;
  }

  async sendInstructions(instructions: Instruction[]): Promise<string> {
    const { value: latestBlockhash } = await this.client.rpc
      .getLatestBlockhash()
      .send();

    const transactionMessage = pipe(
      createTransactionMessage({ version: 0 }),
      (tx) => setTransactionMessageFeePayerSigner(this.signer, tx),
      (tx) => setTransactionMessageLifetimeUsingBlockhash(latestBlockhash, tx),
      (tx) => appendTransactionMessageInstructions(instructions, tx),
    );
    const signedTransaction =
      await signTransactionMessageWithSigners(transactionMessage);
    const wireTransaction = getBase64EncodedWireTransaction(signedTransaction);
    const signature = getSignatureFromTransaction(signedTransaction);
    await this.client.rpc
      .sendTransaction(wireTransaction, {
        encoding: 'base64',
        preflightCommitment: 'confirmed',
        skipPreflight: true,
      })
      .send({ abortSignal: AbortSignal.timeout(30_000) });
    return signature;
  }
}

export function addressAsSigner(address: Address): TransactionSigner {
  return { address } as unknown as TransactionSigner;
}
