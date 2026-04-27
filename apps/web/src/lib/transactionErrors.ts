'use client';

import {
    getSubscriptionsErrorMessage,
    type SubscriptionsError,
} from '@subscriptions/client';

const FALLBACK_TX_FAILED_MESSAGE = 'Transaction failed';

function getErrorMessage(error: unknown): string {
    if (error instanceof Error) return error.message;
    if (typeof error === 'string') return error;
    return '';
}

function extractProgramErrorCode(error: unknown): number | null {
    if (error == null) return null;
    const ctx = (error as { context?: { code?: unknown } } | null)?.context;
    if (ctx?.code != null) return Number(ctx.code);
    const message = getErrorMessage(error);
    const hex = /custom program error: 0x([0-9a-fA-F]+)/.exec(message);
    if (hex?.[1]) return Number.parseInt(hex[1], 16);
    const dec = /custom program error: #(\d+)/.exec(message);
    if (dec?.[1]) return Number(dec[1]);
    if (error instanceof Error && error.cause) {
        return extractProgramErrorCode(error.cause);
    }
    return null;
}

export function formatTransactionError(error: unknown): string {
    const message = getErrorMessage(error);

    if (
        message === FALLBACK_TX_FAILED_MESSAGE ||
        message.startsWith(`${FALLBACK_TX_FAILED_MESSAGE}:`)
    ) {
        return message;
    }

    const code = extractProgramErrorCode(error);
    if (code != null) {
        const programMessage = getSubscriptionsErrorMessage(
            code as SubscriptionsError,
        );
        if (programMessage) {
            return `${FALLBACK_TX_FAILED_MESSAGE}: ${programMessage}`;
        }
    }

    if (message.includes('-32002')) {
        return `${FALLBACK_TX_FAILED_MESSAGE}: request is already pending in your wallet`;
    }

    if (/user rejected|rejected the request|declined|cancelled/i.test(message)) {
        return 'Transaction was rejected in wallet';
    }

    return FALLBACK_TX_FAILED_MESSAGE;
}
