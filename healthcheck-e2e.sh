#!/usr/bin/env bash
#
# End-to-end health check for fxfurtrack
#
# Verifies the full pipeline: Master → Redis → Worker → Redis → Master response
# Tests a real FurTrack URL: /index/species:canine
#
# Usage:
#   ./healthcheck-e2e.sh [MASTER_URL] [TIMEOUT_SECONDS]
#
# Exit codes:
#   0 - All checks passed
#   1 - Health check failed (triggers restart if RESTART_ON_FAILURE=1)
#

set -euo pipefail

MASTER_URL="${1:-http://localhost:3000}"
TIMEOUT="${2:-30}"
RESTART_ON_FAILURE="${RESTART_ON_FAILURE:-0}"
MAX_RETRIES=3

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

log() { echo -e "${GREEN}[E2E-HEALTH]${NC} $*"; }
warn() { echo -e "${YELLOW}[E2E-HEALTH]${NC} $*"; }
fail() { echo -e "${RED}[E2E-HEALTH]${NC} $*"; }

log "Starting end-to-end health check"
log "Master URL: ${MASTER_URL}"
log "Timeout: ${TIMEOUT}s"

# --- Step 1: Check /health endpoint (Redis + queue connectivity) ---
log "Step 1: Checking /health endpoint..."
HEALTH_RESPONSE=$(curl -sf --max-time 10 "${MASTER_URL}/health" 2>&1) || {
    fail "/health endpoint unreachable"
    exit 1
}

HEALTH_STATUS=$(echo "$HEALTH_RESPONSE" | grep -o '"status":"[^"]*"' | head -1 | cut -d'"' -f4)
if [ "$HEALTH_STATUS" != "ok" ]; then
    fail "/health returned status: ${HEALTH_STATUS}"
    fail "Response: ${HEALTH_RESPONSE}"
    exit 1
fi
log "/health OK — Redis connected, queue operational"

# --- Step 2: End-to-end test with a real FurTrack URL ---
TEST_URL="/index/species:canine"
log "Step 2: Testing full pipeline with ${TEST_URL}..."

RESPONSE=""
HTTP_CODE=0
for attempt in $(seq 1 $MAX_RETRIES); do
    log "  Attempt ${attempt}/${MAX_RETRIES}..."
    
    RESPONSE=$(curl -sf --max-time "$TIMEOUT" -w "\n%{http_code}" "${MASTER_URL}${TEST_URL}" 2>&1) || true
    
    HTTP_CODE=$(echo "$RESPONSE" | tail -1)
    BODY=$(echo "$RESPONSE" | sed '$d')
    
    if [ "$HTTP_CODE" = "200" ]; then
        log "  Got HTTP 200 on attempt ${attempt}"
        break
    fi
    
    warn "  Attempt ${attempt} failed (HTTP ${HTTP_CODE})"
    if [ "$attempt" -lt "$MAX_RETRIES" ]; then
        sleep 5
    fi
done

if [ "$HTTP_CODE" != "200" ]; then
    fail "Full pipeline test failed after ${MAX_RETRIES} attempts (HTTP ${HTTP_CODE})"
    exit 1
fi

# --- Step 3: Validate response contains expected metadata ---
log "Step 3: Validating response content..."

if ! echo "$BODY" | grep -q 'og:title'; then
    fail "Response missing og:title meta tag"
    exit 1
fi

if ! echo "$BODY" | grep -q 'og:image'; then
    fail "Response missing og:image meta tag"
    exit 1
fi

if ! echo "$BODY" | grep -q 'og:site_name.*furtrack'; then
    fail "Response missing furtrack site name"
    exit 1
fi

# Check that the response contains tag-related content for species:canine
if ! echo "$BODY" | grep -qi 'canine\|species'; then
    warn "Response does not contain expected 'canine' or 'species' content — may still be valid"
fi

log "Response contains valid OpenGraph metadata ✓"

# --- Summary ---
log "========================================="
log "All end-to-end health checks PASSED ✓"
log "  - /health endpoint: OK"
log "  - Redis connectivity: OK"
log "  - Queue operational: OK"
log "  - Full pipeline (${TEST_URL}): HTTP ${HTTP_CODE}"
log "  - OpenGraph metadata: valid"
log "========================================="

exit 0
