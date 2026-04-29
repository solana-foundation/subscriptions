import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        testTimeout: 60000,
        hookTimeout: 60000,
        teardownTimeout: 60000,
        fileParallelism: false,
    },
});
