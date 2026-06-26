# Audit Status

Last updated: 2026-06-26

## Current Baseline

- Auditor: Cantina
- Report: `audits/report-cli-cantina-0c329845-47bc-4915-a50d-56dbc442b76a-solana-subscriptions.pdf`
- Audited-through commit: `38b88bebd2c3f13ba2fbd54795e9ecc8619f8c0c`
- Compare audited baseline delta: https://github.com/solana-foundation/subscriptions/compare/38b88bebd2c3f13ba2fbd54795e9ecc8619f8c0c...main
- Audit fixes implemented/verified through commit: `2d7b45bdc998dc582874fc8ab32ac03f9c786c1e`
- Compare post-fix delta: https://github.com/solana-foundation/subscriptions/compare/2d7b45bdc998dc582874fc8ab32ac03f9c786c1e...main

Findings: 51 total (0 Critical, 0 High, 5 Medium, 24 Low, 22 Informational); 38 fixed, 13 acknowledged. Cantina re-reviewed holistically at `2d7b45bd...` and concluded all findings were addressed with no new vulnerabilities identified.

Audit scope is commit-based. The external audit baseline is `38b88beb...`. Audit remediation was implemented and verified through `2d7b45bd...`.

## Previous Audits

> **Note**: This program was previously named `multi-delegator`. The audit report filename and audited-through commits were generated under the old name and are preserved verbatim as signed artifacts.

- Auditor: Cantina
- Report: `audits/report-cli-cantina-db2ffeea-c85c-4f35-b188-e861cdcd785d-solana-multi-delegator.pdf`
- Audited-through commit: `18a50bc21c4b91ed62e612109c371f41200385e8`
- Audit fixes implemented/verified through commit: `b4b0345f9fd616e1355b7b6628362283fd6b1691`

## Branch and Release Model

- `main` is the integration branch and may contain audited and unaudited commits.
- Stable production releases are immutable tags/releases (for example `v1.0.0`).
- Audited baselines are tracked by commit SHA plus immutable tags/releases, not by long-lived release branches.

## Verification Commands

```bash
# Count commits after the external audited baseline
git rev-list --count 38b88bebd2c3f13ba2fbd54795e9ecc8619f8c0c..main

# Inspect commit list since external audited baseline
git log --oneline 38b88bebd2c3f13ba2fbd54795e9ecc8619f8c0c..main

# Inspect file-level diff since external audited baseline
git diff --name-status 38b88bebd2c3f13ba2fbd54795e9ecc8619f8c0c..main

# Count commits after fixes implemented/verified through commit
git rev-list --count 2d7b45bdc998dc582874fc8ab32ac03f9c786c1e..main

# Inspect commit list since fixes implemented/verified through commit
git log --oneline 2d7b45bdc998dc582874fc8ab32ac03f9c786c1e..main

# Inspect file-level diff since fixes implemented/verified through commit
git diff --name-status 2d7b45bdc998dc582874fc8ab32ac03f9c786c1e..main
```

## Maintenance Rules

When a new audit is completed:

1. Add the new report to `audits/`.
2. Update `Audited-through commit`, `Audit fixes implemented/verified through commit`, and compare links.
3. Tag audited release commit(s) (for example `vX.Y.Z`).
4. Update README and release notes links if needed.
