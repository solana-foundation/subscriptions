import { Users, Calendar, ClipboardPen } from 'lucide-react';
import { Link } from 'react-router';
import { useDelegations, useIncomingDelegations } from '@/hooks/use-delegations';
import { useMySubscriptions, useSubscriberCounts } from '@/hooks/use-subscriptions';
import { useMyPlans } from '@/hooks/use-plans';
import { useMemo } from 'react';
import { useSelectedToken } from '@/hooks/use-selected-token';
import { formatTokenAmount } from '@/lib/token-display';

export function SummaryCards() {
    const outgoing = useDelegations();
    const incoming = useIncomingDelegations();
    const { data: subscriptions } = useMySubscriptions();
    const { data: plans } = useMyPlans();
    const { selectedMint, selectedToken } = useSelectedToken();
    const decimals = selectedToken?.decimals ?? 0;
    const symbol = selectedToken?.symbol ?? '';

    const outgoingCount = outgoing.all.length;
    const incomingCount = incoming.all.length;

    const subsCounts = useMemo(() => {
        if (!subscriptions || subscriptions.length === 0) return { active: 0, totalAmount: 0n };
        const active = subscriptions.filter(
            s => Number(s.subscription.expiresAtTs) === 0 && s.plan?.data.mint === selectedMint,
        );

        let totalAmount = 0n;
        for (const sub of active) {
            if (sub.plan) {
                totalAmount += sub.plan.data.terms.amount;
            }
        }

        return { active: active.length, totalAmount };
    }, [subscriptions, selectedMint]);

    const planAddresses = useMemo(() => (plans ?? []).map(p => p.address), [plans]);
    const { data: subscriberCounts } = useSubscriberCounts(planAddresses);

    const plansCounts = useMemo(() => {
        if (!plans || plans.length === 0) return { active: 0, subs: 0 };
        let subs = 0;
        if (subscriberCounts) {
            for (const count of subscriberCounts.values()) subs += count;
        }
        return { active: plans.length, subs };
    }, [plans, subscriberCounts]);

    return (
        <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-4 sm:gap-6 pt-4">
            {/* Delegations Card */}
            <Link
                to="/delegations"
                className="group flex flex-col relative overflow-hidden bg-card border-0 border-all-dashed-medium rounded-2xl transition-all hover:bg-sand-100 cursor-pointer"
            >
                <div className="p-5 flex-grow">
                    <div className="flex items-center gap-2 mb-6">
                        <Users className="h-5 w-5 text-sand-1100" />
                        <h3 className="text-[17px] font-semibold text-foreground tracking-tight">Token Delegations</h3>
                    </div>

                    <div className="space-y-4">
                        <div className="flex justify-between items-center text-sm">
                            <span className="text-sand-1100">Outgoing</span>
                            <span className="font-bold text-foreground text-base">{outgoingCount}</span>
                        </div>
                        <div className="h-px w-full bg-sand-100" />
                        <div className="flex justify-between items-center text-sm">
                            <span className="text-sand-1100">Incoming</span>
                            <span className="font-bold text-foreground text-base">{incomingCount}</span>
                        </div>
                    </div>
                </div>
            </Link>

            {/* Subscriptions Card */}
            <Link
                to="/subscriptions"
                className="group flex flex-col relative overflow-hidden bg-card border-0 border-all-dashed-medium rounded-2xl transition-all hover:bg-sand-100 cursor-pointer"
            >
                <div className="p-5 flex-grow">
                    <div className="flex items-center gap-2 mb-6">
                        <Calendar className="h-5 w-5 text-sand-1100" />
                        <h3 className="text-[17px] font-semibold text-foreground tracking-tight">My Subscriptions</h3>
                    </div>

                    <div className="space-y-4">
                        <div className="flex justify-between items-center text-sm">
                            <span className="text-sand-1100">Active</span>
                            <span className="font-bold text-foreground text-base">{subsCounts.active}</span>
                        </div>
                        <div className="h-px w-full bg-sand-100" />
                        <div className="flex justify-between items-center text-sm">
                            <span className="text-sand-1100">Amount</span>
                            <span className="font-bold text-foreground text-sm sm:text-base truncate">
                                {formatTokenAmount(subsCounts.totalAmount, decimals)} {symbol}
                            </span>
                        </div>
                    </div>
                </div>
            </Link>

            {/* Plans Card */}
            <Link
                to="/plans"
                className="group flex flex-col relative overflow-hidden bg-card border-0 border-all-dashed-medium rounded-2xl transition-all hover:bg-sand-100 cursor-pointer"
            >
                <div className="p-5 flex-grow">
                    <div className="flex items-center gap-2 mb-6">
                        <ClipboardPen className="h-5 w-5 text-sand-1100" />
                        <h3 className="text-[17px] font-semibold text-foreground tracking-tight">My Plans</h3>
                    </div>

                    <div className="space-y-4">
                        <div className="flex justify-between items-center text-sm">
                            <span className="text-sand-1100">Active Plans</span>
                            <span className="font-bold text-foreground text-base">{plansCounts.active}</span>
                        </div>
                        <div className="h-px w-full bg-sand-100" />
                        <div className="flex justify-between items-center text-sm">
                            <span className="text-sand-1100">Total Subscribers</span>
                            <span className="font-bold text-foreground text-base">{plansCounts.subs}</span>
                        </div>
                    </div>
                </div>
            </Link>
        </div>
    );
}
