import react from '@vitejs/plugin-react';
import path from 'path';
import { defineConfig } from 'vite';
import { nodePolyfills } from 'vite-plugin-node-polyfills';
import tsconfigPaths from 'vite-tsconfig-paths';

// https://vitejs.dev/config/
export default defineConfig({
    build: {
        rollupOptions: {
            onwarn(warning, warn) {
                // Suppress warnings about vite-plugin-node-polyfills/shims
                if (warning.message?.includes('vite-plugin-node-polyfills/shims')) {
                    return;
                }
                warn(warning);
            },
        },
    },
    optimizeDeps: {
        esbuildOptions: {
            define: {
                global: 'globalThis',
            },
        },
    },
    plugins: [
        nodePolyfills({
            globals: {
                Buffer: true,
                global: true,
                process: true,
            },
        }),
        react(),
        tsconfigPaths(),
    ],
    resolve: {
        alias: {
            '@': path.resolve(__dirname, './src'),
            '@idl': path.resolve(__dirname, '../idl/subscriptions.json'),
        },
    },
    server: {
        proxy: {
            '/rpc': {
                changeOrigin: true,
                rewrite: path => path.replace(/^\/rpc/, ''),
                target: 'http://localhost:8899',
            },
        },
    },
});
