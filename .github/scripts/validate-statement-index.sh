#!/usr/bin/env bash
set -euo pipefail

evidence_dir="${DBX_VALIDATION_EVIDENCE_DIR:-validation-evidence}"
mkdir -p "$evidence_dir"

run_checked_test() {
  local label="$1"
  local expected_count="$2"
  shift 2
  local log_path="$evidence_dir/$label.log"
  local status
  local -a pipeline_status
  set +e
  timeout --signal=TERM --kill-after=30s 1800 "$@" 2>&1 | tee "$log_path"
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
  if ! grep -F "test result: ok. $expected_count passed; 0 failed; 0 ignored;" "$log_path" >/dev/null; then
    printf '1\n' > "$evidence_dir/$label.exit"
    printf 'Expected %s passing tests for %s; validation is incomplete.\n' "$expected_count" "$label" | tee -a "$log_path" >&2
    return 1
  fi
}

run_checked_test cli-batch 6 cargo +1.99.1 test --locked -p dbx-cli --no-default-features --bin dbx batch_ -- --nocapture --test-threads=1
run_checked_test cli-transaction 1 cargo +1.99.1 test --locked -p dbx-cli --no-default-features --bin dbx tests::merged_transaction_output_counts_sql_not_merged_result_entries -- --exact --nocapture --test-threads=1
run_checked_test core-cancellation 1 cargo +1.99.1 test --locked -p dbx-core --no-default-features --features sqlite-bundled --lib query::tests::mysql_batch_cancellation_after_multiple_results_keeps_source_statement_index -- --exact --nocapture --test-threads=1

printf 'All 8 targeted production-function regressions passed.\n' | tee "$evidence_dir/result.txt"
