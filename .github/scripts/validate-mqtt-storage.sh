#!/usr/bin/env bash
set -euo pipefail

source_sha="${SOURCE_SHA:?missing product commit}"
base_sha="${BASE_SHA:?missing baseline commit}"
storage_path='crates/dbx-core/src/persistence/storage.rs'
storage_blob='eb652269ad964dbe81cca85f7ad699afa21d8d08'

check_sources() {
  test "$(git rev-parse HEAD)" = "${GITHUB_SHA:?missing validation commit}"
  test "$(git rev-parse HEAD^)" = "$source_sha"
  test "$(git rev-parse HEAD^^)" = "$base_sha"
  test "$(git rev-parse "$source_sha^{tree}")" = '27d1ec4dfc6200f855ee52b85d46f94c2ac670dd'
  test "$(git show -s --format=%P HEAD | wc -w)" -eq 1
  test "$(git show -s --format=%P HEAD^ | wc -w)" -eq 1
  test "$(git diff --name-only "$base_sha" "$source_sha")" = "$storage_path"
  test "$(git rev-parse "$source_sha:$storage_path")" = "$storage_blob"
  local expected actual
  expected="$(printf '%s\n' '.github/scripts/validate-mqtt-storage.sh' '.github/workflows/validate-mqtt-storage.yml' | LC_ALL=C sort)"
  actual="$(git diff --name-only "$source_sha" HEAD | LC_ALL=C sort)"
  test "$actual" = "$expected"
  git diff --exit-code
  test -z "$(git status --porcelain --untracked-files=no)"
}

check_sources
if [[ "${1:-}" == '--check-sources' ]]; then exit 0; fi

evidence_dir="${DBX_VALIDATION_EVIDENCE_DIR:-validation-evidence}"
mkdir -p "$evidence_dir"
git log -3 --format='%H %T %P %s' | tee "$evidence_dir/source.log"
sha256sum Cargo.lock "$storage_path" | tee "$evidence_dir/source-sha256.log"

# Build the real dbx-core test target once. No copied Storage implementation,
# broker, user profile, OS keyring or desktop executable is used by these tests.
set +e
timeout --signal=TERM --kill-after=30s 1800 \
  cargo +1.99.1 test --locked -p dbx-core --no-default-features \
  --features mq-admin,sqlite-bundled --lib --no-run 2>&1 | tee "$evidence_dir/compiler.log"
build_pipeline_status=("${PIPESTATUS[@]}")
set -e
build_status="${build_pipeline_status[0]}"
if [[ "$build_status" -eq 0 && "${build_pipeline_status[1]}" -ne 0 ]]; then
  build_status="${build_pipeline_status[1]}"
fi
printf '%s\n' "$build_status" > "$evidence_dir/compiler.exit"
if [[ "$build_status" -ne 0 ]]; then exit "$build_status"; fi

run_checked_test() {
  local label="$1" expected_count="$2" filter="$3" exact="$4"
  local -a command pipeline_status
  # Let Cargo provide the crate working directory and runtime library paths.
  # This reuses the exact features and build cache from the no-run step above.
  command=(cargo +1.99.1 test --locked -p dbx-core --no-default-features
    --features mq-admin,sqlite-bundled --lib "$filter" -- --nocapture --test-threads=1 --color never)
  if [[ "$exact" == 'yes' ]]; then command+=(--exact); fi
  set +e
  timeout --signal=TERM --kill-after=10s 120 "${command[@]}" 2>&1 | tee "$evidence_dir/$label.log"
  pipeline_status=("${PIPESTATUS[@]}")
  set -e
  local code="${pipeline_status[0]}"
  if [[ "$code" -eq 0 && "${pipeline_status[1]}" -ne 0 ]]; then code="${pipeline_status[1]}"; fi
  printf '%s\n' "$code" > "$evidence_dir/$label.exit"
  if [[ "$code" -ne 0 ]]; then return "$code"; fi
  python3 - "$evidence_dir/$label.log" "$expected_count" "$filter" "$exact" <<'PY'
import pathlib, re, sys
text = pathlib.Path(sys.argv[1]).read_text()
expected = int(sys.argv[2])
assert expected > 0
summaries = re.findall(r'^test result: ok\. (\d+) passed; (\d+) failed; (\d+) ignored;', text, re.MULTILINE)
assert summaries == [(str(expected), '0', '0')], (sys.argv[1], summaries)
if sys.argv[4] == 'yes':
    assert f'test {sys.argv[3]} ... ok' in text, (sys.argv[3], text)
PY
}

for test_name in \
  mqtt_certificate_password_is_encrypted_at_rest_and_hydrated_on_load \
  migration_moves_legacy_mqtt_certificate_password_into_secret_store \
  mqtt_certificate_sanitized_save_preserves_existing_password \
  mqtt_certificate_auth_kind_change_to_none_deletes_stored_password \
  mqtt_password_is_encrypted_at_rest_and_hydrated_on_load \
  connection_secrets_are_encrypted_at_rest_and_legacy_rows_migrate \
  legacy_plaintext_secrets_are_migrated_during_reopen \
  save_connection_mqtt_saved_topics_updates_only_target_and_preserves_secrets \
  save_connection_mqtt_saved_topics_rejects_non_object_external_config; do
  run_checked_test "$test_name" 1 "persistence::storage::tests::$test_name" yes
done

run_checked_test connection-secret-store 24 'connection::connection_secrets::tests::' no
check_sources
printf 'PASS: 9 exact Storage regressions plus 24 connection-secret-store tests. Synthetic data only.\n'
