# Transfer Context for Token-2022 Transfer Hooks

Token-2022 hands a transfer hook the transfer authority, which for a subscriptions pull is the `SubscriptionAuthority` PDA. The delegate that initiated the pull appears nowhere in the `Execute` accounts, and it cannot be added by the caller: token-2022 forwards only the accounts its `ExtraAccountMetaList` resolves, and the resolver's seed sources (literals, instruction data, other resolved account keys and their data) contain nothing that identifies the delegate.

`TransferContext` closes that gap. On a pull against a mint with an active transfer hook, the program creates a PDA describing the in-flight transfer, writes it before the `TransferChecked` CPI, and closes it after the CPI returns. A hook resolves it by seeds and reads the initiator from it.

## Address

```
["TransferContext", subscription_authority]        program: De1egAFMkMWZSN5rYXRj9CAdheBamobVNubTsi9avR44
```

In an `ExtraAccountMetaList` this is an external PDA whose owning program appears earlier in the list:

```rust
ExtraAccountMeta::new_with_pubkey(&SUBSCRIPTIONS_PROGRAM_ID, false, false)?,   // Execute index 6
ExtraAccountMeta::new_external_pda_with_seeds(
    6,
    &[
        Seed::Literal { bytes: b"TransferContext".to_vec() },
        Seed::AccountKey { index: 3 },                                        // transfer authority
    ],
    false,
    false,
)?,
```

## Layout

Offsets are a wire contract. New fields are appended at the tail behind a `version` bump; existing fields never move.

| Offset | Size | Field                                                        |
| ------ | ---- | ------------------------------------------------------------ |
| 0      | 1    | discriminator (`6`)                                          |
| 1      | 1    | version                                                      |
| 2      | 1    | bump                                                         |
| 3      | 32   | initiator: the delegate that authorized the pull             |
| 35     | 32   | delegation: the delegation account backing the pull          |
| 67     | 1    | delegation kind (`2` fixed, `3` recurring, `4` subscription) |
| 68     | 32   | mint                                                         |
| 100    | 8    | amount (u64 LE)                                              |
| 108    | 8    | slot (u64 LE)                                                |

## Lifetime

The account exists only between its creation and the end of the transfer instruction that created it, so a hook that sees it can treat its contents as describing the transfer currently executing. It is funded by the initiator and the rent returns to the initiator on close.

A hook should still check that the account is owned by the subscriptions program, and may check `amount` against the amount it was invoked with.

## Enforcement

Screening is the hook's job, not the program's. A hook that requires the context makes it non-optional: when the caller omits it, resolution fails with `IncorrectAccount` and the transfer aborts before the hook runs.

Per-initiator policy needs no code in the hook's `Execute` beyond an ownership check. Derive the policy account from the initiator bytes and let resolution do the work:

```rust
ExtraAccountMeta::new_with_seeds(
    &[
        Seed::Literal { bytes: b"allow".to_vec() },
        Seed::AccountData { account_index: 7, data_index: 3, length: 32 },   // context.initiator
    ],
    false,
    false,
)?
```

`tests/transfer-hook-example` and `tests/integration-tests/src/test_transfer_context.rs` implement exactly this.

## Client

Callers must pass the context account **writable**, mark the initiator (delegatee or plan caller) writable so it can fund the rent, and include the system program among the hook accounts. `@solana/subscriptions` does this automatically in `transferFixed`, `transferRecurring`, and `transferSubscription`.

Because the account cannot be fetched before it exists, the SDK hands the resolver the bytes the program is about to write (`buildPendingTransferContext`). `slot` is not known client-side and is encoded as zero, so hook seeds over `slot` cannot be resolved off-chain.

Mints without a transfer hook are unaffected: no context account is created, and pull instructions keep their current account lists.
