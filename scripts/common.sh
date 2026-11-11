#!/usr/bin/env bash
# Shared configuration and functions for scripts

# Configuration (can be overridden via environment)
KEYPAIR_FILE="${KEYPAIR_FILE:-keys/subscriptions-keypair.json}"
PROGRAM_SO="${PROGRAM_SO:-target/deploy/subscriptions_program.so}"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

# Track last spawned service PID
LAST_SERVICE_PID=""

check_program_so() {
  local build_if_missing="${1:-false}"
  if [ ! -f "$PROGRAM_SO" ]; then
    if [ "$build_if_missing" = true ]; then
      echo -e "${YELLOW}Program SO file not found. Building...${NC}"
      SCRIPT_DIR_COMMON="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
      PROJECT_ROOT_COMMON="$( cd "$SCRIPT_DIR_COMMON/.." && pwd )"
      cd "$PROJECT_ROOT_COMMON/program" && cargo build-sbf
      cd "$PROJECT_ROOT_COMMON"
    else
      echo -e "${YELLOW}Warning: Program SO file not found: $PROGRAM_SO${NC}"
      echo -e "${YELLOW}Run 'just build-program' first to build the program.${NC}"
      exit 1
    fi
  fi
}

# Polls a local HTTP endpoint until it responds. Returns 1 on timeout.
wait_for_http() {
  local url="$1"
  local label="$2"
  local timeout="${3:-15}"
  local match="${4:-}"

  echo -e "${YELLOW}  Waiting for ${label}...${NC}"
  for i in $(seq 1 $timeout); do
    if [ -n "$match" ]; then
      curl -s "$url" 2>/dev/null | grep -q "$match" && break
    else
      curl -sf "$url" >/dev/null 2>&1 && break
    fi
    if [ $i -eq $timeout ]; then
      echo -e "  ${RED}${label} failed to start within ${timeout}s${NC}"
      return 1
    fi
    sleep 1
  done
  echo -e "  ${GREEN}${label} is ready!${NC}"
  return 0
}

# Copy keypair to target/deploy/
prepare_deploy_keys() {
  mkdir -p "target/deploy"
  if [[ -f "$KEYPAIR_FILE" ]]; then
    cp "$KEYPAIR_FILE" "target/deploy/subscriptions_program-keypair.json"
    echo -e "  ${GREEN}Deploy key copied${NC}"
  else
    # Post-rotation (#30) the canonical keypair lives only on the deploy
    # authority's machine. Surfpool installs the program at the canonical
    # address via the surfnet-setup runbook (no keypair required), so a
    # missing keypair is fine for local webapp runs.
    echo -e "  ${YELLOW}$KEYPAIR_FILE not found; skipping (surfpool deploys via surfnet-setup)${NC}"
  fi
}

# Build the TypeScript client library
build_client_lib() {
  local project_root
  project_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
  cd "$project_root/clients/typescript" && pnpm install --silent && pnpm run build
  cd "$project_root"
  echo -e "  ${GREEN}Client built${NC}"
}

# Start API server on :3001
start_api_server() {
  local project_root
  project_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
  local api_host="${API_HOST:-127.0.0.1}"
  local health_host="$api_host"
  if [ "$health_host" = "0.0.0.0" ] || [ "$health_host" = "::" ]; then
    health_host="127.0.0.1"
  fi
  local health_url_host="$health_host"
  case "$health_host" in
    *:*) health_url_host="[$health_host]" ;;
  esac

  pkill -f "tsx.*server.ts" 2>/dev/null || true
  sleep 1

  cd "$project_root/webapp/api" && pnpm install --silent
  pnpm run dev > /tmp/api.log 2>&1 &
  LAST_SERVICE_PID=$!
  cd "$project_root"
  echo "  API PID: $LAST_SERVICE_PID"
  wait_for_http "http://$health_url_host:3001/api/health" "API server" 15 '"status"' || exit 1
}

# Start Vite dev server on :5173
start_webapp_dev() {
  local project_root
  project_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

  if curl -s http://localhost:5173 2>/dev/null | grep -q 'html'; then
    echo -e "  ${GREEN}Webapp already running on port 5173${NC}"
    LAST_SERVICE_PID=""
    return 0
  fi

  cd "$project_root/webapp" && pnpm install --silent
  pnpm run dev > /tmp/webapp.log 2>&1 &
  LAST_SERVICE_PID=$!
  cd "$project_root"
  echo "  Webapp PID: $LAST_SERVICE_PID"
  wait_for_http "http://localhost:5173" "Webapp" 15 'html' || exit 1
}
