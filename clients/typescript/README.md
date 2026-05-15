# @solana/subscriptions

TypeScript SDK for the [Subscriptions Solana program](https://github.com/solana-program/subscriptions): token delegation, recurring payments, and subscriptions. Ships as a [`@solana/kit`](https://github.com/anza-xyz/kit) plugin.

**Source & issues:** https://github.com/solana-program/subscriptions

## Installation

```bash
npm install @solana/subscriptions
```

## Quick Start

The SDK exports a `subscriptionsProgram()` Kit plugin. The plugin derives program PDAs, fills the configured identity/payer where possible, and can send transactions directly through Kit.

```typescript
import { address, createClient } from '@solana/kit';
import { solanaLocalRpc } from '@solana/kit-plugin-rpc';
import { signer } from '@solana/kit-plugin-signer';
import { subscriptionsProgram } from '@solana/subscriptions';

const client = createClient()
    .use(signer(walletSigner))
    .use(solanaLocalRpc({ rpcUrl: 'http://127.0.0.1:8899' }))
    .use(subscriptionsProgram());

// 1. Initialize the SubscriptionAuthority for a user's token account (once per mint)
await client.subscriptions.instructions
    .initSubscriptionAuthority({
        tokenMint: address('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'),
        userAta: address('...'),
        tokenProgram: address('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'),
    })
    .sendTransaction();

// 2. Create a fixed delegation (e.g., allow spending 1,000,000 tokens)
await client.subscriptions.instructions
    .createFixedDelegation({
        tokenMint: address('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'),
        delegatee: address('DelegateeAddress...'),
        nonce: 0n,
        amount: 1_000_000n,
        expiryTs: BigInt(Math.floor(Date.now() / 1000) + 3600), // 1 hour
    })
    .sendTransaction();
```

For custom wallet flows, use the exported `get*OverlayInstruction*` functions. They return a single Kit `Instruction` or `Promise<Instruction>` that you can add to your own transaction builder.

## Capabilities

### Delegation Management

| Plugin instruction / builder                                                          | Description                                                                 |
| ------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| `initSubscriptionAuthority` / `getInitSubscriptionAuthorityOverlayInstructionAsync`   | Set up the per-mint SubscriptionAuthority PDA and token approval            |
| `closeSubscriptionAuthority` / `getCloseSubscriptionAuthorityOverlayInstructionAsync` | Tear down SubscriptionAuthority, invalidating all delegations (kill switch) |
| `createFixedDelegation` / `getCreateFixedDelegationOverlayInstructionAsync`           | One-time token allowance with optional expiry                               |
| `createRecurringDelegation` / `getCreateRecurringDelegationOverlayInstructionAsync`   | Periodic allowance (amount per time period)                                 |
| `revokeDelegation` / `getRevokeDelegationOverlayInstruction`                          | Permanently close any delegation and reclaim rent                           |

### Transfers

| Plugin instruction / builder                                              | Description                                |
| ------------------------------------------------------------------------- | ------------------------------------------ |
| `transferFixed` / `getTransferFixedOverlayInstructionAsync`               | Pull tokens from a fixed delegation        |
| `transferRecurring` / `getTransferRecurringOverlayInstructionAsync`       | Pull tokens from a recurring delegation    |
| `transferSubscription` / `getTransferSubscriptionOverlayInstructionAsync` | Pull tokens from a subscription delegation |

### Subscription Plans

| Plugin instruction / builder                                          | Description                                                      |
| --------------------------------------------------------------------- | ---------------------------------------------------------------- |
| `createPlan` / `getCreatePlanOverlayInstructionAsync`                 | Publish a subscription plan with billing terms                   |
| `updatePlan` / `getUpdatePlanOverlayInstruction`                      | Update plan status, end date, pullers, or metadata               |
| `deletePlan` / `getDeletePlanOverlayInstruction`                      | Delete an expired plan and reclaim rent                          |
| `subscribe` / `getSubscribeOverlayInstructionAsync`                   | Subscribe to a plan                                              |
| `cancelSubscription` / `getCancelSubscriptionOverlayInstructionAsync` | Cancel a subscription (grace period until end of billing period) |

### Account Queries

| Function                      | Description                                                |
| ----------------------------- | ---------------------------------------------------------- |
| `fetchDelegationsByDelegator` | All delegations where wallet is the delegator              |
| `fetchDelegationsByDelegatee` | All delegations where wallet is the delegatee              |
| `fetchPlansForOwner`          | All plans owned by an address                              |
| `fetchSubscriptionsForUser`   | All subscriptions for a user                               |
| `decodeDelegationAccount`     | Decode raw delegation accounts (fans out by discriminator) |

### PDA Helpers

Use the generated `find*Pda` helpers directly: `findSubscriptionAuthorityPda`,
`findFixedDelegationPda`, `findRecurringDelegationPda`, `findSubscriptionDelegationPda`,
`findPlanPda`, `findEventAuthorityPda`. All take a seeds object and return `[address, bump]`.

### Types

- `Delegation` - discriminated union: `{ kind: "fixed" | "recurring" | "subscription"; address; data }`. Narrow with `d.kind === '...'`.
- `PlanWithAddress`, `DelegationKindId` (string union), `TransferParams`
- Error handling: client-side `ValidationError`; on-chain errors use the generated `SUBSCRIPTIONS_ERROR__*` constants and `isSubscriptionsError` / `getSubscriptionsErrorMessage`.

## API Reference

Full API documentation is generated from source with [TypeDoc](https://typedoc.org/). Run `npx typedoc` to generate locally, or browse `./docs/`.

## Development

Generated bindings in `src/generated/` are produced by [Codama](https://github.com/codama-idl/codama) and gitignored. Regenerate from the repo root:

```bash
just generate-clients
```

## License

MIT
