import { MyPlansPanel } from '@/components/plan/my-plans-panel';

export function Plans() {
    return (
        <div className="space-y-6">
            <h1 className="text-3xl font-semibold tracking-tight text-foreground">Plans</h1>
            <MyPlansPanel />
        </div>
    );
}
