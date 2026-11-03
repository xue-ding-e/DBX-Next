#!/usr/bin/env bash
set -euo pipefail

if [[ "${1:-}" == "--check-sources" ]]; then
  test "$(git rev-parse HEAD)" = "${GITHUB_SHA:?missing workflow source SHA}"
  expected_paths="$(printf '%s\n' 'apps/desktop/src/components/connection/ConnectionDialog.vue' 'apps/desktop/src/components/connection/__tests__/ConnectionDialog.mqttCertificate.spec.ts' 'crates/dbx-core/src/admin/mqtt/client.rs' 'crates/dbx-core/src/connection/connection_secrets.rs' 'crates/dbx-types/src/mqtt.rs' '.github/workflows/validate-mqtt-certificate.yml' '.github/scripts/validate-mqtt-certificate.sh' | LC_ALL=C sort)"
  actual_paths="$(git diff --name-only HEAD^ HEAD | LC_ALL=C sort)"
  test "$actual_paths" = "$expected_paths"
  exit 0
fi

evidence_dir="${DBX_VALIDATION_EVIDENCE_DIR:-validation-evidence}"
mkdir -p "$evidence_dir"

run_checked_test() {
  local label="$1"
  local expected_count="$2"
  local expected_ignored="$3"
  local seconds="$4"
  shift 4
  local log_path="$evidence_dir/$label.log"
  local status
  local -a pipeline_status
  set +e
  timeout --signal=TERM --kill-after=30s "$seconds" "$@" 2>&1 | tee "$log_path"
  pipeline_status=("${PIPESTATUS[@]}")
  status="${pipeline_status[0]}"
  set -e
  if [[ "$status" -eq 0 && "${pipeline_status[1]}" -ne 0 ]]; then
    status="${pipeline_status[1]}"
  fi
  printf '%s\n' "$status" > "$evidence_dir/$label.exit"
  if [[ "$status" -ne 0 ]]; then
    return "$status"
  fi
  # Cargo exits successfully when a filter matches no tests. Require the
  # reviewed test count so a typo or renamed test cannot produce a false green.
  if ! grep -F "test result: ok. $expected_count passed; 0 failed; $expected_ignored ignored;" "$log_path" >/dev/null; then
    printf '1\n' > "$evidence_dir/$label.exit"
    printf 'Expected %s passing tests for %s; validation is incomplete.\n' "$expected_count" "$label" | tee -a "$log_path" >&2
    return 1
  fi
}

run_checked_test mqtt-types 189 0 300 cargo +1.99.1 test --locked -p dbx-types --no-default-features --features mq-admin --lib -- --nocapture --test-threads=1
run_checked_test mqtt-client 4 0 1800 cargo +1.99.1 test --locked -p dbx-core --no-default-features --features mq-admin,sqlite-bundled --lib admin::mqtt::client::tests::certificate_auth_ -- --nocapture --test-threads=1
run_checked_test mqtt-secrets 24 0 300 cargo +1.99.1 test --locked -p dbx-core --no-default-features --features mq-admin,sqlite-bundled --lib connection::connection_secrets::tests:: -- --nocapture --test-threads=1

set +e
timeout --signal=TERM --kill-after=30s 300 pnpm exec vitest run apps/desktop/src/components/connection/__tests__/ConnectionDialog.mqttCertificate.spec.ts --maxWorkers=1 --reporter=json --outputFile="$evidence_dir/component.json" 2>&1 | tee "$evidence_dir/component.log"
status=("${PIPESTATUS[@]}")
set -e
code="${status[0]}"
if [[ "$code" -eq 0 && "${status[1]}" -ne 0 ]]; then code="${status[1]}"; fi
printf '%s\n' "$code" > "$evidence_dir/component.exit"
if [[ "$code" -ne 0 ]]; then exit "$code"; fi
if ! node -e 'const r=require(process.argv[1]); if(r.success!==true||r.numTotalTests!==2||r.numPassedTests!==2||r.numFailedTests!==0||r.numPendingTests!==0)process.exit(1)' "$(realpath "$evidence_dir/component.json")"; then
  printf '1\n' > "$evidence_dir/component.exit"
  printf 'Expected exactly two passing component tests.\n' | tee -a "$evidence_dir/component.log" >&2
  exit 1
fi
printf '189 types, 4 MQTT client, 24 secret-store and 2 component tests passed. No live broker was used.\n' | tee "$evidence_dir/result.txt"
