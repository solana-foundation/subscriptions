import { useState, useEffect, useCallback, useRef, type ReactNode } from 'react';
import { useNavigate } from 'react-router';
import { useCluster, useKitTransactionSigner, useWallet } from '@solana/connector/react';
import { Button as SolanaButton, TextInput } from '@solana/design-system';
import {
    appendTransactionMessageInstructions,
    createTransactionMessage,
    getBase64EncodedWireTransaction,
    pipe,
    setTransactionMessageFeePayerSigner,
    setTransactionMessageLifetimeUsingBlockhash,
    signTransactionMessageWithSigners,
    type Address,
} from '@solana/kit';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
    Loader2,
    CheckCircle2,
    XCircle,
    Circle,
    Monitor,
    Globe,
    ArrowRight,
    ArrowLeft,
    Settings2,
    Shield,
    Terminal,
    Trash2,
} from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { WalletButton } from '@/components/solana/solana-provider';
import { ProgramKeypairPicker } from '@/components/program/program-keypair-picker';
import { useLocalnetSetup, useDevnetSetup, type SetupStep } from '@/hooks/use-setup-wizard';
import { useProgramDeploy } from '@/hooks/use-program-deploy';
import { useProgramStatus } from '@/hooks/use-program-status';
import { useCreateToken } from '@/hooks/use-create-token';
import { buildSetAuthorityIx } from '@/lib/bpf-loader-browser';
import { useProgramAddress } from '@/hooks/use-token-config';
import { useClusterConfig } from '@/hooks/use-cluster-config';
import { buildCloseProgramIx, deriveProgramDataAddress } from '@/lib/bpf-loader-browser';
import { useWalletTransactionSignAndSend } from '@/components/solana/use-wallet-transaction-sign-and-send';
import { useTransactionToast } from '@/components/use-transaction-toast';
import { extractErrorMessage } from '@/lib/error-utils';
import { truncateAddress } from '@/lib/format';
import { isValidBase58Address } from '@/lib/validators';
import { useRpc } from '@/hooks/use-rpc';
import { api } from '@/lib/api-client';
import type { ProgramKeypairImport } from '@/lib/program-keypair';
import solanaLogo from '@/assets/solana-logo.svg';

type Network = 'localnet' | 'devnet' | null;

interface LogEntry {
    ts: number;
    level: 'info' | 'error' | 'success';
    msg: string;
}

const MAX_LOGS = 200;

function useLogConsole() {
    const [logs, setLogs] = useState<LogEntry[]>([]);
    const log = useCallback((level: LogEntry['level'], msg: string) => {
        setLogs(prev => {
            const next = [...prev, { ts: Date.now(), level, msg }];
            return next.length > MAX_LOGS ? next.slice(-MAX_LOGS) : next;
        });
    }, []);
    const clear = useCallback(() => setLogs([]), []);
    return { logs, log, clear };
}

function LogConsole({ logs }: { logs: LogEntry[] }) {
    const bottomRef = useRef<HTMLDivElement>(null);
    const [expanded, setExpanded] = useState(false);

    useEffect(() => {
        if (expanded) bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
    }, [logs.length, expanded]);

    if (logs.length === 0) return null;

    const lastLog = logs[logs.length - 1];

    return (
        <div className="rounded-lg border border-sand-300 bg-sand-100 overflow-hidden">
            <button
                onClick={() => setExpanded(e => !e)}
                className="w-full flex items-center gap-2 px-3 py-1.5 border-b border-sand-200 bg-sand-100 hover:bg-sand-100 transition-colors"
            >
                <Terminal className="h-3 w-3 text-sand-1000" />
                <span className="text-[10px] font-medium text-sand-1000 uppercase tracking-wider">Console</span>
                <span className="flex-1 text-left text-[10px] text-sand-900 font-mono truncate">
                    {!expanded && lastLog ? lastLog.msg : ''}
                </span>
                <span className="text-[10px] text-sand-900">{expanded ? '−' : '+'}</span>
            </button>
            {expanded && (
                <div className="max-h-48 overflow-y-auto p-3 font-mono text-xs leading-relaxed">
                    {logs.map((entry, i) => (
                        <div
                            key={i}
                            className={
                                entry.level === 'error'
                                    ? 'text-red-600'
                                    : entry.level === 'success'
                                      ? 'text-foreground'
                                      : 'text-sand-1100'
                            }
                        >
                            <span className="text-sand-900 select-none">
                                {new Date(entry.ts).toLocaleTimeString()}{' '}
                            </span>
                            {entry.msg}
                        </div>
                    ))}
                    <div ref={bottomRef} />
                </div>
            )}
        </div>
    );
}

function StepIndicator({ step }: { step: SetupStep }) {
    return (
        <div className="flex items-center gap-3 py-2">
            {step.status === 'pending' && <Circle className="h-5 w-5 text-sand-1000" />}
            {step.status === 'running' && <Loader2 className="h-5 w-5 text-foreground animate-spin" />}
            {step.status === 'done' && <CheckCircle2 className="h-5 w-5 text-foreground" />}
            {step.status === 'error' && <XCircle className="h-5 w-5 text-red-600" />}
            <div className="flex-1 min-w-0">
                <p
                    className={`text-sm font-medium ${
                        step.status === 'done'
                            ? 'text-foreground'
                            : step.status === 'error'
                              ? 'text-red-600'
                              : step.status === 'running'
                                ? 'text-foreground'
                                : 'text-sand-1000'
                    }`}
                >
                    {step.label}
                </p>
                {step.message && <p className="text-xs text-sand-1100 truncate">{step.message}</p>}
            </div>
        </div>
    );
}

function StepProgressBar({ steps }: { steps: SetupStep[] }) {
    const done = steps.filter(s => s.status === 'done').length;
    const running = steps.find(s => s.status === 'running');
    const hasError = steps.some(s => s.status === 'error');
    return (
        <div className="space-y-2">
            <div className="flex items-center justify-between">
                <span className="text-xs text-sand-1000">
                    {hasError
                        ? 'Error'
                        : running
                          ? running.label
                          : done === steps.length
                            ? 'Complete'
                            : `Step ${done + 1} of ${steps.length}`}
                </span>
                <span className="text-xs text-sand-900">
                    {done}/{steps.length}
                </span>
            </div>
            <div className="flex gap-1">
                {steps.map(s => (
                    <div
                        key={s.id}
                        className={`h-1 flex-1 rounded-full transition-colors ${
                            s.status === 'done'
                                ? 'bg-foreground'
                                : s.status === 'running'
                                  ? 'bg-foreground animate-pulse'
                                  : s.status === 'error'
                                    ? 'bg-red-500'
                                    : 'bg-sand-200'
                        }`}
                    />
                ))}
            </div>
        </div>
    );
}

function SetupCompleteCard({
    result,
    onComplete,
    extra,
}: {
    result: { programId: string; usdcMint: string };
    onComplete: () => void;
    extra?: ReactNode;
}) {
    return (
        <div className="space-y-4">
            <div className="rounded-lg border border-sand-300 bg-sand-100 p-4 space-y-2">
                <p className="text-sm text-foreground font-medium">Setup complete</p>
                <div className="text-xs text-sand-1100 space-y-1">
                    <p>
                        Program:{' '}
                        <span className="text-sand-1400 font-mono">{truncateAddress(result.programId, 12)}</span>
                    </p>
                    <p>
                        USDC Mint:{' '}
                        <span className="text-sand-1400 font-mono">{truncateAddress(result.usdcMint, 12)}</span>
                    </p>
                    {extra}
                </div>
            </div>
            <SolanaButton iconRight={<ArrowRight />} onClick={onComplete} size="lg" style={{ width: '100%' }}>
                Go to App
            </SolanaButton>
        </div>
    );
}

function NetworkSelection({ onSelect, onSkip }: { onSelect: (n: Network) => void; onSkip: () => void }) {
    const [skipping, setSkipping] = useState(false);

    const handleSkip = async () => {
        setSkipping(true);
        try {
            const config = await api.config.getAll();
            const configuredNetworks = Object.keys(config.networks ?? {});
            const net = configuredNetworks.includes('devnet') ? 'devnet' : (configuredNetworks[0] ?? 'localnet');
            const clusterId = net === 'devnet' ? 'solana:devnet' : 'solana:localnet';
            localStorage.setItem(`setup-complete-${net}`, 'true');
            localStorage.setItem('setup-cluster', clusterId);
            onSkip();
        } catch {
            localStorage.setItem('setup-complete-devnet', 'true');
            localStorage.setItem('setup-cluster', 'solana:devnet');
            onSkip();
        } finally {
            setSkipping(false);
        }
    };

    return (
        <div className="min-h-screen flex items-center justify-center bg-bg1 p-4">
            <div className="max-w-2xl w-full space-y-8">
                <div className="flex justify-end">
                    <SolanaButton
                        iconRight={<ArrowRight />}
                        loading={skipping}
                        onClick={handleSkip}
                        radius="round"
                        size="md"
                    >
                        Skip to App
                    </SolanaButton>
                </div>
                <div className="text-center space-y-3">
                    <div className="flex items-center justify-center gap-3">
                        <Settings2 className="h-10 w-10 text-foreground" />
                        <img src={solanaLogo} alt="Solana" className="h-8 w-8" />
                    </div>
                    <h1 className="text-3xl font-bold text-foreground">Subscriptions Setup</h1>
                    <p className="text-sand-1100">Choose your network to get started</p>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    <button
                        onClick={() => onSelect('localnet')}
                        className="group relative p-6 rounded-xl border-0 border-all-dashed-medium bg-card hover:bg-sand-100 transition-all text-left"
                    >
                        <div className="space-y-3">
                            <Monitor className="h-8 w-8 text-foreground" />
                            <h3 className="text-lg font-semibold text-foreground">Localnet</h3>
                            <p className="text-sm text-sand-1100">
                                Start a local Surfpool validator with auto-deployed program and mock USDC. Best for
                                development and testing.
                            </p>
                        </div>
                        <ArrowRight className="absolute top-6 right-6 h-5 w-5 text-sand-900 group-hover:text-foreground transition-colors" />
                    </button>

                    <button
                        onClick={() => onSelect('devnet')}
                        className="group relative p-6 rounded-xl border-0 border-all-dashed-medium bg-card hover:bg-sand-100 transition-all text-left"
                    >
                        <div className="space-y-3">
                            <Globe className="h-8 w-8 text-foreground" />
                            <h3 className="text-lg font-semibold text-foreground">Devnet</h3>
                            <p className="text-sm text-sand-1100">
                                Deploy program via wallet and create mock USDC from browser. Best for integration
                                testing.
                            </p>
                        </div>
                        <ArrowRight className="absolute top-6 right-6 h-5 w-5 text-sand-900 group-hover:text-foreground transition-colors" />
                    </button>
                </div>
            </div>
        </div>
    );
}

function LocalnetWizard({ onComplete, onBack }: { onComplete: () => void; onBack: () => void }) {
    const { steps, run, isComplete, result } = useLocalnetSetup();
    const { setCluster } = useCluster();
    const startedRef = useRef(false);
    const { logs, log } = useLogConsole();

    useEffect(() => {
        void setCluster('solana:localnet');
    }, [setCluster]);

    useEffect(() => {
        if (!startedRef.current) {
            startedRef.current = true;
            log('info', 'Starting localnet setup...');
            run();
        }
    }, [run, log]);

    const prevStepsRef = useRef<Map<string, string>>(new Map());

    useEffect(() => {
        for (const step of steps) {
            const key = `${step.status}:${step.message ?? ''}`;
            if (prevStepsRef.current.get(step.id) === key) continue;
            prevStepsRef.current.set(step.id, key);
            if (step.status === 'running' && step.message) log('info', step.message);
            else if (step.status === 'done' && step.message) log('success', `${step.label}: ${step.message}`);
            else if (step.status === 'error' && step.message) log('error', `${step.label}: ${step.message}`);
        }
    }, [steps, log]);

    return (
        <div className="min-h-screen flex items-center justify-center bg-bg1 p-4">
            <div className="max-w-lg w-full space-y-3">
                <button
                    onClick={onBack}
                    className="flex items-center gap-1.5 text-sm text-sand-1000 hover:text-foreground transition-colors"
                >
                    <ArrowLeft className="h-3.5 w-3.5" />
                    Back
                </button>
                <Card className="w-full border-0 border-all-dashed-medium bg-card">
                    <CardHeader className="pb-3">
                        <CardTitle className="flex items-center gap-2 text-base">
                            <Monitor className="h-4 w-4 text-sand-1100" />
                            Localnet Setup
                        </CardTitle>
                        <StepProgressBar steps={steps} />
                    </CardHeader>
                    <CardContent className="space-y-4">
                        {!isComplete && (
                            <div className="space-y-1">
                                {steps.map(step => (
                                    <StepIndicator key={step.id} step={step} />
                                ))}
                            </div>
                        )}

                        {isComplete && result && (
                            <SetupCompleteCard
                                result={result}
                                onComplete={onComplete}
                                extra={
                                    <p>
                                        RPC: <span className="text-sand-1400 font-mono">http://127.0.0.1:8899</span>
                                    </p>
                                }
                            />
                        )}

                        <LogConsole logs={logs} />
                    </CardContent>
                </Card>
            </div>
        </div>
    );
}

function DevnetWizard({ onComplete, onBack }: { onComplete: () => void; onBack: () => void }) {
    const { steps, isComplete, result, markStepDone, markStepError, markStepRunning, completeSetup, setResult } =
        useDevnetSetup();
    const { account } = useWallet();
    const { setCluster } = useCluster();
    const { signer: walletSigner } = useKitTransactionSigner();
    const { id: clusterId } = useClusterConfig();
    const queryClient = useQueryClient();

    useEffect(() => {
        void setCluster('solana:devnet');
    }, [setCluster]);
    const { deploy: programDeploy, progress: deployProgress } = useProgramDeploy();
    const programStatus = useProgramStatus();
    const { createToken, mintTo } = useCreateToken();
    const walletSignAndSend = useWalletTransactionSignAndSend();
    const txToast = useTransactionToast();
    const [phase, setPhase] = useState<
        'wallet' | 'program-choice' | 'deploy' | 'transfer-authority' | 'usdc' | 'mint' | 'save' | 'done'
    >('wallet');
    const [customProgramAddress, setCustomProgramAddress] = useState('');
    const [verifyingAddress, setVerifyingAddress] = useState(false);
    const [customUsdcAddress, setCustomUsdcAddress] = useState('');
    const [verifyingUsdc, setVerifyingUsdc] = useState(false);
    const [usdcVerifyFailed, setUsdcVerifyFailed] = useState(false);
    const [multisigAddress, setMultisigAddress] = useState('');
    const [confirmClose, setConfirmClose] = useState(false);
    const [programKeypair, setProgramKeypair] = useState<ProgramKeypairImport | null>(null);
    const [existingUsdcMint, setExistingUsdcMint] = useState<string | null>(null);
    const [configUsdcOnline, setConfigUsdcOnline] = useState<boolean | null>(null);
    const [checkingUsdc, setCheckingUsdc] = useState(false);
    const [configProgramOnline, setConfigProgramOnline] = useState<boolean | null>(null);
    const [checkingConfigProgram, setCheckingConfigProgram] = useState(false);
    const configProgramCheckRef = useRef(false);
    const usdcCheckTriggered = useRef(false);
    const { logs, log } = useLogConsole();
    const prevProgressRef = useRef('');
    const { url: clusterUrl } = useClusterConfig();
    const rpc = useRpc();
    const configProgramAddress = useProgramAddress();

    const closeProgram = useMutation({
        mutationFn: async () => {
            if (!walletSigner) throw new Error('Wallet not connected');
            const signer = walletSigner;
            const programAddr = (configProgramAddress ?? result?.programId) as Address;
            const programDataPDA = await deriveProgramDataAddress(programAddr);
            const { value: latestBlockhash } = await rpc.getLatestBlockhash().send();
            const closeIx = buildCloseProgramIx(programDataPDA, signer.address, signer, programAddr);
            const tx = pipe(
                createTransactionMessage({ version: 0 }),
                m => setTransactionMessageFeePayerSigner(signer, m),
                m => setTransactionMessageLifetimeUsingBlockhash(latestBlockhash, m),
                m => appendTransactionMessageInstructions([closeIx], m),
            );
            const signedTx = await signTransactionMessageWithSigners(tx);
            await rpc.sendTransaction(getBase64EncodedWireTransaction(signedTx), { encoding: 'base64' }).send();
        },
        onSuccess: () => {
            log('success', 'Program closed, SOL reclaimed');
            queryClient.invalidateQueries({ queryKey: ['program-status', clusterId] });
            setConfirmClose(false);
        },
        onError: e => {
            log('error', `Close program failed: ${e.message}`);
        },
    });

    useEffect(() => {
        if (account && phase === 'wallet') {
            log('success', `Wallet connected: ${account}`);
            markStepDone('connect-wallet', `Connected: ${account.slice(0, 8)}...`);
            queueMicrotask(() => setPhase('program-choice'));
        }
    }, [account, phase, markStepDone, log]);

    useEffect(() => {
        if (phase !== 'program-choice' || !configProgramAddress || configProgramCheckRef.current) return;
        configProgramCheckRef.current = true;
        let cancelled = false;
        setCheckingConfigProgram(true);
        (async () => {
            try {
                log('info', `Checking configured program ${configProgramAddress.slice(0, 8)}... on-chain`);
                const acctInfo = await rpc
                    .getAccountInfo(configProgramAddress as Address, { encoding: 'base64' })
                    .send();
                if (cancelled) return;
                const online = !!acctInfo.value?.executable;
                setConfigProgramOnline(online);
                log(
                    online ? 'success' : 'info',
                    online
                        ? `Program ${configProgramAddress.slice(0, 8)}... is deployed`
                        : `Program ${configProgramAddress.slice(0, 8)}... not found on-chain`,
                );
            } catch {
                if (!cancelled) setConfigProgramOnline(false);
            }
            if (!cancelled) setCheckingConfigProgram(false);
        })();
        return () => {
            cancelled = true;
        };
    }, [phase, configProgramAddress, rpc, log]);

    useEffect(() => {
        const key = `${deployProgress.phase}:${deployProgress.message}:${deployProgress.current}`;
        if (key === prevProgressRef.current) return;
        prevProgressRef.current = key;
        if (deployProgress.phase !== 'preparing' && deployProgress.message) {
            const level =
                deployProgress.phase === 'error' ? 'error' : deployProgress.phase === 'done' ? 'success' : 'info';
            log(level, deployProgress.message);
        }
    }, [deployProgress, log]);

    const handleUseExisting = useCallback(
        async (addr: string) => {
            setVerifyingAddress(true);
            try {
                log('info', `Verifying program at ${addr}...`);
                const acctInfo = await rpc.getAccountInfo(addr as Address, { encoding: 'base64' }).send();
                if (!acctInfo.value) {
                    log('error', 'Account not found on-chain');
                    return;
                }
                log('success', `Program verified: ${addr.slice(0, 8)}...`);
                markStepDone('deploy-program', `Using existing: ${addr.slice(0, 8)}...`);
                setResult({ programId: addr, usdcMint: '' });
                setPhase('usdc');
            } catch (e) {
                log('error', `Verification failed: ${e instanceof Error ? e.message : String(e)}`);
            } finally {
                setVerifyingAddress(false);
            }
        },
        [rpc, markStepDone, setResult, log],
    );

    const handleDeploy = useCallback(async () => {
        if (!programKeypair) {
            const msg = 'Select a program keypair before deployment';
            log('error', msg);
            markStepError('deploy-program', msg);
            return;
        }

        log('info', 'Starting program deployment...');
        markStepRunning('deploy-program', 'Deploying program via wallet...');
        try {
            log('info', 'Preparing deploy plan (fetching .so binary from API)...');
            const deployResult = await programDeploy.mutateAsync({
                isUpgrade: false,
                programAddress: programKeypair?.programAddress,
                programKeypairBytes: programKeypair?.bytes,
            });
            if (!deployResult?.programAddress) {
                throw new Error('Deployment did not return a program address');
            }
            log('success', 'Program deployed successfully');
            setResult({ programId: deployResult.programAddress, usdcMint: '' });
            markStepDone('deploy-program', 'Program deployed');
            setPhase('transfer-authority');
        } catch (e) {
            const msg = extractErrorMessage(e);
            log('error', `Deploy failed: ${msg}`);
            markStepError('deploy-program', msg);
        }
    }, [programDeploy, programKeypair, markStepDone, markStepError, markStepRunning, setResult, log]);

    const handleTransferAuthority = useCallback(async () => {
        if (!walletSigner) return;
        if (!result?.programId) {
            const msg = 'No deployed program target available';
            log('error', msg);
            markStepError('deploy-program', msg);
            return;
        }
        const newAuth = multisigAddress;
        log('info', `Transferring authority to ${newAuth}...`);
        markStepRunning('deploy-program', 'Transferring upgrade authority...');
        try {
            const programAddr = result.programId as Address;
            const programDataPDA = await deriveProgramDataAddress(programAddr);
            const ix = buildSetAuthorityIx(programDataPDA, walletSigner, newAuth as Address);
            const sig = await walletSignAndSend(ix, walletSigner);
            txToast.onSuccess(sig);
            log('success', `Authority transferred to ${newAuth.slice(0, 8)}...`);
            markStepDone('deploy-program', `Authority transferred to ${newAuth.slice(0, 8)}...`);
            setPhase('usdc');
        } catch (e) {
            const msg = extractErrorMessage(e);
            log('error', `Transfer failed: ${msg}`);
            markStepError('deploy-program', msg);
        }
    }, [
        walletSigner,
        walletSignAndSend,
        txToast,
        multisigAddress,
        result,
        markStepDone,
        markStepError,
        markStepRunning,
        log,
    ]);

    useEffect(() => {
        if (phase !== 'usdc' || usdcCheckTriggered.current) return;
        usdcCheckTriggered.current = true;
        let cancelled = false;
        setCheckingUsdc(true);
        (async () => {
            try {
                const config = await api.config.getAll();
                const devnetTokens = config.networks?.devnet?.tokens ?? [];
                const usdc = devnetTokens.find(t => t.symbol === 'USDC');
                if (!usdc?.mint || cancelled) {
                    if (!cancelled) setCheckingUsdc(false);
                    return;
                }
                setExistingUsdcMint(usdc.mint);
                setCustomUsdcAddress(usdc.mint);
                log('info', `Found USDC in config: ${usdc.mint.slice(0, 8)}..., verifying on-chain...`);
                const acctInfo = await rpc.getAccountInfo(usdc.mint as Address, { encoding: 'base64' }).send();
                if (cancelled) return;
                const online = !!acctInfo.value;
                setConfigUsdcOnline(online);
                log(
                    online ? 'success' : 'info',
                    online
                        ? `USDC mint ${usdc.mint.slice(0, 8)}... verified on-chain`
                        : `USDC mint ${usdc.mint.slice(0, 8)}... not found on-chain`,
                );
            } catch (e) {
                if (!cancelled) setConfigUsdcOnline(false);
                log('info', `USDC check failed: ${e instanceof Error ? e.message : String(e)}`);
            }
            if (!cancelled) setCheckingUsdc(false);
        })();
        return () => {
            cancelled = true;
        };
    }, [phase, rpc, log]);

    const handleCreateUsdc = useCallback(async () => {
        log('info', 'Creating mock USDC Token-2022 mint...');
        markStepRunning('create-usdc', 'Creating mock USDC mint...');
        try {
            const res = await createToken.mutateAsync({ decimals: 6 });
            log('success', `Mock USDC created: ${res.mint}`);
            markStepDone('create-usdc', `Mint: ${res.mint.slice(0, 8)}...`);
            setPhase('mint');
            return res.mint;
        } catch (e) {
            const msg = extractErrorMessage(e);
            log('error', `Create USDC failed: ${msg}`);
            markStepError('create-usdc', msg);
            return null;
        }
    }, [createToken, markStepDone, markStepError, markStepRunning, log]);

    const handleMintUsdc = useCallback(
        async (mint: Address) => {
            log('info', `Minting 1000 USDC to connected wallet...`);
            markStepRunning('mint-usdc', 'Minting 1000 USDC...');
            try {
                await mintTo.mutateAsync({ mint, amount: 1_000_000_000n });
                log('success', '1000 USDC minted successfully');
                markStepDone('mint-usdc', '1000 USDC minted');
                setPhase('save');
                return true;
            } catch (e) {
                const msg = extractErrorMessage(e);
                log('error', `Mint USDC failed: ${msg}`);
                markStepError('mint-usdc', msg);
                return false;
            }
        },
        [mintTo, markStepDone, markStepError, markStepRunning, log],
    );

    const handleSaveConfig = useCallback(
        async (mint: string) => {
            log('info', 'Saving configuration...');
            markStepRunning('save-config', 'Saving configuration...');
            try {
                const programId = result?.programId || configProgramAddress || '';
                await api.setup.saveConfig({
                    network: 'devnet',
                    programAddress: programId || undefined,
                    tokens: [{ symbol: 'USDC', mint, decimals: 6 }],
                });
                await queryClient.invalidateQueries({ queryKey: ['network-config'] });
                log('success', 'Configuration saved to config.json');
                markStepDone('save-config', 'Config saved');
                completeSetup(programId, mint);
                setPhase('done');
            } catch (e) {
                const msg = extractErrorMessage(e);
                log('error', `Save config failed: ${msg}`);
                markStepError('save-config', msg);
            }
        },
        [markStepDone, markStepError, markStepRunning, completeSetup, result, configProgramAddress, queryClient, log],
    );

    const handleUseExistingUsdc = useCallback(
        async (mint: string) => {
            log('info', `Using existing USDC mint: ${mint.slice(0, 8)}...`);
            markStepDone('create-usdc', `Existing: ${mint.slice(0, 8)}...`);
            markStepDone('mint-usdc', 'Skipped (using existing)');
            setPhase('save');
            await handleSaveConfig(mint);
        },
        [log, markStepDone, handleSaveConfig],
    );

    const handleUseCustomUsdc = useCallback(
        async (addr: string, skipVerify = false) => {
            setVerifyingUsdc(true);
            setUsdcVerifyFailed(false);
            try {
                if (!skipVerify) {
                    log('info', `Verifying USDC mint at ${addr}...`);
                    const acctInfo = await rpc.getAccountInfo(addr as Address, { encoding: 'base64' }).send();
                    if (!acctInfo.value) {
                        log('error', `Mint account not found on-chain (${clusterUrl})`);
                        setUsdcVerifyFailed(true);
                        return;
                    }
                }
                await handleUseExistingUsdc(addr);
            } catch (e) {
                log('error', `Verification failed: ${e instanceof Error ? e.message : String(e)}`);
                setUsdcVerifyFailed(true);
            } finally {
                setVerifyingUsdc(false);
            }
        },
        [rpc, clusterUrl, log, handleUseExistingUsdc],
    );

    const runUsdcFlow = useCallback(async () => {
        const mint = await handleCreateUsdc();
        if (!mint) return;
        const ok = await handleMintUsdc(mint);
        if (!ok) return;
        await handleSaveConfig(mint);
    }, [handleCreateUsdc, handleMintUsdc, handleSaveConfig]);

    const isPending =
        programDeploy.isPending ||
        createToken.isPending ||
        mintTo.isPending ||
        closeProgram.isPending ||
        verifyingAddress ||
        checkingUsdc ||
        verifyingUsdc;

    return (
        <div className="min-h-screen flex items-center justify-center bg-bg1 p-4">
            <div className="max-w-lg w-full space-y-3">
                <button
                    onClick={onBack}
                    className="flex items-center gap-1.5 text-sm text-sand-1000 hover:text-foreground transition-colors"
                >
                    <ArrowLeft className="h-3.5 w-3.5" />
                    Back
                </button>
                <Card className="w-full border-0 border-all-dashed-medium bg-card">
                    <CardHeader className="pb-3">
                        <div className="flex items-center justify-between">
                            <CardTitle className="flex items-center gap-2 text-base">
                                <Globe className="h-4 w-4 text-sand-1100" />
                                Devnet Setup
                            </CardTitle>
                            {account && (
                                <span className="text-xs font-mono text-sand-1000">{truncateAddress(account)}</span>
                            )}
                        </div>
                        <StepProgressBar steps={steps} />
                    </CardHeader>
                    <CardContent className="space-y-4">
                        {!account && phase === 'wallet' && (
                            <div className="py-8 text-center space-y-4">
                                <p className="text-sm text-sand-1100">Connect your wallet to get started</p>
                                <div className="flex justify-center">
                                    <WalletButton />
                                </div>
                            </div>
                        )}

                        {phase === 'program-choice' && (
                            <div className="space-y-4">
                                {configProgramAddress && (
                                    <button
                                        onClick={() => handleUseExisting(configProgramAddress)}
                                        disabled={verifyingAddress || checkingConfigProgram}
                                        className={`w-full group rounded-lg border p-4 text-left transition-all ${
                                            configProgramOnline === false
                                                ? 'border-amber-300 bg-amber-50 hover:border-amber-400'
                                                : 'border-foreground bg-card hover:bg-sand-100'
                                        }`}
                                    >
                                        <div className="flex items-center justify-between">
                                            <div>
                                                <p className="text-sm font-medium text-foreground">
                                                    Use configured program
                                                </p>
                                                <p className="text-xs font-mono text-sand-1100 mt-0.5">
                                                    {configProgramAddress}
                                                </p>
                                                {checkingConfigProgram && (
                                                    <p className="text-[10px] text-sand-1000 mt-1 flex items-center gap-1">
                                                        <Loader2 className="h-3 w-3 animate-spin" /> Checking
                                                        on-chain...
                                                    </p>
                                                )}
                                                {!checkingConfigProgram && configProgramOnline === true && (
                                                    <p className="text-[10px] text-sand-1000 mt-1 flex items-center gap-1">
                                                        <CheckCircle2 className="h-3 w-3" /> Deployed on devnet
                                                    </p>
                                                )}
                                                {!checkingConfigProgram && configProgramOnline === false && (
                                                    <p className="text-[10px] text-amber-600 mt-1 flex items-center gap-1">
                                                        <XCircle className="h-3 w-3" /> Not found on-chain
                                                    </p>
                                                )}
                                            </div>
                                            {verifyingAddress || checkingConfigProgram ? (
                                                <Loader2 className="h-4 w-4 animate-spin text-sand-1100 shrink-0" />
                                            ) : (
                                                <ArrowRight className="h-4 w-4 text-sand-900 group-hover:text-foreground transition-colors shrink-0" />
                                            )}
                                        </div>
                                    </button>
                                )}

                                <div className="rounded-lg border border-sand-300 bg-sand-100 p-4 space-y-3">
                                    <p className="text-sm font-medium text-sand-1400">Use a different program</p>
                                    <div className="flex gap-2">
                                        <TextInput
                                            value={customProgramAddress}
                                            onChange={e => setCustomProgramAddress(e.target.value)}
                                            placeholder="Program address..."
                                            className="min-w-0 flex-1"
                                            inputClassName="font-mono"
                                        />
                                        <Button
                                            onClick={() => handleUseExisting(customProgramAddress)}
                                            disabled={!isValidBase58Address(customProgramAddress) || verifyingAddress}
                                            variant="outline"
                                            className="border-sand-300 shrink-0"
                                        >
                                            {verifyingAddress ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Use'}
                                        </Button>
                                    </div>
                                </div>

                                <div className="relative flex items-center gap-3">
                                    <div className="flex-1 border-t border-sand-200" />
                                    <span className="text-[10px] text-sand-900 uppercase tracking-wider">or</span>
                                    <div className="flex-1 border-t border-sand-200" />
                                </div>

                                <Button
                                    onClick={() => setPhase('deploy')}
                                    variant="outline"
                                    className="w-full border-sand-400 text-foreground hover:bg-sand-100"
                                >
                                    Deploy New Program
                                </Button>
                            </div>
                        )}

                        {phase === 'deploy' && (
                            <div className="space-y-3">
                                <ProgramKeypairPicker
                                    disabled={isPending}
                                    value={programKeypair}
                                    onChange={setProgramKeypair}
                                />
                                <SolanaButton
                                    onClick={handleDeploy}
                                    disabled={isPending || !programKeypair}
                                    loading={programDeploy.isPending}
                                    style={{ width: '100%' }}
                                >
                                    Begin Deployment
                                </SolanaButton>

                                {programStatus.data?.deployed && programStatus.data?.upgradeAuthority === account && (
                                    <div className="rounded-lg border border-red-500/20 bg-red-500/5 p-3">
                                        <div className="flex items-center justify-between">
                                            <div className="flex items-center gap-2">
                                                <Trash2 className="h-3 w-3 text-red-600" />
                                                <span className="text-xs text-red-600">Close existing program</span>
                                            </div>
                                            {!confirmClose ? (
                                                <Button
                                                    onClick={() => setConfirmClose(true)}
                                                    variant="ghost"
                                                    size="sm"
                                                    className="text-red-600 hover:text-red-700 text-xs h-6 px-2"
                                                >
                                                    Close...
                                                </Button>
                                            ) : (
                                                <div className="flex gap-1.5">
                                                    <Button
                                                        onClick={() => closeProgram.mutate()}
                                                        disabled={closeProgram.isPending}
                                                        size="sm"
                                                        className="bg-red-600 hover:bg-red-500 text-xs h-6 px-2"
                                                    >
                                                        {closeProgram.isPending ? (
                                                            <Loader2 className="h-3 w-3 animate-spin mr-1" />
                                                        ) : null}
                                                        Confirm
                                                    </Button>
                                                    <Button
                                                        onClick={() => setConfirmClose(false)}
                                                        variant="ghost"
                                                        size="sm"
                                                        className="text-sand-1000 text-xs h-6 px-2"
                                                    >
                                                        Cancel
                                                    </Button>
                                                </div>
                                            )}
                                        </div>
                                    </div>
                                )}
                            </div>
                        )}

                        {phase === 'transfer-authority' && (
                            <div className="space-y-3">
                                <div className="rounded-lg border border-sand-300 bg-sand-100 p-4 space-y-3">
                                    <div className="flex items-center gap-2">
                                        <Shield className="h-4 w-4 text-sand-1100" />
                                        <span className="text-sm font-medium text-foreground">Transfer Authority</span>
                                        <span className="text-[10px] text-sand-900 uppercase tracking-wider">
                                            Optional
                                        </span>
                                    </div>
                                    {result?.programId && (
                                        <p className="text-xs text-sand-1000">
                                            Target:{' '}
                                            <span className="font-mono text-sand-1400">
                                                {truncateAddress(result.programId, 12)}
                                            </span>
                                        </p>
                                    )}
                                    <TextInput
                                        value={multisigAddress}
                                        onChange={e => setMultisigAddress(e.target.value)}
                                        placeholder="New authority address..."
                                        inputClassName="font-mono"
                                    />
                                    <SolanaButton
                                        onClick={handleTransferAuthority}
                                        disabled={
                                            isPending || !result?.programId || !isValidBase58Address(multisigAddress)
                                        }
                                        loading={isPending}
                                        style={{ width: '100%' }}
                                    >
                                        Transfer Authority
                                    </SolanaButton>
                                </div>
                                <Button
                                    onClick={() => {
                                        log('info', 'Skipping authority transfer');
                                        setPhase('usdc');
                                    }}
                                    variant="ghost"
                                    className="w-full text-sand-1000 hover:text-foreground text-xs"
                                >
                                    Skip
                                </Button>
                            </div>
                        )}

                        {phase === 'usdc' && (
                            <div className="space-y-4">
                                {checkingUsdc && (
                                    <div className="flex items-center gap-2 py-4 justify-center text-sand-1100">
                                        <Loader2 className="h-4 w-4 animate-spin" />
                                        <span className="text-sm">Checking for existing USDC...</span>
                                    </div>
                                )}

                                {!checkingUsdc && existingUsdcMint && (
                                    <button
                                        onClick={() => handleUseExistingUsdc(existingUsdcMint)}
                                        disabled={isPending}
                                        className={`w-full group rounded-lg border p-4 text-left transition-all ${
                                            configUsdcOnline === false
                                                ? 'border-amber-300 bg-amber-50 hover:border-amber-400'
                                                : 'border-foreground bg-card hover:bg-sand-100'
                                        }`}
                                    >
                                        <div className="flex items-center justify-between">
                                            <div>
                                                <p className="text-sm font-medium text-foreground">
                                                    Use configured USDC mint
                                                </p>
                                                <p className="text-xs font-mono text-sand-1100 mt-0.5">
                                                    {existingUsdcMint}
                                                </p>
                                                {configUsdcOnline === true && (
                                                    <p className="text-[10px] text-sand-1000 mt-1 flex items-center gap-1">
                                                        <CheckCircle2 className="h-3 w-3" /> Verified on devnet
                                                    </p>
                                                )}
                                                {configUsdcOnline === false && (
                                                    <p className="text-[10px] text-amber-600 mt-1 flex items-center gap-1">
                                                        <XCircle className="h-3 w-3" /> Not found on-chain
                                                    </p>
                                                )}
                                            </div>
                                            <ArrowRight className="h-4 w-4 text-sand-900 group-hover:text-foreground transition-colors shrink-0" />
                                        </div>
                                    </button>
                                )}

                                {!checkingUsdc && (
                                    <>
                                        <div className="rounded-lg border border-sand-300 bg-sand-100 p-4 space-y-3">
                                            <p className="text-sm font-medium text-sand-1400">Use a different mint</p>
                                            <div className="flex gap-2">
                                                <TextInput
                                                    value={customUsdcAddress}
                                                    onChange={e => {
                                                        setCustomUsdcAddress(e.target.value);
                                                        setUsdcVerifyFailed(false);
                                                    }}
                                                    placeholder="USDC mint address..."
                                                    className="min-w-0 flex-1"
                                                    inputClassName="font-mono"
                                                />
                                                <Button
                                                    onClick={() => handleUseCustomUsdc(customUsdcAddress)}
                                                    disabled={!isValidBase58Address(customUsdcAddress) || isPending}
                                                    variant="outline"
                                                    className="border-sand-300 shrink-0"
                                                >
                                                    {verifyingUsdc ? (
                                                        <Loader2 className="h-4 w-4 animate-spin" />
                                                    ) : (
                                                        'Verify'
                                                    )}
                                                </Button>
                                            </div>
                                            {usdcVerifyFailed && isValidBase58Address(customUsdcAddress) && (
                                                <div className="flex items-center justify-between rounded-md border border-amber-300 bg-amber-50 px-3 py-2">
                                                    <span className="text-xs text-amber-600">
                                                        Could not verify on-chain
                                                    </span>
                                                    <Button
                                                        onClick={() => handleUseCustomUsdc(customUsdcAddress, true)}
                                                        disabled={isPending}
                                                        variant="ghost"
                                                        size="sm"
                                                        className="text-amber-600 hover:text-amber-700 text-xs h-6 px-2"
                                                    >
                                                        Use anyway
                                                    </Button>
                                                </div>
                                            )}
                                        </div>

                                        <div className="relative flex items-center gap-3">
                                            <div className="flex-1 border-t border-sand-200" />
                                            <span className="text-[10px] text-sand-900 uppercase tracking-wider">
                                                or
                                            </span>
                                            <div className="flex-1 border-t border-sand-200" />
                                        </div>

                                        <SolanaButton
                                            onClick={runUsdcFlow}
                                            disabled={isPending}
                                            loading={isPending}
                                            style={{ width: '100%' }}
                                        >
                                            Create New USDC Mint
                                        </SolanaButton>
                                    </>
                                )}
                            </div>
                        )}

                        {isComplete && result && <SetupCompleteCard result={result} onComplete={onComplete} />}

                        <LogConsole logs={logs} />
                    </CardContent>
                </Card>
            </div>
        </div>
    );
}

export function Setup() {
    const [network, setNetwork] = useState<Network>(null);
    const navigate = useNavigate();
    const { setCluster } = useCluster();

    const handleComplete = useCallback(
        (net: string) => {
            const clusterId = net === 'localnet' ? 'solana:localnet' : 'solana:devnet';
            localStorage.setItem(`setup-complete-${net}`, 'true');
            localStorage.setItem('setup-cluster', clusterId);
            void setCluster(clusterId);
            navigate('/');
        },
        [navigate, setCluster],
    );

    if (!network) {
        return <NetworkSelection onSelect={setNetwork} onSkip={() => navigate('/')} />;
    }

    if (network === 'localnet') {
        return <LocalnetWizard onComplete={() => handleComplete('localnet')} onBack={() => setNetwork(null)} />;
    }

    return <DevnetWizard onComplete={() => handleComplete('devnet')} onBack={() => setNetwork(null)} />;
}
