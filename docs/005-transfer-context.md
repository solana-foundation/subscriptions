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

The account only exists during a pull. A hook derives it from the `Execute`
authority, and ordinary wallets have none, so on any other transfer of the mint
the address still resolves but the account is empty and system-owned.

Resolve every account the hook needs from fixed seeds, then decide in
`Execute`: a context owned by the subscriptions program carrying discriminator
`5` is a pull, anything else is a normal transfer that the hook lets through.
Check the owner, not just the contents; the address is derivable by anyone.

Do not seed a meta from the context's data (`Seed::AccountData`,
`PubkeyData::AccountData`). Resolution reads bytes that are absent outside a
pull, so the mint stops accepting any transfer that is not a subscriptions one.

`tests/transfer-hook-example` implements the branch and
`tests/integration-tests/src/test_transfer_context.rs` covers it.

## Client

Callers pass the context writable, the initiator writable to fund the rent, and
the system program among the hook accounts. `@solana/subscriptions` does this
automatically. The account cannot be fetched before it exists, so the SDK hands
the resolver the bytes the program is about to write
(`buildPendingTransferContext`). Mints without a transfer hook are unaffected.
