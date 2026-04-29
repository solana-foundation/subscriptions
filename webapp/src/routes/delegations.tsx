import { DelegationManagementPanel } from '@/components/delegation/delegation-management-panel';

export function Delegations() {
    return (
        <div className="space-y-6">
            <h1 className="text-3xl font-bold tracking-tight text-white">Delegations</h1>
            <DelegationManagementPanel />
        </div>
    );
}
