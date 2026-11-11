# Installs Portplane on Windows (beta):
#   irm https://akamachinecode.github.io/portplane/install.ps1 | iex
# $env:PORTPLANE_VERSION picks a release (for example v0.2.0). The archive is
# checked against the release's checksums.txt.
$ErrorActionPreference = 'Stop'
$repo = 'akamachinecode/portplane'
$dir = Join-Path $env:LOCALAPPDATA 'Programs\Portplane'

$tag = $env:PORTPLANE_VERSION
if (-not $tag) {
  $tag = (Invoke-RestMethod "https://api.github.com/repos/$repo/releases/latest").tag_name
}
$version = $tag.TrimStart('v')
$arch = if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { 'arm64' } else { 'amd64' }
$archive = "portplane_${version}_windows_${arch}.zip"
$base = "https://github.com/$repo/releases/download/$tag"
$tmp = Join-Path ([System.IO.Path]::GetTempPath()) ("portplane-" + [System.Guid]::NewGuid())
New-Item -ItemType Directory -Path $tmp | Out-Null
try {
  Write-Host "Downloading Portplane $tag for windows/$arch"
  Invoke-WebRequest "$base/$archive" -OutFile (Join-Path $tmp $archive) -UseBasicParsing
  Invoke-WebRequest "$base/checksums.txt" -OutFile (Join-Path $tmp 'checksums.txt') -UseBasicParsing
  $line = Get-Content (Join-Path $tmp 'checksums.txt') | Where-Object { $_ -match ("\s" + [regex]::Escape($archive) + '$') }
  if (-not $line) { throw "$archive is not listed in checksums.txt" }
  $expected = ($line -split '\s+')[0].ToLower()
  $actual = (Get-FileHash (Join-Path $tmp $archive) -Algorithm SHA256).Hash.ToLower()
  if ($expected -ne $actual) { throw "checksum mismatch for $archive" }
  Write-Host 'Checksum OK'
  Expand-Archive (Join-Path $tmp $archive) -DestinationPath $tmp -Force
  New-Item -ItemType Directory -Path $dir -Force | Out-Null
  Copy-Item (Join-Path $tmp 'portplane.exe') (Join-Path $dir 'portplane.exe') -Force
  $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
  if (-not ($userPath -split ';' | Where-Object { $_ -eq $dir })) {
    [Environment]::SetEnvironmentVariable('Path', ($userPath.TrimEnd(';') + ';' + $dir), 'User')
    Write-Host "Added $dir to your PATH (open a new terminal)."
  }
  Write-Host "Installed $dir\portplane.exe"
  Write-Host 'Next: portplane folders add $HOME\code; portplane'
} finally {
  Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
}
