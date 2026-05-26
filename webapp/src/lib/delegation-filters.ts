export interface DelegationFilterItem {
    data: {
        mint: string;
    };
    type: 'Fixed' | 'Recurring';
}

export interface GroupedDelegationItems<T extends DelegationFilterItem> {
    all: T[];
    fixed: T[];
    recurring: T[];
}

export function filterDelegationsByMint<T extends DelegationFilterItem>(
    delegations: readonly T[],
    tokenMint: string,
): T[] {
    return delegations.filter(delegation => delegation.data.mint === tokenMint);
}

export function groupDelegations<T extends DelegationFilterItem>(delegations: readonly T[]): GroupedDelegationItems<T> {
    return {
        all: [...delegations],
        fixed: delegations.filter(delegation => delegation.type === 'Fixed'),
        recurring: delegations.filter(delegation => delegation.type === 'Recurring'),
    };
}

export function groupDelegationsByMint<T extends DelegationFilterItem>(
    delegations: readonly T[],
    tokenMint: string,
): GroupedDelegationItems<T> {
    return groupDelegations(filterDelegationsByMint(delegations, tokenMint));
}
