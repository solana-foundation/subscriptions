/**
 * Token-2022 transfer-hook account resolution, ported to `@solana/kit` from the
 * web3.js `@solana/spl-token` resolver (the kit client ships no equivalent).
 * Computes the trailing accounts a hooked `TransferChecked` must forward.
 */

import {
    AccountRole,
    type Address,
    fetchEncodedAccount,
    getAddressDecoder,
    getAddressEncoder,
    getProgramDerivedAddress,
    type ReadonlyUint8Array,
} from '@solana/kit';
import { fetchMint, TOKEN_2022_PROGRAM_ADDRESS } from '@solana-program/token-2022';

export type TransferHookAccount = { address: Address; role: AccountRole };

/** Identity of the four base `Execute` accounts and the transfer amount, needed
 * to resolve seed- and instruction-data-derived extra accounts. */
export type ResolveTransferHookArgs = {
    amount: bigint | number;
    authority: Address;
    destination: Address;
    mint: Address;
    source: Address;
    tokenProgram: Address;
    transferHookAccounts?: TransferHookAccount[];
};

const DEFAULT_ADDRESS = '11111111111111111111111111111111' as Address;
const EXTRA_ACCOUNT_METAS_SEED = 'extra-account-metas';
const TLV_HEADER_LEN = 12; // u64 discriminator + u32 length
const POD_SLICE_COUNT_LEN = 4;
const EXTRA_ACCOUNT_META_LEN = 35;
const PUBKEY_LEN = 32;
const PDA_PROGRAM_INDEX_OFFSET = 1 << 7;
// sha256("spl-transfer-hook-interface:execute")[..8]
const EXECUTE_DISCRIMINATOR = Uint8Array.from([0x69, 0x25, 0x65, 0xc5, 0x4b, 0xfb, 0x66, 0x1a]);

const addressDecoder = getAddressDecoder();
const addressEncoder = getAddressEncoder();

function roleFor(isSigner: boolean, isWritable: boolean): AccountRole {
    if (isSigner && isWritable) return AccountRole.WRITABLE_SIGNER;
    if (isSigner) return AccountRole.READONLY_SIGNER;
    if (isWritable) return AccountRole.WRITABLE;
    return AccountRole.READONLY;
}

async function fetchData(rpc: ResolveRpc, address: Address): Promise<ReadonlyUint8Array> {
    const account = await fetchEncodedAccount(rpc, address);
    if (!account.exists) throw new Error('transfer hook: referenced account not found');
    return account.data;
}

type ResolveRpc = Parameters<typeof fetchMint>[0];
type RawMeta = { addressConfig: ReadonlyUint8Array; discriminator: number; isSigner: boolean; isWritable: boolean };

function executeInstructionData(amount: bigint | number): Uint8Array {
    const data = new Uint8Array(EXECUTE_DISCRIMINATOR.length + 8);
    data.set(EXECUTE_DISCRIMINATOR, 0);
    new DataView(data.buffer).setBigUint64(EXECUTE_DISCRIMINATOR.length, BigInt(amount), true);
    return data;
}

function readMetas(data: ReadonlyUint8Array): RawMeta[] {
    if (data.length < TLV_HEADER_LEN || !EXECUTE_DISCRIMINATOR.every((byte, i) => data[i] === byte)) {
        return [];
    }
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    const count = view.getUint32(TLV_HEADER_LEN, true);
    const metas: RawMeta[] = [];
    let offset = TLV_HEADER_LEN + POD_SLICE_COUNT_LEN;
    for (let n = 0; n < count && offset + EXTRA_ACCOUNT_META_LEN <= data.length; n++) {
        metas.push({
            addressConfig: data.subarray(offset + 1, offset + 33),
            discriminator: data[offset],
            isSigner: data[offset + 33] === 1,
            isWritable: data[offset + 34] === 1,
        });
        offset += EXTRA_ACCOUNT_META_LEN;
    }
    return metas;
}

async function unpackSeeds(
    config: ReadonlyUint8Array,
    previous: TransferHookAccount[],
    instructionData: Uint8Array,
    rpc: ResolveRpc,
): Promise<ReadonlyUint8Array[]> {
    const seeds: ReadonlyUint8Array[] = [];
    let i = 0;
    while (i < 32) {
        const discriminator = config[i];
        const rest = config.subarray(i + 1);
        if (discriminator === 0) break;
        if (discriminator === 1) {
            const length = rest[0];
            seeds.push(rest.subarray(1, 1 + length));
            i += 2 + length;
        } else if (discriminator === 2) {
            const [index, length] = [rest[0], rest[1]];
            seeds.push(instructionData.subarray(index, index + length));
            i += 3;
        } else if (discriminator === 3) {
            seeds.push(addressEncoder.encode(previous[rest[0]].address));
            i += 2;
        } else if (discriminator === 4) {
            const [accountIndex, dataIndex, length] = [rest[0], rest[1], rest[2]];
            const data = await fetchData(rpc, previous[accountIndex].address);
            seeds.push(data.subarray(dataIndex, dataIndex + length));
            i += 4;
        } else {
            throw new Error('transfer hook: invalid seed');
        }
    }
    return seeds;
}

async function unpackPubkeyData(
    config: ReadonlyUint8Array,
    previous: TransferHookAccount[],
    instructionData: Uint8Array,
    rpc: ResolveRpc,
): Promise<Address> {
    const rest = config.subarray(1);
    if (config[0] === 1) {
        const offset = rest[0];
        return addressDecoder.decode(instructionData.subarray(offset, offset + PUBKEY_LEN));
    }
    if (config[0] === 2) {
        const [accountIndex, offset] = [rest[0], rest[1]];
        const data = await fetchData(rpc, previous[accountIndex].address);
        return addressDecoder.decode(data.subarray(offset, offset + PUBKEY_LEN));
    }
    throw new Error('transfer hook: invalid pubkey data');
}

async function resolveMeta(
    meta: RawMeta,
    previous: TransferHookAccount[],
    instructionData: Uint8Array,
    hookProgram: Address,
    rpc: ResolveRpc,
): Promise<TransferHookAccount> {
    const role = roleFor(meta.isSigner, meta.isWritable);
    if (meta.discriminator === 0) {
        return { address: addressDecoder.decode(meta.addressConfig), role };
    }
    if (meta.discriminator === 2) {
        return { address: await unpackPubkeyData(meta.addressConfig, previous, instructionData, rpc), role };
    }
    const programId =
        meta.discriminator === 1 ? hookProgram : previous[meta.discriminator - PDA_PROGRAM_INDEX_OFFSET].address;
    const seeds = await unpackSeeds(meta.addressConfig, previous, instructionData, rpc);
    const [pda] = await getProgramDerivedAddress({ programAddress: programId, seeds });
    return { address: pda, role };
}

/**
 * Trailing hook accounts for a `TransferChecked` — `[hook program, validation PDA,
 * ...resolved extras]`. Returns `[]` for non-2022, no-hook, or inert mints, and
 * the explicit `transferHookAccounts` verbatim when provided.
 */
export async function resolveTransferHookAccounts(
    rpc: ResolveRpc,
    args: ResolveTransferHookArgs,
): Promise<TransferHookAccount[]> {
    if (args.transferHookAccounts) return args.transferHookAccounts;
    if (args.tokenProgram !== TOKEN_2022_PROGRAM_ADDRESS) return [];

    const { data } = await fetchMint(rpc, args.mint);
    const extensions = data.extensions.__option === 'Some' ? data.extensions.value : [];
    const hook = extensions.find(extension => extension.__kind === 'TransferHook');
    if (!hook || hook.programId === DEFAULT_ADDRESS) return [];

    const hookProgram = hook.programId;
    const [validationPda] = await getProgramDerivedAddress({
        programAddress: hookProgram,
        seeds: [EXTRA_ACCOUNT_METAS_SEED, addressEncoder.encode(args.mint)],
    });

    const trailing: TransferHookAccount[] = [
        { address: hookProgram, role: AccountRole.READONLY },
        { address: validationPda, role: AccountRole.READONLY },
    ];

    const validationAccount = await fetchEncodedAccount(rpc, validationPda);
    if (!validationAccount.exists) return trailing;

    const instructionData = executeInstructionData(args.amount);
    const previous: TransferHookAccount[] = [
        { address: args.source, role: AccountRole.READONLY },
        { address: args.mint, role: AccountRole.READONLY },
        { address: args.destination, role: AccountRole.READONLY },
        { address: args.authority, role: AccountRole.READONLY },
        { address: validationPda, role: AccountRole.READONLY },
    ];
    for (const meta of readMetas(validationAccount.data)) {
        const resolved = await resolveMeta(meta, previous, instructionData, hookProgram, rpc);
        previous.push(resolved);
        trailing.push(resolved);
    }
    return trailing;
}
