<#
    mdview portable installer.

    Registers mdview.exe (sitting next to this script) as the handler for
    Markdown files. Everything is per-user (HKCU): no administrator rights,
    no system directories, no services, nothing machine-wide, fully reversible.

    This script is intentionally pure ASCII so that Windows PowerShell 5.1 can
    read it with any code page.

    Usage (from this folder):
        powershell -NoProfile -ExecutionPolicy Bypass -File portable-install.ps1
        powershell ... -File portable-install.ps1 -Default      # also set as .md default
        powershell ... -File portable-install.ps1 -AddPath       # also add this folder to PATH
        powershell ... -File portable-install.ps1 -Remove        # uninstall
#>
[CmdletBinding()]
param(
    [string]   $InstallDir = $PSScriptRoot,
    [string]   $ExeName    = 'mdview.exe',
    [string[]] $Ext        = @('.md', '.markdown', '.mdx', '.mdown', '.mkd'),
    [string]   $ProgId     = 'mdview.md',
    [switch]   $Default,
    [switch]   $AddPath,
    [switch]   $Remove
)

$ErrorActionPreference = 'Stop'

try {
    [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
} catch { <# not a console host #> }

$script:Changes = New-Object System.Collections.Generic.List[string]
function Say([string] $m, [string] $c = 'Gray') { Write-Host $m -ForegroundColor $c }
function Record([string] $m) { $script:Changes.Add($m); Say "  $m" 'DarkGray' }

if (-not $InstallDir) { $InstallDir = (Get-Location).Path }
$ExePath = Join-Path $InstallDir $ExeName
$BackupFile = Join-Path $InstallDir 'assoc-backup.json'

# ------------------------------------------------------------------ remove --

function Invoke-Remove {
    Say ''
    Say 'mdview portable - removing per-user registration' 'Cyan'

    foreach ($e in $Ext) {
        $dotKey = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Explorer\FileExts\$e"
        if (Test-Path $dotKey) {
            $owp = Join-Path $dotKey 'OpenWithProgids'
            if (Test-Path $owp) {
                Remove-ItemProperty -Path $owp -Name $ProgId -ErrorAction SilentlyContinue
                Record "removed 'open with' entry for $e"
            }
            $props = Get-ItemProperty -Path $dotKey -ErrorAction SilentlyContinue
            if ($props -and $props.PSObject.Properties['ProgId'] -and $props.ProgId -eq $ProgId) {
                Remove-ItemProperty -Path $dotKey -Name 'ProgId' -ErrorAction SilentlyContinue
                Record "removed default handler for $e"
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

    if (Test-Path $BackupFile) {
        try {
            $backup = Get-Content -LiteralPath $BackupFile -Raw | ConvertFrom-Json
            foreach ($e in $backup.extensions.PSObject.Properties.Name) {
                $entry = $backup.extensions.$e
                if ($entry.progId) {
                    $dotKey = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Explorer\FileExts\$e"
                    if (-not (Test-Path $dotKey)) { New-Item -Path $dotKey -Force | Out-Null }
                    Set-ItemProperty -Path $dotKey -Name 'ProgId' -Value $entry.progId -ErrorAction SilentlyContinue
                    Record "restored $e -> $($entry.progId)"
                }
                foreach ($p in @($entry.openWithProgids)) {
                    if (-not $p) { continue }
                    $owp = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Explorer\FileExts\$e\OpenWithProgids"
                    if (-not (Test-Path $owp)) { New-Item -Path $owp -Force | Out-Null }
                    New-ItemProperty -Path $owp -Name $p -Value ([byte[]]@()) -PropertyType Binary -Force | Out-Null
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
            Record 'removed this folder from the user PATH'
        }
    }

    $lnk = Join-Path ([Environment]::GetFolderPath('Desktop')) 'mdview.lnk'
    if (Test-Path $lnk) { Remove-Item $lnk -Force; Record 'removed desktop shortcut' }

    Say ''
    Say 'Done. The files were left in place; delete the folder when you are sure.' 'Yellow'
    Say ''
    return $true
}

# ----------------------------------------------------------------- install --

Say ''
Say 'mdview portable - installing' 'Cyan'
Say '----------------------------' 'DarkCyan'

if ($Remove) {
    if (Invoke-Remove) { exit 0 }
}

if (-not (Test-Path $ExePath)) {
    Say "ERROR: $ExeName was not found next to this script." 'Red'
    Say "  looked for: $ExePath" 'Red'
    Say '  keep portable-install.ps1 in the same folder as mdview.exe and retry.' 'Yellow'
    exit 1
}
$exeItem = Get-Item $ExePath
Say ('  app: {0}  ({1:N1} MB)' -f $ExePath, ($exeItem.Length / 1MB))

# 1. remember the current associations so -Remove can put them back
$backup = @{ created = (Get-Date).ToString('o'); extensions = @{} }
foreach ($e in $Ext) {
    $entry = @{ progId = $null; userChoice = $null; openWithProgids = @() }
    $dotKey = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Explorer\FileExts\$e"
    if (Test-Path $dotKey) {
        $props = Get-ItemProperty -Path $dotKey -ErrorAction SilentlyContinue
        if ($props -and $props.PSObject.Properties['ProgId']) { $entry.progId = $props.ProgId }
        $owp = Join-Path $dotKey 'OpenWithProgids'
        if (Test-Path $owp) { $entry.openWithProgids = @((Get-Item -Path $owp).GetValueNames() | Where-Object { $_ }) }
        $uc = Join-Path $dotKey 'UserChoice'
        if (Test-Path $uc) {
            $ucProps = Get-ItemProperty -Path $uc -ErrorAction SilentlyContinue
            if ($ucProps -and $ucProps.PSObject.Properties['ProgId']) { $entry.userChoice = $ucProps.ProgId }
        }
    }
    $backup.extensions[$e] = $entry
}
$backup | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $BackupFile -Encoding UTF8
Say "  saved the previous associations to assoc-backup.json" 'DarkGray'

# 2. the ProgID itself. Prefer the silent VBS launcher so Explorer does not flash
#    a console window; fall back to the .cmd wrapper, then to the exe.
$vbsPath = Join-Path $InstallDir 'mdview-silent.vbs'
$cmdPath = Join-Path $InstallDir 'mdview-launch.cmd'
if (Test-Path $vbsPath) {
    $openCmd = 'wscript.exe //nologo "{0}" "%1"' -f $vbsPath
} elseif (Test-Path $cmdPath) {
    $openCmd = '"{0}" "%1"' -f $cmdPath
} else {
    $openCmd = '"{0}" open "%1"' -f $ExePath
}

$progKey = "HKCU:\Software\Classes\$ProgId"
New-Item -Path $progKey -Force | Out-Null
Set-ItemProperty -Path $progKey -Name '(default)' -Value 'Markdown document'
New-Item -Path "$progKey\DefaultIcon" -Force | Out-Null
Set-ItemProperty -Path "$progKey\DefaultIcon" -Name '(default)' -Value "$ExePath,0"
New-Item -Path "$progKey\shell\open\command" -Force | Out-Null
Set-ItemProperty -Path "$progKey\shell\open\command" -Name '(default)' -Value $openCmd
New-Item -Path "$progKey\shell\edit\command" -Force | Out-Null
Set-ItemProperty -Path "$progKey\shell\edit\command" -Name '(default)' -Value 'notepad.exe "%1"'
Record "registered ProgID $ProgId"

# 3. per-extension entries
foreach ($e in $Ext) {
    $classes = "HKCU:\Software\Classes\$e"
    New-Item -Path $classes -Force | Out-Null
    $cur = (Get-ItemProperty -Path $classes -ErrorAction SilentlyContinue).'(default)'
    if ([string]::IsNullOrWhiteSpace($cur)) {
        Set-ItemProperty -Path $classes -Name '(default)' -Value $ProgId
    }
    $dotKey = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Explorer\FileExts\$e"
    New-Item -Path $dotKey -Force | Out-Null
    New-Item -Path "$dotKey\OpenWithProgids" -Force | Out-Null
    New-ItemProperty -Path "$dotKey\OpenWithProgids" -Name $ProgId -Value ([byte[]]@()) -PropertyType Binary -Force | Out-Null

    # Only claim the default when this extension truly has none: an existing
    # FileExts ProgId, a UserChoice (the real Win10/11 default) or a
    # Classes\<ext> default all mean "someone else already owns it".
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
        Record "$e -> mdview"
    } else {
        Record "$e available in 'Open with' (default left unchanged)"
    }
}

# 4. optional PATH entry, so `mdview` works from any terminal
if ($AddPath) {
    $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
    if (-not $userPath) { $userPath = '' }
    $already = $userPath.Split(';') | Where-Object { $_ -and ($_.TrimEnd('\') -eq $InstallDir.TrimEnd('\')) }
    if ($already) { Record 'PATH already contains this folder' }
    else {
        $newPath = if ($userPath.TrimEnd(';')) { $userPath.TrimEnd(';') + ';' + $InstallDir } else { $InstallDir }
        [Environment]::SetEnvironmentVariable('Path', $newPath, 'User')
        Record 'added this folder to the user PATH (open a new terminal)'
    }
}

# 5. desktop shortcut, so there is something to click
try {
    $lnk = Join-Path ([Environment]::GetFolderPath('Desktop')) 'mdview.lnk'
    $ws = New-Object -ComObject WScript.Shell
    $sc = $ws.CreateShortcut($lnk)
    $sc.TargetPath = $ExePath
    $sc.WorkingDirectory = $InstallDir
    $sc.IconLocation = "$ExePath,0"
    $sc.Description = 'mdview - local Markdown viewer'
    $sc.Save()
    Record 'created desktop shortcut "mdview"'
} catch {
    Say "  (skipped desktop shortcut: $($_.Exception.Message))" 'Yellow'
}

# 6. self test: open a small file through the freshly registered association
Say ''
Say 'Verifying...' 'Cyan'
$testFile = Join-Path $env:TEMP 'mdview-self-test.md'
$selfTest = @'
# mdview is installed

If you can read this, the portable single-file build works.

| check | result |
|---|---|
| embedded runtime | yes |
| .md association | registered |

- [x] no Node.js required
- [x] runs fully offline
'@
Set-Content -LiteralPath $testFile -Value $selfTest -Encoding UTF8

Say "  opening $testFile ..." 'DarkGray'
& $ExePath $testFile | Out-Null

$ok = $false
foreach ($i in 1..20) {
    Start-Sleep -Milliseconds 300
    try {
        $state = Get-Content -LiteralPath (Join-Path $env:LOCALAPPDATA 'mdview\server.json') -Raw -ErrorAction Stop | ConvertFrom-Json
        $res = Invoke-WebRequest -Uri ("http://127.0.0.1:{0}/health" -f $state.port) -UseBasicParsing -TimeoutSec 3
        if ($res.StatusCode -eq 200) { $ok = $true; break }
    } catch { }
}
if ($ok) { Say '  the viewer is running - check your browser' 'Green' }
else { Say '  could not confirm the server started; see %LOCALAPPDATA%\mdview\server.log' 'Yellow' }

# 7. how to make it the actual default
$userChoice = @()
foreach ($e in $Ext) {
    $uc = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Explorer\FileExts\$e\UserChoice"
    if (Test-Path $uc) {
        $p = Get-ItemProperty -Path $uc -ErrorAction SilentlyContinue
        if ($p -and $p.PSObject.Properties['ProgId'] -and $p.ProgId -ne $ProgId) { $userChoice += $e }
    }
}

if ($Default -and $userChoice.Count -gt 0) {
    Say ''
    Say ('  Windows needs you to confirm the default for: ' + ($userChoice -join ', ')) 'Yellow'
    foreach ($e in $userChoice) {
        $probe = Join-Path $env:TEMP ('mdview-probe' + $e)
        Set-Content -LiteralPath $probe -Value '# mdview' -Encoding UTF8
        Start-Process -FilePath $probe -Verb OpenWith
        Start-Sleep -Milliseconds 900
    }
} elseif ($userChoice.Count -gt 0) {
    Say ''
    Say ('  Note: another app is still the default for ' + ($userChoice -join ', ') + '.') 'Yellow'
    Say '  Right-click any .md -> Open with -> Choose another app -> mdview -> Always.' 'Yellow'
    Say '  Or rerun this script with -Default to get the picker dialog.' 'Yellow'
}

Say ''
Say 'Done.' 'Green'
Say ''
Say '  Double-click any .md file, or run:' 'White'
Say "      `"$ExePath`" `"$testFile`"" 'DarkCyan'
Say ''
Say "  Uninstall:  powershell -NoProfile -ExecutionPolicy Bypass -File `"$PSCommandPath`" -Remove" 'Gray'
Say ''
Say 'Changes made:' 'Cyan'
$script:Changes | ForEach-Object { Say "  - $_" 'DarkGray' }
Say ''
