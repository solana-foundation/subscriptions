# Transfer Context for Token-2022 Transfer Hooks

A transfer hook only sees the accounts token-2022 resolves for it, and none of
them record who asked for the transfer or under what authorization.

`TransferContext` is that record: on a pull against a hooked mint, the program
creates a PDA before the `TransferChecked` CPI and closes it after.

## Layout

PDA seeds `["TransferContext", subscription_authority]`, program
`De1egAFMkMWZSN5rYXRj9CAdheBamobVNubTsi9avR44`. Offsets are a wire contract:
append new fields behind a `version` bump, never move existing ones.

| Offset | Size | Field                                                        |
| ------ | ---- | ------------------------------------------------------------ |
| 0      | 1    | discriminator (`5`)                                          |
| 1      | 1    | version                                                      |
| 2      | 32   | initiator                                                    |
| 34     | 32   | delegation                                                   |
| 66     | 1    | delegation kind (`2` fixed, `3` recurring, `4` subscription) |

Nothing else: the mint is `Execute` account 1 and the amount is its
instruction data, both straight from token-2022.

The account lives only for the instruction that creates it. The initiator funds
the rent and gets it back on close. A hook should check the owner.

## Hook usage

Resolve it as an external PDA of the subscriptions program, which must appear
earlier in the validation list (here at `Execute` index 6):

```rust
ExtraAccountMeta::new_external_pda_with_seeds(
    6,
    &[
        Seed::Literal { bytes: b"TransferContext".to_vec() },
        Seed::AccountKey { index: 3 },
    ],
    false,
    false,
)?
```

Screening is the hook's job. Requiring the context makes it non-optional:
omitting it fails resolution before the hook runs. Per-initiator policy then
needs no `Execute` code beyond an owner check, since resolution does the work:

```rust
// allowlist PDA seeded from context.initiator
Seed::AccountData { account_index: 7, data_index: 2, length: 32 }

// the delegation account itself, forwarded so the hook can read its terms
PubkeyData::AccountData { account_index: 7, data_index: 34 }
```

`tests/transfer-hook-example` and
`tests/integration-tests/src/test_transfer_context.rs` implement both.

## Client

Callers pass the context writable, the initiator writable (it funds the rent),
and the system program. `@solana/subscriptions` does this automatically.

The account never exists for an RPC to read, so the SDK hands the resolver the
bytes the program is about to write (`buildPendingTransferContext`). Every
field is known client-side, so any hook seed over it resolves off-chain.
