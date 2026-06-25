# Subscriptions - Solana program build automation
# https://github.com/casey/just

# Use bash for all recipes
set shell := ["bash", "-uc"]

# Variables
program_dir := "program"
ts_client_dir := "clients/typescript"
webapp_dir := "webapp"
idl_file := "idl/subscriptions.json"
generated_paths := "idl clients/typescript/src/generated clients/rust/src/generated"

# List available recipes
default:
    @just --list

# ============================================
# Setup and initialization
# ============================================

# Install dependencies and configure git hooks
setup: setup-hooks
    #!/usr/bin/env bash
    set -euo pipefail

    commands=(pnpm cargo solana-keygen surfpool)
    for cmd in "${commands[@]}"; do
        if ! command -v "$cmd" &>/dev/null; then
            echo "Error: $cmd is required but not installed"
            exit 1
        fi
    done

    pnpm install
    echo "✓ Setup complete"

# Configure git hooks path
setup-hooks:
    git config core.hooksPath .githooks
    @echo "✓ Git hooks configured"

# Print program ID from keypair
program-id:
    @sed -n 's/.*declare_id!("\([^"]*\)").*/\1/p' "{{program_dir}}/src/lib.rs"

# ============================================
# Build recipes
# ============================================

# Build everything (program + clients)
build: build-program build-client

# Compile Solana program to .so
build-program:
    cd {{program_dir}} && cargo build-sbf
    @echo "✓ Program built"

# Build the example transfer-hook program used as a CPI target in integration tests
build-test-hook:
    cd tests/transfer-hook-example && cargo build-sbf
    @echo "✓ Test transfer-hook program built"

# Generate IDL from Rust source
generate-idl:
    pnpm run generate-idl
    @echo "✓ IDL generated"

# Generate TypeScript and Rust clients from IDL
generate-clients: generate-idl
    pnpm run generate-clients
    @echo "✓ Clients generated"

# Check that committed IDL and generated clients are current
check-generated: generate-clients
    #!/usr/bin/env bash
    set -euo pipefail

    if ! git diff --quiet -- {{generated_paths}} || [[ -n "$(git ls-files --others --exclude-standard -- {{generated_paths}})" ]]; then
        echo "Error: IDL or generated clients are out of date"
        echo "Run: just generate-clients"
        git status --short -- {{generated_paths}}
        git diff -- {{generated_paths}}
        exit 1
    fi

    echo "✓ IDL and generated clients are up-to-date"

# Backwards-compatible alias for the old recipe name
generate-client: generate-clients
    @true

# Build TypeScript client
build-client: generate-clients
    cd {{ts_client_dir}} && pnpm run build
    @echo "✓ TypeScript client built"

# ============================================
# Test recipes
# ============================================

# Run all tests
test *args: unit-test (integration-test args) test-client

# Run Rust unit tests
unit-test:
    cargo test -p subscriptions-program

# Backwards-compatible alias for the old recipe name
test-program: unit-test
    @true

# Run Rust integration tests
integration-test *args: build-program build-test-hook
    #!/usr/bin/env bash
    set -euo pipefail
    cargo test -p tests-subscriptions "$@"

# Run tests with compute unit benchmark report
test-and-benchmark: build-program build-test-hook
    CU_REPORT=1 CU_REPORT_DATE=$(date +%Y-%m-%d) cargo test -p tests-subscriptions

# Run TypeScript client integration tests (fork pass, then offline pass for getProgramAccounts)
test-client: build-program build-test-hook generate-clients
    #!/usr/bin/env bash
    set -euo pipefail
    trap 'just kill-validator' EXIT

    just kill-validator
    just _start-surfpool fork
    ( cd {{ts_client_dir}} && pnpm run test )

    just kill-validator
    just _start-surfpool offline
    ( cd {{ts_client_dir}} && pnpm run test:offline )

# ============================================
# Validator management
# ============================================

# Start surfpool validator if not already running
ensure-surfpool:
    #!/usr/bin/env bash
    set -euo pipefail

    if curl -sf -X POST http://localhost:8899 \
        -H "Content-Type: application/json" \
        -d '{"jsonrpc":"2.0","id":1,"method":"getHealth"}' &>/dev/null; then
        echo "✓ Validator already running"
        exit 0
    fi

    just _start-surfpool fork

# Start a fresh surfpool validator and deploy the program. mode=fork|offline
_start-surfpool mode="fork":
    #!/usr/bin/env bash
    set -euo pipefail

    PROG_ID=$(sed -n 's/.*declare_id!("\([^"]*\)").*/\1/p' "{{program_dir}}/src/lib.rs")
    if [[ -z "$PROG_ID" ]]; then
        echo "Error: could not parse declare_id! from {{program_dir}}/src/lib.rs"
        exit 1
    fi

    extra=""
    if [[ "{{mode}}" == "offline" ]]; then
        extra="--offline"
    fi

    echo "Starting surfpool validator ({{mode}})..."
    mkdir -p .surfpool
    nohup surfpool start --ci --no-tui --block-production-mode transaction $extra \
        --runbook surfnet-setup \
        > /tmp/surfpool.log 2>&1 &
    echo $! > .surfpool/pid.txt

    for i in {1..30}; do
        if curl -sf -X POST http://localhost:8899 \
            -H "Content-Type: application/json" \
            -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"getAccountInfo\",\"params\":[\"$PROG_ID\",{\"encoding\":\"base64\"}]}" \
            | grep -q '"executable":true'; then
            echo "✓ Program deployed successfully ($PROG_ID)"
            exit 0
        fi
        echo "Waiting for program deployment... ($i/30)"
        sleep 2
    done

    echo "Error: Program deployment failed"
    echo "Surfpool logs:"
    cat /tmp/surfpool.log
    just kill-validator
    exit 1

# Bootstrap localnet (validator + program + mock USDC) and write webapp/.env.local for pnpm dev (no api server)
dev-local: ensure-surfpool
    #!/usr/bin/env bash
    set -euo pipefail

    pushd {{webapp_dir}}/scripts > /dev/null
    pnpm install --silent
    NETWORK=localnet RPC_URL=http://127.0.0.1:8899 pnpm run init
    popd > /dev/null

    PROG_ID=$(just program-id)
    USDC_MINT=$(node -e "const c=JSON.parse(require('fs').readFileSync('{{webapp_dir}}/config.json'));process.stdout.write(c.networks.localnet.tokens.find(t=>t.symbol==='USDC').mint)")

    {
        echo "VITE_DEFAULT_CLUSTER=solana:localnet"
        echo "VITE_LOCALNET_PROGRAM=$PROG_ID"
        echo "VITE_LOCALNET_USDC_MINT=$USDC_MINT"
    } > {{webapp_dir}}/.env.local
    echo "✓ {{webapp_dir}}/.env.local written"
    echo "    VITE_LOCALNET_PROGRAM=$PROG_ID"
    echo "    VITE_LOCALNET_USDC_MINT=$USDC_MINT"
    echo ""
    echo "Next: pnpm --filter webapp dev"

# Stop all validators
kill-validator:
    #!/usr/bin/env bash
    set -euo pipefail

    if [[ -f .surfpool/pid.txt ]]; then
        pid=$(cat .surfpool/pid.txt)
        kill -9 "$pid" 2>/dev/null || true
    fi

    killall -9 solana-test-validator 2>/dev/null || true
    killall -9 surfpool 2>/dev/null || true
    rm -f .surfpool/pid.txt 2>/dev/null || true
    rm -rf .validator-ledger 2>/dev/null || true
    echo "✓ All validators stopped"

# ============================================
# Webapp recipes
# ============================================

# Start webapp stack (builds client, starts API + Vite)
webapp-run:
    ./scripts/start-webapp.sh

webapp-test:
    cd {{webapp_dir}} && pnpm run test

# Kill all webapp processes and remove all generated state
webapp-clean:
    #!/usr/bin/env bash
    set -euo pipefail

    echo "Stopping webapp processes..."
    pkill -f "surfpool" 2>/dev/null || true
    pkill -f "solana-test-validator" 2>/dev/null || true
    pkill -f "tsx.*server.ts" 2>/dev/null || true
    pkill -f "vite" 2>/dev/null || true

    echo "Removing generated state..."
    rm -rf target/deploy/
    rm -rf {{webapp_dir}}/{dist,node_modules,api/node_modules,scripts/node_modules}
    rm -rf .validator-ledger .surfpool
    rm -f /tmp/{surfpool,api,webapp,validator}.log

    echo "Done"

# ============================================
# Clean recipes
# ============================================

# Clean everything: build artifacts, deps, validators, ledger
clean:
    #!/usr/bin/env bash
    set -euo pipefail

    echo "Stopping services..."
    pkill -f "solana-test-validator" 2>/dev/null || true
    pkill -f "surfpool" 2>/dev/null || true

    echo "Cleaning program build artifacts..."
    cargo clean

    echo "Cleaning client build artifacts..."
    cd {{ts_client_dir}} && pnpm run clean || true
    cd -

    echo "Cleaning webapp..."
    rm -rf {{webapp_dir}}/{node_modules,dist,api/node_modules,scripts/node_modules}
    rm -rf .{validator-ledger,surfpool}
    rm -f /tmp/{surfpool,api,webapp}.log

    echo "✓ Clean complete"

# ============================================
# Format and lint recipes
# ============================================

# Check formatting without fixing
fmt-check:
    @echo "Checking Rust formatting..."
    @cargo fmt -p subscriptions-program -p tests-subscriptions --check
    @echo "Checking TypeScript formatting..."
    @pnpm run format:check
    @echo "✓ Format check passed"

# Auto-format all code
fmt:
    @echo "Formatting Rust..."
    @cargo fmt -p subscriptions-program -p tests-subscriptions
    @echo "Formatting TypeScript..."
    @pnpm run format
    @echo "✓ Code formatted"

# Lint with auto-fix
lint:
    @echo "Linting Rust..."
    @cargo clippy --workspace --exclude subscriptions --all-targets --no-deps --fix -- -D warnings
    @echo "Linting TypeScript..."
    @pnpm run lint:fix
    @echo "✓ Code linted"

# Check linting without fixing
lint-check:
    @echo "Checking Rust lint..."
    @cargo clippy --workspace --exclude subscriptions --all-targets --no-deps -- -D warnings
    @echo "Checking TypeScript lint..."
    @pnpm run lint
    @echo "✓ Lint check passed"

# Run all code quality checks
check: fmt-check lint-check

# ============================================
# IDL Deployment (uses Program Metadata Program)
# ============================================

[private]
check-program-metadata:
    @command -v program-metadata >/dev/null 2>&1 || { echo "Error: program-metadata not installed. See https://github.com/solana-program/program-metadata"; exit 1; }

# Deploy IDL to devnet (requires PROGRAM_UPGRADE_AUTHORITY_KEYPAIR env var)
deploy-idl-devnet: check-program-metadata
    #!/usr/bin/env bash
    set -euo pipefail
    KP="${PROGRAM_UPGRADE_AUTHORITY_KEYPAIR:?Set PROGRAM_UPGRADE_AUTHORITY_KEYPAIR (e.g. via doppler run -- just deploy-idl-devnet)}"
    PROG_ID=$(sed -n 's/.*declare_id!("\([^"]*\)").*/\1/p' "{{program_dir}}/src/lib.rs")
    program-metadata write idl "$PROG_ID" {{idl_file}} \
        --keypair "$KP" \
        --rpc https://api.devnet.solana.com

# Deploy IDL to mainnet (requires PROGRAM_UPGRADE_AUTHORITY_KEYPAIR env var)
deploy-idl-mainnet: check-program-metadata
    #!/usr/bin/env bash
    set -euo pipefail
    KP="${PROGRAM_UPGRADE_AUTHORITY_KEYPAIR:?Set PROGRAM_UPGRADE_AUTHORITY_KEYPAIR (e.g. via doppler run -- just deploy-idl-mainnet)}"
    PROG_ID=$(sed -n 's/.*declare_id!("\([^"]*\)").*/\1/p' "{{program_dir}}/src/lib.rs")
    program-metadata write idl "$PROG_ID" {{idl_file}} \
        --keypair "$KP" \
        --rpc https://api.mainnet-beta.solana.com

# ============================================
# Build Verification (uses solana-verify CLI)
# ============================================

[private]
check-solana-verify:
    @command -v solana-verify >/dev/null 2>&1 || { echo "Error: solana-verify not installed. Run: cargo install solana-verify"; exit 1; }

# Verify mainnet deployment against repo (remote build via OtterSec).
# Note: Remote verification (--remote) only works on mainnet.
# Apple Silicon (local builds without --remote): enable Docker/Colima Rosetta and
# `export DOCKER_DEFAULT_PLATFORM=linux/amd64`. The pinned verify image is amd64-only,
# so the SBF build fails on getrandom under arm64 emulation without it.
verify-mainnet: check-solana-verify
    #!/usr/bin/env bash
    set -euo pipefail
    PROG_ID=$(sed -n 's/.*declare_id!("\([^"]*\)").*/\1/p' "{{program_dir}}/src/lib.rs")
    solana-verify verify-from-repo \
        https://github.com/solana-foundation/subscriptions \
        --program-id "$PROG_ID" \
        --library-name subscriptions_program \
        --remote \
        -um

verify-local: check-solana-verify
    solana-verify build --library-name subscriptions_program
