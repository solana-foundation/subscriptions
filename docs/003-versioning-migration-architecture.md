# 003 - Versioning & Migration Architecture

## Context

On-chain accounts persist indefinitely. When the program upgrades and struct layouts change,
existing accounts must be migrated. The system provides a three-tier fallback chain,
from fully transparent to worst-case manual intervention.

## Migration Fallback Chain

```mermaid
flowchart TD
    A[Account version < CURRENT] --> B{Lazy update possible?}
    B -- yes --> C[Tier 1: Lazy update, transparent to user]
    B -- no --> D{Explicit migrate IX exists?}
    D -- yes --> E[Tier 2: User calls migrate instruction]
    D -- no --> F[Tier 3: User must revoke/close and recreate account]

    C --> G[Account at CURRENT_VERSION]
    E --> G
    F --> H[New account created at CURRENT_VERSION]
```

### Tier 1 - Lazy update (transparent)

Triggered automatically during normal instructions (transfer, cancel, revoke).
Transforms raw bytes in-place without realloc or extra accounts.

- **When**: field value transforms, new fields fitting in existing padding
- **User experience**: seamless, no extra action needed
- **Error on failure**: falls through to Tier 2/3

### Tier 2 - Explicit migration instruction (user action required)

A dedicated `migrate` instruction the user must call. Has access to additional
accounts and can perform realloc, create new PDAs, or do cross-account changes.

- **When**: account size increase, new associated PDAs, layout incompatible with in-place transform
- **User experience**: UI prompts user to sign a migrate transaction
- **Error**: `MigrationRequired` - signals the user must call the migrate IX
- **Note**: this instruction does not exist yet, it will be added when the first
  migration that needs it arises

### Tier 3 - Account recreation (worst case)

When neither lazy nor explicit migration can bring the account to the current version,
the user must revoke/close the old delegation or subscription and create a new one.

- **When**: fundamental schema incompatibility, deprecated account type, corrupted data
- **User experience**: UI explains the account cannot be migrated and guides recreation
- **Error**: `NeedsAccountRecreate` - signals the account must be closed and recreated
- **Note**: this error code does not exist yet, it will be added when the first
  migration that needs it arises. Currently `MigrationRequired` covers both Tier 2
  and Tier 3 since no migrations exist yet (CURRENT_VERSION == 1)

## Module Structure

```
state/
  versioning/
    mod.rs          # CURRENT_VERSION, check_and_update_version, try_lazy_update, check_min_account_size
    v1_to_v2.rs     # Stub: lazy_update + migrate for future v1->v2 transition
```

## Dispatcher Flow

```mermaid
flowchart TD
    A[check_and_update_version] --> B{data too short?}
    B -- yes --> C[Err InvalidAccountData]
    B -- no --> D{version == CURRENT?}
    D -- yes --> E[Ok fast path]
    D -- no --> F{version > CURRENT?}
    F -- yes --> G[Err DelegationVersionMismatch]
    F -- no --> H[try_lazy_update]
    H --> I{match arm exists for version?}
    I -- yes --> J[run migration chain v->v+1->...->CURRENT]
    J --> K[write CURRENT_VERSION to data]
    K --> E
    I -- no --> L[Err MigrationRequired]
```

## Account Header Layout

All delegation accounts (FixedDelegation, RecurringDelegation, SubscriptionDelegation) share a
common `Header` where:

- Byte 0: `discriminator` (identifies the account type via `AccountDiscriminator`)
- Byte 1: `version` (the schema version checked by `check_and_update_version`)
- Byte 2: `bump` (PDA bump seed)
- Bytes 3--34: `delegator`
- Bytes 35--66: `delegatee`
- Bytes 67--98: `payer`
- Bytes 99--106: `init_id`

The version check reads `data[VERSION_OFFSET]` (byte 1), not byte 0.
`SubscriptionAuthority` and `Plan` accounts have their own layouts but also store a discriminator at
byte 0; versioning currently applies only to delegation accounts that use the shared `Header`.

## Instruction Integration

Version check runs **before** struct loading, on raw bytes:

```mermaid
sequenceDiagram
    participant IX as Instruction
    participant V as check_and_update_version

    IX->>IX: borrow_mut account data
    IX->>V: &mut raw_bytes
    alt version == CURRENT
        V-->>IX: Ok (no-op, data unchanged)
    else version < CURRENT and lazy update exists
        V->>V: migrate bytes in-place
        V-->>IX: Ok (data updated to CURRENT)
    else version < CURRENT and no lazy update
        V-->>IX: Err (MigrationRequired)
    end
    IX->>IX: load typed struct from data
```

Normal instructions (transfer, create) use exact-size `load`/`load_mut`.
Defensive instructions (revoke, cancel) use `load_with_min_size`/`load_mut_with_min_size`
so users can always reclaim funds from old-version accounts.

## Adding a New Version

1. Bump `CURRENT_VERSION` in `versioning/mod.rs`
2. Implement `lazy_update` in `vN_to_vN+1.rs`
3. Add match arm in try_lazy_update dispatcher: `N => { vN_to_vN1::lazy_update(data)?; v = N+1; }`
4. If lazy isn't possible, return `MigrationRequired` from `lazy_update` (Tier 2)
5. Add explicit `migrate` instruction if needed
6. If neither lazy nor explicit works, add `NeedsAccountRecreate` error (Tier 3)
7. Update tests

## Error Semantics

| Error                       | Tier | When                                                        | User Action               |
| --------------------------- | ---- | ----------------------------------------------------------- | ------------------------- |
| `Ok`                        | -    | version == CURRENT or lazy migration succeeded              | None                      |
| `DelegationVersionMismatch` | -    | version > CURRENT (program downgrade)                       | Use newer program         |
| `MigrationRequired`         | 2    | version < CURRENT, no lazy path, explicit migrate IX exists | Call migrate instruction  |
| `NeedsAccountRecreate`      | 3    | no migration path at all (future)                           | Revoke/close and recreate |
| `InvalidAccountData`        | -    | data too short for version byte                             | Account corrupted         |

**Note**: `NeedsAccountRecreate` is not yet implemented. Currently `MigrationRequired`
covers both Tier 2 and Tier 3 since CURRENT_VERSION == 1 and no migrations exist.
When the first Tier 3 scenario arises, add the error code and split the handling.

## Size Check: check_min_account_size

Replaces strict `bytes.len() != Self::LEN` with `bytes.len() < Self::LEN`.

When `Self::LEN` grows in a new version, old accounts (smaller) would fail the strict check,
trapping rent lamports. The minimum-size check allows old accounts to load safely,
combined with `check_and_update_version` to ensure schema compatibility.

### Recovery (revoke) is version-agnostic

The delegation/subscription structs are **append-only**: later versions add fields at the end,
so `Self::LEN` may grow but never shrinks (`const`-asserted `Self::LEN >= V1_LEN`). Each closable
struct exposes a frozen `V1_LEN` — the first on-chain version's length — which is the minimum
length at which every original field is present.

Recovery's read loader, `load_with_min_size`, gates on `V1_LEN` (not `Self::LEN`), copies the
account into a zero-padded `Self::LEN` buffer, and returns an owned value. So an account from an
older, smaller version (length in `V1_LEN..Self::LEN`) reads its not-yet-written trailing fields
as zero, and a newer, larger account is truncated to `Self::LEN`. **Invariant:** recovery must
read only first-version fields, so those zeros are inert; never make a close decision depend on a
field added after `V1_LEN`.

Recovery paths (`revoke_delegation`, `revoke_abandoned_delegation`,
`revoke_abandoned_subscription`) therefore do **not** gate on `check_and_update_version`: a
delegation or subscription stays closable on any version, and the delegator/sponsor can always
reclaim rent without a prior migration. The mutable loader (`load_mut_with_min_size`) keeps the
exact `Self::LEN` gate, since transfer paths mutate the full current struct (and migrate first via
`check_and_update_version`).
