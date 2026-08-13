$ErrorActionPreference = "Stop"

$repo = (git rev-parse --show-toplevel).Trim()
if (-not $repo) { throw "Not inside a Git repository." }

Push-Location $repo
try {
    $dirty = git status --porcelain
    if ($dirty) {
        throw "Working tree is not clean. Commit/push your changes first."
    }

    $sha = (git rev-parse HEAD).Trim()
    $pkg = Get-Content (Join-Path $repo "package.json") -Raw | ConvertFrom-Json
    $version = if ($pkg.stayVersion) { $pkg.stayVersion } else { $pkg.version }

    if (-not $version) { throw "No stayVersion/version found in package.json." }

    $outDir = Join-Path $repo "release-output"
    New-Item -ItemType Directory -Force -Path $outDir | Out-Null

    $archive = Join-Path $outDir ("stay-{0}-{1}.tar.gz" -f $version, $sha)
    if (Test-Path $archive) { Remove-Item $archive -Force }

    git archive --format=tar.gz --output="$archive" HEAD
    if ($LASTEXITCODE -ne 0) { throw "git archive failed." }

    $hash = (Get-FileHash $archive -Algorithm SHA256).Hash.ToLower()

    Write-Host ""
    Write-Host "STAY release ready"
    Write-Host "Version : $version"
    Write-Host "Commit  : $sha"
    Write-Host "SHA256  : $hash"
    Write-Host "File    : $archive"
    Write-Host ""
    Write-Host "Fallback deployment:"
    Write-Host "1. Upload that one .tar.gz with WinSCP."
    Write-Host "2. Run: sudo stay-deploy /home/ubuntu/<filename>"
}
finally {
    Pop-Location
}
