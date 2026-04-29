import { useCallback, useRef, useState } from 'react';

import { api } from '@/lib/api-client';

export interface SetupStep {
    id: string;
    label: string;
    message?: string;
    status: 'done' | 'error' | 'pending' | 'running';
}

const POLL_INTERVAL = 2000;

export function useLocalnetSetup() {
    const [steps, setSteps] = useState<SetupStep[]>([
        { id: 'start-validator', label: 'Start Surfpool validator', status: 'pending' },
        { id: 'wait-validator', label: 'Wait for validator', status: 'pending' },
        { id: 'wait-program', label: 'Wait for program deployment', status: 'pending' },
        { id: 'create-usdc', label: 'Create mock USDC', status: 'pending' },
    ]);
    const [isComplete, setIsComplete] = useState(false);
    const [result, setResult] = useState<{ programId: string; usdcMint: string } | null>(null);
    const abortRef = useRef(false);

    const updateStep = useCallback((id: string, update: Partial<SetupStep>) => {
        setSteps(prev => prev.map(s => (s.id === id ? { ...s, ...update } : s)));
    }, []);

    const poll = useCallback(async (check: () => Promise<boolean>, maxAttempts = 60): Promise<void> => {
        for (let i = 0; i < maxAttempts; i++) {
            if (abortRef.current) throw new Error('Setup cancelled');
            if (await check()) return;
            await new Promise(r => setTimeout(r, POLL_INTERVAL));
        }
        throw new Error('Timed out');
    }, []);

    const run = useCallback(async () => {
        abortRef.current = false;

        try {
            updateStep('start-validator', { message: 'Starting surfpool...', status: 'running' });
            await api.setup.startValidator();
            updateStep('start-validator', { message: 'Surfpool started', status: 'done' });

            updateStep('wait-validator', { message: 'Waiting for RPC...', status: 'running' });
            await poll(async () => {
                const s = await api.setup.validatorStatus();
                return s.validatorRunning;
            });
            updateStep('wait-validator', { message: 'Validator ready', status: 'done' });

            updateStep('wait-program', { message: 'Waiting for program...', status: 'running' });
            let programAddress = '';
            await poll(async () => {
                const s = await api.setup.validatorStatus();
                if (s.programDeployed) programAddress = s.programAddress;
                return s.programDeployed;
            });
            updateStep('wait-program', { message: 'Program deployed', status: 'done' });

            updateStep('create-usdc', { message: 'Creating mock USDC...', status: 'running' });
            const usdcResult = await api.setup.createMockUsdc();
            updateStep('create-usdc', {
                message: usdcResult.alreadyExisted ? 'USDC already exists' : 'USDC created',
                status: 'done',
            });

            setResult({
                programId: programAddress,
                usdcMint: usdcResult.mint,
            });
            setIsComplete(true);
        } catch (error) {
            const msg = error instanceof Error ? error.message : 'Unknown error';
            setSteps(prev => {
                const running = prev.find(s => s.status === 'running');
                if (!running) return prev;
                return prev.map(s => (s.id === running.id ? { ...s, message: msg, status: 'error' as const } : s));
            });
        }
    }, [updateStep, poll]);

    return { isComplete, result, run, steps };
}

export function useDevnetSetup() {
    const [steps, setSteps] = useState<SetupStep[]>([
        { id: 'connect-wallet', label: 'Connect wallet', status: 'pending' },
        { id: 'deploy-program', label: 'Deploy program', status: 'pending' },
        { id: 'create-usdc', label: 'Create mock USDC', status: 'pending' },
        { id: 'mint-usdc', label: 'Mint USDC to wallet', status: 'pending' },
        { id: 'save-config', label: 'Save configuration', status: 'pending' },
    ]);
    const [isComplete, setIsComplete] = useState(false);
    const [result, setResult] = useState<{ programId: string; usdcMint: string } | null>(null);

    const updateStep = useCallback((id: string, update: Partial<SetupStep>) => {
        setSteps(prev => prev.map(s => (s.id === id ? { ...s, ...update } : s)));
    }, []);

    const markStepDone = useCallback(
        (id: string, message: string) => {
            updateStep(id, { message, status: 'done' });
        },
        [updateStep],
    );

    const markStepError = useCallback(
        (id: string, message: string) => {
            updateStep(id, { message, status: 'error' });
        },
        [updateStep],
    );

    const markStepRunning = useCallback(
        (id: string, message: string) => {
            updateStep(id, { message, status: 'running' });
        },
        [updateStep],
    );

    const completeSetup = useCallback((programId: string, usdcMint: string) => {
        setResult({ programId, usdcMint });
        setIsComplete(true);
    }, []);

    return {
        completeSetup,
        isComplete,
        markStepDone,
        markStepError,
        markStepRunning,
        result,
        setResult,
        steps,
        updateStep,
    };
}
