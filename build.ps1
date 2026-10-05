# Builds the release packages into .\dist:
#   stream-drop-collector-extension-v<version>-chrome.zip   (Chrome / Brave / Edge, load unpacked)
#   stream-drop-collector-extension-v<version>-firefox.xpi  (Firefox / LibreWolf)
# Both come from the same source; the only difference is manifest.firefox.json (background page instead of a
# service worker, plus a Firefox add-on id).
param(
    [string]$OutDir = (Join-Path $PSScriptRoot "dist")
)

$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.IO.Compression, System.IO.Compression.FileSystem

$version = (Get-Content (Join-Path $PSScriptRoot "manifest.json") -Raw | ConvertFrom-Json).version
$firefoxVersion = (Get-Content (Join-Path $PSScriptRoot "manifest.firefox.json") -Raw | ConvertFrom-Json).version
if ($version -ne $firefoxVersion) { throw "manifest.json ($version) and manifest.firefox.json ($firefoxVersion) versions differ" }

New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
$files = foreach ($dir in "src", "popup", "icons") { Get-ChildItem (Join-Path $PSScriptRoot $dir) -Recurse -File }

function New-Package([string]$path, [string]$manifest) {
    if (Test-Path $path) { Remove-Item $path -Force }
    $zip = [IO.Compression.ZipFile]::Open($path, "Create")
    try {
        [IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip, (Join-Path $PSScriptRoot $manifest), "manifest.json") | Out-Null
        foreach ($file in $files) {
            $entry = $file.FullName.Substring($PSScriptRoot.Length + 1).Replace("\", "/")
            [IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip, $file.FullName, $entry) | Out-Null
        }
    }
    finally { $zip.Dispose() }
    Write-Host "Built $path"
}

New-Package (Join-Path $OutDir "stream-drop-collector-extension-v$version-chrome.zip") "manifest.json"
New-Package (Join-Path $OutDir "stream-drop-collector-extension-v$version-firefox.xpi") "manifest.firefox.json"
