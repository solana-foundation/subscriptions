import { useEffect, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router';
import { useCluster } from '@solana/connector/react';
import { Button } from '@solana/design-system';
import { ChevronDown, Menu, RotateCcw, Settings2 } from 'lucide-react';

import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuLabel,
    DropdownMenuSeparator,
    DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { CURRENT_PROGRAM_VERSION } from '@subscriptions/client';
import solanaLogo from '@/assets/solana-logo.svg';
import { cn } from '@/lib/utils';

import { NAV_ITEMS, type NavItem } from './nav-items';
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

function isActive(pathname: string, path: string): boolean {
    return path === '/' ? pathname === '/' : pathname.startsWith(path);
}

function NavLinks({ items, pathname }: { items: NavItem[]; pathname: string }) {
    return (
        <>
            {items.map(item => {
                if (item.children?.length) {
                    return <NavParent key={item.path} item={item} pathname={pathname} />;
                }
                const active = isActive(pathname, item.path);
                return (
                    <Link
                        key={item.path}
                        to={item.path}
                        className={cn(
                            'rounded-full px-3 py-2 text-sm font-medium transition-colors',
                            active
                                ? 'text-foreground bg-sand-200'
                                : 'text-sand-1100 hover:text-foreground hover:bg-sand-100',
                        )}
                    >
                        {item.label}
                    </Link>
                );
            })}
        </>
    );
}

function NavParent({ item, pathname }: { item: NavItem; pathname: string }) {
    const active = isActive(pathname, item.path) || item.children?.some(c => isActive(pathname, c.path));
    return (
        <DropdownMenu>
            <DropdownMenuTrigger
                className={cn(
                    'inline-flex items-center gap-1 rounded-full px-3 py-2 text-sm font-medium transition-colors outline-none',
                    active ? 'text-foreground bg-sand-200' : 'text-sand-1100 hover:text-foreground hover:bg-sand-100',
                )}
            >
                {item.label}
                <ChevronDown className="h-3.5 w-3.5 opacity-60" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="w-48">
                <DropdownMenuItem asChild>
                    <Link to={item.path}>{item.label}</Link>
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                {item.children?.map(child => (
                    <DropdownMenuItem key={child.path} asChild>
                        <Link to={child.path} className="flex items-center gap-2">
                            <child.icon className="h-4 w-4" />
                            {child.label}
                        </Link>
                    </DropdownMenuItem>
                ))}
            </DropdownMenuContent>
        </DropdownMenu>
    );
}

export function AppHeader() {
    const { pathname } = useLocation();
    const { cluster } = useCluster();
    const [hasScrolled, setHasScrolled] = useState(false);

    useEffect(() => {
        function handleScroll() {
            const next = window.scrollY > 0;
            setHasScrolled(prev => (prev === next ? prev : next));
        }
        handleScroll();
        window.addEventListener('scroll', handleScroll, { passive: true });
        return () => window.removeEventListener('scroll', handleScroll);
    }, []);

    const filteredItems = NAV_ITEMS.filter(
        item => !item.clusterFilter || item.clusterFilter.includes(cluster?.id ?? ''),
    );

    return (
        <header
            className={cn(
                'fixed inset-x-0 top-0 z-40 border-b transition-colors duration-200',
                hasScrolled
                    ? 'bg-background/70 backdrop-blur-sm border-border-low/70'
                    : 'bg-transparent border-transparent',
            )}
        >
            <div className="mx-auto flex max-w-7xl items-center justify-between gap-4 px-6 py-4">
                <Link to="/" className="flex items-center gap-2 group">
                    <img src={solanaLogo} alt="Solana" className="h-6 w-6 shrink-0" />
                    <span className="text-foreground font-semibold text-lg tracking-tight">Subscriptions</span>
                    <span className="text-xs font-medium text-sand-900">v{CURRENT_PROGRAM_VERSION}</span>
                </Link>

                <nav className="hidden md:flex items-center gap-1">
                    <NavLinks items={filteredItems} pathname={pathname} />
                </nav>

                <div className="hidden md:flex items-center gap-2">
                    <TimeTravelButton />
                    <WalletButton />
                    <ClusterButton />
                </div>

                <div className="md:hidden flex items-center gap-2">
                    <ClusterButton />
                    <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                            <Button
                                aria-label="Open navigation menu"
                                iconLeft={<Menu />}
                                iconOnly
                                size="sm"
                                variant="secondary"
                            />
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end" className="w-56">
                            {filteredItems.map(item => (
                                <DropdownMenuItem key={item.path} asChild>
                                    <Link to={item.path} className="flex items-center gap-2">
                                        <item.icon className="h-4 w-4" />
                                        {item.label}
                                    </Link>
                                </DropdownMenuItem>
                            ))}
                            <DropdownMenuSeparator />
                            <div className="p-2 flex flex-col gap-2">
                                <TimeTravelButton />
                                <WalletButton />
                            </div>
                        </DropdownMenuContent>
                    </DropdownMenu>
                </div>
            </div>
        </header>
    );
}
