# @subscriptions/client

TypeScript SDK for the Subscriptions Solana program: token delegation, recurring payments, and subscriptions.

## Installation

```bash
npm install @subscriptions/client
```

## Quick Start

The SDK exports `build*` helpers that return Solana instructions. You sign and send them with your wallet adapter.

```typescript
import { address } from "gill";
import {
  buildInitSubscriptionAuthority,
  buildCreateFixedDelegation,
} from "@subscriptions/client";

// 1. Initialize the SubscriptionAuthority for a user's token account (once per mint)
const { instructions: initIxs } = await buildInitSubscriptionAuthority({
  owner: walletSigner,
  tokenMint: address("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"),
  userAta: address("..."),
  tokenProgram: address("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"),
});
await signAndSendTransaction(initIxs, walletSigner);

// 2. Create a fixed delegation (e.g., allow spending 1,000,000 tokens)
const { instructions: delegateIxs } = await buildCreateFixedDelegation({
  delegator: walletSigner,
  tokenMint: address("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"),
  delegatee: address("DelegateeAddress..."),
  nonce: 0n,
  amount: 1_000_000n,
  expiryTs: BigInt(Math.floor(Date.now() / 1000) + 3600), // 1 hour
});
await signAndSendTransaction(delegateIxs, walletSigner);
```

Each `build*` helper returns `{ instructions: IInstruction[] }`. You provide signing/sending, so it works with any wallet adapter or backend signer.

> For Node.js/backend usage, `SubscriptionsClient` wraps all `build*` helpers with automatic transaction signing and sending via a [Gill](https://github.com/solana-foundation/gill)-compatible RPC client. It also provides query methods like `getDelegationsForWallet` and `getActiveDelegationSummary`.

## Capabilities

### Delegation Management

| Helper | Description |
|--------|-------------|
| `buildInitSubscriptionAuthority` | Set up the per-mint SubscriptionAuthority PDA and token approval |
| `buildCloseSubscriptionAuthority` | Tear down SubscriptionAuthority, invalidating all delegations (kill switch) |
| `buildCreateFixedDelegation` | One-time token allowance with optional expiry |
| `buildCreateRecurringDelegation` | Periodic allowance (amount per time period) |
| `buildRevokeDelegation` | Permanently close any delegation and reclaim rent |

### Transfers

| Helper | Description |
|--------|-------------|
| `buildTransferFixed` | Pull tokens from a fixed delegation |
| `buildTransferRecurring` | Pull tokens from a recurring delegation |
| `buildTransferSubscription` | Pull tokens from a subscription delegation |

### Subscription Plans

| Helper | Description |
|--------|-------------|
| `buildCreatePlan` | Publish a subscription plan with billing terms |
| `buildUpdatePlan` | Update plan status, end date, pullers, or metadata |
| `buildDeletePlan` | Delete an expired plan and reclaim rent |
| `buildSubscribe` | Subscribe to a plan |
| `buildCancelSubscription` | Cancel a subscription (grace period until end of billing period) |

### Account Queries

| Function | Description |
|----------|-------------|
| `fetchDelegationsByDelegator` | All delegations where wallet is the delegator |
| `fetchDelegationsByDelegatee` | All delegations where wallet is the delegatee |
| `fetchPlansForOwner` | All plans owned by an address |
| `fetchSubscriptionsForUser` | All subscriptions for a user |
| `decodeDelegationAccount` / `decodePlanAccount` | Decode raw RPC responses |

### PDA Helpers

`getSubscriptionAuthorityPDA`, `getDelegationPDA`, `getPlanPDA`, `getSubscriptionPDA`, `getEventAuthorityPDA`

### Types

- `Delegation` - discriminated union: `{ kind: "fixed" | "recurring" | "subscription"; address; data }`
- Type guards: `isFixedDelegation`, `isRecurringDelegation`, `isSubscriptionDelegation`
- `PlanWithAddress`, `DelegationKindId`, `TransferParams`
- Error handling: `parseProgramError`, `ProgramError`, `ValidationError`

## API Reference

Full API documentation is generated from source with [TypeDoc](https://typedoc.org/). Run `npx typedoc` to generate locally, or browse `./docs/`.

## Development

Generated bindings in `src/generated/` are produced by [Codama](https://github.com/codama-idl/codama) and gitignored. Regenerate from the repo root:

```bash
just generate-client
```

## License

MIT
