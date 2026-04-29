import { useQuery } from '@tanstack/react-query';

import { useClusterConfig } from '@/hooks/use-cluster-config';
import { useProgramAddress } from '@/hooks/use-token-config';
import { api } from '@/lib/api-client';

export function useProgramStatus() {
    const { url, id } = useClusterConfig();
    const progAddr = useProgramAddress();
    return useQuery({
        enabled: id !== 'solana:localnet' && !!progAddr,
        queryFn: () => api.program.status(progAddr!, url),
        queryKey: ['program-status', id, progAddr],
        staleTime: 30_000,
    });
}

export function useBinaryInfo() {
    return useQuery({
        queryFn: () => api.program.binaryInfo(),
        queryKey: ['binary-info'],
        staleTime: 60_000,
    });
}
