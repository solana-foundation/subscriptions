import { useCluster } from '@solana/connector/react';
import { Button } from '@solana/design-system';
import { ChevronDown, Menu, RotateCcw, Settings2, X } from 'lucide-react';
import { useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router';

import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuLabel,
    DropdownMenuSeparator,
    DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { CURRENT_PROGRAM_VERSION } from '@subscriptions/client';

import { NAV_ITEMS } from './nav-items';
import { WalletButton } from './solana/solana-provider';
import { TimeTravelButton } from './time-travel/time-travel-button';

function ClusterButton() {
    const { cluster, clusters, setCluster } = useCluster();
    const navigate = useNavigate();

    return (
        <DropdownMenu>
            <DropdownMenuTrigger asChild>
                <Button
                    iconLeft={<Settings2 />}
                    iconRight={<ChevronDown className="opacity-60" />}
                    size="sm"
                    variant="secondary"
                >
                    {cluster?.label ?? 'Network'}
                </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-44">
                <DropdownMenuLabel>Network</DropdownMenuLabel>
                <DropdownMenuSeparator />
                {clusters.map(c => (
                    <DropdownMenuItem
                        key={c.id}
                        onClick={() => {
                            void setCluster(c.id);
                        }}
                    >
                        {c.label}
                    </DropdownMenuItem>
                ))}
                {import.meta.env.DEV && (
                    <>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem
                            onClick={() => {
                                localStorage.removeItem('setup-complete-localnet');
                                localStorage.removeItem('setup-complete-devnet');
                                localStorage.removeItem('setup-cluster');
                                navigate('/setup');
                            }}
                        >
                            <RotateCcw className="mr-2 h-4 w-4" />
                            Rerun setup
                        </DropdownMenuItem>
                    </>
                )}
            </DropdownMenuContent>
        </DropdownMenu>
    );
}

export function AppHeader() {
    const { pathname } = useLocation();
    const { cluster } = useCluster();
    const [showMenu, setShowMenu] = useState(false);
    const filteredItems = NAV_ITEMS.filter(
        item => !item.clusterFilter || item.clusterFilter.includes(cluster?.id ?? ''),
    );

    function isActive(path: string) {
        return path === '/' ? pathname === '/' : pathname.startsWith(path);
    }

    return (
        <header className="relative z-50 px-4 py-2 bg-neutral-100 dark:bg-neutral-900 dark:text-neutral-400">
            <div className="mx-auto flex justify-between items-center">
                <span className="text-xl md:hidden">
                    Subscriptions <span className="text-sm font-bold text-blue-400/60">v{CURRENT_PROGRAM_VERSION}</span>
                </span>

                <Button
                    aria-label={showMenu ? 'Close navigation menu' : 'Open navigation menu'}
                    className="md:hidden"
                    iconLeft={showMenu ? <X /> : <Menu />}
                    iconOnly
                    onClick={() => setShowMenu(!showMenu)}
                    size="lg"
                    variant="secondary"
                />

                <div className="hidden md:flex items-center gap-4 ml-auto">
                    <TimeTravelButton />
                    <WalletButton />
                    <ClusterButton />
                </div>

                {showMenu && (
                    <div className="md:hidden fixed inset-x-0 top-[52px] bottom-0 bg-neutral-100/95 dark:bg-neutral-900/95 backdrop-blur-sm">
                        <div className="flex flex-col p-4 gap-4 border-t dark:border-neutral-800">
                            <ul className="flex flex-col gap-4">
                                {filteredItems.map(({ label, path, icon: Icon, children }) => (
                                    <li key={path}>
                                        <Link
                                            className={`flex items-center gap-3 hover:text-neutral-500 dark:hover:text-white text-lg py-2 ${isActive(path) ? 'text-neutral-500 dark:text-white' : ''}`}
                                            to={path}
                                            onClick={() => setShowMenu(false)}
                                        >
                                            <Icon className="h-5 w-5" />
                                            {label}
                                        </Link>
                                        {children?.map(child => (
                                            <Link
                                                key={child.path}
                                                className={`flex items-center gap-3 ml-8 hover:text-neutral-500 dark:hover:text-white text-sm py-1.5 ${isActive(child.path) ? 'text-neutral-500 dark:text-white' : 'text-gray-500'}`}
                                                to={child.path}
                                                onClick={() => setShowMenu(false)}
                                            >
                                                <child.icon className="h-4 w-4" />
                                                {child.label}
                                            </Link>
                                        ))}
                                    </li>
                                ))}
                            </ul>
                            <div className="flex flex-col gap-4">
                                <TimeTravelButton />
                                <WalletButton />
                                <ClusterButton />
                            </div>
                        </div>
                    </div>
                )}
            </div>
        </header>
    );
}
