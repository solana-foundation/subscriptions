import { useState, useMemo } from 'react';
import { ClipboardPen, Plus, RefreshCw } from 'lucide-react';
import { Badge, Button } from '@solana/design-system';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { PlanCard } from './plan-card';
import { CreatePlanDialog } from './create-plan-dialog';
import { useMyPlans } from '@/hooks/use-plans';
import { useSubscriberCounts } from '@/hooks/use-subscriptions';
import { useQueryClient } from '@tanstack/react-query';

export function MyPlansPanel() {
    const [dialogOpen, setDialogOpen] = useState(false);
    const { data: plans, isLoading } = useMyPlans();
    const planAddresses = useMemo(() => plans?.map(p => p.address) ?? [], [plans]);
    const { data: subCounts } = useSubscriberCounts(planAddresses);
    const queryClient = useQueryClient();
    const [spinning, setSpinning] = useState(false);
    const [expandedAddress, setExpandedAddress] = useState<string | null>(null);

    const handleRefresh = async () => {
        setSpinning(true);
        const minSpin = new Promise(r => setTimeout(r, 600));
        await Promise.all([
            queryClient.invalidateQueries({ queryKey: ['plans'] }),
            queryClient.invalidateQueries({ queryKey: ['subscriberCount'] }),
            minSpin,
        ]);
        setSpinning(false);
    };
    const sortedPlans = useMemo(() => {
        if (!plans) return [];
        if (!subCounts) return plans;
        return [...plans].sort((a, b) => (subCounts.get(b.address) ?? 0) - (subCounts.get(a.address) ?? 0));
    }, [plans, subCounts]);

    if (isLoading) {
        return (
            <Card className="border-emerald-500/20 bg-gradient-to-br from-emerald-950/40 via-emerald-900/20 to-transparent">
                <CardContent className="flex items-center justify-center py-12">
                    <div className="animate-pulse text-muted-foreground">Loading plans...</div>
                </CardContent>
            </Card>
        );
    }

    const hasPlan = plans && plans.length > 0;

    return (
        <Card className="relative overflow-hidden border-emerald-500/20 bg-gradient-to-br from-emerald-950/40 via-emerald-900/20 to-transparent hover:border-emerald-500/40 transition-all duration-300">
            <CardHeader className="pb-4">
                <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                        <ClipboardPen className="h-5 w-5 text-emerald-400" />
                        <CardTitle>My Plans</CardTitle>
                    </div>
                    <div className="flex items-center gap-2">
                        {hasPlan && <Badge variant="success">{plans.length}</Badge>}
                        <Button
                            variant="secondary"
                            size="sm"
                            iconOnly
                            iconLeft={<RefreshCw className={spinning ? 'animate-spin' : ''} />}
                            aria-label="Refresh plans"
                            onClick={handleRefresh}
                            disabled={spinning}
                        />
                    </div>
                </div>
            </CardHeader>
            <CardContent>
                {hasPlan ? (
                    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                        {sortedPlans.map(plan => (
                            <PlanCard
                                key={plan.address}
                                plan={plan}
                                isExpanded={expandedAddress === plan.address}
                                onToggleExpand={() =>
                                    setExpandedAddress(expandedAddress === plan.address ? null : plan.address)
                                }
                            />
                        ))}
                    </div>
                ) : (
                    <div className="flex flex-col items-center justify-center py-8 gap-2 text-muted-foreground">
                        <ClipboardPen className="h-8 w-8" />
                        <p className="text-sm">No plans yet</p>
                    </div>
                )}
                <div className="flex justify-end pt-2">
                    <Button radius="round" size="lg" iconLeft={<Plus />} onClick={() => setDialogOpen(true)}>
                        Create Plan
                    </Button>
                </div>
            </CardContent>
            <CreatePlanDialog open={dialogOpen} onOpenChange={setDialogOpen} />
        </Card>
    );
}
