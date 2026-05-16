# pursue-helper · one-command setup for volunteers (PowerShell)
#
# Usage:
#   iwr https://rizzleroc.github.io/pursue-console/install-helper.ps1 | iex
#
# What it does:
#   1. Sparse-checkout the helper-relevant directories of pursue-console
#      (~10 MB instead of the full corpus + ORT bundle).
#   2. Installs the daemon (npm install in pursue-vision-mcp).
#   3. Tells you exactly what to run next.

$ErrorActionPreference = "Stop"

$repo = if ($env:PURSUE_HELPER_REPO) { $env:PURSUE_HELPER_REPO } else { "https://github.com/rizzleroc/pursue-console" }
$dest = if ($env:PURSUE_HELPER_DEST) { $env:PURSUE_HELPER_DEST } else { "pursue-helper" }

Write-Host "[helper] cloning lean checkout of $repo into .\$dest"
if (Test-Path $dest) {
    Write-Host "[helper] $dest already exists. Pulling latest..."
    git -C $dest pull --ff-only
} else {
    git clone --filter=blob:none --no-checkout --depth=1 $repo $dest
    git -C $dest sparse-checkout init --cone
    git -C $dest sparse-checkout set `
        pursue-vision-mcp `
        scripts/volunteer.mjs `
        scripts/build-work-available.mjs `
        src/data/events.js `
        HOW-CAN-I-HELP.md `
        JUDGE-STANDARD.md `
        CONTRIBUTING-CORPUS.md `
        LICENSE `
        README.md
    git -C $dest checkout main
}

Write-Host "[helper] installing daemon deps"
Push-Location "$dest\pursue-vision-mcp"
try {
    npm install --no-audit --no-fund
    npm install --no-audit --no-fund pdfjs-dist@^5 "@napi-rs/canvas@^1"
} finally {
    Pop-Location
}

Write-Host ""
Write-Host "[helper] done. next steps:"
Write-Host ""
Write-Host "  cd $dest"
Write-Host "  npm start --prefix pursue-vision-mcp"
Write-Host "  # in another terminal:"
Write-Host "  node scripts/volunteer.mjs --my-handle=YOUR_GITHUB_HANDLE --slice=20"
Write-Host ""
Write-Host "your contributions land in:  contributions\YOUR_GITHUB_HANDLE\"
Write-Host "the daemon writes its token to: `$env:USERPROFILE\.pursue-vision-token"
Write-Host ""
Write-Host "read first if you want context:  $dest\HOW-CAN-I-HELP.md"
