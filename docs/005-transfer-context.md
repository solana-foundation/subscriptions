# Transfer Context for Token-2022 Transfer Hooks

During a pull against a mint with an active transfer hook, the program publishes
an ephemeral `TransferContext` PDA: who initiated the pull and which delegation
authorizes it, the two facts `Execute` does not already carry. It is created
before the `TransferChecked` CPI and closed after it returns.

## Address

`["TransferContext", subscription_authority]`, program
`De1egAFMkMWZSN5rYXRj9CAdheBamobVNubTsi9avR44`. A hook resolves it as an external
PDA of the subscriptions program, which must appear earlier in its
`ExtraAccountMetaList`.

## Layout

Offsets are a wire contract. New fields are appended at the tail behind a
`version` bump; existing fields never move.

| Offset | Size | Field                                                        |
| ------ | ---- | ------------------------------------------------------------ |
| 0      | 1    | discriminator (`5`)                                          |
| 1      | 1    | version                                                      |
| 2      | 32   | initiator                                                    |
| 34     | 32   | delegation                                                   |
| 66     | 1    | delegation kind (`2` fixed, `3` recurring, `4` subscription) |

The mint arrives as `Execute` account index 1 and the amount as its instruction
data, so neither is duplicated here.

## Use

Screening is the hook's job. A hook that requires the context makes it
non-optional: when the caller omits it, resolution fails and the transfer aborts
before the hook runs. It should also check the account is owned by the
subscriptions program.

Both pubkeys are usable without code in the hook's `Execute`. A
`Seed::AccountData` meta over the initiator bytes resolves a per-initiator
policy PDA; a `PubkeyData::AccountData` meta over the delegation bytes has the
delegation account itself forwarded, terms readable.
`tests/integration-tests/src/test_transfer_context.rs` implements both.

## Client

Callers pass the context writable, the initiator writable to fund the rent, and
the system program among the hook accounts. `@solana/subscriptions` does this
automatically. The account cannot be fetched before it exists, so the SDK hands
the resolver the bytes the program is about to write
(`buildPendingTransferContext`). Mints without a transfer hook are unaffected.
