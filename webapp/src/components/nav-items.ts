import { Banknote, Calendar, ClipboardPen, Code2, Droplets, LayoutDashboard, ShoppingBag, Users } from 'lucide-react';
import { type LucideIcon } from 'lucide-react';

export interface NavItem {
    children?: NavItem[];
    clusterFilter?: string[];
    icon: LucideIcon;
    label: string;
    path: string;
}

export const NAV_ITEMS: NavItem[] = [
    { icon: LayoutDashboard, label: 'Dashboard', path: '/' },
    { icon: ShoppingBag, label: 'Marketplace', path: '/marketplace' },
    { icon: Users, label: 'Delegations', path: '/delegations' },
    { icon: Calendar, label: 'Subscriptions', path: '/subscriptions' },
    {
        children: [{ icon: Banknote, label: 'Collect Payments', path: '/plans/collect' }],
        icon: ClipboardPen,
        label: 'Plans',
        path: '/plans',
    },
    { clusterFilter: ['solana:localnet', 'solana:devnet'], icon: Droplets, label: 'Faucet', path: '/faucet' },
    { clusterFilter: ['solana:devnet', 'solana:testnet'], icon: Code2, label: 'Program', path: '/program' },
];
