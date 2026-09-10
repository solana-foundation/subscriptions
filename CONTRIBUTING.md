# Contributing

Thanks for contributing to Subscriptions, the Solana program and clients for managed token delegations on SPL Token and Token-2022.

## Before you start

- Search existing issues and pull requests before opening a new one.
- For substantial changes, open an issue or start a discussion first so maintainers can confirm the approach. In general, small PRs are preferred.
- Do not include secrets, private keys, seed phrases, or production credentials in issues, pull requests, commits, logs, or screenshots.
- All commits into a Solana Foundation repository require [commit signature verification](https://docs.github.com/en/authentication/managing-commit-signature-verification/about-commit-signature-verification) to be enabled. Your PRs will not be merged without this.

## Security vulnerabilities

Do not report security vulnerabilities in public issues. Follow the [security policy](./SECURITY.md) and use the [Report a Vulnerability](https://github.com/solana-foundation/subscriptions/security/advisories/new) link. Expect a response in the advisory, typically within 72 hours.

## Development setup

Toolchain versions are checked into the repository: Rust in `rust-toolchain.toml` (installed automatically by rustup), Node.js in `.nvmrc` (`nvm use` or `fnm use`), and pnpm in the `packageManager` field of `package.json`. Do not update language runtimes, the Solana CLI, or package-manager versions as an incidental part of another change.

```sh
just setup          # verify tooling, install dependencies, configure git hooks
just build          # program .so, IDL, generated clients, TypeScript client
just check          # format check + lint check (also run by the pre-push hook)
just test           # Rust unit tests, LiteSVM integration tests, TypeScript client tests
```

`just --list` shows every recipe. The TypeScript client tests start and stop a local Surfpool validator; `just test-client` runs a fork pass followed by an offline pass.

## Making a change

Keep changes focused. A pull request should solve one problem and include the tests, documentation, generated artifacts, or migration notes needed to keep the repository usable.

Before opening a pull request:

- Run `just check` and `just test` for the affected code.
- Add or update tests when behavior changes. Rust unit tests live alongside the code in `program/src/`, integration tests in `tests/integration-tests/`, and TypeScript tests in `clients/typescript/test/`.
- Regenerate committed artifacts with `just generate-clients` whenever program types, instructions, events, or `#[codama(...)]` attributes change, and commit the resulting `idl/` and `clients/*/src/generated/` diff. CI runs `just check-generated` and fails on drift.
- Update `README.md`, the ADRs in `docs/`, and `CHANGELOG.md` when the change is part of the user-facing contract.
- Explain any new dependency and why the existing dependency set is insufficient. The program is built on Pinocchio; do not introduce `anchor-lang`.

For onchain changes, document relevant account validation, authority, state-transition, or value-movement considerations. Include a threat-model note when the change creates or modifies a trust boundary. Architecture decisions are recorded in [docs/](docs/) — read the relevant ADR before changing PDA layouts, delegation semantics, account versioning, or the upgrade path, and add a new ADR when the decision itself changes.

Compute-unit cost is part of the contract for an onchain program. CI posts a CU report on each PR; run `just test-and-benchmark` locally to see the same numbers before pushing a change to an instruction handler.

## Pull requests

Fill in every section of the pull request template: the problem, the approach, how you tested it, and the [AI disclosure](#disclosure). Link related issues and call out behavior changes, compatibility concerns, or follow-up work. CI fails the PR until the disclosure is declared. Use [Conventional Commits](https://www.conventionalcommits.org/) for your commit naming, and name branches `<type>/<short-description>` (for example `fix/plan-period-overflow`).

By default, [Greptile](https://www.greptile.com) is enabled on all Solana Foundation repositories. Before maintainers review, all Greptile comments must be resolved with either a code fix or an explanation of why no change is needed.

Once CI is approved to run by maintainers, all CI errors must be addressed before the PR will be merged.

Maintainers may ask you to rebase, split a broad change, add tests, or revise documentation before merging.

Reviewers are assigned from [CODEOWNERS](.github/CODEOWNERS). Changes to the program, the IDL, or the generated clients need a review from a program maintainer.

## AI use

You may use AI-assisted tools, but you should review the generated code, understand its behavior, and run the same checks expected of any other contribution.

If you are building with AI on Solana, check out the [Solana Dev Skill](https://github.com/solana-foundation/solana-dev-skill) or the [Solana MCP](https://mcp.solana.com/) to aid in your work. This repository ships a [CLAUDE.md](./CLAUDE.md) and [AGENTS.md](./AGENTS.md) with the repo-specific gotchas an agent needs — the non-Anchor wire format, the IDL build-script behavior, the two-pass TypeScript test setup — read it before letting an agent loose here.

Ensure that the generated code adheres to the project's coding standards and best practices. Maintainers can close PRs if they appear to be low-effort AI slop. In particular, audit your changes for the following AI code smells that increase maintenance burden:

- Comments that explain why the _previous_ behavior was wrong and the new behavior is correct. This can be helpful context for reviewers as a Github comment in the review, but we do not need a history of every code change living in the codebase
- Large blocks of comments with high density of technical jargon; comments should be distilled to clearly explain _why_ this code is doing something (if it's not obvious), not _what_ (the code should speak for itself).
- Drive-by refactoring of code that is not relevant to the actual change being made.

Two more that matter here: never hand-edit files under `idl/` or `clients/*/src/generated/` — regenerate them — and do not let an agent add defensive checks or allocations to instruction handlers without checking the CU report.

You must be able to explain every line of your diff without an LLM. Reviewers may ask you a pointed question about any part of the change; if the answer is pasted from a model or does not come, the PR is closed.

Tool attribution left in a PR (a `Generated with Claude Code` footer, a `Co-Authored-By: Claude` trailer, a `cursor/` or `codex/` branch, and the like) tells us the submission was opened without being read. CI labels these `ai-unreviewed`, fails the check, and explains what to fix. PRs left in that state are closed.

### Disclosure

Disclosure is required. The pull request template has two boxes; check exactly one. If AI tooling was used, name the tool and the extent, for example:

> I wrote all of the code for this feature, and had Claude update the documentation and create tests accordingly

or

> I architected the change and handed all implementation over to Codex

Editor autocomplete of single keywords or short phrases does not count as AI tooling.

### Communication

If maintainers have suggested changes, feedback, or questions about your code, you should not be copy/pasting the questions to an LLM and copy/pasting the response. You being able to distill the information that AI produces it what makes your contribution valuable.

## License

By contributing, you agree that your contributions are licensed under the project's [LICENSE](./LICENSE).
