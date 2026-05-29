import type { SolanaCluster } from '@solana/connector/react';

export const CUSTOM_CLUSTER_ID = 'solana:custom' as const;

const URL_KEY = 'custom-rpc-url';
const LABEL_KEY = 'custom-rpc-label';
const SETUP_CLUSTER_KEY = 'setup-cluster';
const SETUP_COMPLETE_KEY = 'setup-complete-custom';

export function readCustomCluster(): SolanaCluster | null {
    const url = localStorage.getItem(URL_KEY);
    if (!url) return null;
    return { id: CUSTOM_CLUSTER_ID, label: localStorage.getItem(LABEL_KEY) || 'Custom', url };
}

export function saveCustomCluster(url: string, label?: string): void {
    localStorage.setItem(URL_KEY, url);
    localStorage.setItem(LABEL_KEY, label?.trim() || 'Custom');
    localStorage.setItem(SETUP_CLUSTER_KEY, CUSTOM_CLUSTER_ID);
    localStorage.setItem(SETUP_COMPLETE_KEY, 'true');
}

export function clearCustomCluster(): void {
    localStorage.removeItem(URL_KEY);
    localStorage.removeItem(LABEL_KEY);
    localStorage.removeItem(SETUP_COMPLETE_KEY);
    if (localStorage.getItem(SETUP_CLUSTER_KEY) === CUSTOM_CLUSTER_ID) {
        localStorage.removeItem(SETUP_CLUSTER_KEY);
    }
}

export function isValidRpcUrl(value: string): boolean {
    try {
        const { protocol } = new URL(value);
        return protocol === 'http:' || protocol === 'https:';
    } catch {
        return false;
    }
}
