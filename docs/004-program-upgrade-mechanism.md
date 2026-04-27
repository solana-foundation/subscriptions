# Program Upgrade Mechanism

Program upgrades are governed by a [Squads](https://squads.xyz/) multisig and deployed via [txtx/Surfpool](https://docs.surfpool.run/).

## Signer Configuration

Each environment uses a pair of signers defined in `runbooks/deployment/signers.<env>.tx`:

| Environment | Payer             | Authority         |
| ----------- | ----------------- | ----------------- |
| localnet    | `svm::secret_key` | `svm::secret_key` |
| devnet      | `svm::web_wallet` | `svm::squads`     |
| mainnet     | `svm::web_wallet` | `svm::squads`     |

For environments using Squads, the authority signer is configured as:

```hcl
signer "authority" "svm::squads" {
    description = "Squads multisig controlling program upgrade authority"
    address = env.squads_vault_address
}
```

## Deploying / Upgrading

Run the deployment runbook with the appropriate environment:

```bash
surfpool run deployment --signers signers.<env>.tx
```

When the authority is a Squads signer, Surfpool automatically creates a multisig proposal. Each member approves via Squads UI or Surfpool Studio, and the upgrade executes once the threshold is met.

## Verifying a Proposed Upgrade

Before approving a Squads proposal, each multisig member should verify that the buffer bytecode matches the source code.

### 1. Build from the target commit

```bash
git checkout <COMMIT_HASH>
solana-verify build
```

### 2. Hash the local build

```bash
solana-verify get-executable-hash target/deploy/subscriptions.so
```

### 3. Hash the on-chain buffer

The buffer address is shown in the Squads proposal.

```bash
solana-verify get-buffer-hash -u <RPC_URL> <BUFFER_ADDRESS>
```

### 4. Compare

If the hashes match, the buffer contains exactly the bytecode from that commit — approve. If they don't match, reject and investigate.

## Verifying a Deployed Program

After an upgrade, anyone can verify the on-chain program matches the public source:

```bash
solana-verify verify-from-repo \
    --program-id <PROGRAM_ID> \
    --url https://github.com/solana-program/subscriptions
```

## References

- [Squads Protocol](https://squads.xyz/)
- [Squads Program Upgrade Management](https://squads.xyz/blog/solana-multisig-program-upgrades-management)
- [Surfpool SVM Signers](https://docs.surfpool.run/iac/svm/signers)
- [Solana Verified Builds](https://solana.com/docs/programs/verified-builds)
