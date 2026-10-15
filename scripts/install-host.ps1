# 注册 Browser Bridge native messaging host(Windows)。
# 用法: .\install-host.ps1 [-All | -Chrome | -Chromium | -Edge] [扩展ID]
param(
    [switch]$All,
    [switch]$Chrome,
    [switch]$Chromium,
    [switch]$Edge,
    [string]$ExtId
)

$ErrorActionPreference = "Stop"
$HostName = "com.browserbridge"
$DefaultExtId = "hjilgpmhomhbimplmicadchhdfnndmpg"
if (-not $ExtId) { $ExtId = $DefaultExtId }

if ($ExtId -notmatch "^[a-p]{32}$") {
    Write-Error "扩展 ID 格式非法: $ExtId(应为 32 位 a-p 字母)"
    exit 1
}

# host 位于扩展目录的 bin 子目录
$HostPath = Join-Path $PSScriptRoot "browser-bridge/bin/browser-bridge-host.exe"
if (-not (Test-Path $HostPath)) {
    Write-Error "找不到 $HostPath(请先构建或复制扩展目录)"
    exit 1
}

$Candidates = @(
    (Join-Path $env:LOCALAPPDATA "Google/Chrome/User Data/NativeMessagingHosts"),
    (Join-Path $env:LOCALAPPDATA "Microsoft/Edge/User Data/NativeMessagingHosts")
)
$Found = @($Candidates | Where-Object { Test-Path $_ })
if ($Found.Count -eq 0) {
    Write-Error "未找到任何浏览器配置目录,请先安装并运行一次 Chrome/Edge"
    exit 1
}

# 确定安装目标
$Selected = @()
if ($All -or -not ($Chrome -or $Chromium -or $Edge)) {
    $Selected = $Found
} else {
    $names = @()
    if ($Chrome) { $names += "chrome" }
    if ($Chromium) { $names += "chromium" }
    if ($Edge) { $names += "edge" }
    foreach ($d in $Found) {
        foreach ($n in $names) {
            if ($d.ToLower().Contains($n)) { $Selected += $d; break }
        }
    }
}
if ($Selected.Count -eq 0) {
    Write-Error "未匹配到所选浏览器目录"
    exit 1
}

$manifest = @"
{
  "name": "$HostName",
  "description": "Browser Bridge native host (AI|program ↔ browser)",
  "path": "$HostPath",
  "type": "stdio",
  "allowed_origins": ["chrome-extension://$ExtId/"]
}
"@

foreach ($d in $Selected) {
    New-Item -ItemType Directory -Force -Path $d | Out-Null
    $dest = Join-Path $d "$HostName.json"
    Set-Content -Path $dest -Value $manifest -Encoding UTF8
    Write-Output "installed: $dest"
}
Write-Output "host: $HostPath"
Write-Output "allowed extension: $ExtId"
Write-Output "若浏览器已打开,请完全退出并重启后再试。"
