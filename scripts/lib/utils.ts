import fs from 'fs';
import path from 'path';

interface ConfigPreserver {
    restore: () => void;
}

/**
 * Preserves the Rust client `Cargo.toml` while the v1 rust renderer wipes
 * the crate folder during regeneration.
 */
export function preserveConfigFiles(rustClientsDir: string): ConfigPreserver {
    const cargoPath = path.join(rustClientsDir, 'Cargo.toml');
    const tempPath = path.join(rustClientsDir, 'Cargo.toml.temp');
    const exists = fs.existsSync(cargoPath);

    if (exists) {
        fs.copyFileSync(cargoPath, tempPath);
    }

    return {
        restore: () => {
            if (!exists) return;
            try {
                fs.copyFileSync(tempPath, cargoPath);
                fs.unlinkSync(tempPath);
            } catch (error) {
                console.warn(`Warning: failed to restore Cargo.toml:`, (error as Error).message);
            }
        },
    };
}
