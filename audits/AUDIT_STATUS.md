# Audit Status

Last updated: 2026-04-08

> **Note**: This program was previously named `multi-delegator`. The audit report filename and audited-through commits were generated under the old name and are preserved verbatim as signed artifacts.

## Current Baseline

- Auditor: Cantina
- Report: `audits/report-cli-cantina-db2ffeea-c85c-4f35-b188-e861cdcd785d-solana-multi-delegator.pdf`
- Audited-through commit: `18a50bc21c4b91ed62e612109c371f41200385e8`
- Compare audited baseline delta: https://github.com/solana-foundation/subscriptions/compare/18a50bc21c4b91ed62e612109c371f41200385e8...main
- Audit fixes implemented/verified through commit: `b4b0345f9fd616e1355b7b6628362283fd6b1691`
- Compare post-fix delta: https://github.com/solana-foundation/subscriptions/compare/b4b0345f9fd616e1355b7b6628362283fd6b1691...main

Audit scope is commit-based. The external audit baseline is `18a50bc...`. Audit remediation was implemented and verified through `b4b0345...`.

## Branch and Release Model

- `main` is the integration branch and may contain audited and unaudited commits.
- Stable production releases are immutable tags/releases (for example `v1.0.0`).
- Audited baselines are tracked by commit SHA plus immutable tags/releases, not by long-lived release branches.

## Verification Commands

```bash
# Count commits after the external audited baseline
git rev-list --count 18a50bc21c4b91ed62e612109c371f41200385e8..main

# Inspect commit list since external audited baseline
git log --oneline 18a50bc21c4b91ed62e612109c371f41200385e8..main

# Inspect file-level diff since external audited baseline
git diff --name-status 18a50bc21c4b91ed62e612109c371f41200385e8..main

# Count commits after fixes implemented/verified through commit
git rev-list --count b4b0345f9fd616e1355b7b6628362283fd6b1691..main

# Inspect commit list since fixes implemented/verified through commit
git log --oneline b4b0345f9fd616e1355b7b6628362283fd6b1691..main

# Inspect file-level diff since fixes implemented/verified through commit
git diff --name-status b4b0345f9fd616e1355b7b6628362283fd6b1691..main
```

## Maintenance Rules

When a new audit is completed:

1. Add the new report to `audits/`.
2. Update `Audited-through commit`, `Audit fixes implemented/verified through commit`, and compare links.
3. Tag audited release commit(s) (for example `vX.Y.Z`).
4. Update README and release notes links if needed.
