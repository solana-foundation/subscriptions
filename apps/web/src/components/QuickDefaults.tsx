'use client';

import { Button } from '@solana/design-system/button';
import { TextInput } from '@solana/design-system/text-input';
import { useSavedValues } from '@/contexts/SavedValuesContext';

interface SavedFieldProps {
    label: string;
    value: string;
    onChange: (v: string) => void;
    onSave: (v: string) => void;
    savedValues: string[];
    datalistId: string;
    placeholder: string;
}

function SavedField({ label, value, onChange, onSave, savedValues, datalistId, placeholder }: SavedFieldProps) {
    return (
        <div>
            <TextInput label={label} description={`${savedValues.length} saved`}
                list={datalistId} value={value} onChange={e => onChange(e.target.value)}
                placeholder={placeholder}
                action={
                    <Button type="button" size="sm" variant="secondary"
                        onClick={() => onSave(value)} disabled={!value.trim()}>
                        Save
                    </Button>
                }
            />
            <datalist id={datalistId}>
                {savedValues.map(v => <option key={v} value={v} />)}
            </datalist>
        </div>
    );
}

export function QuickDefaults() {
    const {
        defaultDelegatee, defaultSubscriptionAuthority, defaultDelegation,
        defaultMint, defaultPlan, defaultSubscription,
        delegatees, subscriptionAuthoritys, delegations, mints, plans, subscriptions,
        setDefaultDelegatee, setDefaultSubscriptionAuthority, setDefaultDelegation,
        setDefaultMint, setDefaultPlan, setDefaultSubscription,
        rememberDelegatee, rememberSubscriptionAuthority, rememberDelegation,
        rememberMint, rememberPlan, rememberSubscription,
        clearSavedValues,
    } = useSavedValues();

    return (
        <section style={{ border: '1px solid var(--color-border)', borderRadius: 8, padding: 16, marginBottom: 24, background: 'var(--color-card)' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
                <h3 style={{ fontSize: '0.9375rem', fontWeight: 600 }}>Quick Defaults</h3>
                <Button type="button" size="sm" variant="secondary" onClick={clearSavedValues}>Clear Saved</Button>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 12 }}>
                <SavedField label="Default Delegatee" value={defaultDelegatee} onChange={setDefaultDelegatee}
                    onSave={rememberDelegatee} savedValues={delegatees} datalistId="saved-delegatees" placeholder="Delegatee address" />
                <SavedField label="Default SubscriptionAuthority" value={defaultSubscriptionAuthority} onChange={setDefaultSubscriptionAuthority}
                    onSave={rememberSubscriptionAuthority} savedValues={subscriptionAuthoritys} datalistId="saved-subscriptionAuthoritys" placeholder="SubscriptionAuthority PDA" />
                <SavedField label="Default Delegation" value={defaultDelegation} onChange={setDefaultDelegation}
                    onSave={rememberDelegation} savedValues={delegations} datalistId="saved-delegations" placeholder="Delegation PDA" />
                <SavedField label="Default Mint" value={defaultMint} onChange={setDefaultMint}
                    onSave={rememberMint} savedValues={mints} datalistId="saved-mints" placeholder="Token mint address" />
                <SavedField label="Default Plan" value={defaultPlan} onChange={setDefaultPlan}
                    onSave={rememberPlan} savedValues={plans} datalistId="saved-plans" placeholder="Plan PDA" />
                <SavedField label="Default Subscription" value={defaultSubscription} onChange={setDefaultSubscription}
                    onSave={rememberSubscription} savedValues={subscriptions} datalistId="saved-subscriptions" placeholder="Subscription PDA" />
            </div>
        </section>
    );
}
