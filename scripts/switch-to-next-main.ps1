param(
  [string]$NextRemote = "next",
  [string]$NextBranch = "main",
  [switch]$Apply
)

$ErrorActionPreference = "Stop"
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot ".." )).Path

function Invoke-Git([string[]]$Arguments) {
  & git -C $repoRoot @Arguments
  if ($LASTEXITCODE -ne 0) {
    throw "git $($Arguments -join ' ') failed with exit code $LASTEXITCODE"
  }
}

$remoteUrl = & git -C $repoRoot remote get-url $NextRemote 2>$null
if ($LASTEXITCODE -ne 0 -or -not $remoteUrl) {
  throw "Missing Next remote '$NextRemote'."
}

$targetRef = "$NextRemote/$NextBranch"
$null = & git -C $repoRoot rev-parse --verify "$targetRef^{commit}" 2>$null
if ($LASTEXITCODE -ne 0) {
  throw "Missing fetched Next ref '$targetRef'. Run: git fetch $NextRemote $NextBranch"
}

$status = & git -C $repoRoot status --porcelain
if (-not $Apply) {
  Write-Output "Preview only. The repository will be switched to $targetRef."
  if ($status) {
    Write-Output "Existing changes will be saved with git stash -u and restored after the switch."
  } else {
    Write-Output "The working tree is clean."
  }
  Write-Output "Run again with -Apply to perform the switch."
  exit 0
}

if ($status) {
  Invoke-Git @("stash", "push", "-u", "-m", "codex-before-next-main-switch")
}

Invoke-Git @("reset", "--hard", $targetRef)

if ($status) {
  Write-Output "Restoring the saved worktree changes; resolve any reported conflicts before building."
  & git -C $repoRoot stash pop
  if ($LASTEXITCODE -ne 0) {
    throw "The Next baseline is active, but stash restoration reported conflicts."
  }
}

Write-Output "Switched main to $targetRef."
