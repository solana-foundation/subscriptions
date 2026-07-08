# ADR-002: Subscriptions Subscriptions (Plan Track)

**Status:** Implemented

**Parent ADR:** ADR-001 - Subscriptions Program Architecture

## Context

ADR-001 implements a direct delegation model where delegators create Delegation PDAs with embedded terms for each delegatee. This works well for P2P, one-off, and bespoke delegations. However, subscription-based services and mass-market scenarios benefit from an additional pattern where:

**Both parties agree to terms in advance** - The merchant publishes immutable terms, subscribers verify and accept them.

**Use Cases:**

1. **Subscription Services**: Netflix, Spotify, or any SaaS where:
    - Merchants publish pricing plans once for all customers
    - Many users voluntarily subscribe to the same pre-verified terms
    - Terms remain immutable to establish trust

2. **Recurring Billing Platforms**: Payment processors where:
    - Merchants want centralized plan management
    - Subscribers independently verify terms before subscribing
    - Mutual agreement on pricing prevents disputes

3. **Marketplace Ecosystems**: DeFi or NFT platforms where:
    - Service providers publish standardized offerings
    - Users discover and subscribe via UI/SDK with term verification
    - Plan registries enable discoverability

**This is an Enhancement, Not Replacement:**

- ADR-001 flows remain fully available and intact
- Plans are built on top of the existing delegation structure
- Both models can coexist and are selected per use case
- Delegators always maintain their direct delegation capabilities

## Decision

Extend ADR-001 with a **Plan-based subscription layer** that:

1. Allows delegatees to publish reusable, immutable terms as Plans
2. Lets delegators subscribe to Plans, creating Delegation PDAs that reference the Plan
3. Uses the same Subscription Authority (SA) and transfer flows from ADR-001
4. Adds mutual agreement verification: delegators verify Plan terms before subscribing

### Architecture Overview

ADR-002 is an **add-on** to ADR-001 that introduces Plans while reusing all existing delegation infrastructure:

```mermaid
graph TB
    subgraph "ADR-001 Core Infrastructure (Always Available)"
        User[Alice] -->|initialize_subscription_authority| SA[SubscriptionAuthority PDA<br/>u64::MAX approval]
        SA -.->|Used by| TransferFlows[Transfer Flows]

        subgraph "Direct Delegations (ADR-001)"
            SA -->|create_fixed_delegation| FD[FixedDelegation PDA<br/>Embedded terms]
            SA -->|create_recurring_delegation| RD[RecurringDelegation PDA<br/>Embedded terms]
        end
    end

    subgraph "ADR-002 Add-On: Plan-Based Subscriptions"
        Merchant[Merchant] -->|create_plan| Plan[Plan PDA<br/>Immutable terms]
        A2[Alice] -->|subscribe| SD1[Subscription Delegation PDA<br/>References Plan]
        B2[Bob] -->|subscribe| SD2[Subscription Delegation PDA<br/>References Plan]
        Plan -.-> SD1 & SD2
    end

    subgraph "Unified Execution (Same for Both)"
        SD1 -->|pull| TransferFlows
        SD2 -->|pull| TransferFlows
        FD -->|pull| TransferFlows
        RD -->|pull| TransferFlows
        TransferFlows -->|validates constraints| SA
        SA -->|transfers| TokenProg[Token Program]
    end
```

**Key Design Principles:**

1. **Add-On, Not Replacement**: ADR-002 extends ADR-001 without modifying core flows
2. **Mutual Agreement**: Plans enable both parties to verify and agree on terms before commitment
3. **Immutable Terms**: Once published, Plan terms cannot change (prevents mid-stream price hikes)
4. **Separate Controls vs Terms**: `update_plan` can modify status, end_ts, pullers, metadata_uri - but NOT core terms (mint, terms.amount, terms.period_hours, terms.created_at, destinations)
5. **Unified Execution**: Subscriptions and direct delegations share the same SA and transfer flows
6. **Coexistence**: Direct delegations (ADR-001) and subscriptions (ADR-002) operate simultaneously

### Rationale

**Why Add Plans to ADR-001?**

ADR-001 provides the core delegation infrastructure. Plans add a subscription model on top with these benefits:

1. **Mutual Term Agreement**
    - Both delegator and delegatee verify the same immutable Plan terms
    - Establishes clear, shared understanding before commitment
    - Prevents disputes - terms are visible to all parties

2. **Cost Efficiency for Merchants (Delegatees)**
    - One Plan PDA serves infinite subscribers
    - Per-subscriber cost is only the Delegation PDA (much smaller than Plan)
    - Example: 10K subscribers = 10K Delegation PDAs + 1 Plan (vs 10K separate delegations if using embedded terms

3. **Trust Model Through Immutability**
    - Merchants commit to terms via immutable Plan
    - Subscribers verify Plan terms before subscribing
    - No fear of arbitrary price changes mid-subscription
    - Builds trust for subscription-heavy use cases

4. **Discoverability and Ecosystem Growth**
    - Merchants publish Plans with metadata URIs (images, descriptions)
    - Plan discovery via `getProgramAccounts` and filtering
    - Enables subscription marketplaces and aggregators
    - Supports frontend SDKs for user-friendly subscription flows

5. **Management Flexibility**
    - `update_plan` allows:
        - Set status to Sunset (stop accepting new subscribers; effectively terminal — status/end_ts/metadata can no longer change, though the owner may still remove existing pullers; requires non-zero end_ts)
        - Shorten a finite end_ts (graceful discontinuation; a finite end_ts can never be extended or cleared — `PlanEndTsCannotExtend`; 0 is valid only when the plan already has no expiry)
        - Update pullers array (change authorized callers)
        - Update metadata_uri (change plan description/branding)
    - Without modifying core terms (mint, terms, destinations)
    - `delete_plan` allows the owner to reclaim rent after a plan has expired (end_ts has passed)

6. **Zero Breaking Changes to ADR-001**
    - All direct delegation flows continue working unchanged
    - Transfer logic is reused with Plan-provided terms instead of embedded terms
    - `pullers` array configures authorization without modifying core transfer validation
    - Both models use the same SubscriptionAuthority PDA infrastructure

7. **Opt-In Enhancement**
    - Use ADR-001 for: P2P, ad-hoc, customized delegations
    - Use ADR-002 for: Subscriptions, mass-market, standardized services
    - Users choose the approach that fits their use case

### Comparison to Direct Delegation

| Aspect                 | ADR-001 Direct Delegation                              | ADR-002 Plan Subscriptions                                                                                                                                                                     |
| ---------------------- | ------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Creation**           | Delegator initiates                                    | Delegatee publishes, delegators subscribe                                                                                                                                                      |
| **Terms Storage**      | Embedded per delegation                                | Single Plan for all                                                                                                                                                                            |
| **Cost Structure**     | Full cost per delegation                               | Plan cost (1x) + Delegation cost (Nx)                                                                                                                                                          |
| **Term Mutability**    | Per delegation                                         | Core billing terms (amount, period_hours, created_at) immutable and snapshotted per subscription; pullers, status, end_ts, metadata_uri mutable                                                |
| **Discoverability**    | Manual PDA sharing                                     | Plans can be discovered/marketplace                                                                                                                                                            |
| **Use Cases**          | P2P, custom, one-off                                   | Subscription services, SaaS, platforms                                                                                                                                                         |
| **Pull Authorization** | Delegatee-only (`transfer_fixed`/`transfer_recurring`) | Owner + configurable pullers array (`transfer_subscription`)                                                                                                                                   |
| **Cancellability**     | Not implemented (add later)                            | `cancel_subscription` pre-computes expiration at end of current period, `resume_subscription` clears a pending cancellation, and `revoke_delegation` closes after expiration. Plan can sunset. |

### Integration With ADR-001

ADR-002 is built **on top of** ADR-001's core infrastructure with **zero changes to existing flows**:

**Key Insight: Terms are Snapshotted at Subscribe Time**

When a subscriber subscribes, the plan's `PlanTerms` (amount, period_hours, created_at) are copied into the `SubscriptionDelegation` PDA. At transfer time, `transfer_subscription` reads billing terms from the subscription's snapshot and validates them against the live plan via `check_plan_terms()`. This prevents ghost-account attacks where a merchant deletes and recreates a plan at the same PDA address with different terms.

| Flow                            | Terms Storage                                                    | Transfer Reads From                                                               |
| ------------------------------- | ---------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| **Direct Delegation (ADR-001)** | Terms embedded in Delegation PDA                                 | Delegation PDA only                                                               |
| **Subscription (ADR-002)**      | Terms snapshotted in SubscriptionDelegation + stored in Plan PDA | Subscription PDA (billing terms) + Plan PDA (authorization, destinations, expiry) |

**What SubscriptionDelegation Stores:**

- `header` (delegator = subscriber, delegatee = plan_pda, payer = rent payer: the subscriber, or a sponsor when provided, `init_id` = the subscriber's SubscriptionAuthority incarnation at subscribe time) — `resume`/abandon paths compare this `init_id` against the live authority to detect a stale (closed-and-reinitialized) authority
- `terms` - snapshot of plan's PlanTerms (amount, period_hours, created_at)
- `amount_pulled_in_period` - tracking for the current billing period
- `current_period_start_ts` - start of the current billing period
- `expires_at_ts` - cancellation timestamp (0 = active)

**What Plans Provide at Transfer Time:**

- `terms` - validated against subscription's snapshot via `check_plan_terms()`
- `destinations` - whitelisted receiver addresses
- `pullers` - authorized caller addresses
- `mint` - token mint for validation
- `end_ts` - plan expiration

**The Plan is Just a Reusable container for terms:**

- Plan = Published, reusable terms that delegators can subscribe to
- Subscribe = Create a Delegation PDA with a snapshot of the Plan's terms
- After subscription, the Delegation works exactly like ADR-001 delegations

**Subscription Uses a Dedicated Transfer Instruction:**

- Direct delegations use `transfer_fixed` or `transfer_recurring`
- Subscriptions use `transfer_subscription`, which loads both the Plan PDA and SubscriptionDelegation PDA
- The Plan PDA provides the billing terms; the SubscriptionDelegation PDA provides the billing state

**Component Overview:**

| Component                                            | ADR-001               | ADR-002                                                                       |
| ---------------------------------------------------- | --------------------- | ----------------------------------------------------------------------------- |
| `SubscriptionAuthority` PDA                          | Used                  | Same SA                                                                       |
| `FixedDelegation`                                    | Standalone delegation | Not used for subscriptions                                                    |
| `RecurringDelegation`                                | Standalone delegation | Not used for subscriptions                                                    |
| `transfer_fixed` / `transfer_recurring`              | Delegation transfers  | Not used for subscriptions                                                    |
| **NEW**: `Plan` PDA                                  | -                     | Stores subscription terms                                                     |
| **NEW**: `SubscriptionDelegation` PDA                | -                     | Tracks per-subscriber billing state                                           |
| **NEW**: `subscribe` instruction                     | -                     | Creates SubscriptionDelegation referencing a Plan                             |
| **NEW**: `cancel_subscription` instruction           | -                     | Sets expires_at_ts, grace period                                              |
| **NEW**: `resume_subscription` instruction           | -                     | Clears expires_at_ts to resume autopay                                        |
| **NEW**: `transfer_subscription` instruction         | -                     | Pulls tokens using Plan terms + Delegation state                              |
| **NEW**: `revoke_abandoned_subscription` instruction | -                     | Sponsor reclaims rent from a subscription whose SubscriptionAuthority is dead |

**Seeded Separation for Coexistence:**

- **Direct Delegations**: Seeds `["delegation", subscription_authority, delegator, delegatee, nonce]`
- **Subscription Delegations**: Seeds `["subscription", plan_pda, subscriber]`
- Different seeds prevent PDA collisions
- Both can use the same SubscriptionAuthority PDA simultaneously

**Flows Remain Available:**

- All ADR-001 instructions (`initialize_subscription_authority`, `create_fixed_delegation`, `create_recurring_delegation`) continue to work unchanged
- New ADR-002 instructions (`create_plan`, `update_plan`, `delete_plan`, `subscribe`, `cancel_subscription`, `resume_subscription`, `transfer_subscription`, `revoke_abandoned_subscription`) add subscription capability
- Direct delegations and subscriptions can be created and withdrawn independently

---

## Types

### Plan PDA (`repr(C, packed)`)

Top-level account structure:

- `discriminator`: 1 byte - `AccountDiscriminator::Plan` (= 1)
- `owner`: 32 bytes - Merchant (Plan creator)
- `bump`: 1 byte - PDA bump seed
- `status`: 1 byte - `PlanStatus` enum (Sunset=0, Active=1)
- `data`: PlanData (see below)

### PlanTerms (24 bytes)

Immutable billing terms snapshotted into each SubscriptionDelegation at subscribe time. The `created_at` field acts as a unique fingerprint for the plan's lifecycle, preventing ghost-account attacks.

- `amount`: 8 bytes (`u64`) - Amount per period
- `period_hours`: 8 bytes (`u64`) - Hours in each billing period
- `created_at`: 8 bytes (`i64`) - Unix timestamp set by the program at plan creation time

### PlanData (456 bytes)

Embedded payload within the Plan PDA:

- `plan_id`: 8 bytes (`u64`) - Unique identifier
- `mint`: 32 bytes (`Address`) - Token mint
- `terms`: 24 bytes (`PlanTerms`) - Immutable billing terms (amount, period_hours, created_at)
- `end_ts`: 8 bytes (`i64`) - Plan expiration timestamp (0 = no expiry)
- `destinations`: 128 bytes (`[Address; 4]`) - Up to 4 fund recipients (all zeros = any destination valid at transfer time)
- `pullers`: 128 bytes (`[Address; 4]`) - Up to 4 authorized pullers
- `metadata_uri`: 128 bytes (`[u8; 128]`) - Optional metadata URI

Plans are always recurring; there is no one-time variant.

**PDA seeds**: `["plan", owner, plan_id]`

**Puller Authorization:**

- The plan owner is **always** implicitly authorized to pull (does not need to be in the `pullers` array)
- If all 4 puller slots are zero, only the plan owner can pull
- Up to 4 additional puller addresses can be specified in the `pullers` array
- Zero-filled entries are ignored

**Destination Whitelist:**

The `destinations` array controls where pulled funds can be sent. If the array is empty (all zeros), funds can be transferred to any wallet. If any addresses are set, the receiver must match one of them (else `UnauthorizedDestination`). Destinations are immutable after plan creation.

### SubscriptionDelegation PDA (`repr(C, packed)`)

Per-subscriber billing state linked to a Plan:

- `header`: 107 bytes - shared `Header` (delegator = subscriber, delegatee = plan_pda, payer = subscriber or sponsor)
- `terms`: 24 bytes (`PlanTerms`) - snapshot of the plan's billing terms at subscribe time
- `amount_pulled_in_period`: 8 bytes (`u64`) - tokens transferred in the current billing period
- `current_period_start_ts`: 8 bytes (`i64`) - start of the current billing period
- `expires_at_ts`: 8 bytes (`i64`) - cancellation timestamp (0 = active, non-zero = cancelled)

**Total size**: 155 bytes

**PDA seeds**: `["subscription", plan_pda, subscriber]`

**Cancellation semantics**: `expires_at_ts == 0` means the subscription is active. When the subscriber cancels, `expires_at_ts` is set to the end of the current billing period. The subscriber can call `resume_subscription` to clear the pending cancellation before the account is revoked. Transfers are blocked after `expires_at_ts`, and the account can be closed via `revoke_delegation`.

---

## Instructions

### `create_plan` (Discriminator: 7)

Merchant publishes a Plan with subscription terms.

| Account | Type             | Description           |
| ------- | ---------------- | --------------------- |
| 0       | signer, writable | Merchant (Plan owner) |
| 1       | writable         | Plan PDA to create    |
| 2       |                  | Token mint            |
| 3       |                  | System program        |
| 4       |                  | Token program         |

**Parameters (PlanData):**

- `plan_id: u64` - Unique identifier
- `mint: Address` - Token mint
- `terms: PlanTerms` - Billing terms (amount, period_hours, created_at). `created_at` is overwritten on-chain.
- `end_ts: i64` - Plan expiration (0 = no expiry)
- `destinations: [Address; 4]` - Fund recipients, optional (all zeros = any destination valid at transfer time)
- `pullers: [Address; 4]` - Authorized pullers (optional, plan owner always authorized by default)
- `metadata_uri: [u8; 128]` - Optional metadata URI

**Validation:**

1. `terms.amount > 0` (else `InvalidAmount`)
2. `0 < terms.period_hours <= 8760` (else `InvalidPeriodLength`)
3. `end_ts == 0` or `end_ts >= current_time + (terms.period_hours * 3600)` (else `InvalidEndTs`)

**Process:**

1. Validate PlanData fields (see above)
2. Derive PDA from `["plan", merchant, plan_id]` and verify match (else `InvalidPlanPda`)
3. Create Plan account via CPI to System Program (handles pre-funded accounts)
4. Set `discriminator = Plan (1)`, `owner = merchant`, `bump`, `status = Active (1)`
5. Copy PlanData into the account
6. Set `terms.created_at = Clock::get()?.unix_timestamp` (overwrites client value)

### `update_plan` (Discriminator: 8)

Plan owner updates mutable admin fields (status, end_ts, pullers, metadata_uri). Core terms (mint, terms, destinations, plan_id) are immutable.

| Account | Type     | Description         |
| ------- | -------- | ------------------- |
| 0       | signer   | Plan owner          |
| 1       | writable | Plan PDA to update  |
| 2       |          | Event authority PDA |
| 3       |          | Self program        |

**Parameters (UpdatePlanData, 265 bytes):**

- `status: u8` - PlanStatus (Sunset=0, Active=1)
- `end_ts: i64` - Plan expiration timestamp (0 = no expiry, valid only when the plan currently has no finite end_ts; cannot be 0 when status=Sunset; a finite end_ts may only be shortened)
- `pullers: [Address; 4]` - Updated puller whitelist (128 bytes)
- `metadata_uri: [u8; 128]` - Metadata URI

**Process:**

1. Load Plan account, verify discriminator and size
2. Verify caller is Plan owner (else `NotPlanOwner`)
3. If the plan is already in Sunset status, reject the update (`PlanImmutableAfterSunset`) **unless** it only removes existing pullers — `status` stays Sunset, `end_ts` and `metadata_uri` are unchanged, and the new `pullers` are a subset of the current set (removal/reorder only). On this sunset puller-removal path only `pullers` is rewritten and the remaining steps are skipped.
4. Reject if status=Sunset and end_ts=0 (else `SunsetRequiresEndTs`) - sunsetting requires a finite expiration
5. Validate the status byte: `PlanStatus::try_from(status)` must succeed (else `InvalidPlanStatus`)
6. Reject if plan has expired: `plan.end_ts != 0 && current_ts > plan.end_ts` (else `PlanExpired`)
7. Enforce shorten-only end_ts: when the stored `end_ts != 0`, a new `end_ts` of `0` or greater than the stored value is rejected (`PlanEndTsCannotExtend`). A finite `end_ts` may only be shortened. Because UpdatePlan is full-replacement, metadata- or puller-only edits to a finite-end plan must re-send the existing `end_ts`.
8. Only when `end_ts` changes from the stored value, validate the new finite end is at least one billing period out: `end_ts == 0` or `end_ts >= current_time + (terms.period_hours * 3600)` (else `InvalidEndTs`). An unchanged `end_ts` skips this check, so puller removal, metadata edits, and the Active→Sunset transition stay available during the final billing period.
9. Write status, end_ts, pullers, and metadata_uri from input data
10. Emit `PlanUpdatedEvent` (plan, owner, status, end_ts, pullers)

**Immutable fields (never modified by update_plan):**
`plan_id`, `owner`, `bump`, `mint`, `terms` (amount, period_hours, created_at), `destinations`

### `delete_plan` (Discriminator: 9)

Plan owner deletes an expired plan, closing the account and reclaiming rent. Does NOT require Sunset status, only that the plan has expired.

| Account | Type             | Description                |
| ------- | ---------------- | -------------------------- |
| 0       | signer, writable | Plan owner (receives rent) |
| 1       | writable         | Plan PDA to delete         |

**Parameters:** None (only discriminator byte)

**Process:**

1. Verify caller is Plan owner (else `NotPlanOwner`)
2. Verify plan is expired: `end_ts != 0 && current_ts > end_ts` (else `PlanNotExpired`)
3. Close account: zero all data, transfer lamports to owner

**Lifecycle paths to deletion:**

- **Active + expired:** Plan created with end_ts, time passes, owner deletes. Natural lifecycle.
- **Sunset + expired:** Owner sunsets plan (sets end_ts), time passes, owner deletes. Early termination.
- **Perpetual plans (end_ts=0):** Cannot be deleted directly. Owner must first `update_plan` to set an end_ts, then wait for expiration.

### `subscribe` (Discriminator: 11)

Subscriber subscribes to a Plan, creating a lightweight `SubscriptionDelegation` PDA that references the Plan.

| Account | Type             | Description                                                   |
| ------- | ---------------- | ------------------------------------------------------------- |
| 0       | signer, writable | Subscriber                                                    |
| 1       |                  | Merchant (Plan owner)                                         |
| 2       |                  | Plan PDA being subscribed to                                  |
| 3       | writable         | SubscriptionDelegation PDA being created                      |
| 4       |                  | Subscriber's SubscriptionAuthority PDA (must match plan mint) |
| 5       |                  | System program                                                |
| 6       |                  | Event authority PDA                                           |
| 7       |                  | This program (for self-CPI event emission)                    |
| 8       | signer, writable | Payer (optional; sponsor funds rent, defaults to subscriber)  |

**Parameters (SubscribeData):**

- `plan_id: u64` - The plan's identifier (used with merchant to derive plan PDA)
- `plan_bump: u8` - The plan PDA's bump seed (avoids on-chain `find_program_address`)
- `expected_mint`, `expected_amount`, `expected_period_hours`, `expected_created_at` - the plan terms the subscriber consented to; mismatch with the live plan fails with `PlanTermsMismatch`
- `expected_subscription_authority_init_id: i64` - the SA `init_id` the subscriber consented to; mismatch fails with `StaleSubscriptionAuthority`

**Process:**

1. Validate Plan PDA derivation from `["plan", merchant, plan_id]` using `plan_bump`
2. Load Plan, verify `status == Active` (else `PlanSunset`), and check not expired (else `PlanExpired`)
3. Validate subscriber's SubscriptionAuthority PDA exists and matches the plan's mint (else `MintMismatch`)
4. Derive SubscriptionDelegation PDA from `["subscription", plan_pda, subscriber]`
5. Check subscription doesn't already exist (else `AlreadySubscribed`)
6. Verify the live plan terms match the `expected_*` consent fields (else `PlanTermsMismatch`) and the SA `init_id` matches `expected_subscription_authority_init_id` (else `StaleSubscriptionAuthority`)
7. Create SubscriptionDelegation account with:
    - `header.delegator = subscriber`, `header.delegatee = plan_pda`, `header.payer = rent payer (subscriber or sponsor)`
    - `terms = plan.data.terms` (snapshot of plan's billing terms)
    - `amount_pulled_in_period = 0`, `current_period_start_ts = current_ts`, `expires_at_ts = 0`
8. Emit `SubscriptionCreatedEvent` via self-CPI

---

### `transfer_subscription` (Discriminator: 10)

Authorized caller (plan owner or whitelisted puller) pulls tokens from a subscriber's account through their SubscriptionDelegation, validated against the Plan's terms.

| Account | Type     | Description                                                                    |
| ------- | -------- | ------------------------------------------------------------------------------ |
| 0       | writable | SubscriptionDelegation PDA                                                     |
| 1       |          | Plan PDA                                                                       |
| 2       |          | SubscriptionAuthority PDA                                                      |
| 3       | writable | Delegator's ATA (source of funds)                                              |
| 4       | writable | Receiver's ATA (destination)                                                   |
| 5       | signer   | Caller (plan owner or whitelisted puller)                                      |
| 6       |          | Token mint                                                                     |
| 7       |          | Token program                                                                  |
| 8       |          | Event authority PDA                                                            |
| 9       |          | This program (for self-CPI event emission)                                     |
| 10+     |          | Optional transfer-hook accounts (`ExtraAccountMetas`), forwarded to Token-2022 |

**Parameters (TransferData):**

- `amount: u64` - Amount to transfer
- `delegator: Address` - Subscriber's public key
- `mint: Address` - Token mint

**Validation:**

1. Verify plan account is program-owned (else `PlanClosed`)
2. Load Plan and verify `mint` matches `transfer_data.mint` (else `MintMismatch`)
3. Check plan not expired: `end_ts == 0` or `current_ts <= end_ts` (else `PlanExpired`)
4. Authorize caller: must be plan owner or listed in `pullers` array (else `Unauthorized`)
5. Validate destination: if plan has non-zero destinations, receiver ATA owner must match one (else `UnauthorizedDestination`); if all destinations are zero, any receiver is valid
6. Load SubscriptionDelegation and verify plan terms match via `check_plan_terms()` (else `PlanTermsMismatch`)
7. Verify `delegatee == plan_pda` (else `SubscriptionPlanMismatch`)
8. Verify `delegator` matches `transfer_data.delegator` (else `Unauthorized`)
9. Check subscription not cancelled: if `expires_at_ts != 0 && current_ts >= expires_at_ts`, block the transfer (else `SubscriptionCancelled`)
10. Validate recurring transfer using subscription's snapshotted terms: amount within period limit, handle period rollover
11. Update subscription state (`current_period_start_ts`, `amount_pulled_in_period`)
12. Execute transfer via SubscriptionAuthority PDA (CPI to Token Program)
13. Emit `SubscriptionTransferEvent` via self-CPI (its `period_end_ts` is clamped to the plan's `end_ts`, and it records the receiver ATA and the caller as `puller`)

**Authorization Logic:**

- Direct delegations (ADR-001): Only delegatee can call transfer
- Subscription delegations (ADR-002): Plan owner is always authorized, plus up to 4 additional addresses in `pullers` array

**Sunset behavior:** A plan in Sunset status still allows existing subscription pulls. Sunset only prevents new subscriptions (handled in `subscribe` instruction).

### `cancel_subscription` (Discriminator: 12)

Subscriber cancels their subscription. Three paths based on plan state:

- **Plan exists, terms match:** grace period (expires at end of current billing period)
- **Plan exists, terms mismatch (ghost plan):** immediate expiration (`expires_at_ts = current_ts`)
- **Plan closed:** immediate expiration (`expires_at_ts = current_ts`)

After `expires_at_ts` passes, pulls are blocked. The subscriber can then call `revoke_delegation` to close the account and reclaim rent.

| Account | Type     | Description                |
| ------- | -------- | -------------------------- |
| 0       | signer   | Subscriber (delegator)     |
| 1       |          | Plan PDA                   |
| 2       | writable | SubscriptionDelegation PDA |
| 3       |          | Event authority PDA        |
| 4       |          | Self program               |

**Parameters:** None (only discriminator byte)

**Validation:**

1. Verify caller is the subscription's delegator (else `Unauthorized`)
2. Verify `expires_at_ts == 0` (else `SubscriptionAlreadyCancelled`)
3. Verify subscription's delegatee matches the plan PDA (else `SubscriptionPlanMismatch`)

**Process:**

1. If plan is valid (program-owned) and `check_plan_terms()` passes: compute `expires_at_ts = current_period_start + (periods_elapsed + 1) * period_length` using subscription's snapshotted `terms.period_hours`, then cap at `plan.end_ts + 1` if `end_ts != 0` (`end_ts` is inclusive — the merchant may pull through `end_ts` — so the cancellation expiry sits one second past it, matching the plan-expiry boundary used elsewhere, and a cancelled subscription cannot outlive the plan)
2. If plan is valid but `check_plan_terms()` fails (ghost plan): set `expires_at_ts = current_ts` (immediate, no grace period)
3. If plan is closed (not program-owned): set `expires_at_ts = current_ts`
4. Emit `SubscriptionCancelled` event via self-CPI

**Cancellation flow:**

- `cancel_subscription` → pre-computes `expires_at_ts` (end of current period), allows pulls until then
- `resume_subscription` → clears `expires_at_ts` back to `0` before the cancellation period ends, provided the plan is not closed, expired, or recreated with different terms
- `revoke_delegation` → closes account (requires `expires_at_ts != 0` and `expires_at_ts <= current_ts`)

### `resume_subscription` (Discriminator: 13)

Subscriber resumes a cancelled subscription by clearing `expires_at_ts`. This does not change `current_period_start_ts` or `amount_pulled_in_period`, so the billing period and allowance accounting continue from the existing subscription state.

| Account | Type     | Description                                                   |
| ------- | -------- | ------------------------------------------------------------- |
| 0       | signer   | Subscriber (delegator)                                        |
| 1       |          | Plan PDA                                                      |
| 2       | writable | SubscriptionDelegation PDA                                    |
| 3       |          | SubscriptionAuthority PDA (subscriber's, for the plan's mint) |
| 4       |          | Event authority PDA                                           |
| 5       |          | Self program                                                  |

**Parameters:** None (only discriminator byte)

**Validation:**

1. Verify caller is the subscription's delegator (else `Unauthorized`)
2. Verify subscription's delegatee matches the plan PDA (else `SubscriptionPlanMismatch`)
3. Verify `expires_at_ts != 0` (else `SubscriptionNotCancelled`)
4. Verify the plan account is still program-owned (else `PlanClosed`)
5. Verify the plan has not reached `end_ts` (else `PlanExpired`)
6. Verify the live plan terms still match the subscription's snapshotted terms (else `PlanTermsMismatch`)
7. Verify the SubscriptionAuthority is owned by the subscriber (else `Unauthorized`), its mint matches the plan (else `MintMismatch`), and its `init_id` equals the subscription's recorded `init_id` (else `StaleSubscriptionAuthority`) — prevents resuming against a closed-and-reinitialized authority.
8. Verify `expires_at_ts > current_ts` (else `SubscriptionCancelled`)

**Process:**

1. Clear `expires_at_ts` to `0`
2. Leave `current_period_start_ts` and `amount_pulled_in_period` unchanged
3. Emit `SubscriptionResumed` event via self-CPI

### `revoke_abandoned_subscription` (Discriminator: 16)

Sponsor-driven recovery: the recorded `payer` reclaims rent from a SubscriptionDelegation once its SubscriptionAuthority is dead. This is the sponsor counterpart to `resume_subscription`'s `init_id` liveness check.

| Account | Type             | Description                                                   |
| ------- | ---------------- | ------------------------------------------------------------- |
| 0       | signer, writable | Recorded payer (sponsor) reclaiming rent                      |
| 1       | writable         | SubscriptionDelegation PDA to close                           |
| 2       |                  | SubscriptionAuthority PDA (subscriber's, for the plan's mint) |
| 3       |                  | Plan PDA (used to recover the mint)                           |

**Parameters:** None (only discriminator byte)

**Validation:**

1. Verify the caller equals the subscription's recorded `payer` (else `Unauthorized`)
2. Verify the subscription's `delegatee` matches the supplied Plan PDA (else `SubscriptionPlanMismatch`)
3. Verify the Plan account is still program-owned — a closed plan is recoverable via `revoke_delegation` instead (else `PlanClosed`)
4. Verify the supplied SubscriptionAuthority is the canonical `find_pda(delegator, plan.mint)` — the mint is taken from the bound plan, never the supplied authority, so a sponsor cannot spoof "abandoned" with an unrelated-mint authority
5. Verify the authority is abandoned: it is closed (not program-owned / fails to load) or its `init_id` no longer matches the subscription's recorded `init_id`. A still-live, matching authority is rejected (else `Unauthorized`), since the subscription remains billable.

**Process:**

1. Close the SubscriptionDelegation account and return rent to the recorded payer.

---

## Sequence Diagrams

### Merchant Creates Plan

```mermaid
sequenceDiagram
    participant M as Merchant
    participant P as Program

    M->>P: create_plan(plan_id, recurring_terms)
    Note over P: Validate PDA from<br/>["plan", merchant, plan_id]
    Note over P: Create Plan PDA with terms
    P->>M: Plan published
```

### Alice Subscribes

```mermaid
sequenceDiagram
    participant A as Alice
    participant P as Program
    participant Plan as Plan PDA
    participant SA as SA

    A->>P: subscribe(plan_id, plan_bump)
    Note over P: Plan status == Active?
    Note over P: Derive SubscriptionDelegation PDA from<br/>["subscription", plan_pda, alice]
    Note over P: Create SubscriptionDelegation PDA<br/>referencing Plan
    Note over P: Emit SubscriptionCreatedEvent
    P->>A: Subscribed through SA
```

### Transfer Subscription (Pull)

```mermaid
sequenceDiagram
    participant X as Caller
    participant P as Program
    participant SD as SubscriptionDelegation PDA
    participant T as TokenProgram

    Note over P: Check plan not closed/expired<br/>Verify mint match<br/>Check caller is owner<br/>or in pullers[4] array

    alt Caller is owner or in pullers
        X->>P: transfer_subscription(amount, delegator, mint)
        Note over P: Authorization passed
        P->>SD: Validate subscription state<br/>and recurring period limits
        P->>T: Transfer via SA
        T->>X: Tokens transferred
    else Caller not authorized
        X->>P: transfer_subscription(amount, delegator, mint)
        Note over P: Authorization failed
        P->>X: Unauthorized error
    end
```

### Delegator Cancels and Revokes Subscription

Cancellation is a three-step flow (resume is optional):

1. **`cancel_subscription`** — Sets `expires_at_ts`. Three paths: terms match (grace period until end of billing period), terms mismatch/ghost plan (immediate), plan closed (immediate).
2. **`resume_subscription`** — Optional. Clears a pending cancellation without resetting period accounting. Rejected once the cancellation period elapses, or if the plan is closed, expired, or recreated with different terms. Sunset plans may still resume existing subscriptions before `end_ts`.
3. **`revoke_delegation`** — Closes the subscription account and reclaims rent. Only allowed after `expires_at_ts` is in the past.

```mermaid
sequenceDiagram
    participant D as Alice (Delegator)
    participant P as Program
    participant X as Merchant/Puller

    D->>P: cancel_subscription(plan_pda, subscription_pda)
    Note over P: Compute expires_at_ts = end of current period<br/>Emit SubscriptionCancelled event

    X->>P: transfer_subscription(amount, delegator, mint)
    Note over P: Within cancellation period:<br/>Pull allowed (grace period)

    D->>P: resume_subscription(plan_pda, subscription_pda)
    Note over P: expires_at_ts = 0<br/>Period state unchanged

    X->>P: transfer_subscription(amount, delegator, mint)
    Note over P: Pulls continue as an active subscription

    D->>P: cancel_subscription(plan_pda, subscription_pda)
    Note over P: Subscriber cancels again

    Note over D,P: Period boundary passes...

    X->>P: transfer_subscription(amount, delegator, mint)
    Note over P: Past cancellation period end:<br/>Rejected (SubscriptionCancelled)

    D->>P: revoke_delegation(subscription_pda)
    Note over P: expires_at_ts in the past → Close account<br/>Return rent to payer
```

### Ghost Account Recovery

When a merchant deletes an expired plan and recreates it with the same `plan_id`, the new plan occupies the same PDA. Existing subscriptions detect this via `check_plan_terms()`.

```mermaid
sequenceDiagram
    participant M as Merchant
    participant P as Program
    participant D as Alice (Subscriber)

    Note over M,P: Merchant deletes expired plan,<br/>recreates with same plan_id<br/>but different terms

    M->>P: transfer_subscription(amount, alice, mint)
    Note over P: check_plan_terms() fails:<br/>subscription.terms.created_at ≠ plan.terms.created_at<br/>Rejected (PlanTermsMismatch)

    D->>P: cancel_subscription(plan_pda, subscription_pda)
    Note over P: check_plan_terms() fails:<br/>Ghost plan detected<br/>expires_at_ts = current_ts (immediate)

    D->>P: revoke_delegation(subscription_pda)
    Note over P: expires_at_ts in the past → Close account<br/>Return rent to Alice
```

### Merchant Sunsets and Deletes Plan

```mermaid
sequenceDiagram
    participant M as Merchant
    participant P as Program
    participant X as Anyone/Whitelist

    M->>P: update_plan(status=Sunset, end_ts=future)
    Note over P: Plan status set to Sunset<br/>(status/end_ts/metadata frozen;<br/>owner may still remove pullers)<br/>Requires non-zero end_ts

    X->>P: transfer_subscription(amount, delegator, mint)
    Note over P: Plan is Sunset:<br/>new subscriptions rejected<br/>existing subscriptions honored until end_ts

    Note over M,P: After end_ts passes...

    M->>P: delete_plan(plan_pda)
    Note over P: Verify owner + expired<br/>Close account, return rent
```

---

## Security Model

| Attack                                                      | Prevention                                                                                                                                                                                                                                                                                                                                                                                                   |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Merchant changes terms mid-subscription                     | `update_plan` only modifies status, end_ts, pullers, metadata_uri; core billing terms (mint, terms, destinations) are immutable                                                                                                                                                                                                                                                                              |
| Ghost account (merchant deletes/recreates plan at same PDA) | `PlanTerms` (amount, period_hours, created_at) are snapshotted into each SubscriptionDelegation at subscribe time. `transfer_subscription` calls `check_plan_terms()` to compare the snapshot against the live plan; mismatch returns `PlanTermsMismatch`. `cancel_subscription` detects mismatch and expires immediately (no grace period). Subscriber then calls `revoke_delegation` to close the account. |
| Delegator can't verify terms                                | Terms stored in immutable Plan PDA; delegator verifies before subscribing                                                                                                                                                                                                                                                                                                                                    |
| Unauthorized pull on Plans                                  | Owner is always authorized, plus explicit pullers array (`Unauthorized`)                                                                                                                                                                                                                                                                                                                                     |
| Plan closed/deleted before pull                             | `transfer_subscription` checks plan ownership before loading; returns `PlanClosed` if account is no longer program-owned                                                                                                                                                                                                                                                                                     |
| Puller redirects funds to unauthorized wallet               | `destinations` whitelist is checked at transfer time; receiver ATA owner must match a whitelisted address (`UnauthorizedDestination`). Destinations are immutable after plan creation.                                                                                                                                                                                                                       |
| Duplicate subscription                                      | `subscribe` checks if SubscriptionDelegation PDA already has data (`AlreadySubscribed`)                                                                                                                                                                                                                                                                                                                      |
| Delegator hijacks subscription                              | Delegation PDA seeds include plan_pda; can't be recreated                                                                                                                                                                                                                                                                                                                                                    |
| Plan expiration handling                                    | `end_ts` field; 0 means no expiry, otherwise must be in the future at creation. Sunset requires non-zero end_ts (`SunsetRequiresEndTs`)                                                                                                                                                                                                                                                                      |
| Unauthorized plan deletion                                  | `delete_plan` requires owner signature and expired end_ts (`PlanNotExpired`). Does not require Sunset status.                                                                                                                                                                                                                                                                                                |
| Plan with invalid data                                      | Validated: amount>0, period_hours in (0,8760], destinations optional (0-4), end_ts=0 or future                                                                                                                                                                                                                                                                                                               |
| Orphaned Delegation reference                               | Delegation tracks state; `transfer_subscription` checks Plan reference                                                                                                                                                                                                                                                                                                                                       |
| SA spends without Plan constraint                           | Pull must validate Plan terms and Delegation constraints                                                                                                                                                                                                                                                                                                                                                     |

---

## Consequences

### Positive

- `+` **Cost Efficiency** - One Plan serves many subscribers
- `+` **Trust Through Immutability** - Terms fixed at creation prevent price changes
- `+` **Discoverability** - Plans can be published and discovered via marketplaces
- `+` **Flexible Control** - Pullers array for authorization, status and end_ts for lifecycle
- `+` **Reuses ADR-001** - Shares SA infrastructure, minimal code duplication
- `+` **Complementary** - Subscriptions and direct delegations can coexist
- `+` **Marketplace Enabling** - Standard structure for subscription services

### Negative

- `-` **Complexity** - Adds Plan management layer and additional instructions
- `-` **Rent Overhead** - Plan rent paid by merchants (though amortized over many delegations)
- `-` **Discovery Required** - Delegators must find Plans (vs direct PDA sharing)

### Neutral

- `~` **Mixed Authorization Models** - Direct delegations: delegatee-only; Subscriptions: configurable via pullers
- `~` **Separate Transfer Instructions** - Subscriptions use `transfer_subscription` with Plan reference; direct delegations use `transfer_fixed`/`transfer_recurring` with embedded terms
- `~` **Graceful Sunset** - Allows merchants to retire plans while honoring existing commitments

---

## Event System

All transfer and lifecycle instructions emit events via self-CPI through an event authority PDA (`["event_authority"]`). This uses an Anchor-compatible event emission pattern where the program invokes itself with a special `EmitEvent` instruction (discriminator 228).

**Events:**

| Event                        | Emitted By              | Data                                                                                                                                           |
| ---------------------------- | ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `SubscriptionCreatedEvent`   | `subscribe`             | plan, subscriber, mint, created_ts, payer                                                                                                      |
| `SubscriptionCancelledEvent` | `cancel_subscription`   | plan, subscriber, expires_at_ts                                                                                                                |
| `SubscriptionResumedEvent`   | `resume_subscription`   | plan, subscriber, resumed_ts                                                                                                                   |
| `SubscriptionTransferEvent`  | `transfer_subscription` | subscription, plan, delegator, mint, amount, period_start_ts, period_end_ts, amount_pulled_in_period, receiver, receiver_token_account, puller |
| `FixedTransferEvent`         | `transfer_fixed`        | delegation, delegator, delegatee, mint, amount, remaining_amount, receiver, receiver_token_account                                             |
| `RecurringTransferEvent`     | `transfer_recurring`    | delegation, delegator, delegatee, mint, amount, period_start_ts, period_end_ts, amount_pulled_in_period, receiver, receiver_token_account      |
| `PlanUpdatedEvent`           | `update_plan`           | plan, owner, status, end_ts, pullers[4]                                                                                                        |

> **Note:** `amount` on transfer events is the gross debited value; for transfer-fee mints the receiver gets `amount` minus the fee.

Instructions that emit events require two additional accounts: the event authority PDA and the program itself (for self-CPI).

---

## Migration Path (If Needed)

Subscription Delegations would use different PDA seeds than direct delegations, so both models can coexist:

**Direct Delegation Seeds (ADR-001):**

```
["delegation", subscription_authority, delegator, delegatee, nonce]
```

**Subscription Delegation Seeds (ADR-002):**

```
["subscription", plan_pda, subscriber]
```

This enables incremental rollout (start with direct, add subscriptions later) without breaking existing delegations.

---

## Future Enhancements

- Plan marketplace/aggregator protocol for discovery
- Merkle tree for pullers (scale beyond 4 addresses)
- Subscription UI/SDK templates for frontend
- Analytics for merchants (active subscribers, total volume)
- Auto-renewal with Plan term modifications (version upgrades)
