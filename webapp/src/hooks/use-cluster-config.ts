import { useWalletUi } from '@wallet-ui/react';

import type { ClusterWithUrl } from '@/lib/types';

export function useClusterConfig(): ClusterWithUrl {
    const { cluster } = useWalletUi();
    return cluster as unknown as ClusterWithUrl;
}
