import type { Metadata } from 'next';
import { Analytics } from '@vercel/analytics/next';
import './globals.css';
import '@solana/wallet-adapter-react-ui/styles.css';
import { Providers } from '@/components/Providers';

export const metadata: Metadata = {
    title: 'Subscriptions Dev Tool',
    description: 'Developer tool for direct on-chain interaction with the Subscriptions program',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
    return (
        <html lang="en" className="dark">
            <body>
                <Providers>{children}</Providers>
                <Analytics />
            </body>
        </html>
    );
}
