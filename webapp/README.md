# Subscriptions Webapp

Web interface for managing Solana token delegations and pull-payment subscriptions. Connects to the Subscriptions on-chain program (SPL Token and Token-2022 mints), allowing users to create, manage, and revoke delegations with controlled spending limits and time-based expiry, and to publish and subscribe to merchant billing plans.

## Features

- **Wallet Connection** - Solana wallet integration (tested with Phantom) with real-time SOL and token balance display
- **Create Delegations** - Two delegation types:
    - **Fixed**: one-time total amount with an expiry date
    - **Recurring**: per-period amount with configurable period length, optional start-on-landing (`startTs = 0`)
- **Marketplace** - Browse merchant plans and subscribe; manage subscriptions (cancel, resume, delete expired) under My Subscriptions
- **Plans** - Create, edit, sunset, and delete billing plans; manage pullers and destination accounts; collect payments
- **View Delegations** - Separate tabs for outgoing (delegator) and incoming (delegatee) delegations, with active/expired filtering
- **Revoke & Reclaim** - Cancel active outgoing delegations, reclaim rent from abandoned delegations, and disable delegations by closing the Subscription Authority (feature-gated per network)
- **Transfer Under Delegation** - Delegatees can withdraw amounts within the delegation rules
- **SA Initialization** - Subscription Authority Account setup flow required before creating delegations
- **Dev Tooling** - Faucet for SOL/test-token airdrops, first-run setup wizard, program deploy page, and time travel (hidden on mainnet)
- **Theme Support** - Dark/light mode toggle

## Scripts

Run from `webapp/` (or from the root with `pnpm --filter webapp <script>`):

| Script         | Description                                           |
| -------------- | ----------------------------------------------------- |
| `pnpm dev`     | Start the Vite dev server with hot module replacement |
| `pnpm build`   | Type-check with TypeScript and build for production   |
| `pnpm test`    | Run the Node test runner over `test/*.test.ts`        |
| `pnpm preview` | Preview the production build locally                  |

From the project root, `just webapp-run` builds the program and clients, starts a local validator + API, and launches the webapp.

## Tech Stack

React 19, TypeScript, Vite, Tailwind CSS, Radix UI, jotai (state), TanStack Query (data fetching), Solana Kit, ConnectorKit.
