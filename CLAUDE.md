# CLAUDE.md

Solana program (Pinocchio, `no_std`) for token delegations + pull-payment
subscriptions, with Codama-generated Rust/TS clients and a demo webapp.
Build/test recipes: `just --list`. ADRs: `docs/00*.md`.

## Gotchas

**Wire format is not Anchor's.** Instruction discriminators are 1 byte, not
Anchor's 8. Events are the exception: emitted via self-CPI with Anchor's
`Sha256("anchor:event")[..8]` tag so indexers pick them up, followed by a
1-byte event discriminator. Any tool that assumes Anchor layout (IDL
converters, fuzzers, decoders) will mis-decode instructions; use raw
instruction calls or `clients/rust`.

**The IDL is a build-script side effect.** `program/build.rs` writes
`idl/subscriptions.json` only when `GENERATE_IDL=1` is set (`just
generate-idl` runs `cargo check` with it). A plain `cargo build` leaves a
stale IDL. `#[codama(...)]` attributes silently drift from the Rust types;
`just check-generated` is the only thing that catches it, and CI fails on it.

**Account versioning runs on raw bytes.** `check_and_update_version` must be
called before any typed struct load: a lazy migration can change the layout
under you. It also validates the kind byte first so a migration never mutates
a wrong-kind account.

**TS integration tests need two validator passes.** `just test-client` runs a
fork pass, then restarts surfpool with `--offline` for `*.offline.test.ts`.
Reason: surfpool forwards `getProgramAccounts` to public mainnet-beta, which
rejects it (-32603). Anything scanning program accounts belongs in an
`.offline.test.ts` file.

**surfpool-sdk's in-process VM cannot execute our `.so`.** For TS-side program
tests use node-litesvm, not the SDK VM.

**LiteSVM clock reads are not stable.** `current_ts()` is read more than once
per instruction, so period-boundary tests with tiny periods flake. Pin time
with the absolute `set_clock` helper instead of relative advances.

**No BigInt `toJSON` patch in the webapp.** A global patch was added once and
corrupted RPC request serialization (silent, took days to find). Serialize
bigints at the call site.

**`declare_id!` in `program/src/lib.rs` is parsed by `sed`** in the justfile
and scripts. Keep it a single literal line.

**Release order:** bump the version string before cutting buffers. v0.5.0
shipped `-beta.1` on-chain because the bump came after the freeze.

## Conventions

- Pinocchio, never `anchor-lang`. `AccountView`, `Address`, `ProgramResult`.
- `no_std` + `extern crate alloc`; `std` only under `#[cfg(test)]`.
- `mod.rs` holds declarations and re-exports only, no logic.
- PDA seeds live with the state struct; shared helpers in `state/common.rs`.
