import { Users, Calendar, ClipboardPen } from 'lucide-react';
import { Link } from 'react-router';
import { useDelegations, useIncomingDelegations } from '@/hooks/use-delegations';
import { useMySubscriptions, useSubscriberCounts } from '@/hooks/use-subscriptions';
import { useMyPlans } from '@/hooks/use-plans';
import { useMemo } from 'react';
import { USDC_MULTIPLIER } from '@/lib/utils';

export function SummaryCards() {
    const outgoing = useDelegations();
    const incoming = useIncomingDelegations();
    const { data: subscriptions } = useMySubscriptions();
    const { data: plans } = useMyPlans();

    const outgoingCount = outgoing.all.length;
    const incomingCount = incoming.all.length;

    const subsCounts = useMemo(() => {
        if (!subscriptions || subscriptions.length === 0) return { active: 0, totalAmount: 0 };
        const active = subscriptions.filter(s => Number(s.subscription.expiresAtTs) === 0);

        let totalAmount = 0;
        for (const sub of active) {
            if (sub.plan) {
                totalAmount += Number(sub.plan.data.terms.amount) / USDC_MULTIPLIER;
            }
        }

        return { active: active.length, totalAmount };
    }, [subscriptions]);

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
                className="group flex flex-col relative overflow-hidden border border-blue-500/20 bg-[#121629]/80 backdrop-blur-xl rounded-2xl shadow-[0_0_15px_rgba(59,130,246,0.1)] transition-all hover:border-blue-500/40 hover:shadow-[0_0_20px_rgba(59,130,246,0.2)] cursor-pointer"
            >
                <div className="p-5 flex-grow">
                    <div className="flex items-center gap-2 mb-6">
                        <Users className="h-5 w-5 text-blue-400" />
                        <h3 className="text-[17px] font-semibold text-white tracking-tight">Token Delegations</h3>
                    </div>

                    <div className="space-y-4">
                        <div className="flex justify-between items-center text-sm">
                            <span className="text-gray-400">Outgoing</span>
                            <span className="font-bold text-white text-base">{outgoingCount}</span>
                        </div>
                        <div className="h-px w-full bg-white/5" />
                        <div className="flex justify-between items-center text-sm">
                            <span className="text-gray-400">Incoming</span>
                            <span className="font-bold text-white text-base">{incomingCount}</span>
                        </div>
                    </div>
                </div>
            </Link>

            {/* Subscriptions Card */}
            <Link
                to="/subscriptions"
                className="group flex flex-col relative overflow-hidden border border-amber-500/20 bg-[#291b12]/80 backdrop-blur-xl rounded-2xl shadow-[0_0_15px_rgba(245,158,11,0.1)] transition-all hover:border-amber-500/40 hover:shadow-[0_0_20px_rgba(245,158,11,0.2)] cursor-pointer"
            >
                <div className="p-5 flex-grow">
                    <div className="flex items-center gap-2 mb-6">
                        <Calendar className="h-5 w-5 text-amber-500" />
                        <h3 className="text-[17px] font-semibold text-white tracking-tight">My Subscriptions</h3>
                    </div>

                    <div className="space-y-4">
                        <div className="flex justify-between items-center text-sm">
                            <span className="text-gray-400">Active</span>
                            <span className="font-bold text-white text-base">{subsCounts.active}</span>
                        </div>
                        <div className="h-px w-full bg-white/5" />
                        <div className="flex justify-between items-center text-sm">
                            <span className="text-gray-400">Amount</span>
                            <span className="font-bold text-white text-sm sm:text-base truncate">
                                $
                                {subsCounts.totalAmount.toLocaleString(undefined, {
                                    minimumFractionDigits: 2,
                                    maximumFractionDigits: 2,
                                })}{' '}
                                USDC
                            </span>
                        </div>
                    </div>
                </div>
            </Link>

            {/* Plans Card */}
            <Link
                to="/plans"
                className="group flex flex-col relative overflow-hidden border border-emerald-500/20 bg-[#12291d]/80 backdrop-blur-xl rounded-2xl shadow-[0_0_15px_rgba(16,185,129,0.1)] transition-all hover:border-emerald-500/40 hover:shadow-[0_0_20px_rgba(16,185,129,0.2)] cursor-pointer"
            >
                <div className="p-5 flex-grow">
                    <div className="flex items-center gap-2 mb-6">
                        <ClipboardPen className="h-5 w-5 text-emerald-500" />
                        <h3 className="text-[17px] font-semibold text-white tracking-tight">My Plans</h3>
                    </div>

                    <div className="space-y-4">
                        <div className="flex justify-between items-center text-sm">
                            <span className="text-gray-400">Active Plans</span>
                            <span className="font-bold text-white text-base">{plansCounts.active}</span>
                        </div>
                        <div className="h-px w-full bg-white/5" />
                        <div className="flex justify-between items-center text-sm">
                            <span className="text-gray-400">Total Subscribers</span>
                            <span className="font-bold text-white text-base">{plansCounts.subs}</span>
                        </div>
                    </div>
                </div>
            </Link>
        </div>
    );
}
