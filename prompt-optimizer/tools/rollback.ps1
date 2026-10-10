<#
=============================================================================
 dsh-prompt-optimizer -- one-step rollback / uninstall script
=============================================================================
 Purpose: restore the DSH "web" profile to its exact pre-install state.

 Why this file is pure ASCII: Windows PowerShell 5.1 reads .ps1 files using the
 system ANSI code page unless the file carries a UTF-8 BOM. A script containing
 literal CJK text would therefore fail to parse on this machine. All messages
 here are ASCII on purpose.

 Usage (running it IS the rollback; nothing happens without a flag only in DryRun):
   powershell -NoProfile -ExecutionPolicy Bypass -File tools\rollback.ps1
   powershell -NoProfile -ExecutionPolicy Bypass -File tools\rollback.ps1 -DryRun

 Steps (idempotent, safe to run repeatedly):
   1. Remove the profile-side link/copy of the plugin
   2. Restore the backed-up profile files byte-for-byte
   3. Belt-and-braces: strip the plugin from dsh.profile.bundles / dependencies
   4. Verify the restored files match the backup by SHA256

 A restart of `dsh web` is required afterwards (the config tree is assembled at
 startup only). The plugin source directory inside the workspace is NOT touched.
=============================================================================
#>
[CmdletBinding()]
param(
  [switch]$DryRun,
  [string]$ProfileDir = "$env:USERPROFILE\.dsh\profiles\web",
  [string]$PluginName = 'dsh-prompt-optimizer'
)

$ErrorActionPreference = 'Stop'
$backup = Join-Path $ProfileDir '.dsh-po-backup'

Write-Host '=== dsh-prompt-optimizer rollback ===' -ForegroundColor Cyan
Write-Host "profile  : $ProfileDir"
Write-Host "backup   : $backup"
Write-Host ("mode     : " + $(if ($DryRun) { 'DRY RUN (nothing will be changed)' } else { 'EXECUTE' }))
Write-Host ''

if (-not (Test-Path -LiteralPath $ProfileDir)) {
  Write-Host 'profile directory not found; nothing to roll back.' -ForegroundColor Yellow
  exit 0
}

# --- Step 1: remove the profile-side link or copy -------------------------
$linkPath = Join-Path $ProfileDir "node_modules\$PluginName"
if (Test-Path -LiteralPath $linkPath) {
  $item = Get-Item -LiteralPath $linkPath -Force
  $isLink = @('Junction', 'SymbolicLink') -contains $item.LinkType
  $what = if ($isLink) { $item.LinkType } else { 'directory' }
  Write-Host "[1] remove $what : $linkPath"
  if (-not $DryRun) {
    if ($isLink) {
      # Delete the link itself only; never the link target.
      [System.IO.Directory]::Delete($linkPath, $false)
    }
    else {
      Remove-Item -LiteralPath $linkPath -Recurse -Force
    }
  }
}
else {
  Write-Host "[1] no link found at $linkPath (never installed or already removed)"
}

# --- Step 2: restore the backed-up profile files --------------------------
Write-Host ''
Write-Host '[2] restore profile configuration files'
$restoreFiles = @('package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'cordis.yml', 'cordis.patch.yml')
$restored = @()
foreach ($file in $restoreFiles) {
  $src = Join-Path $backup $file
  if (-not (Test-Path -LiteralPath $src)) {
    Write-Host ("    - " + $file + ": not present in backup, skipped") -ForegroundColor DarkGray
    continue
  }
  $dst = Join-Path $ProfileDir $file
  if (-not $DryRun) { Copy-Item -LiteralPath $src -Destination $dst -Force }
  $restored += $file
  Write-Host ("    - " + $file + " restored") -ForegroundColor Green
}

# --- Step 3: belt-and-braces bundle stripping -----------------------------
# The backup restore above is authoritative. This extra pass only matters when
# the backup is missing; it uses Node so JSON/UTF-8 is handled correctly.
Write-Host ''
Write-Host '[3] ensure the plugin is absent from dsh.profile.bundles'
$pkgPath = Join-Path $ProfileDir 'package.json'
if (Test-Path -LiteralPath $pkgPath) {
  if ($DryRun) {
    $raw = Get-Content -LiteralPath $pkgPath -Raw
    if ($raw -match [regex]::Escape($PluginName)) {
      Write-Host "    - package.json still mentions $PluginName (DRY RUN: not modified)" -ForegroundColor Yellow
    }
    else {
      Write-Host '    - clean' -ForegroundColor Green
    }
  }
  else {
    $node = @(
      'const fs = require("fs")'
      'const file = process.argv[2]'
      'const name = process.argv[3]'
      'const pkg = JSON.parse(fs.readFileSync(file, "utf8"))'
      'let changed = false'
      'if (pkg.dependencies && pkg.dependencies[name]) { delete pkg.dependencies[name]; changed = true }'
      'if (pkg.dsh && pkg.dsh.profile && Array.isArray(pkg.dsh.profile.bundles)) {'
      '  const before = pkg.dsh.profile.bundles.length'
      '  pkg.dsh.profile.bundles = pkg.dsh.profile.bundles.filter((b) => b !== name)'
      '  if (pkg.dsh.profile.bundles.length !== before) changed = true'
      '}'
      'if (changed) {'
      '  fs.writeFileSync(file, JSON.stringify(pkg, null, 2) + "\n", "utf8")'
      '  console.log("    - removed " + name + " from bundles/dependencies")'
      '} else {'
      '  console.log("    - nothing to change")'
      '}'
    ) -join "`n"
    $tmp = Join-Path ([System.IO.Path]::GetTempPath()) 'dsh-po-rollback.cjs'
    Set-Content -LiteralPath $tmp -Value $node -Encoding ASCII
    & node $tmp $pkgPath $PluginName
    Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue
  }
}

# --- Step 4: verify -------------------------------------------------------
Write-Host ''
Write-Host '[4] verify restored files against backup (SHA256)'
foreach ($file in $restored) {
  $src = Join-Path $backup $file
  $dst = Join-Path $ProfileDir $file
  if (-not (Test-Path -LiteralPath $dst)) {
    Write-Host ("    MISSING " + $file) -ForegroundColor Red
    continue
  }
  $h1 = (Get-FileHash -LiteralPath $src -Algorithm SHA256).Hash
  $h2 = (Get-FileHash -LiteralPath $dst -Algorithm SHA256).Hash
  if ($h1 -eq $h2) {
    Write-Host ("    OK   " + $file) -ForegroundColor Green
  }
  else {
    # Expected only when step 3 additionally stripped an entry the backup still had.
    Write-Host ("    DIFF " + $file + " (expected if step 3 stripped an entry)") -ForegroundColor Yellow
  }
}

Write-Host ''
if ($DryRun) {
  Write-Host 'DRY RUN finished: no file was modified.' -ForegroundColor Cyan
}
else {
  Write-Host 'Rollback finished.' -ForegroundColor Green
  Write-Host 'Restart dsh web so the config tree is reassembled, then reload the page.' -ForegroundColor Yellow
}
Write-Host ''
Write-Host 'Note: the plugin source directory inside the workspace is untouched.'
Write-Host '      Runtime files left behind (delete them if you no longer need the plugin):'
Write-Host ("        " + (Join-Path $env:USERPROFILE '.dsh\prompt-optimizer.json'))
Write-Host ("        " + (Join-Path $env:USERPROFILE '.dsh\prompt-optimizer.state.json'))
