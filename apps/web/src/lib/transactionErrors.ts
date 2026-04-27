'use client';

import { parseProgramError } from '@subscriptions/client';

const FALLBACK_TX_FAILED_MESSAGE = 'Transaction failed';

function getErrorMessage(error: unknown): string {
    if (error instanceof Error) return error.message;
    if (typeof error === 'string') return error;
    return '';
}

export function formatTransactionError(error: unknown): string {
    const message = getErrorMessage(error);

    if (
        message === FALLBACK_TX_FAILED_MESSAGE ||
        message.startsWith(`${FALLBACK_TX_FAILED_MESSAGE}:`)
    ) {
        return message;
    }

    const programError = parseProgramError(error);
    if (programError) {
        return `${FALLBACK_TX_FAILED_MESSAGE}: ${programError.message}`;
    }

    if (message.includes('-32002')) {
        return `${FALLBACK_TX_FAILED_MESSAGE}: request is already pending in your wallet`;
    }

    if (/user rejected|rejected the request|declined|cancelled/i.test(message)) {
        return 'Transaction was rejected in wallet';
    }

    return FALLBACK_TX_FAILED_MESSAGE;
}
