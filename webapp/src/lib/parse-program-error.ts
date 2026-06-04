import idl from '@idl';
import { TOKEN_PROGRAM_ADDRESS } from '@solana-program/token';
import { TOKEN_2022_PROGRAM_ADDRESS } from '@solana-program/token-2022';

type IdlError = { code: number; name: string; message: string };

const errors = (idl.program?.errors ?? []) as IdlError[];
const PROGRAM_ERRORS: Record<number, string> = Object.fromEntries(errors.map(e => [e.code, e.message]));
const PROGRAM_ADDRESS = idl.program?.publicKey ?? '';

const SPL_TOKEN_ERRORS: Record<number, string> = {
    0: 'Account not rent exempt',
    1: 'Insufficient funds',
    2: 'Invalid mint',
    3: 'Account not associated with this mint',
    4: 'Owner mismatch',
    5: 'Mint has a fixed supply',
    6: 'Account already in use',
    7: 'Invalid number of provided signers',
    8: 'Invalid number of required signers',
    9: 'Token account is not initialized',
    10: 'Instruction does not support native tokens',
    11: 'Non-native account can only be closed if its balance is zero',
    12: 'Invalid instruction',
    13: 'Account is in an invalid state for this operation',
    14: 'Operation overflowed',
    15: 'Account does not support the specified authority type',
    16: 'This mint cannot freeze accounts',
    17: 'Token account is frozen',
    18: 'Decimals do not match the mint',
    19: 'Instruction does not support non-native tokens',
};

const TOKEN_PROGRAM_IDS = new Set<string>([TOKEN_PROGRAM_ADDRESS, TOKEN_2022_PROGRAM_ADDRESS]);

export function parseProgramError(error: unknown): string {
    if (!(error instanceof Error)) return 'Unknown error';

    const hexMatch = error.message.match(/custom program error: 0x([0-9a-fA-F]+)/i);
    const decMatch = error.message.match(/Custom\((\d+)\)/);
    const code = hexMatch ? parseInt(hexMatch[1], 16) : decMatch ? parseInt(decMatch[1], 10) : null;

    if (code === null) return error.message;

    const failLineMatch = error.message.match(/Program (\w+) failed: custom program error:/);
    const failedProgram = failLineMatch?.[1] ?? '';

    if (failedProgram === PROGRAM_ADDRESS) {
        return PROGRAM_ERRORS[code] ?? `Subscriptions program error ${code}`;
    }

    if (TOKEN_PROGRAM_IDS.has(failedProgram)) {
        return SPL_TOKEN_ERRORS[code] ?? `Token program error ${code}`;
    }

    if (failedProgram) {
        return `Program ${failedProgram} error ${code}`;
    }

    return PROGRAM_ERRORS[code] ?? `Program error ${code}`;
}
