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
    $branch = (git rev-parse --abbrev-ref HEAD).Trim()
    $pkg = Get-Content (Join-Path $repo "package.json") -Raw | ConvertFrom-Json
    $version = if ($pkg.stayVersion) { $pkg.stayVersion } else { $pkg.version }

    if (-not $version) { throw "No stayVersion/version found in package.json." }

    $outDir = Join-Path $repo "release-output"
    New-Item -ItemType Directory -Force -Path $outDir | Out-Null

    $archive = Join-Path $outDir ("stay-{0}-{1}.tar.gz" -f $version, $sha)
    if (Test-Path $archive) { Remove-Item $archive -Force }

    $buildDir = Join-Path $outDir (".build-{0}" -f $sha)
    if (Test-Path $buildDir) { Remove-Item $buildDir -Recurse -Force }
    New-Item -ItemType Directory -Force -Path $buildDir | Out-Null
    $sourceTar = Join-Path $buildDir "source.tar"
    git archive --format=tar --output="$sourceTar" HEAD
    if ($LASTEXITCODE -ne 0) { throw "git archive failed." }
    tar -xf $sourceTar -C $buildDir
    if ($LASTEXITCODE -ne 0) { throw "source archive extraction failed." }
    Remove-Item $sourceTar -Force

    foreach ($relative in @("data", ".stay-data", "release-output")) {
        $candidate = Join-Path $buildDir $relative
        if (Test-Path $candidate) { Remove-Item $candidate -Recurse -Force }
    }

    $releaseControl = Join-Path $buildDir "runtime/release/sntss-release-control.js"
    if (-not (Test-Path $releaseControl)) { throw "R10 release-control module is missing." }

    node $releaseControl emit --root $buildDir --version $version --commit $sha --builder "tools/build-release.ps1" --branch $branch
    if ($LASTEXITCODE -ne 0) { throw "R10 release provenance generation failed." }
    node $releaseControl verify --root $buildDir
    if ($LASTEXITCODE -ne 0) { throw "R10 release verification failed." }

    tar -czf $archive -C $buildDir .
    if ($LASTEXITCODE -ne 0) { throw "release tar creation failed." }
    Remove-Item $buildDir -Recurse -Force

    $hash = (Get-FileHash $archive -Algorithm SHA256).Hash.ToLower()
    $sidecar = "$archive.sha256"
    Set-Content -Path $sidecar -Value ("{0}  {1}" -f $hash, (Split-Path $archive -Leaf)) -Encoding ascii

    Write-Host ""
    Write-Host "STAY R10 release ready"
    Write-Host "Version : $version"
    Write-Host "Commit  : $sha"
    Write-Host "SHA256  : $hash"
    Write-Host "File    : $archive"
    Write-Host ""
    Write-Host "The archive contains R10 inventory/provenance and excludes live/laboratory state."
    Write-Host "Fallback staging/deployment:"
    Write-Host "Sidecar: $sidecar"
    Write-Host "1. Upload the .tar.gz and matching .sha256 with WinSCP."
    Write-Host "2. Stage only unless the current production gate explicitly authorizes deployment."
}
finally {
    Pop-Location
}
