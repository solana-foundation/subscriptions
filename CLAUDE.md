# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Required Versions

- **Rust**: See `rust-toolchain.toml` (auto-installed by rustup)
- **Node.js**: See `.nvmrc` (use `nvm use` or `fnm use`)
- **pnpm**: See `package.json` `packageManager` field

## Build Commands

```bash
# Full build (program .so → IDL → clients → TS client dist)
just build

# Individual steps
just generate-idl          # Generate IDL via Codama (cargo build with build.rs)
just generate-client       # Generate TypeScript + Rust clients from IDL
just build-program         # Build .so binary only (cargo build-sbf)
just build-client          # Build TypeScript client (tsup)

# Formatting and linting
just fmt                   # cargo fmt + prettier
just check                 # fmt-check + lint-check

# Testing
just test                  # All tests (program + client)
just unit-test             # Rust unit tests
just integration-test      # Rust LiteSVM integration tests
just test-program          # backwards-compatible alias for unit-test
just test-client           # Vitest against Surfpool
just test-and-benchmark    # CU report → cu_report.md

# Deployment
just deploy-idl-devnet     # Write IDL on-chain via program-metadata
just deploy-idl-mainnet
just verify-mainnet        # solana-verify against repo

# Dependencies
pnpm install               # all workspaces
```

## Architecture

Solana program using **Pinocchio** (lightweight `no_std` framework) with **Codama** for IDL-driven client generation.

### Code Flow

```
program/src/lib.rs (declares ID, dispatches via SubscriptionsInstruction enum)
    ↓
program/src/instructions/*.rs (instruction processors)
    ↓
program/src/state/*.rs (PDA account structs)
    ↓
program/src/event_engine.rs (self-CPI event emission)
```

### Client Generation Pipeline

```
Rust code with #[codama(...)] attributes
    ↓
program/build.rs → idl/subscriptions.json
    ↓
scripts/generate-clients.ts
    ↓
clients/rust/src/generated/        (auto-generated)
clients/typescript/src/generated/  (auto-generated; wrapped by hand-written SDK in src/)
```

### Architecture Decision Records

- [docs/001-program-architecture.md](docs/001-program-architecture.md) — Subscription Authority + delegations + PDA design
- [docs/002-subscriptions-architecture.md](docs/002-subscriptions-architecture.md) — Plans + pull-payment subscriptions
- [docs/003-versioning-migration-architecture.md](docs/003-versioning-migration-architecture.md) — Three-tier account versioning/migration
- [docs/004-program-upgrade-mechanism.md](docs/004-program-upgrade-mechanism.md) — Upgrade authority and deployment

### Key Modules

- `program/src/instructions/` — 14 instruction handlers + `helpers/` (validation, token ops, traits)
- `program/src/state/` — Account structs (SubscriptionAuthority, FixedDelegation, RecurringDelegation, Plan, Subscription) + `versioning/`
- `program/src/events/` — Event structs and self-CPI emission
- `program/src/errors.rs` — Error codes (ranges 100-699)
- `program/src/event_engine.rs` — Self-CPI dispatcher for events

### Testing

- Rust unit tests: located in `program/src/tests/`. Run via `just unit-test`.
- Rust integration tests: LiteSVM-based workspace crate in `tests/integration-tests/`. Run via `just integration-test`.
- TypeScript: Vitest against Surfpool, in `clients/typescript/test/`. Includes Squads + Swig smart-wallet integration tests and security-focused tests.
- CU benchmarks: set `CU_REPORT=1` to write `cu_report.md` (posted as PR comment in CI).

### Program ID

`De1egAFMkMWZSN5rYXRj9CAdheBamobVNubTsi9avR44`

## Audit Status

Audited by Cantina. See [audits/AUDIT_STATUS.md](audits/AUDIT_STATUS.md) for the baseline commit, fix-verified commit, and verification commands. Audit report PDF is in `audits/`.

## Workspace Structure

- `program/` — Pinocchio program (workspace member `subscriptions-program`)
- `clients/rust/` — Codama-generated Rust client (`subscriptions`)
- `clients/typescript/` — Hand-written SDK wrapping Codama-generated TS (`@solana/subscriptions`)
- `webapp/` — Vite + React 19 + Node API demo (faucet, deploy wizard, marketplace)
- `docs/` — Numbered ADRs
- `audits/` — Audit report and AUDIT_STATUS.md
- `runbooks/` — txtx Surfpool deployment runbooks
- `scripts/` — Validator + webapp shell scripts

## Conventions

- **Pinocchio, not Anchor**: do not introduce `anchor-lang`. Use `pinocchio::AccountView`, `Address`, `ProgramResult`.
- **No `mod.rs` business logic**: only module declarations and re-exports.
- **PDA seeds co-located with state**: each state struct exposes its seed pattern; helpers live in `state/common.rs`.
- **Codama attributes drive IDL**: keep `#[codama(...)]` macros in sync with Rust types — `just generate-idl && git diff` catches drift.
