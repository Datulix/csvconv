# Fetches the pdfium native library used by pdfium-render at runtime.
# Run once after `npm install` (and again to upgrade).
#
# Usage:   pwsh scripts/fetch-pdfium.ps1
# Sources: https://github.com/bblanchon/pdfium-binaries

$ErrorActionPreference = "Stop"

$repoRoot = Resolve-Path "$PSScriptRoot\.."
$binariesDir = Join-Path $repoRoot "src-tauri\binaries"
$devTargetDir = Join-Path $repoRoot "src-tauri\target\debug"

# Pick the right asset for the current OS+arch.
$asset = if ($IsWindows -or $env:OS -eq "Windows_NT") {
    "pdfium-win-x64.tgz"
} elseif ($IsMacOS) {
    if ((uname -m) -eq "arm64") { "pdfium-mac-arm64.tgz" } else { "pdfium-mac-x64.tgz" }
} elseif ($IsLinux) {
    "pdfium-linux-x64.tgz"
} else {
    throw "Unsupported OS"
}

$url = "https://github.com/bblanchon/pdfium-binaries/releases/latest/download/$asset"
$tmpDir = Join-Path ([System.IO.Path]::GetTempPath()) ("pdfium-fetch-" + [guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Path $tmpDir | Out-Null

try {
    Write-Host "Downloading $url ..."
    $tgz = Join-Path $tmpDir "pdfium.tgz"
    Invoke-WebRequest -Uri $url -OutFile $tgz -UseBasicParsing
    Write-Host "  $((Get-Item $tgz).Length) bytes"

    Write-Host "Extracting ..."
    tar -xzf $tgz -C $tmpDir

    $libCandidates = Get-ChildItem $tmpDir -Recurse -File |
        Where-Object { $_.Name -in @("pdfium.dll", "libpdfium.dylib", "libpdfium.so") }

    if ($libCandidates.Count -eq 0) {
        throw "No pdfium library found in the downloaded archive."
    }

    foreach ($lib in $libCandidates) {
        New-Item -ItemType Directory -Path $binariesDir -Force | Out-Null
        Copy-Item $lib.FullName -Destination (Join-Path $binariesDir $lib.Name) -Force
        Write-Host "  -> src-tauri/binaries/$($lib.Name)"

        # Also copy to the dev build dir so `npm run tauri dev` can load it immediately.
        if (Test-Path $devTargetDir) {
            Copy-Item $lib.FullName -Destination (Join-Path $devTargetDir $lib.Name) -Force
            Write-Host "  -> src-tauri/target/debug/$($lib.Name)"
        }
    }

    $versionFile = Get-ChildItem $tmpDir -Recurse -File | Where-Object { $_.Name -eq "VERSION" } | Select-Object -First 1
    if ($versionFile) {
        Write-Host ""
        Write-Host "Pdfium version:"
        Get-Content $versionFile.FullName | ForEach-Object { Write-Host "  $_" }
    }
}
finally {
    Remove-Item $tmpDir -Recurse -Force -ErrorAction SilentlyContinue
}

Write-Host ""
Write-Host "Done. Re-run if you need to upgrade."
