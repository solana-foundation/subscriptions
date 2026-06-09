// Drives a hooked-mint fixed-delegation transfer through the SDK against an
// in-process LiteSVM VM, asserting the SDK resolves + forwards the hook accounts
// and the hook program runs.

import { resolve } from 'node:path';

import {
    type Address,
    appendTransactionMessageInstruction,
    type ClientWithRpc,
    createClient,
    createTransactionMessage,
    type EncodedAccount,
    generateKeyPairSigner,
    type GetProgramAccountsApi,
    getAddressDecoder,
    getAddressEncoder,
    getMinimumBalanceForRentExemption,
    getProgramDerivedAddress,
    type Instruction,
    type KeyPairSigner,
    lamports,
    pipe,
    type ReadonlyUint8Array,
    setTransactionMessageFeePayerSigner,
    setTransactionMessageLifetimeUsingBlockhash,
    signTransactionMessageWithSigners,
    type TransactionSigner,
} from '@solana/kit';
import { createRpcFromSvm } from '@solana/kit-plugin-litesvm';
import { signer } from '@solana/kit-plugin-signer';
import {
    AccountState,
    extension,
    findAssociatedTokenPda,
    getMintEncoder,
    getTokenEncoder,
    TOKEN_2022_PROGRAM_ADDRESS,
    fetchMint,
} from '@solana-program/token-2022';
import { FailedTransactionMetadata, LiteSVM } from 'litesvm';
import { beforeAll, describe, expect, it } from 'vitest';

import {
    findFixedDelegationPda,
    findSubscriptionAuthorityPda,
    getCreateFixedDelegationOverlayInstructionAsync,
    getInitSubscriptionAuthorityOverlayInstructionAsync,
    getSubscriptionAuthorityDecoder,
    getTransferFixedOverlayInstructionAsync,
    resolveTransferHookAccounts,
    subscriptionsProgram,
} from '../src/index.js';

const SUBSCRIPTIONS_PROGRAM_ID = 'De1egAFMkMWZSN5rYXRj9CAdheBamobVNubTsi9avR44' as Address;
const HOOK_PROGRAM_ID = getAddressDecoder().decode(new Uint8Array(32).fill(42));

const SUBSCRIPTIONS_SO = resolve(process.cwd(), '../../target/deploy/subscriptions_program.so');
const HOOK_SO = resolve(process.cwd(), '../../tests/transfer-hook-example/target/deploy/transfer_hook_example.so');

const EXECUTE_DISCRIMINATOR = [0x69, 0x25, 0x65, 0xc5, 0x4b, 0xfb, 0x66, 0x1a];

function encodedAccount(address: Address, data: Uint8Array, owner: Address): EncodedAccount {
    return {
        address,
        data,
        executable: false,
        lamports: lamports(getMinimumBalanceForRentExemption(BigInt(data.length))),
        programAddress: owner,
        space: BigInt(data.length),
    };
}

function liteSvmRpc(svm: LiteSVM) {
    return createRpcFromSvm(svm) as unknown as Parameters<typeof fetchMint>[0];
}

/** Injects the LiteSVM RPC as `client.rpc` so the plugin client resolves hook accounts against the VM. */
function liteSvmRpcPlugin(svm: LiteSVM) {
    return <T extends object>(client: T): T & ClientWithRpc<GetProgramAccountsApi> =>
        ({ ...client, rpc: liteSvmRpc(svm) }) as T & ClientWithRpc<GetProgramAccountsApi>;
}

// One seed-derived ExtraAccountMeta: PDA from seeds [Literal("counter"), AccountKey(mint)].
function extraAccountMetaListData(): Uint8Array {
    const data = new Uint8Array(8 + 4 + 4 + 35);
    const view = new DataView(data.buffer);
    data.set(EXECUTE_DISCRIMINATOR, 0);
    view.setUint32(8, 4 + 35, true);
    view.setUint32(12, 1, true);
    data[16] = 1; // discriminator 1 = PDA of the hook program
    const seedConfig = data.subarray(17, 49);
    seedConfig[0] = 1; // Literal seed
    seedConfig[1] = 7;
    seedConfig.set(new TextEncoder().encode('counter'), 2);
    seedConfig[9] = 3; // AccountKey seed
    seedConfig[10] = 1; // index 1 = mint
    data[49] = 0; // is_signer
    data[50] = 1; // is_writable
    return data;
}

function counterPdaSeeds(mint: Address): [string, ReadonlyUint8Array] {
    return ['counter', getAddressEncoder().encode(mint)];
}

function hookedTokenAccount(mint: Address, owner: Address, amount: bigint): Uint8Array {
    return new Uint8Array(
        getTokenEncoder().encode({
            amount,
            closeAuthority: null,
            delegate: null,
            delegatedAmount: 0n,
            extensions: [extension('TransferHookAccount', { transferring: false })],
            isNative: null,
            mint,
            owner,
            state: AccountState.Initialized,
        }),
    );
}

async function send(svm: LiteSVM, feePayer: TransactionSigner, instruction: Instruction): Promise<void> {
    const message = pipe(
        createTransactionMessage({ version: 0 }),
        m => setTransactionMessageFeePayerSigner(feePayer, m),
        m =>
            setTransactionMessageLifetimeUsingBlockhash(
                { blockhash: svm.latestBlockhash(), lastValidBlockHeight: 2n ** 63n },
                m,
            ),
        m => appendTransactionMessageInstruction(instruction, m),
    );
    const signed = await signTransactionMessageWithSigners(message);
    const result = svm.sendTransaction(signed);
    if (result instanceof FailedTransactionMetadata) {
        throw new Error(`tx failed: ${result.err()}\n${result.meta().logs().join('\n')}`);
    }
    svm.expireBlockhash();
}

describe('Token-2022 transfer hook (LiteSVM)', () => {
    let svm: LiteSVM;
    let payer: KeyPairSigner;
    let mint: Address;
    let counter: Address;

    beforeAll(async () => {
        svm = new LiteSVM();
        svm.addProgramFromFile(SUBSCRIPTIONS_PROGRAM_ID, SUBSCRIPTIONS_SO);
        svm.addProgramFromFile(HOOK_PROGRAM_ID, HOOK_SO);

        payer = await generateKeyPairSigner();
        svm.airdrop(payer.address, lamports(10_000_000_000n));

        mint = (await generateKeyPairSigner()).address;
        const mintData = new Uint8Array(
            getMintEncoder().encode({
                decimals: 6,
                extensions: [extension('TransferHook', { authority: payer.address, programId: HOOK_PROGRAM_ID })],
                freezeAuthority: null,
                isInitialized: true,
                mintAuthority: payer.address,
                supply: 0n,
            }),
        );
        svm.setAccount(encodedAccount(mint, mintData, TOKEN_2022_PROGRAM_ADDRESS));

        [counter] = await getProgramDerivedAddress({ programAddress: HOOK_PROGRAM_ID, seeds: counterPdaSeeds(mint) });
        const [validationPda] = await getProgramDerivedAddress({
            programAddress: HOOK_PROGRAM_ID,
            seeds: ['extra-account-metas', getAddressEncoder().encode(mint)],
        });
        svm.setAccount(encodedAccount(validationPda, extraAccountMetaListData(), HOOK_PROGRAM_ID));
        svm.setAccount(encodedAccount(counter, new Uint8Array(1), HOOK_PROGRAM_ID));
    });

    it('auto-resolves hook accounts and runs the hook on a fixed-delegation transfer', async () => {
        const delegatee = await generateKeyPairSigner();
        const [delegatorAta] = await findAssociatedTokenPda({
            mint,
            owner: payer.address,
            tokenProgram: TOKEN_2022_PROGRAM_ADDRESS,
        });
        const [receiverAta] = await findAssociatedTokenPda({
            mint,
            owner: delegatee.address,
            tokenProgram: TOKEN_2022_PROGRAM_ADDRESS,
        });
        svm.setAccount(
            encodedAccount(
                delegatorAta,
                hookedTokenAccount(mint, payer.address, 100_000_000n),
                TOKEN_2022_PROGRAM_ADDRESS,
            ),
        );
        svm.setAccount(
            encodedAccount(receiverAta, hookedTokenAccount(mint, delegatee.address, 0n), TOKEN_2022_PROGRAM_ADDRESS),
        );

        await send(
            svm,
            payer,
            await getInitSubscriptionAuthorityOverlayInstructionAsync({
                owner: payer,
                tokenMint: mint,
                tokenProgram: TOKEN_2022_PROGRAM_ADDRESS,
                userAta: delegatorAta,
            }),
        );

        const [subscriptionAuthority] = await findSubscriptionAuthorityPda({ tokenMint: mint, user: payer.address });
        const authAccount = svm.getAccount(subscriptionAuthority)!;
        const { initId } = getSubscriptionAuthorityDecoder().decode(authAccount.data);

        await send(
            svm,
            payer,
            await getCreateFixedDelegationOverlayInstructionAsync({
                amount: 50_000_000n,
                delegatee: delegatee.address,
                delegator: payer,
                expectedSubscriptionAuthorityInitId: initId,
                expiryTs: BigInt(Math.floor(Date.now() / 1000) + 86_400),
                nonce: 0n,
                tokenMint: mint,
            }),
        );

        const [delegationPda] = await findFixedDelegationPda({
            delegatee: delegatee.address,
            delegator: payer.address,
            nonce: 0n,
            subscriptionAuthority,
        });

        const transferHookAccounts = await resolveTransferHookAccounts(liteSvmRpc(svm), {
            amount: 10_000_000n,
            authority: subscriptionAuthority,
            destination: receiverAta,
            mint,
            source: delegatorAta,
            tokenProgram: TOKEN_2022_PROGRAM_ADDRESS,
        });
        expect(transferHookAccounts).toHaveLength(3);
        expect(transferHookAccounts[2].address).toBe(counter);

        await send(
            svm,
            payer,
            await getTransferFixedOverlayInstructionAsync({
                amount: 10_000_000n,
                delegatee,
                delegationPda,
                delegator: payer.address,
                delegatorAta,
                receiverAta,
                tokenMint: mint,
                tokenProgram: TOKEN_2022_PROGRAM_ADDRESS,
                transferHookAccounts,
            }),
        );

        const receiverData = svm.getAccount(receiverAta)!.data;
        const receiverAmount = new DataView(
            receiverData.buffer,
            receiverData.byteOffset,
            receiverData.byteLength,
        ).getBigUint64(64, true);
        expect(receiverAmount).toBe(10_000_000n);

        expect(svm.getAccount(counter)!.data[0]).toBe(1);
    });

    it('auto-resolves hook accounts through the plugin client transferFixed', async () => {
        const delegatee = await generateKeyPairSigner();
        const [delegatorAta] = await findAssociatedTokenPda({
            mint,
            owner: payer.address,
            tokenProgram: TOKEN_2022_PROGRAM_ADDRESS,
        });
        const [receiverAta] = await findAssociatedTokenPda({
            mint,
            owner: delegatee.address,
            tokenProgram: TOKEN_2022_PROGRAM_ADDRESS,
        });
        svm.setAccount(
            encodedAccount(receiverAta, hookedTokenAccount(mint, delegatee.address, 0n), TOKEN_2022_PROGRAM_ADDRESS),
        );

        const [subscriptionAuthority] = await findSubscriptionAuthorityPda({ tokenMint: mint, user: payer.address });
        const { initId } = getSubscriptionAuthorityDecoder().decode(svm.getAccount(subscriptionAuthority)!.data);

        await send(
            svm,
            payer,
            await getCreateFixedDelegationOverlayInstructionAsync({
                amount: 50_000_000n,
                delegatee: delegatee.address,
                delegator: payer,
                expectedSubscriptionAuthorityInitId: initId,
                expiryTs: BigInt(Math.floor(Date.now() / 1000) + 86_400),
                nonce: 1n,
                tokenMint: mint,
            }),
        );

        const [delegationPda] = await findFixedDelegationPda({
            delegatee: delegatee.address,
            delegator: payer.address,
            nonce: 1n,
            subscriptionAuthority,
        });

        const client = createClient().use(signer(delegatee)).use(liteSvmRpcPlugin(svm)).use(subscriptionsProgram());

        const counterBefore = svm.getAccount(counter)!.data[0];
        const instruction = await client.subscriptions.instructions.transferFixed({
            amount: 10_000_000n,
            delegationPda,
            delegator: payer.address,
            delegatorAta,
            receiverAta,
            tokenMint: mint,
            tokenProgram: TOKEN_2022_PROGRAM_ADDRESS,
        });

        await send(svm, payer, instruction);

        const receiverData = svm.getAccount(receiverAta)!.data;
        const receiverAmount = new DataView(
            receiverData.buffer,
            receiverData.byteOffset,
            receiverData.byteLength,
        ).getBigUint64(64, true);
        expect(receiverAmount).toBe(10_000_000n);
        expect(svm.getAccount(counter)!.data[0]).toBe(counterBefore + 1);
    });
});
