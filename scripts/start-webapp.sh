#!/usr/bin/env bash
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$PROJECT_ROOT"

source "$SCRIPT_DIR/common.sh"

API_PID=""
WEBAPP_PID=""

cleanup() {
  echo ""
  echo -e "${YELLOW}Cleaning up...${NC}"
  [ -n "$WEBAPP_PID" ] && kill $WEBAPP_PID 2>/dev/null || true
  [ -n "$API_PID" ] && kill $API_PID 2>/dev/null || true
  echo -e "${GREEN}Cleanup complete.${NC}"
}
trap cleanup EXIT INT TERM

echo -e "${GREEN}========================================${NC}"
echo -e "${GREEN}  Subscriptions Webapp Launcher${NC}"
echo -e "${GREEN}========================================${NC}"
echo ""

echo -e "${BLUE}[1/5] Preparing deploy keys...${NC}"
prepare_deploy_keys

echo ""
echo -e "${BLUE}[2/5] Building program (if needed)...${NC}"
check_program_so true

echo ""
echo -e "${BLUE}[3/5] Building client library...${NC}"
build_client_lib

echo ""
echo -e "${BLUE}[4/5] Starting API server...${NC}"
start_api_server
API_PID=$LAST_SERVICE_PID

echo ""
echo -e "${BLUE}[5/5] Starting webapp dev server...${NC}"
start_webapp_dev
WEBAPP_PID=$LAST_SERVICE_PID

echo ""
echo -e "${GREEN}========================================${NC}"
echo -e "${GREEN}  Services started successfully!${NC}"
echo -e "${GREEN}========================================${NC}"
echo ""
echo -e "  ${BLUE}API Server:${NC}  http://${API_HOST:-127.0.0.1}:3001"
echo -e "  ${BLUE}Webapp:${NC}      http://localhost:5173"
echo ""
echo -e "  ${YELLOW}Open http://localhost:5173 to begin setup${NC}"
echo -e "  ${YELLOW}Press Ctrl+C to stop all services${NC}"
echo ""

wait
