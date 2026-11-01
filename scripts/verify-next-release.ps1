param(
  [string]$Repository = "xue-ding-e/DBX-Next"
)

$ErrorActionPreference = "Stop"
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot ".." )).Path
$configPath = Join-Path $repoRoot "src-tauri\tauri.conf.json"
$config = Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json
$workflowPath = Join-Path $repoRoot ".github\workflows\release-next.yml"
if (-not (Test-Path -LiteralPath $workflowPath -PathType Leaf)) {
  throw "Missing active DBX-Next release workflow: $workflowPath"
}
$workflow = Get-Content -LiteralPath $workflowPath -Raw
foreach ($requiredMarker in @("tauri-apps/tauri-action", 'DBX_${{ steps.release.outputs.version }}_x64-portable.zip', "dbx-cli-win32-x64.zip", "dbx-portable.cmd", "latest.json", "TAURI_SIGNING_PRIVATE_KEY_BASE64")) {
  if ($workflow -notlike "*$requiredMarker*") {
    throw "DBX-Next release workflow is missing required marker: $requiredMarker"
  }
}

$endpoints = @($config.plugins.updater.endpoints)
if (-not $endpoints -or ($endpoints | Where-Object { $_ -notmatch [regex]::Escape($Repository) })) {
  throw "Updater endpoints must all target $Repository."
}

$inheritedPublicKey = "dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IDkxNEYyMzE3QkJCNkM3REYKUldUZng3YTdGeU5Qa1NnTUZCRVhJVkxsOWZKQWFPVCtacUgySlNlcjRDU2RmZElCQnphd25pYUMK"
if ([string]$config.plugins.updater.pubkey -eq $inheritedPublicKey) {
  throw "The updater still uses the inherited upstream public key. Configure a DBX-Next signing key before releasing."
}

$privateKeyPresent =
  -not [string]::IsNullOrWhiteSpace($env:TAURI_SIGNING_PRIVATE_KEY) -or
  -not [string]::IsNullOrWhiteSpace($env:TAURI_SIGNING_PRIVATE_KEY_BASE64) -or
  -not [string]::IsNullOrWhiteSpace($env:TAURI_SIGNING_PRIVATE_KEY_PATH)
if (-not $privateKeyPresent) {
  throw "TAURI_SIGNING_PRIVATE_KEY, TAURI_SIGNING_PRIVATE_KEY_BASE64, or TAURI_SIGNING_PRIVATE_KEY_PATH is required for a DBX-Next release."
}

if ($env:TAURI_SIGNING_PRIVATE_KEY_PATH -and -not (Test-Path -LiteralPath $env:TAURI_SIGNING_PRIVATE_KEY_PATH -PathType Leaf)) {
  throw "TAURI_SIGNING_PRIVATE_KEY_PATH does not point to a private key file."
}

if ($env:GITHUB_REPOSITORY -and $env:GITHUB_REPOSITORY -ne $Repository) {
  throw "GITHUB_REPOSITORY is $($env:GITHUB_REPOSITORY), expected $Repository."
}

Write-Output "DBX-Next release signing prerequisites are present."
