import { randomBytes } from 'node:crypto';
import {
    type Address,
    createNoopSigner,
    fetchEncodedAccount,
    type Instruction,
    type KeyPairSigner,
    signBytes,
    type TransactionSigner,
} from '@solana/kit';
import {
    ActionsBuilder,
    createEd25519AuthorityInfo,
    findSwigPdaRaw,
    getCreateSwigInstruction,
    getSignInstructions,
    getSwigWalletAddressRaw,
    type SigningFn,
    SolInstruction,
    Swig,
} from '@swig-wallet/kit';
import type { SmartWallet } from './SmartWallet.ts';
import { sendKitInstructions, type SmartWalletClient } from './utils.ts';

type SwigWalletConfig = {
    client: SmartWalletClient;
    feePayer: KeyPairSigner;
    authority: KeyPairSigner;
};

class SwigSmartWallet implements SmartWallet {
    public readonly name = 'swig';
    public readonly address: Address;
    public readonly signer: TransactionSigner;
    private readonly client: SmartWalletClient;
    private readonly feePayer: KeyPairSigner;
    private readonly authority: KeyPairSigner;
    private readonly swig: Swig;
    private readonly roleId: number;

    constructor(config: {
        client: SmartWalletClient;
        feePayer: KeyPairSigner;
        authority: KeyPairSigner;
        swig: Swig;
        walletAddress: Address;
        roleId: number;
    }) {
        this.client = config.client;
        this.feePayer = config.feePayer;
        this.authority = config.authority;
        this.swig = config.swig;
        this.address = config.walletAddress;
        this.signer = createNoopSigner(this.address);
        this.roleId = config.roleId;
    }

    async sendInstructions(instructions: Instruction[]): Promise<string> {
        const signingFn: SigningFn = async message => ({
            signature: await signBytes(this.authority.keyPair.privateKey, message),
        });

        const innerInstructions = instructions.map(ix => SolInstruction.from(ix as unknown).toKitInstruction());

        const signInstructions = await getSignInstructions(this.swig, this.roleId, innerInstructions, false, {
            signingFn,
            payer: this.feePayer.address,
        });

        return sendKitInstructions(this.client, this.feePayer, [this.authority], signInstructions);
    }
}

export async function createSwigWallet(config: SwigWalletConfig): Promise<SmartWallet> {
    const swigId = randomBytes(32);
    const actions = ActionsBuilder.new().manageAuthority().all().get();
    const authorityInfo = createEd25519AuthorityInfo(config.authority.address);

    const createIx = await getCreateSwigInstruction({
        payer: config.feePayer.address,
        id: swigId,
        actions,
        authorityInfo,
    });

    await sendKitInstructions(config.client, config.feePayer, [], [createIx]);

    const [swigPda] = await findSwigPdaRaw(swigId);
    const swigAccount = await fetchEncodedAccount(config.client.rpc, swigPda.toBase58() as Address);
    if (!swigAccount.exists) {
        throw new Error('Swig account not found after creation');
    }

    const swig = Swig.fromRawAccountData(swigPda.toBase58(), swigAccount.data);
    const walletAddress = (await getSwigWalletAddressRaw(swig)).toBase58();

    return new SwigSmartWallet({
        client: config.client,
        feePayer: config.feePayer,
        authority: config.authority,
        swig,
        walletAddress: walletAddress as Address,
        roleId: 0,
    });
}
