import { Toaster } from './ui/sonner';
import { AppHeader } from './app-header';

import { AppSidebar } from './app-sidebar';
import React from 'react';
import { ClusterChecker } from './cluster/cluster-ui';
import { AccountChecker } from './account/account-ui';

export function AppLayout({ children }: { children: React.ReactNode }) {
    return (
        <div className="flex min-h-screen">
            <AppSidebar />
            <div className="flex flex-col flex-grow min-w-0">
                <AppHeader />
                <main className="flex-grow w-full mx-auto p-4 overflow-x-hidden">
                    <ClusterChecker>
                        <AccountChecker />
                    </ClusterChecker>
                    {children}
                </main>
            </div>
            <Toaster />
        </div>
    );
}
