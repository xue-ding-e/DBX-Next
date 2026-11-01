param(
  [string]$BaseRef = "upstream-main",
  [string]$HeadRef = "main",
  [string]$OutputPath = ""
)

$ErrorActionPreference = "Stop"
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot ".." )).Path

if (-not (Test-Path (Join-Path $repoRoot ".git"))) {
  throw "Not a Git repository: $repoRoot"
}

$excludedFiles = @(
  "crates/dbx-core/src/host/update.rs",
  "src-tauri/src/commands/update.rs",
  "src-tauri/tauri.conf.json",
  "apps/desktop/src/composables/useAppUpdater.ts",
  "apps/desktop/src/composables/__tests__/useAppUpdater.spec.ts",
  "apps/desktop/src/components/layout/UpdateDialog.spec.ts",
  "apps/desktop/src/lib/app/changelog.ts",
  "apps/desktop/src/App.vue",
  "scripts/prepare-upstream-pr.ps1",
  "scripts/switch-to-next-main.ps1",
  "scripts/sync-next-upstream.ps1",
  "scripts/verify-next-release.ps1",
  "docs/self-update-and-signing-playbook.md"
)

foreach ($ref in @($BaseRef, $HeadRef)) {
  $null = & git -C $repoRoot rev-parse --verify "$ref^{commit}" 2>$null
  if ($LASTEXITCODE -ne 0) {
    throw "Git ref does not exist: $ref"
  }
}

$status = & git -C $repoRoot status --porcelain
if ($status) {
  throw "Working tree must be clean before preparing an upstream patch."
}

if (-not $OutputPath) {
  $OutputPath = Join-Path $env:TEMP ("dbx-upstream-pr-{0}.patch" -f (Get-Date -Format "yyyyMMdd-HHmmss"))
}

$pathspec = @(".") + ($excludedFiles | ForEach-Object { ":(exclude)$_" })
$patch = & git -C $repoRoot diff --binary --no-ext-diff "$BaseRef..$HeadRef" -- @pathspec
if ($LASTEXITCODE -ne 0) {
  throw "Unable to compute the upstream patch."
}

[System.IO.File]::WriteAllText((Resolve-Path (Split-Path -Parent $OutputPath)).Path + "\" + (Split-Path -Leaf $OutputPath), ($patch -join [Environment]::NewLine) + [Environment]::NewLine, [System.Text.UTF8Encoding]::new($false))
Write-Output "Wrote upstream-only patch: $OutputPath"
Write-Output "Excluded Next updater/branding files: $($excludedFiles -join ', ')"
