import {
    appendTransactionMessageInstructions,
    assertIsSendableTransaction,
    type ClientWithRpc,
    type ClientWithRpcSubscriptions,
    compileTransaction,
    createTransactionMessage,
    type GetAccountInfoApi,
    type GetEpochInfoApi,
    type GetLatestBlockhashApi,
    type GetSignatureStatusesApi,
    getSignatureFromTransaction,
    type Instruction,
    type KeyPairSigner,
    pipe,
    sendAndConfirmTransactionFactory,
    type SendTransactionApi,
    setTransactionMessageFeePayer,
    setTransactionMessageLifetimeUsingBlockhash,
    type SignatureNotificationsApi,
    signTransaction,
    type SlotNotificationsApi,
} from '@solana/kit';
import type { KitInstruction } from '@swig-wallet/kit';

export type SmartWalletInstruction = Instruction | KitInstruction;

export type SmartWalletClient = ClientWithRpc<
    GetAccountInfoApi & GetEpochInfoApi & GetLatestBlockhashApi & GetSignatureStatusesApi & SendTransactionApi
> &
    ClientWithRpcSubscriptions<SignatureNotificationsApi & SlotNotificationsApi>;

export async function sendKitInstructions(
    client: SmartWalletClient,
    feePayer: KeyPairSigner,
    signers: KeyPairSigner[],
    instructions: SmartWalletInstruction[],
): Promise<string> {
    const { value: latestBlockhash } = await client.rpc.getLatestBlockhash().send();

    const message = pipe(
        createTransactionMessage({ version: 0 }),
        tx => setTransactionMessageFeePayer(feePayer.address, tx),
        tx => setTransactionMessageLifetimeUsingBlockhash(latestBlockhash, tx),
        tx => appendTransactionMessageInstructions(instructions as Instruction[], tx),
    );
    const transaction = await signTransaction(
        [feePayer, ...signers].map(signer => signer.keyPair),
        compileTransaction(message),
    );
    assertIsSendableTransaction(transaction);

    await sendAndConfirmTransactionFactory(client)(transaction, { commitment: 'confirmed' });
    return getSignatureFromTransaction(transaction);
}
