# Transfer Context for Token-2022 Transfer Hooks

A transfer hook only sees the accounts token-2022 resolves for it, and those
carry no record of who asked for the transfer or under what authorization. A
hook that wants to screen on that has nothing to read.

`TransferContext` is that record. On a pull against a mint with an active
transfer hook, the program creates a PDA describing the in-flight transfer
before the `TransferChecked` CPI and closes it after the CPI returns. A hook
resolves it by seeds and reads what it needs.

## Address

```
["TransferContext", subscription_authority]        program: De1egAFMkMWZSN5rYXRj9CAdheBamobVNubTsi9avR44
```

In an `ExtraAccountMetaList` this is an external PDA whose owning program
appears earlier in the list:

```rust
ExtraAccountMeta::new_with_pubkey(&SUBSCRIPTIONS_PROGRAM_ID, false, false)?,
ExtraAccountMeta::new_external_pda_with_seeds(
    6,
    &[
        Seed::Literal { bytes: b"TransferContext".to_vec() },
        Seed::AccountKey { index: 3 },
    ],
    false,
    false,
)?,
```

## Layout

Offsets are a wire contract. New fields are appended at the tail behind a
`version` bump; existing fields never move.

| Offset | Size | Field                                                        |
| ------ | ---- | ------------------------------------------------------------ |
| 0      | 1    | discriminator (`6`)                                          |
| 1      | 1    | version                                                      |
| 2      | 32   | initiator                                                    |
| 34     | 32   | delegation                                                   |
| 66     | 1    | delegation kind (`2` fixed, `3` recurring, `4` subscription) |

The context carries only what a hook cannot get from `Execute` itself. The mint
arrives as `Execute` account index 1 and the amount as its instruction data,
both from token-2022, so duplicating them here would only add a copy a hook has
less reason to trust.

## Lifetime

The account exists only for the duration of the transfer instruction that
creates it, so a hook that sees it can treat its contents as describing the
transfer currently executing. The initiator funds the rent and gets it back on
close.

A hook should still check that the account is owned by the subscriptions
program.

## Enforcement

Screening is the hook's job, not the program's. A hook that requires the
context makes it non-optional: when the caller omits it, resolution fails and
the transfer aborts before the hook runs.

Per-initiator policy needs no code in the hook's `Execute` beyond an ownership
check. Derive the policy account from the context and let resolution do the
work:

```rust
ExtraAccountMeta::new_with_seeds(
    &[
        Seed::Literal { bytes: b"allow".to_vec() },
        Seed::AccountData { account_index: 7, data_index: 2, length: 32 },
    ],
    false,
    false,
)?
```

`tests/transfer-hook-example` and
`tests/integration-tests/src/test_transfer_context.rs` implement this.

## Client

Callers must pass the context account writable, mark the initiator writable so
it can fund the rent, and include the system program among the hook accounts.
`@solana/subscriptions` does this automatically in the transfer instructions.

Because the account cannot be fetched before it exists, the SDK hands the
resolver the bytes the program is about to write
(`buildPendingTransferContext`). Every field is known client-side, so any hook
seed over the context resolves off-chain.

Mints without a transfer hook are unaffected.
