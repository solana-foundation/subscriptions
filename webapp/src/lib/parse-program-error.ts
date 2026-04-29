import idl from '@idl';

type IdlError = { code: number; name: string; message: string };

const errors = (idl.program?.errors ?? []) as IdlError[];
const PROGRAM_ERRORS: Record<number, string> = Object.fromEntries(errors.map(e => [e.code, e.message]));

const SPL_TOKEN_ERRORS: Record<number, string> = {
    0: 'Account not rent exempt',
    1: 'Insufficient funds',
    2: 'Invalid mint',
    3: 'Mint mismatch',
    4: 'Owner mismatch',
};

export function parseProgramError(error: unknown, programAddress?: string): string {
    if (!(error instanceof Error)) return 'Unknown error';

    const hexMatch = error.message.match(/custom program error: 0x([0-9a-fA-F]+)/i);
    const decMatch = error.message.match(/Custom\((\d+)\)/);

    const code = hexMatch ? parseInt(hexMatch[1], 16) : decMatch ? parseInt(decMatch[1], 10) : null;

    if (code === null) return error.message;

    const failLineMatch = error.message.match(/Program (\w+) failed: custom program error:/);
    const failedProgram = failLineMatch?.[1] ?? '';

    if (!programAddress || failedProgram === programAddress) {
        const msg = PROGRAM_ERRORS[code];
        if (msg) return msg;
    }

    return SPL_TOKEN_ERRORS[code] ?? `Program error ${code}`;
}
