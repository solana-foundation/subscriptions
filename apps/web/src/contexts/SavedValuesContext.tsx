'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';

const STORAGE_KEY = 'subscriptions-ui-saved-values-v1';
const MAX_SAVED_VALUES = 25;

interface SavedValuesState {
    defaultDelegatee: string;
    defaultSubscriptionAuthority: string;
    defaultDelegation: string;
    defaultMint: string;
    defaultPlan: string;
    defaultSubscription: string;
    delegatees: string[];
    subscriptionAuthoritys: string[];
    delegations: string[];
    mints: string[];
    plans: string[];
    subscriptions: string[];
}

const INITIAL_STATE: SavedValuesState = {
    defaultDelegatee: '',
    defaultSubscriptionAuthority: '',
    defaultDelegation: '',
    defaultMint: '',
    defaultPlan: '',
    defaultSubscription: '',
    delegatees: [],
    subscriptionAuthoritys: [],
    delegations: [],
    mints: [],
    plans: [],
    subscriptions: [],
};

interface SavedValuesContextType extends SavedValuesState {
    setDefaultDelegatee: (v: string) => void;
    setDefaultSubscriptionAuthority: (v: string) => void;
    setDefaultDelegation: (v: string) => void;
    setDefaultMint: (v: string) => void;
    setDefaultPlan: (v: string) => void;
    setDefaultSubscription: (v: string) => void;
    rememberDelegatee: (v: string) => void;
    rememberSubscriptionAuthority: (v: string) => void;
    rememberDelegation: (v: string) => void;
    rememberMint: (v: string) => void;
    rememberPlan: (v: string) => void;
    rememberSubscription: (v: string) => void;
    clearSavedValues: () => void;
}

const SavedValuesContext = createContext<SavedValuesContextType | null>(null);

function normalize(v: string) { return v.trim(); }

function addUnique(values: string[], value: string): string[] {
    const n = normalize(value);
    if (!n) return values;
    return [n, ...values.filter(v => v !== n)].slice(0, MAX_SAVED_VALUES);
}

function readFromStorage(): SavedValuesState {
    try {
        const raw = window.localStorage.getItem(STORAGE_KEY);
        if (!raw) return INITIAL_STATE;
        const parsed: unknown = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object') return INITIAL_STATE;
        const p = parsed as Record<string, unknown>;
        const sa = (v: unknown) => Array.isArray(v) ? (v as unknown[]).filter(x => typeof x === 'string') as string[] : [];
        const ss = (v: unknown) => typeof v === 'string' ? normalize(v) : '';
        return {
            defaultDelegatee: ss(p.defaultDelegatee),
            defaultSubscriptionAuthority: ss(p.defaultSubscriptionAuthority),
            defaultDelegation: ss(p.defaultDelegation),
            defaultMint: ss(p.defaultMint),
            defaultPlan: ss(p.defaultPlan),
            defaultSubscription: ss(p.defaultSubscription),
            delegatees: sa(p.delegatees),
            subscriptionAuthoritys: sa(p.subscriptionAuthoritys),
            delegations: sa(p.delegations),
            mints: sa(p.mints),
            plans: sa(p.plans),
            subscriptions: sa(p.subscriptions),
        };
    } catch {
        return INITIAL_STATE;
    }
}

export function SavedValuesProvider({ children }: { children: React.ReactNode }) {
    const [state, setState] = useState<SavedValuesState>(INITIAL_STATE);
    const [hydrated, setHydrated] = useState(false);

    useEffect(() => { setState(readFromStorage()); setHydrated(true); }, []);
    useEffect(() => { if (!hydrated) return; window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); }, [state, hydrated]);

    const setDefaultDelegatee = useCallback((v: string) => setState(s => ({ ...s, defaultDelegatee: normalize(v) })), []);
    const setDefaultSubscriptionAuthority = useCallback((v: string) => setState(s => ({ ...s, defaultSubscriptionAuthority: normalize(v) })), []);
    const setDefaultDelegation = useCallback((v: string) => setState(s => ({ ...s, defaultDelegation: normalize(v) })), []);
    const setDefaultMint = useCallback((v: string) => setState(s => ({ ...s, defaultMint: normalize(v) })), []);
    const setDefaultPlan = useCallback((v: string) => setState(s => ({ ...s, defaultPlan: normalize(v) })), []);
    const setDefaultSubscription = useCallback((v: string) => setState(s => ({ ...s, defaultSubscription: normalize(v) })), []);

    const rememberDelegatee = useCallback((v: string) => setState(s => {
        const n = normalize(v); if (!n) return s;
        return { ...s, defaultDelegatee: n, delegatees: addUnique(s.delegatees, n) };
    }), []);
    const rememberSubscriptionAuthority = useCallback((v: string) => setState(s => {
        const n = normalize(v); if (!n) return s;
        return { ...s, defaultSubscriptionAuthority: n, subscriptionAuthoritys: addUnique(s.subscriptionAuthoritys, n) };
    }), []);
    const rememberDelegation = useCallback((v: string) => setState(s => {
        const n = normalize(v); if (!n) return s;
        return { ...s, defaultDelegation: n, delegations: addUnique(s.delegations, n) };
    }), []);
    const rememberMint = useCallback((v: string) => setState(s => {
        const n = normalize(v); if (!n) return s;
        return { ...s, defaultMint: n, mints: addUnique(s.mints, n) };
    }), []);
    const rememberPlan = useCallback((v: string) => setState(s => {
        const n = normalize(v); if (!n) return s;
        return { ...s, defaultPlan: n, plans: addUnique(s.plans, n) };
    }), []);
    const rememberSubscription = useCallback((v: string) => setState(s => {
        const n = normalize(v); if (!n) return s;
        return { ...s, defaultSubscription: n, subscriptions: addUnique(s.subscriptions, n) };
    }), []);

    const clearSavedValues = useCallback(() => setState(INITIAL_STATE), []);

    const ctx = useMemo<SavedValuesContextType>(() => ({
        ...state,
        setDefaultDelegatee, setDefaultSubscriptionAuthority, setDefaultDelegation,
        setDefaultMint, setDefaultPlan, setDefaultSubscription,
        rememberDelegatee, rememberSubscriptionAuthority, rememberDelegation,
        rememberMint, rememberPlan, rememberSubscription,
        clearSavedValues,
    }), [state,
        setDefaultDelegatee, setDefaultSubscriptionAuthority, setDefaultDelegation,
        setDefaultMint, setDefaultPlan, setDefaultSubscription,
        rememberDelegatee, rememberSubscriptionAuthority, rememberDelegation,
        rememberMint, rememberPlan, rememberSubscription,
        clearSavedValues]);

    return <SavedValuesContext.Provider value={ctx}>{children}</SavedValuesContext.Provider>;
}

export function useSavedValues() {
    const ctx = useContext(SavedValuesContext);
    if (!ctx) throw new Error('useSavedValues must be used inside SavedValuesProvider');
    return ctx;
}
