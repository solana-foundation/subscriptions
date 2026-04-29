/**
 * Generates TypeScript and Rust clients from the Codama IDL.
 *
 * Renderer versions:
 *  - @codama/renderers-rust v1 (legacy API: `(generatedDir, { crateFolder })`)
 *    Pinned to v1 deliberately — v3 generates code that requires bumping the
 *    Rust client's solana-* deps to ~3.x; out of scope for this migration.
 *  - @codama/renderers-js v2 (new API: `(packageDir, { generatedFolder })`)
 */

import type { AnchorIdl } from '@codama/nodes-from-anchor';
import { renderVisitor as renderJavaScriptVisitor } from '@codama/renderers-js';
import { renderVisitor as renderRustVisitor } from '@codama/renderers-rust';
import { createFromJson } from 'codama';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import { preserveConfigFiles } from './lib/utils';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const projectRoot = path.join(__dirname, '..');
const idlPath = path.join(projectRoot, 'idl', 'subscriptions.json');
const idl = JSON.parse(fs.readFileSync(idlPath, 'utf-8')) as AnchorIdl;
const rustClientsDir = path.join(projectRoot, 'clients', 'rust');
const typescriptClientsDir = path.join(projectRoot, 'clients', 'typescript');

const codama = createFromJson(JSON.stringify(idl));

const cargoToml = preserveConfigFiles(rustClientsDir);

void codama.accept(
    renderRustVisitor(path.join(rustClientsDir, 'src', 'generated'), {
        crateFolder: rustClientsDir,
        deleteFolderBeforeRendering: true,
        formatCode: true,
    }),
);

cargoToml.restore();

void codama.accept(
    renderJavaScriptVisitor(typescriptClientsDir, {
        generatedFolder: 'src/generated',
        deleteFolderBeforeRendering: true,
        formatCode: true,
    }),
);
