import react from '@vitejs/plugin-react';
import path from 'path';
import { defineConfig } from 'vite';

export default defineConfig({
    define: {
        'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'development'),
    },
    plugins: [react()],
    resolve: {
        alias: {
            '@': path.resolve(__dirname, './src'),
            '@idl': path.resolve(__dirname, '../idl/subscriptions.json'),
        },
        tsconfigPaths: true,
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
