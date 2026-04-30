import { DelegationManagementPanel } from '@/components/delegation/delegation-management-panel';

export function Delegations() {
    return (
        <div className="space-y-6">
            <h1 className="text-3xl font-semibold tracking-tight text-foreground">Delegations</h1>
            <DelegationManagementPanel />
        </div>
    );
}
