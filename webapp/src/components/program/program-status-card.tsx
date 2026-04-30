import { Shield, ShieldOff, ShieldQuestion } from 'lucide-react';
import { Badge, CopyButton } from '@solana/design-system';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { truncateAddress } from '@/lib/format';
import { useProgramStatus, useBinaryInfo } from '@/hooks/use-program-status';
import { useProgramAddress } from '@/hooks/use-token-config';

function StatusBadge({ deployed, upgradeable }: { deployed: boolean; upgradeable: boolean }) {
    if (!deployed)
        return (
            <Badge variant="danger">
                <span className="inline-flex items-center gap-1.5">
                    <ShieldOff className="h-3 w-3" /> Not Deployed
                </span>
            </Badge>
        );
    if (upgradeable)
        return (
            <Badge variant="info">
                <span className="inline-flex items-center gap-1.5">
                    <Shield className="h-3 w-3" /> Upgradeable
                </span>
            </Badge>
        );
    return (
        <Badge variant="success">
            <span className="inline-flex items-center gap-1.5">
                <ShieldQuestion className="h-3 w-3" /> Immutable
            </span>
        </Badge>
    );
}

export function ProgramStatusCard() {
    const { data: status, isLoading, error } = useProgramStatus();
    const { data: binaryInfo } = useBinaryInfo();
    const progAddr = useProgramAddress();

    if (isLoading)
        return (
            <Card className="border-0 border-all-dashed-medium bg-card">
                <CardContent className="flex items-center justify-center py-12">
                    <div className="animate-spin h-6 w-6 border-2 border-foreground border-t-transparent rounded-full" />
                </CardContent>
            </Card>
        );

    if (error)
        return (
            <Card className="border-red-500/20 bg-gradient-to-br from-red-100 via-white to-white">
                <CardContent className="py-6 text-red-600 text-sm">Failed to load program status</CardContent>
            </Card>
        );

    return (
        <Card className="border-0 border-all-dashed-medium bg-card">
            <CardHeader>
                <CardTitle className="flex items-center justify-between">
                    <span className="text-foreground">Program Status</span>
                    {status && <StatusBadge deployed={status.deployed} upgradeable={status.upgradeable} />}
                </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
                <Row label="Program ID">
                    <span className="font-mono text-sm text-sand-1400">
                        {progAddr ? truncateAddress(progAddr, 6) : '...'}
                    </span>
                    {progAddr && <CopyButton value={progAddr} />}
                </Row>

                {status?.deployed && (
                    <>
                        {status.upgradeAuthority && (
                            <Row label="Upgrade Authority">
                                <span className="font-mono text-sm text-sand-1400">
                                    {truncateAddress(status.upgradeAuthority, 6)}
                                </span>
                                <CopyButton value={status.upgradeAuthority} />
                            </Row>
                        )}
                        {status.lastDeploySlot && (
                            <Row label="Last Deploy Slot">
                                <span className="text-sm text-sand-1400">{status.lastDeploySlot.toLocaleString()}</span>
                            </Row>
                        )}
                        {status.lastDeployTime && (
                            <Row label="Deployed At">
                                <span className="text-sm text-sand-1400">
                                    {new Date(status.lastDeployTime * 1000).toLocaleString()}
                                </span>
                            </Row>
                        )}
                        {status.dataSize && (
                            <Row label="Program Data Size">
                                <span className="text-sm text-sand-1400">{(status.dataSize / 1024).toFixed(1)} KB</span>
                            </Row>
                        )}
                    </>
                )}

                {binaryInfo && (
                    <>
                        <Row label="Binary Size">
                            <span className="text-sm text-sand-1400">{(binaryInfo.size / 1024).toFixed(1)} KB</span>
                        </Row>
                        <Row label="Binary Hash">
                            <span className="font-mono text-xs text-sand-1100">{binaryInfo.hash.slice(0, 16)}...</span>
                            <CopyButton value={binaryInfo.hash} />
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
            <span className="text-sm text-sand-1000">{label}</span>
            <div className="flex items-center gap-2">{children}</div>
        </div>
    );
}
