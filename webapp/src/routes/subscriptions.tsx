import { MySubscriptionsPanel } from '@/components/subscription/my-subscriptions-panel';

export function Subscriptions() {
    return (
        <div className="space-y-6">
            <h1 className="text-3xl font-bold tracking-tight text-white">Subscriptions</h1>
            <MySubscriptionsPanel />
        </div>
    );
}
