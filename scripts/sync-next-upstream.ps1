param(
  [string]$UpstreamRemote = "upstream",
  [string]$UpstreamBranch = "main",
  [string]$TrackingBranch = "upstream-main",
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

if (-not (Test-Path (Join-Path $repoRoot ".git"))) {
  throw "Not a Git repository: $repoRoot"
}

$status = & git -C $repoRoot status --porcelain
if ($status) {
  throw "Working tree must be clean before syncing upstream."
}

$remoteUrl = (& git -C $repoRoot remote get-url $UpstreamRemote 2>$null)
if (-not $remoteUrl) {
  throw "Missing upstream remote '$UpstreamRemote'."
}

if (-not $Apply) {
  Write-Output "Preview only. The following operations will update $TrackingBranch and rebase $NextBranch on it:"
  Write-Output "  git fetch $UpstreamRemote $UpstreamBranch"
  Write-Output "  git branch --force $TrackingBranch FETCH_HEAD"
  Write-Output "  git rebase $TrackingBranch $NextBranch"
  Write-Output "Run again with -Apply after reviewing the remote and branch names."
  exit 0
}

Invoke-Git @("fetch", $UpstreamRemote, $UpstreamBranch)

$null = & git -C $repoRoot show-ref --verify --quiet ("refs/heads/{0}" -f $TrackingBranch)
$trackingExists = $LASTEXITCODE -eq 0
if ($trackingExists) {
  Invoke-Git @("branch", "--force", $TrackingBranch, "FETCH_HEAD")
} else {
  Invoke-Git @("branch", $TrackingBranch, "FETCH_HEAD")
}

Invoke-Git @("rebase", $TrackingBranch, $NextBranch)
Write-Output "Updated $TrackingBranch and rebased $NextBranch."
