import { randomBytes } from 'node:crypto';
import type { Address, Instruction } from '@solana/kit';
import { type Connection, type Keypair, PublicKey } from '@solana/web3.js';
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
import nacl from 'tweetnacl';
import type { SmartWallet } from './SmartWallet.ts';
import { sendWeb3Instructions } from './utils.ts';

type SwigWalletConfig = {
    connection: Connection;
    feePayer: Keypair;
    authority: Keypair;
};

class SwigSmartWallet implements SmartWallet {
    public readonly name = 'swig';
    public readonly address: Address;
    private readonly connection: Connection;
    private readonly feePayer: Keypair;
    private readonly authority: Keypair;
    private readonly swig: Swig;
    private readonly roleId: number;

    constructor(config: {
        connection: Connection;
        feePayer: Keypair;
        authority: Keypair;
        swig: Swig;
        walletAddress: Address;
        roleId: number;
    }) {
        this.connection = config.connection;
        this.feePayer = config.feePayer;
        this.authority = config.authority;
        this.swig = config.swig;
        this.address = config.walletAddress;
        this.roleId = config.roleId;
    }

    async sendInstructions(instructions: Instruction[]): Promise<string> {
        const signingFn: SigningFn = async message => ({
            signature: nacl.sign.detached(message, this.authority.secretKey),
        });

        const innerInstructions = instructions.map(ix => SolInstruction.from(ix as unknown).toKitInstruction());

        const signInstructions = await getSignInstructions(this.swig, this.roleId, innerInstructions, false, {
            signingFn,
            payer: this.feePayer.publicKey,
        });

        return sendWeb3Instructions(this.connection, this.feePayer, [this.authority], signInstructions);
    }
}

export async function createSwigWallet(config: SwigWalletConfig): Promise<SmartWallet> {
    const swigId = randomBytes(32);
    const actions = ActionsBuilder.new().manageAuthority().all().get();
    const authorityInfo = createEd25519AuthorityInfo(config.authority.publicKey);

    const createIx = await getCreateSwigInstruction({
        payer: config.feePayer.publicKey,
        id: swigId,
        actions,
        authorityInfo,
    });

    await sendWeb3Instructions(config.connection, config.feePayer, [], [createIx]);

    const [swigPda] = await findSwigPdaRaw(swigId);
    const swigPubkey = new PublicKey(swigPda.toBytes());
    const swigAccountInfo = await config.connection.getAccountInfo(swigPubkey);
    if (!swigAccountInfo) {
        throw new Error('Swig account not found after creation');
    }

    const swig = Swig.fromRawAccountData(swigPda.toBase58(), swigAccountInfo.data);
    const walletAddress = (await getSwigWalletAddressRaw(swig)).toBase58();

    return new SwigSmartWallet({
        connection: config.connection,
        feePayer: config.feePayer,
        authority: config.authority,
        swig,
        walletAddress: walletAddress as Address,
        roleId: 0,
    });
}
