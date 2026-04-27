import type { NextConfig } from 'next';
import { resolve } from 'path';

const nextConfig: NextConfig = {
    transpilePackages: ['@subscriptions/client'],
    turbopack: {
        root: resolve(process.cwd(), '../..'),
    },
};

export default nextConfig;
