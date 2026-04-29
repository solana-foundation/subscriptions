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
    Copy,
    Check,
    Send,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { useProgramStatus } from '@/hooks/use-program-status';
import { useProgramDeploy, type DeployProgress } from '@/hooks/use-program-deploy';
import { useProgramAddress } from '@/hooks/use-token-config';
import { useClusterConfig } from '@/hooks/use-cluster-config';
import { useWalletUi } from '@wallet-ui/react';
import { useWalletUiSigner } from '@/components/solana/use-wallet-ui-signer';
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
            <div className="flex justify-between text-xs text-gray-400">
                <span>
                    {current}/{total} chunks
                </span>
                <span>{pct}%</span>
            </div>
            <div className="h-2 bg-slate-800 rounded-full overflow-hidden">
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
        preparing: { icon: <Loader2 className="h-5 w-5 animate-spin" />, color: 'text-purple-400' },
        funding: { icon: <Loader2 className="h-5 w-5 animate-spin" />, color: 'text-amber-400' },
        init: { icon: <Loader2 className="h-5 w-5 animate-spin" />, color: 'text-blue-400' },
        writing: { icon: <Loader2 className="h-5 w-5 animate-spin" />, color: 'text-emerald-400' },
        deploying: { icon: <Loader2 className="h-5 w-5 animate-spin" />, color: 'text-purple-400' },
        done: { icon: <CheckCircle2 className="h-5 w-5" />, color: 'text-emerald-400' },
        error: { icon: <XCircle className="h-5 w-5" />, color: 'text-red-400' },
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
    const { account } = useWalletUi();
    const signer = useWalletUiSigner();
    const signAndSend = useWalletTransactionSignAndSend();
    const toast = useTransactionToast();
    const queryClient = useQueryClient();
    const { id: clusterId } = useClusterConfig();
    const rpc = useRpc();
    const progAddr = useProgramAddress();

    const [expanded, setExpanded] = useState(false);
    const [newAuthority, setNewAuthority] = useState('');
    const [base58Output, setBase58Output] = useState('');
    const [copied, setCopied] = useState(false);
    const [generating, setGenerating] = useState(false);

    const walletAddress = account?.address;
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

    const handleCopy = () => {
        navigator.clipboard.writeText(base58Output);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
    };

    return (
        <div className="border border-purple-500/10 rounded-lg overflow-hidden">
            <button
                onClick={() => setExpanded(!expanded)}
                className="w-full flex items-center justify-between px-4 py-3 text-sm text-gray-400 hover:text-white hover:bg-purple-500/5 transition-colors"
            >
                <div className="flex items-center gap-2">
                    <Shield className="h-4 w-4 text-purple-400" />
                    <span>Transfer Authority</span>
                </div>
                {expanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
            </button>

            {expanded && (
                <div className="px-4 pb-4 space-y-3 border-t border-purple-500/10 pt-3">
                    <div>
                        <label className="text-xs text-gray-500 mb-1 block">New Authority Address</label>
                        <Input
                            value={newAuthority}
                            onChange={e => {
                                setNewAuthority(e.target.value);
                                setBase58Output('');
                            }}
                            placeholder="New authority address..."
                            className="bg-slate-900/50 border-purple-500/20 text-sm font-mono"
                        />
                    </div>

                    {newAuthority && !isValidInput && <p className="text-xs text-red-400">Invalid base58 address</p>}

                    {isValidInput && (
                        <div className="flex gap-2">
                            {isAuthority && (
                                <Button
                                    onClick={() => transferMutation.mutate()}
                                    disabled={transferMutation.isPending}
                                    className="flex-1 bg-purple-600 hover:bg-purple-500 text-white"
                                >
                                    {transferMutation.isPending ? (
                                        <>
                                            <Loader2 className="h-4 w-4 mr-2 animate-spin" /> Transferring...
                                        </>
                                    ) : (
                                        <>
                                            <Send className="h-4 w-4 mr-2" /> Sign & Send
                                        </>
                                    )}
                                </Button>
                            )}
                            <Button
                                onClick={handleGenerateBase58}
                                disabled={generating}
                                variant="outline"
                                className={`${isAuthority ? '' : 'flex-1'} border-purple-500/30 text-purple-400 hover:bg-purple-500/10`}
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
                                <span className="text-xs text-gray-500">Raw Transaction (base58)</span>
                                <Button
                                    onClick={handleCopy}
                                    variant="ghost"
                                    size="sm"
                                    className="h-6 px-2 text-gray-400 hover:text-white"
                                >
                                    {copied ? (
                                        <Check className="h-3 w-3 text-emerald-400" />
                                    ) : (
                                        <Copy className="h-3 w-3" />
                                    )}
                                </Button>
                            </div>
                            <div className="p-3 rounded-lg bg-black/40 border border-purple-500/10 max-h-32 overflow-y-auto">
                                <code className="text-xs text-purple-300 break-all font-mono leading-relaxed">
                                    {base58Output}
                                </code>
                            </div>
                            <p className="text-[10px] text-gray-600">
                                Import this transaction into your multisig app (Squads, Realms, etc.) to execute.
                            </p>
                        </div>
                    )}

                    {base58Output && base58Output.startsWith('Error:') && (
                        <p className="text-xs text-red-400">{base58Output}</p>
                    )}
                </div>
            )}
        </div>
    );
}

export function ProgramDeployCard() {
    const { data: status } = useProgramStatus();
    const { deploy, progress, resetProgress, closeBuffer } = useProgramDeploy();
    const { account } = useWalletUi();
    const isActive = deploy.isPending;
    const isUpgrade = status?.deployed ?? false;
    const [lastFailedChunk, setLastFailedChunk] = useState<number | null>(null);
    const progressRef = useRef(progress);
    useEffect(() => {
        progressRef.current = progress;
    }, [progress]);

    const walletAddress = account?.address;
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
        <Card className="border-purple-500/20 bg-gradient-to-br from-purple-950/30 via-slate-950 to-slate-950">
            <CardHeader>
                <CardTitle className="text-white">{isUpgrade ? 'Upgrade Program' : 'Deploy Program'}</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
                {authorityMismatch && (
                    <div className="p-3 rounded-lg bg-amber-500/10 border border-amber-500/20 text-xs text-amber-400">
                        Upgrade authority is{' '}
                        <span className="font-mono">{status?.upgradeAuthority?.slice(0, 8)}...</span> which differs from
                        your wallet. Use the Transfer Authority section below to change it, or generate a base58
                        transaction for your multisig.
                    </div>
                )}

                {!isActive && progress.phase !== 'done' && progress.phase !== 'error' && (
                    <Button
                        onClick={() => handleDeploy()}
                        disabled={!!authorityMismatch}
                        className="w-full bg-purple-600 hover:bg-purple-500 text-white disabled:opacity-50"
                    >
                        <Rocket className="h-4 w-4 mr-2" />
                        {isUpgrade ? 'Upgrade Program' : 'Deploy Program'}
                    </Button>
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
                        <p className="text-xs text-red-400/80 break-all">{progress.message}</p>
                        <div className="flex gap-2">
                            {lastFailedChunk !== null && lastFailedChunk > 0 ? (
                                <Button
                                    onClick={() => handleDeploy(lastFailedChunk)}
                                    variant="outline"
                                    className="flex-1 border-amber-500/30 text-amber-400 hover:bg-amber-500/10"
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
                                    className="flex-1 border-red-500/30 text-red-400 hover:bg-red-500/10"
                                >
                                    <RotateCcw className="h-4 w-4 mr-2" /> Retry
                                </Button>
                            )}
                            <Button
                                onClick={() => closeBuffer.mutate()}
                                disabled={closeBuffer.isPending}
                                variant="outline"
                                className="border-gray-500/30 text-gray-400 hover:bg-gray-500/10"
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
                        className="w-full border-emerald-500/30 text-emerald-400 hover:bg-emerald-500/10"
                    >
                        Done
                    </Button>
                )}

                {status?.deployed && status.upgradeable && <TransferAuthoritySection />}
            </CardContent>
        </Card>
    );
}
