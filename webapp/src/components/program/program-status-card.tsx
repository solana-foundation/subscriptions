import { Shield, ShieldOff, ShieldQuestion } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { CopyButton } from '@/components/ui/copy-button';
import { truncateAddress } from '@/lib/format';
import { useProgramStatus, useBinaryInfo } from '@/hooks/use-program-status';
import { useProgramAddress } from '@/hooks/use-token-config';

function StatusBadge({ deployed, upgradeable }: { deployed: boolean; upgradeable: boolean }) {
    if (!deployed)
        return (
            <span className="flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium bg-red-500/10 text-red-400 border border-red-500/20">
                <ShieldOff className="h-3 w-3" /> Not Deployed
            </span>
        );
    if (upgradeable)
        return (
            <span className="flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium bg-purple-500/10 text-purple-400 border border-purple-500/20">
                <Shield className="h-3 w-3" /> Upgradeable
            </span>
        );
    return (
        <span className="flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
            <ShieldQuestion className="h-3 w-3" /> Immutable
        </span>
    );
}

export function ProgramStatusCard() {
    const { data: status, isLoading, error } = useProgramStatus();
    const { data: binaryInfo } = useBinaryInfo();
    const progAddr = useProgramAddress();

    if (isLoading)
        return (
            <Card className="border-purple-500/20 bg-gradient-to-br from-purple-950/30 via-slate-950 to-slate-950">
                <CardContent className="flex items-center justify-center py-12">
                    <div className="animate-spin h-6 w-6 border-2 border-purple-500 border-t-transparent rounded-full" />
                </CardContent>
            </Card>
        );

    if (error)
        return (
            <Card className="border-red-500/20 bg-gradient-to-br from-red-950/30 via-slate-950 to-slate-950">
                <CardContent className="py-6 text-red-400 text-sm">Failed to load program status</CardContent>
            </Card>
        );

    return (
        <Card className="border-purple-500/20 bg-gradient-to-br from-purple-950/30 via-slate-950 to-slate-950">
            <CardHeader>
                <CardTitle className="flex items-center justify-between">
                    <span className="text-white">Program Status</span>
                    {status && <StatusBadge deployed={status.deployed} upgradeable={status.upgradeable} />}
                </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
                <Row label="Program ID">
                    <span className="font-mono text-sm text-gray-300">
                        {progAddr ? truncateAddress(progAddr, 6) : '...'}
                    </span>
                    {progAddr && <CopyButton text={progAddr} />}
                </Row>

                {status?.deployed && (
                    <>
                        {status.upgradeAuthority && (
                            <Row label="Upgrade Authority">
                                <span className="font-mono text-sm text-gray-300">
                                    {truncateAddress(status.upgradeAuthority, 6)}
                                </span>
                                <CopyButton text={status.upgradeAuthority} />
                            </Row>
                        )}
                        {status.lastDeploySlot && (
                            <Row label="Last Deploy Slot">
                                <span className="text-sm text-gray-300">{status.lastDeploySlot.toLocaleString()}</span>
                            </Row>
                        )}
                        {status.lastDeployTime && (
                            <Row label="Deployed At">
                                <span className="text-sm text-gray-300">
                                    {new Date(status.lastDeployTime * 1000).toLocaleString()}
                                </span>
                            </Row>
                        )}
                        {status.dataSize && (
                            <Row label="Program Data Size">
                                <span className="text-sm text-gray-300">{(status.dataSize / 1024).toFixed(1)} KB</span>
                            </Row>
                        )}
                    </>
                )}

                {binaryInfo && (
                    <>
                        <Row label="Binary Size">
                            <span className="text-sm text-gray-300">{(binaryInfo.size / 1024).toFixed(1)} KB</span>
                        </Row>
                        <Row label="Binary Hash">
                            <span className="font-mono text-xs text-gray-400">{binaryInfo.hash.slice(0, 16)}...</span>
                            <CopyButton text={binaryInfo.hash} />
                        </Row>
                    </>
                )}
            </CardContent>
        </Card>
    );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
    return (
        <div className="flex items-center justify-between">
            <span className="text-sm text-gray-500">{label}</span>
            <div className="flex items-center gap-2">{children}</div>
        </div>
    );
}
