import type { TokenConfig } from '@/config/networks';

export interface PlanTokenDisplay {
    decimals: number;
    mint: string;
    name: string;
    supported: boolean;
    symbol: string;
}

export function resolvePlanTokenDisplay(mint: string, tokens: readonly TokenConfig[] | undefined): PlanTokenDisplay {
    const token = tokens?.find(t => t.mint === mint);
    if (token) return { ...token, supported: true };

    return {
        decimals: 0,
        mint,
        name: 'Unsupported token',
        supported: false,
        symbol: 'Unsupported token',
    };
}

export function formatTokenAmount(amount: bigint, decimals: number): string {
    const divisor = 10n ** BigInt(decimals);
    const whole = amount / divisor;
    const fraction = amount % divisor;
    const wholeText = whole.toLocaleString('en-US');

    if (decimals === 0 || fraction === 0n) return wholeText;

    const fractionText = fraction.toString().padStart(decimals, '0').replace(/0+$/, '');
    return `${wholeText}.${fractionText}`;
}

export function formatPlanTokenAmount(amount: bigint, token: PlanTokenDisplay): string {
    if (!token.supported) return `${amount.toLocaleString('en-US')} raw units`;

    return `${formatTokenAmount(amount, token.decimals)} ${token.symbol}`;
}
