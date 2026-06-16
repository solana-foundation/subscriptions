import { FEATURES, type Features } from '@/config/networks';
import { useClusterConfig } from '@/hooks/use-cluster-config';
import { clusterIdToNetwork } from '@/lib/cluster';

export function useFeatures(): Features {
    const { id } = useClusterConfig();
    return FEATURES[clusterIdToNetwork(id)];
}
