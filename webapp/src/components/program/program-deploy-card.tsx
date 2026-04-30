import { useState, useRef, useEffect } from 'react';
import {
    Rocket,
    RotateCcw,
    Loader2,
    CheckCircle2,
    XCircle,
    Trash2,
    ChevronDown,
    ChevronRight,
    Shield,
    Send,
} from 'lucide-react';
import { Button as SolanaButton, CopyButton, TextInput } from '@solana/design-system';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { useProgramStatus } from '@/hooks/use-program-status';
import { useProgramDeploy, type DeployProgress } from '@/hooks/use-program-deploy';
import { useProgramAddress } from '@/hooks/use-token-config';
import { useClusterConfig } from '@/hooks/use-cluster-config';
import { useKitTransactionSigner, useWallet } from '@solana/connector/react';
import { useWalletTransactionSignAndSend } from '@/components/solana/use-wallet-transaction-sign-and-send';
import { useTransactionToast } from '@/components/use-transaction-toast';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { isValidBase58Address } from '@/lib/validators';
import { buildSetAuthorityIx, deriveProgramDataAddress } from '@/lib/bpf-loader-browser';
import {
    address,
    appendTransactionMessageInstructions,
    compileTransaction,
    createTransactionMessage,
    getBase64EncodedWireTransaction,
    getBase58Decoder,
    createNoopSigner,
    generateKeyPair,
    createSignerFromKeyPair,
    pipe,
    setTransactionMessageFeePayerSigner,
    setTransactionMessageLifetimeUsingBlockhash,
} from '@solana/kit';
import { useRpc } from '@/hooks/use-rpc';

function ProgressBar({ current, total }: { current: number; total: number }) {
    const pct = total > 0 ? Math.round((current / total) * 100) : 0;
    return (
        <div className="space-y-1.5">
            <div className="flex justify-between text-xs text-sand-1100">
                <span>
                    {current}/{total} chunks
                </span>
                <span>{pct}%</span>
            </div>
            <div className="h-2 bg-sand-200 rounded-full overflow-hidden">
                <div
                    className="h-full bg-gradient-to-r from-emerald-500 to-emerald-400 rounded-full transition-all duration-300 relative"
                    style={{ width: `${pct}%` }}
                >
                    <div className="absolute inset-0 bg-gradient-to-r from-transparent via-white/20 to-transparent animate-pulse" />
                </div>
            </div>
        </div>
    );
}

function PhaseDisplay({ progress }: { progress: DeployProgress }) {
    const { phase, message } = progress;
    const phaseConfig: Record<string, { icon: React.ReactNode; color: string }> = {
        preparing: { icon: <Loader2 className="h-5 w-5 animate-spin" />, color: 'text-foreground' },
        funding: { icon: <Loader2 className="h-5 w-5 animate-spin" />, color: 'text-amber-600' },
        init: { icon: <Loader2 className="h-5 w-5 animate-spin" />, color: 'text-foreground' },
        writing: { icon: <Loader2 className="h-5 w-5 animate-spin" />, color: 'text-foreground' },
        deploying: { icon: <Loader2 className="h-5 w-5 animate-spin" />, color: 'text-foreground' },
        done: { icon: <CheckCircle2 className="h-5 w-5" />, color: 'text-foreground' },
        error: { icon: <XCircle className="h-5 w-5" />, color: 'text-red-600' },
    };

    const config = phaseConfig[phase] ?? phaseConfig.preparing;

    return (
        <div className={`flex items-center gap-3 ${config.color}`}>
            {config.icon}
            <span className="text-sm">{message}</span>
        </div>
    );
}

function TransferAuthoritySection() {
    const { data: status } = useProgramStatus();
    const { account } = useWallet();
    const { signer } = useKitTransactionSigner();
    const signAndSend = useWalletTransactionSignAndSend();
    const toast = useTransactionToast();
    const queryClient = useQueryClient();
    const { id: clusterId } = useClusterConfig();
    const rpc = useRpc();
    const progAddr = useProgramAddress();

    const [expanded, setExpanded] = useState(false);
    const [newAuthority, setNewAuthority] = useState('');
    const [base58Output, setBase58Output] = useState('');
    const [generating, setGenerating] = useState(false);

    const walletAddress = account;
    const isAuthority = !!(walletAddress && status?.upgradeAuthority === walletAddress);
    const isValidInput = isValidBase58Address(newAuthority);
    const programAddress = progAddr ?? '';

    const transferMutation = useMutation({
        mutationFn: async () => {
            if (!signer || !programAddress) throw new Error('Wallet not connected');
            const programDataPDA = await deriveProgramDataAddress(address(programAddress));
            const ix = buildSetAuthorityIx(programDataPDA, signer, address(newAuthority));
            return signAndSend(ix, signer);
        },
        onSuccess: sig => {
            toast.onSuccess(sig);
            queryClient.invalidateQueries({ queryKey: ['program-status', clusterId] });
            setNewAuthority('');
        },
        onError: err => toast.onError(err),
    });

    const handleGenerateBase58 = async () => {
        if (!programAddress || !status?.upgradeAuthority || !walletAddress) return;
        setGenerating(true);
        setBase58Output('');
        try {
            const programDataPDA = await deriveProgramDataAddress(address(programAddress));
            const currentAuth = address(status.upgradeAuthority);
            const { value: latestBlockhash } = await rpc.getLatestBlockhash().send();

            const authSigner = createNoopSigner(currentAuth);
            const dummyFeePayer = await createSignerFromKeyPair(await generateKeyPair());
            const ix = buildSetAuthorityIx(programDataPDA, authSigner, address(newAuthority));
            const tx = pipe(
                createTransactionMessage({ version: 'legacy' }),
                m => setTransactionMessageFeePayerSigner(dummyFeePayer, m),
                m => setTransactionMessageLifetimeUsingBlockhash(latestBlockhash, m),
                m => appendTransactionMessageInstructions([ix], m),
            );
            const compiled = compileTransaction(tx);
            const base64 = getBase64EncodedWireTransaction(compiled);
            const bytes = Uint8Array.from(atob(base64), c => c.charCodeAt(0));
            setBase58Output(getBase58Decoder().decode(bytes));
        } catch (e) {
            setBase58Output(`Error: ${e instanceof Error ? e.message : String(e)}`);
        } finally {
            setGenerating(false);
        }
    };

    return (
        <div className="border border-sand-300 rounded-lg overflow-hidden">
            <button
                onClick={() => setExpanded(!expanded)}
                className="w-full flex items-center justify-between px-4 py-3 text-sm text-sand-1100 hover:text-foreground hover:bg-sand-100 transition-colors"
            >
                <div className="flex items-center gap-2">
                    <Shield className="h-4 w-4 text-sand-1100" />
                    <span>Transfer Authority</span>
                </div>
                {expanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
            </button>

            {expanded && (
                <div className="px-4 pb-4 space-y-3 border-t border-sand-300 pt-3">
                    <div>
                        <label className="text-xs text-sand-1000 mb-1 block">New Authority Address</label>
                        <TextInput
                            value={newAuthority}
                            onChange={e => {
                                setNewAuthority(e.target.value);
                                setBase58Output('');
                            }}
                            placeholder="New authority address..."
                            inputClassName="font-mono"
                        />
                    </div>

                    {newAuthority && !isValidInput && <p className="text-xs text-red-600">Invalid base58 address</p>}

                    {isValidInput && (
                        <div className="flex gap-2">
                            {isAuthority && (
                                <SolanaButton
                                    onClick={() => transferMutation.mutate()}
                                    disabled={transferMutation.isPending}
                                    iconLeft={<Send />}
                                    loading={transferMutation.isPending}
                                    style={{ flex: 1 }}
                                >
                                    Sign & Send
                                </SolanaButton>
                            )}
                            <Button
                                onClick={handleGenerateBase58}
                                disabled={generating}
                                variant="outline"
                                className={`${isAuthority ? '' : 'flex-1'} border-sand-400 text-foreground hover:bg-sand-100`}
                            >
                                {generating ? (
                                    <>
                                        <Loader2 className="h-4 w-4 mr-2 animate-spin" /> Generating...
                                    </>
                                ) : (
                                    'Generate TX (base58)'
                                )}
                            </Button>
                        </div>
                    )}

                    {base58Output && !base58Output.startsWith('Error:') && (
                        <div className="space-y-2">
                            <div className="flex items-center justify-between">
                                <span className="text-xs text-sand-1000">Raw Transaction (base58)</span>
                                <CopyButton value={base58Output} />
                            </div>
                            <div className="p-3 rounded-lg bg-sand-100 border border-sand-300 max-h-32 overflow-y-auto">
                                <code className="text-xs text-foreground break-all font-mono leading-relaxed">
                                    {base58Output}
                                </code>
                            </div>
                            <p className="text-[10px] text-sand-900">
                                Import this transaction into your multisig app (Squads, Realms, etc.) to execute.
                            </p>
                        </div>
                    )}

                    {base58Output && base58Output.startsWith('Error:') && (
                        <p className="text-xs text-red-600">{base58Output}</p>
                    )}
                </div>
            )}
        </div>
    );
}

export function ProgramDeployCard() {
    const { data: status } = useProgramStatus();
    const { deploy, progress, resetProgress, closeBuffer } = useProgramDeploy();
    const { account } = useWallet();
    const isActive = deploy.isPending;
    const isUpgrade = status?.deployed ?? false;
    const [lastFailedChunk, setLastFailedChunk] = useState<number | null>(null);
    const progressRef = useRef(progress);
    useEffect(() => {
        progressRef.current = progress;
    }, [progress]);

    const walletAddress = account;
    const authorityMismatch =
        isUpgrade && status?.upgradeAuthority && walletAddress && status.upgradeAuthority !== walletAddress;

    const handleDeploy = (resumeFrom?: number) => {
        setLastFailedChunk(null);
        deploy.mutate(
            { isUpgrade, resumeFrom },
            {
                onError: () => {
                    if (progressRef.current.phase === 'writing' && progressRef.current.current > 0) {
                        setLastFailedChunk(progressRef.current.current - 1);
                    }
                },
            },
        );
    };

    return (
        <Card className="border-0 border-all-dashed-medium bg-card">
            <CardHeader>
                <CardTitle className="text-foreground">{isUpgrade ? 'Upgrade Program' : 'Deploy Program'}</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
                {authorityMismatch && (
                    <div className="p-3 rounded-lg bg-amber-100 border border-amber-300 text-xs text-amber-600">
                        Upgrade authority is{' '}
                        <span className="font-mono">{status?.upgradeAuthority?.slice(0, 8)}...</span> which differs from
                        your wallet. Use the Transfer Authority section below to change it, or generate a base58
                        transaction for your multisig.
                    </div>
                )}

                {!isActive && progress.phase !== 'done' && progress.phase !== 'error' && (
                    <SolanaButton
                        onClick={() => handleDeploy()}
                        disabled={!!authorityMismatch}
                        iconLeft={<Rocket />}
                        style={{ width: '100%' }}
                    >
                        {isUpgrade ? 'Upgrade Program' : 'Deploy Program'}
                    </SolanaButton>
                )}

                {(isActive || progress.phase === 'done' || progress.phase === 'error') && (
                    <div className="space-y-4">
                        <PhaseDisplay progress={progress} />
                        {['writing', 'deploying', 'done'].includes(progress.phase) && progress.total > 0 && (
                            <ProgressBar current={progress.current} total={progress.total} />
                        )}
                    </div>
                )}

                {progress.phase === 'error' && (
                    <div className="space-y-2">
                        <p className="text-xs text-red-600/80 break-all">{progress.message}</p>
                        <div className="flex gap-2">
                            {lastFailedChunk !== null && lastFailedChunk > 0 ? (
                                <Button
                                    onClick={() => handleDeploy(lastFailedChunk)}
                                    variant="outline"
                                    className="flex-1 border-amber-300 text-amber-600 hover:bg-amber-100"
                                >
                                    <RotateCcw className="h-4 w-4 mr-2" /> Resume from chunk {lastFailedChunk}
                                </Button>
                            ) : (
                                <Button
                                    onClick={() => {
                                        resetProgress();
                                        handleDeploy();
                                    }}
                                    variant="outline"
                                    className="flex-1 border-red-300 text-red-600 hover:bg-red-100"
                                >
                                    <RotateCcw className="h-4 w-4 mr-2" /> Retry
                                </Button>
                            )}
                            <Button
                                onClick={() => closeBuffer.mutate()}
                                disabled={closeBuffer.isPending}
                                variant="outline"
                                className="border-gray-500/30 text-sand-1100 hover:bg-gray-500/10"
                                title="Close buffer and reclaim SOL"
                            >
                                <Trash2 className="h-4 w-4" />
                            </Button>
                        </div>
                    </div>
                )}

                {progress.phase === 'done' && (
                    <Button
                        onClick={resetProgress}
                        variant="outline"
                        className="w-full border-foreground bg-foreground text-background hover:bg-foreground/90"
                    >
                        Done
                    </Button>
                )}

                {status?.deployed && status.upgradeable && <TransferAuthoritySection />}
            </CardContent>
        </Card>
    );
}
