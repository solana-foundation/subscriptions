/** Delegation kind metadata for UI display. Maps to the on-chain AccountDiscriminator enum. */
export const DELEGATION_KINDS = {
    fixed: {
        id: 'fixed',
        label: 'Fixed',
        description: 'One-time delegation with a fixed total amount',
        icon: 'Coins', // lucide-react icon name
    },
    recurring: {
        id: 'recurring',
        label: 'Recurring',
        description: 'Periodic delegation with amount per time period',
        icon: 'RefreshCw', // lucide-react icon name
    },
    subscription: {
        id: 'subscription',
        label: 'Subscription',
        description: 'Plan-based recurring subscription delegation',
        icon: 'CalendarCheck',
    },
} as const;

export type DelegationKindId = keyof typeof DELEGATION_KINDS;
