import { EnhancedCollectPayments } from '@/components/plan/enhanced-collect-payments';

export function CollectPayments() {
    return (
        <div className="space-y-6">
            <h1 className="text-3xl font-bold tracking-tight text-white">Collect Payments</h1>
            <EnhancedCollectPayments />
        </div>
    );
}
