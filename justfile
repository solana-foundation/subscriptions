# Subscriptions - Solana program build automation
# https://github.com/casey/just

# Use bash for all recipes
set shell := ["bash", "-uc"]

# Variables
program_dir := "programs/subscriptions"
ts_client_dir := "clients/typescript"
webapp_dir := "webapp"
deploy_key := "keys/subscriptions-keypair.json"
target_deploy_key := "target/deploy/subscriptions-keypair.json"
idl_file := program_dir / "idl/subscriptions.json"

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
    @solana-keygen pubkey "{{deploy_key}}"

# Copy deployment keypair to build directory
prepare-deploy-keys:
    #!/usr/bin/env bash
    set -euo pipefail

    mkdir -p "target/deploy"

    if [[ ! -f "{{deploy_key}}" ]]; then
        echo "Error: {{deploy_key}} not found."
        echo "This keypair defines the program identity. Do not generate a random one."
        echo "Restore it from git history: git show <commit>^:keys/subscriptions-keypair.json > {{deploy_key}}"
        exit 1
    fi

    PROG_ID=$(solana-keygen pubkey "{{deploy_key}}")
    DECLARED_ID=$(sed -n 's/.*declare_id!("\([^"]*\)").*/\1/p' "{{program_dir}}/src/lib.rs")

    if [[ "$DECLARED_ID" != "$PROG_ID" ]]; then
        echo "Error: declare_id! ($DECLARED_ID) does not match keypair ($PROG_ID)"
        echo "Update declare_id! in {{program_dir}}/src/lib.rs or restore the correct keypair."
        exit 1
    fi

    cp "{{deploy_key}}" "{{target_deploy_key}}"
    echo "✓ Deploy key ready (program: $PROG_ID)"

# ============================================
# Build recipes
# ============================================

# Check if rebuild is needed (exits 0 if rebuild needed, 1 if up-to-date)
[private]
needs-rebuild target source:
    #!/usr/bin/env bash
    if [[ -f "{{target}}" ]] && [[ "{{source}}" -ot "{{target}}" ]]; then
        echo "✓ {{target}} is up-to-date"
        exit 1
    fi

# Build everything (program + clients)
build: prepare-deploy-keys build-program build-client

# Compile Solana program to .so
build-program: prepare-deploy-keys
    cd {{program_dir}} && cargo build-sbf
    @echo "✓ Program built"

# Generate IDL from Rust source
generate-idl:
    #!/usr/bin/env bash
    set -euo pipefail

    if just needs-rebuild "{{idl_file}}" "{{program_dir}}/src/instructions/mod.rs" 2>/dev/null; then
        cd {{program_dir}}
        cargo build
        echo "✓ IDL generated"
    fi

# Generate TypeScript and Rust clients from IDL
generate-client: generate-idl
    #!/usr/bin/env bash
    set -euo pipefail

    if just needs-rebuild "clients/typescript/src/generated/index.ts" "{{idl_file}}" 2>/dev/null; then
        pnpm run generate
        echo "✓ Clients generated"
    fi

# Build TypeScript client
build-client: generate-client
    #!/usr/bin/env bash
    set -euo pipefail

    if just needs-rebuild "{{ts_client_dir}}/dist/index.js" "clients/typescript/src/generated/index.ts" 2>/dev/null; then
        cd {{ts_client_dir}}
        pnpm run build
        echo "✓ TypeScript client built"
    fi

# ============================================
# Test recipes
# ============================================

# Run all tests
test: test-program test-client

# Run E2E tests against the dev UI (requires PLAYRIGHT_WALLET and PLAYWRIGHT_TOKEN_MINT in .env)
e2e-test:
    pnpm --filter @subscriptions/web test:e2e

# Run Rust program tests
test-program:
    cd {{program_dir}} && cargo test-sbf

# Run tests with compute unit benchmark report
test-and-benchmark:
    cd {{program_dir}} && CU_REPORT=1 CU_REPORT_DATE=$(date +%Y-%m-%d) cargo test-sbf

# Run TypeScript client integration tests
test-client: build-program generate-client ensure-surfpool
    cd {{ts_client_dir}} && pnpm run test

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

    PROG_ID=$(solana-keygen pubkey "{{deploy_key}}")

    echo "Starting surfpool validator..."
    mkdir -p .surfpool
    nohup surfpool start --ci --no-tui --block-production-mode transaction \
        > /tmp/surfpool.log 2>&1 &
    echo $! > .surfpool/pid.txt

    for i in {1..7}; do
        if curl -sf -X POST http://localhost:8899 \
            -H "Content-Type: application/json" \
            -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"getAccountInfo\",\"params\":[\"$PROG_ID\",{\"encoding\":\"base64\"}]}" \
            | grep -q '"executable":true'; then
            echo "✓ Program deployed successfully ($PROG_ID)"
            exit 0
        fi
        echo "Waiting for program deployment... ($i/7)"
        sleep 1
    done

    echo "Error: Program deployment failed"
    echo "Surfpool logs:"
    cat /tmp/surfpool.log
    just kill-validator
    exit 1

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

    echo "Cleaning program..."
    cargo clean
    rm -f {{idl_file}}

    echo "Cleaning client..."
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
    @cargo fmt -p subscriptions --check
    @echo "Checking TypeScript formatting..."
    @cd {{ts_client_dir}} && pnpm run format:check
    @echo "✓ Format check passed"

# Auto-format all code
fmt:
    @echo "Formatting Rust..."
    @cargo fmt -p subscriptions
    @echo "Formatting TypeScript..."
    @cd {{ts_client_dir}} && pnpm run format
    @echo "✓ Code formatted"

# Lint with auto-fix
lint:
    @echo "Linting Rust..."
    @cargo clippy --workspace --exclude subscriptions-client --all-targets --no-deps --fix -- -D warnings
    @echo "Linting TypeScript..."
    @cd {{ts_client_dir}} && pnpm run lint
    @echo "✓ Code linted"

# Check linting without fixing
lint-check:
    @echo "Checking Rust lint..."
    @cargo clippy --workspace --exclude subscriptions-client --all-targets --no-deps -- -D warnings
    @echo "Checking TypeScript lint..."
    @cd {{ts_client_dir}} && pnpm run lint:check
    @echo "✓ Lint check passed"

# Run all code quality checks
check: fmt-check lint-check
