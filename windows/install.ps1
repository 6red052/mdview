<#
    mdview installer — registers a local Markdown viewer for the current user.

    Everything it does is per-user (HKCU) and reversible:
      * copies the app to %LOCALAPPDATA%\mdview
      * registers a ProgID + "Open with" entries for .md / .markdown / .mdx / .mdown
      * records the exact node.exe path so Node need not be on PATH
      * optionally adds an "mdview" command to the user PATH

    No administrator rights are needed and nothing machine-wide is touched.

    Usage:
      powershell -NoProfile -ExecutionPolicy Bypass -File windows\install.ps1
      powershell ... -File windows\install.ps1 -InstallDir 'D:\tools\mdview'
      powershell ... -File windows\install.ps1 -Default        # also sets .md default
      powershell ... -File windows\install.ps1 -Ext '.md','.markdown'
      powershell ... -File windows\install.ps1 -Remove
#>
[CmdletBinding()]
param(
    [string]   $InstallDir = (Join-Path $env:LOCALAPPDATA 'mdview'),
    [string[]] $Ext        = @('.md', '.markdown', '.mdx', '.mdown', '.mkd'),
    [string]   $ProgId     = 'mdview.md',
    [switch]   $Default,
    [switch]   $AddPath,
    [switch]   $Remove,
    [switch]   $Quiet
)

$ErrorActionPreference = 'Stop'
$script:Changes = New-Object System.Collections.Generic.List[string]

# Windows PowerShell 5.1 defaults to the ANSI code page, which mangles the
# Chinese output below. Switch the console to UTF-8 where we can.
try {
    [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
    $OutputEncoding = New-Object System.Text.UTF8Encoding($false)
} catch { <# not a console host #> }

function Say([string] $Message, [string] $Color = 'Gray') {
    if (-not $Quiet) { Write-Host $Message -ForegroundColor $Color }
}

function Record([string] $Message, [string] $Color = 'DarkGray') {
    $script:Changes.Add($Message)
    Say "  $Message" $Color
}

# --------------------------------------------------------------------- backup

$BackupFile = Join-Path $InstallDir 'assoc-backup.json'

function New-RegBackup {
    param([string[]] $Extensions)

    $backup = @{ created = (Get-Date).ToString('o'); extensions = @{} }
    foreach ($e in $Extensions) {
        $entry = @{ progId = $null; userChoice = $null; openWithProgids = @() }
        $dotKey = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Explorer\FileExts\$e"
        if (Test-Path $dotKey) {
            $props = Get-ItemProperty -Path $dotKey -ErrorAction SilentlyContinue
            if ($props -and $props.PSObject.Properties['ProgId']) { $entry.progId = $props.ProgId }
            $uc = Join-Path $dotKey 'UserChoice'
            if (Test-Path $uc) {
                $ucProps = Get-ItemProperty -Path $uc -ErrorAction SilentlyContinue
                if ($ucProps -and $ucProps.PSObject.Properties['ProgId']) { $entry.userChoice = $ucProps.ProgId }
            }
            $owp = Join-Path $dotKey 'OpenWithProgids'
            if (Test-Path $owp) {
                $entry.openWithProgids = @(
                    (Get-Item -Path $owp).GetValueNames() | Where-Object { $_ }
                )
            }
        }
        $backup.extensions[$e] = $entry
    }
    $backup | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $BackupFile -Encoding UTF8
    Say "  backup written: $BackupFile" 'DarkGray'
}

# ------------------------------------------------------------------ uninstall

function Invoke-Remove {
    Say '' 
    Say 'mdview — removing per-user registration' 'Cyan'

    foreach ($e in $Ext) {
        $dotKey = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Explorer\FileExts\$e"
        if (Test-Path $dotKey) {
            # Only the OpenWithProgids entry and our own ProgId value are ours.
            $owp = Join-Path $dotKey 'OpenWithProgids'
            if (Test-Path $owp) {
                Remove-ItemProperty -Path $owp -Name $ProgId -ErrorAction SilentlyContinue
                Record "removed OpenWith entry for $e"
            }
            $props = Get-ItemProperty -Path $dotKey -ErrorAction SilentlyContinue
            if ($props -and $props.PSObject.Properties['ProgId'] -and $props.ProgId -eq $ProgId) {
                Remove-ItemProperty -Path $dotKey -Name 'ProgId' -ErrorAction SilentlyContinue
                Record "removed default ProgId for $e"
            }
        }
        $classes = "HKCU:\Software\Classes\$e"
        if (Test-Path $classes) {
            $props = Get-ItemProperty -Path $classes -ErrorAction SilentlyContinue
            if ($props -and $props.PSObject.Properties['(default)'] -and $props.'(default)' -eq $ProgId) {
                Remove-ItemProperty -Path $classes -Name '(default)' -ErrorAction SilentlyContinue
            }
        }
    }

    $progKey = "HKCU:\Software\Classes\$ProgId"
    if (Test-Path $progKey) {
        Remove-Item -Path $progKey -Recurse -Force
        Record "removed ProgID $ProgId"
    }

    # Restore whatever was there before, when we have a record of it.
    if (Test-Path $BackupFile) {
        try {
            $backup = Get-Content -LiteralPath $BackupFile -Raw | ConvertFrom-Json
            foreach ($e in $backup.extensions.PSObject.Properties.Name) {
                $entry = $backup.extensions.$e
                if ($entry.progId) {
                    $dotKey = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Explorer\FileExts\$e"
                    if (-not (Test-Path $dotKey)) { New-Item -Path $dotKey -Force | Out-Null }
                    Set-ItemProperty -Path $dotKey -Name 'ProgId' -Value $entry.progId -ErrorAction SilentlyContinue
                    Record "restored $e ProgId -> $($entry.progId)"
                }
                foreach ($p in @($entry.openWithProgids)) {
                    if (-not $p) { continue }
                    $owp = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Explorer\FileExts\$e\OpenWithProgids"
                    if (-not (Test-Path $owp)) { New-Item -Path $owp -Force | Out-Null }
                    New-ItemProperty -Path $owp -Name $p -Value ([byte[]]@()) -PropertyType Binary -Force | Out-Null
                    Record "restored OpenWith entry $p for $e"
                }
            }
        } catch {
            Say "  could not restore from backup: $($_.Exception.Message)" 'Yellow'
        }
    }

    $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
    if ($userPath) {
        $parts = $userPath.Split(';') | Where-Object { $_ -and ($_.TrimEnd('\') -ne $InstallDir.TrimEnd('\')) }
        $newPath = ($parts -join ';')
        if ($newPath -ne $userPath) {
            [Environment]::SetEnvironmentVariable('Path', $newPath, 'User')
            Record 'removed mdview from the user PATH'
        }
    }

    Say ''
    Say "Files were kept so you can reinstall instantly." 'Yellow'
    Say "Delete the folder yourself when you are sure: $InstallDir" 'Yellow'
    Say ''
    return $true
}

# -------------------------------------------------------------------- install

Say ''
Say 'mdview — local Markdown viewer installer' 'Cyan'
Say '----------------------------------------' 'DarkCyan'

if ($Remove) {
    if (Invoke-Remove) { exit 0 }
}

if (-not (Test-Path $InstallDir)) {
    New-Item -ItemType Directory -Path $InstallDir -Force | Out-Null
    Say "  created $InstallDir"
}

# 1. find the app source (this script lives in <app>\windows)
$SourceDir = Split-Path -Parent $PSScriptRoot
if (-not (Test-Path (Join-Path $SourceDir 'server.mjs'))) {
    throw "server.mjs not found next to $PSScriptRoot — run this script from the mdview folder."
}

# 2. find Node
$nodeCmd = Get-Command node -ErrorAction SilentlyContinue
if (-not $nodeCmd) {
    Write-Host ''
    Write-Host 'ERROR: Node.js was not found on this machine.' -ForegroundColor Red
    Write-Host 'mdview needs Node 18 or newer: https://nodejs.org/' -ForegroundColor Red
    Write-Host 'Install Node, reopen this terminal, and run the installer again.' -ForegroundColor Red
    exit 1
}
$nodeExe = $nodeCmd.Source
$nodeVersion = (& $nodeExe --version) -replace '^v', ''
$nodeMajor = [int]($nodeVersion.Split('.')[0])
Say "  node: $nodeExe (v$nodeVersion)"
if ($nodeMajor -lt 20) {
    Write-Host "ERROR: Node $nodeVersion is too old; mdview needs Node 20+." -ForegroundColor Red
    exit 1
}

# 3. copy the app (windows\ comes along so uninstall stays available)
# README 里链接到的几份文档一起带上，安装后它们才不会变成死链。
$files = @(
    'server.mjs', 'package.json', 'mdview-launch.cmd', 'mdview-silent.vbs',
    'README.md', 'SECURITY.md', 'KNOWN-ISSUES.md', 'CHANGELOG.md', 'CONTRIBUTING.md', 'LICENSE'
)
foreach ($f in $files) {
    $src = Join-Path $SourceDir $f
    if (Test-Path $src) {
        Copy-Item -LiteralPath $src -Destination (Join-Path $InstallDir $f) -Force
        Record "copied $f"
    }
}
$windowsSrc = Join-Path $SourceDir 'windows'
if (Test-Path $windowsSrc) {
    $windowsDst = Join-Path $InstallDir 'windows'
    if (-not (Test-Path $windowsDst)) { New-Item -ItemType Directory -Path $windowsDst -Force | Out-Null }
    # 只带 install.ps1（卸载要用）；portable-install.ps1 是单文件版用的，
    # 在源码安装里跑必然报错，装了只会让人误点。
    Get-ChildItem -LiteralPath $windowsSrc -File | Where-Object { $_.Name -ne 'portable-install.ps1' } | ForEach-Object {
        Copy-Item -LiteralPath $_.FullName -Destination $windowsDst -Force
    }
    Record 'copied windows\ (uninstall script)'
}
# 用 OEM 代码页写（cmd.exe 读 .cmd 时用的就是它）。原先用 -Encoding ASCII，
# 非 ASCII 字符会变成 "?"，装在 C:\Users\张三\ 这类路径下的 node.exe 就失效了。
$nodeTxt = Join-Path $InstallDir 'mdview-node.txt'
$oem = [System.Text.Encoding]::GetEncoding([System.Globalization.CultureInfo]::CurrentCulture.TextInfo.OEMCodePage)
[System.IO.File]::WriteAllText($nodeTxt, $nodeExe, $oem)
Record "recorded node path"

# The shortcuts need an app identity; be explicit so the icon is not a blank page.
$openCmd = 'wscript.exe //nologo "{0}" "{1}" "{2}" "%1"' -f `
    (Join-Path $InstallDir 'mdview-silent.vbs'), $nodeExe, (Join-Path $InstallDir 'server.mjs')

# 4. back up the current associations before touching them
New-RegBackup -Extensions $Ext

# 5. ProgID
$progKey = "HKCU:\Software\Classes\$ProgId"
New-Item -Path $progKey -Force | Out-Null
Set-ItemProperty -Path $progKey -Name '(default)' -Value 'Markdown 文档'
New-Item -Path "$progKey\DefaultIcon" -Force | Out-Null
Set-ItemProperty -Path "$progKey\DefaultIcon" -Name '(default)' -Value "$nodeExe,0"
New-Item -Path "$progKey\shell\open\command" -Force | Out-Null
Set-ItemProperty -Path "$progKey\shell\open\command" -Name '(default)' -Value $openCmd
New-Item -Path "$progKey\shell\edit\command" -Force | Out-Null
Set-ItemProperty -Path "$progKey\shell\edit\command" -Name '(default)' -Value 'notepad.exe "%1"'
Record "registered ProgID $ProgId"

# 6. per-extension "Open with" entries
foreach ($e in $Ext) {
    $classes = "HKCU:\Software\Classes\$e"
    New-Item -Path $classes -Force | Out-Null
    $cur = (Get-ItemProperty -Path $classes -ErrorAction SilentlyContinue).'(default)'
    if ([string]::IsNullOrWhiteSpace($cur)) {
        Set-ItemProperty -Path $classes -Name '(default)' -Value $ProgId
        Record "$e -> $ProgId (no previous handler)"
    }

    $dotKey = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Explorer\FileExts\$e"
    New-Item -Path $dotKey -Force | Out-Null
    New-Item -Path "$dotKey\OpenWithProgids" -Force | Out-Null
    New-ItemProperty -Path "$dotKey\OpenWithProgids" -Name $ProgId -Value ([byte[]]@()) `
        -PropertyType Binary -Force | Out-Null

    # 只有当这个扩展名确实没有默认程序时，才写 per-user ProgId。
    # 三个来源都要看：已有的 FileExts\ProgId、UserChoice（Win10/11 真正的默认），
    # 以及 Classes\<ext> 的默认值。否则会在用户已有默认程序时写进去，等于抢默认。
    $props = Get-ItemProperty -Path $dotKey -ErrorAction SilentlyContinue
    $hasFileExtsProgId = [bool]($props -and $props.PSObject.Properties['ProgId'] -and $props.ProgId)
    $ucKey = "$dotKey\UserChoice"
    $hasUserChoice = $false
    if (Test-Path $ucKey) {
        $uc = Get-ItemProperty -Path $ucKey -ErrorAction SilentlyContinue
        $hasUserChoice = [bool]($uc -and $uc.PSObject.Properties['ProgId'] -and $uc.ProgId)
    }
    $hasClassesDefault = -not [string]::IsNullOrWhiteSpace($cur)

    if (-not $hasFileExtsProgId -and -not $hasUserChoice -and -not $hasClassesDefault) {
        Set-ItemProperty -Path $dotKey -Name 'ProgId' -Value $ProgId
        Record "$e default -> mdview"
    } else {
        Record "$e available in 打开方式（默认程序保持不变）"
    }
}

# 7. optional: an `mdview` command on the user PATH
if ($AddPath) {
    $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
    if (-not $userPath) { $userPath = '' }
    $already = $userPath.Split(';') | Where-Object { $_ -and ($_.TrimEnd('\') -eq $InstallDir.TrimEnd('\')) }
    if ($already) {
        Record 'PATH already contains the install folder'
    } else {
        $newPath = if ($userPath.TrimEnd(';')) { $userPath.TrimEnd(';') + ';' + $InstallDir } else { $InstallDir }
        [Environment]::SetEnvironmentVariable('Path', $newPath, 'User')
        Record 'added the install folder to the user PATH (open a new terminal)'
    }
}

# 8. optional: try to become the actual default handler
$userChoice = @{}
foreach ($e in $Ext) {
    $uc = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Explorer\FileExts\$e\UserChoice"
    if (Test-Path $uc) {
        $p = Get-ItemProperty -Path $uc -ErrorAction SilentlyContinue
        if ($p -and $p.PSObject.Properties['ProgId']) { $userChoice[$e] = $p.ProgId }
    }
}

$needsChoice = @()
foreach ($e in $Ext) {
    if ($userChoice.ContainsKey($e) -and $userChoice[$e] -ne $ProgId) { $needsChoice += $e }
}

if ($Default) {
    if ($needsChoice.Count -eq 0) {
        Say '  .md files already open with mdview by default.' 'Green'
    } else {
        Say ''
        Say "  Windows requires you to confirm the default for: $($needsChoice -join ', ')" 'Yellow'
        Say '  The "打开方式" dialog will appear for each — pick "mdview" and tick "始终使用".' 'Yellow'
        foreach ($e in $needsChoice) {
            $probe = Join-Path $env:TEMP ("mdview-probe$e")
            Set-Content -LiteralPath $probe -Value "# mdview`r`n`r`nSelect mdview, then confirm." -Encoding UTF8
            Start-Process -FilePath $probe -Verb OpenWith
            Start-Sleep -Milliseconds 900
        }
    }
} elseif ($needsChoice.Count -gt 0) {
    Say ''
    Say "  Note: Windows still has another default app for $($needsChoice -join ', ')." 'Yellow'
    Say '  Right-click any .md file -> 打开方式 -> 选择其他应用 -> mdview -> 始终使用。' 'Yellow'
    Say '  Or rerun this installer with -Default to get the picker dialog.' 'Yellow'
}

# 9. verify: start the viewer for the self-test file and confirm it serves
Say ''
Say 'Verifying...' 'Cyan'
$serverJs = Join-Path $InstallDir 'server.mjs'
$dataDir = if ($env:LOCALAPPDATA) { Join-Path $env:LOCALAPPDATA 'mdview' } else { $InstallDir }

# Whatever this user already had running is about to lose its state file, so
# stop it first — otherwise `mdview status` would keep reporting a dead server.
$stopped = $false
try {
    $statusOut = & $nodeExe $serverJs status 2>&1 | Out-String
    if ($statusOut -match 'running|运行中') { $stopped = $true }
} catch { /* status 失败就当没在运行 */ }
& $nodeExe $serverJs stop 2>&1 | Out-Null
Remove-Item (Join-Path $dataDir 'server.json') -Force -ErrorAction SilentlyContinue
if ($stopped) { Say 'Note: a running mdview service was stopped and will restart on next open.' 'Yellow' }

$testFile = Join-Path $env:TEMP 'mdview-self-test.md'
$selfTest = @'
# mdview 安装成功

**粗体**、``行内代码``、[链接](https://example.com)、表格与代码高亮都可用。

| 检查项 | 结果 |
|---|---|
| 文件关联 | 已注册 |
| 本地服务 | 已运行 |

```js
console.log('hello mdview');
```
'@
Set-Content -LiteralPath $testFile -Value $selfTest -Encoding UTF8

# Launch the viewer exactly the way Explorer will: through the silent VBS
# launcher, so this check exercises the file association and not a bare
# `node server.mjs`.
#
# Never use Start-Process -Wait here: the viewer detaches a background server,
# and -Wait would block on that whole process tree.
$launchArgs = '//nologo "{0}" "{1}" "{2}" "{3}"' -f `
    (Join-Path $InstallDir 'mdview-silent.vbs'), $nodeExe, $serverJs, $testFile
Start-Process -FilePath 'wscript.exe' -ArgumentList $launchArgs -WindowStyle Hidden
Start-Sleep -Milliseconds 1800
$stateFile = Join-Path $dataDir 'server.json'
$port = $null
try {
    $state = Get-Content -LiteralPath $stateFile -Raw -ErrorAction Stop | ConvertFrom-Json
    if ($state.port) { $port = [int]$state.port }
} catch { <# server not started #> }

if ($port) {
    try {
        $res = Invoke-WebRequest -Uri "http://127.0.0.1:$port/health" -UseBasicParsing -TimeoutSec 8
        Say "  viewer responds: HTTP $($res.StatusCode) on port $port" 'Green'
    } catch {
        Say "  server started but did not answer: $($_.Exception.Message)" 'Yellow'
        Say "  see $dataDir\server.log" 'Yellow'
    }
} else {
    Say '  the viewer did not start. Last lines of server.log:' 'Red'
    Get-Content -LiteralPath (Join-Path $dataDir 'server.log') -Tail 6 -ErrorAction SilentlyContinue |
        ForEach-Object { Say "    $_" 'Red' }
}

& $nodeExe $serverJs stop 2>&1 | Out-Null
Remove-Item -LiteralPath $stateFile -Force -ErrorAction SilentlyContinue

Say ''
Say 'Done.' 'Green'
Say ''
Say "  Open a Markdown file:   double-click any .md, or run:" 'White'
Say "      `"$InstallDir\mdview-launch.cmd`" `"$testFile`"" 'DarkCyan'
Say ''
Say "  A self-test file was created at: $testFile" 'Gray'
Say "  Logs (if anything misbehaves): $env:LOCALAPPDATA\mdview\server.log and launcher.log" 'Gray'
Say "  Uninstall:  powershell -NoProfile -ExecutionPolicy Bypass -File `"$InstallDir\windows\install.ps1`" -Remove" 'Gray'
Say ''
Say 'Changes made:' 'Cyan'
$script:Changes | ForEach-Object { Say "  - $_" 'DarkGray' }
Say ''
