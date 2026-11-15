# SniperValley: get a Megascans pack from Fab out of Unreal Engine in a form the game can use.
# Default pack: the European Beech trees, which Fab only offers in Unreal Engine format.
# Three steps, run in PowerShell from the SniperValley folder:
#
#   powershell -ExecutionPolicy Bypass -File scripts\megascans\megascans.ps1 setup
#       makes an empty Unreal project "SVMegascans" (Documents\Unreal Projects) and opens it once.
#       Then, in Epic Games Launcher: Library -> Fab Library -> European Beech -> Add to Project.
#   powershell -ExecutionPolicy Bypass -File scripts\megascans\megascans.ps1 export
#       opens the project with export_megascans.py, waits for it, scales the textures to 2048.
#       Output: %USERPROFILE%\SniperValley-megascans
#   powershell -ExecutionPolicy Bypass -File scripts\megascans\megascans.ps1 upload
#       pushes that folder to your PRIVATE repository <owner>/SniperValley-assets (create it on
#       github.com first: New repository, Private, no README). Refuses a public repository.
#
# The Fab Standard License forbids sharing the files themselves, so they never go into the
# SniperValley repository, which is public. Options: -Pack beech (a word in the asset paths),
# -Repo SniperValley-assets, -MaxTexture 2048.
param(
  [Parameter(Position = 0)][ValidateSet('setup', 'export', 'upload')][string]$Step = 'setup',
  [string]$Pack = 'beech',
  [string]$Repo = 'SniperValley-assets',
  [int]$MaxTexture = 2048
)
$ErrorActionPreference = 'Stop'
$Root = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$ProjectName = 'SVMegascans'
$ProjectDir = Join-Path ([Environment]::GetFolderPath('MyDocuments')) "Unreal Projects\$ProjectName"
$Uproject = Join-Path $ProjectDir "$ProjectName.uproject"
$OutDir = Join-Path $HOME 'SniperValley-megascans'

function Say([string]$Msg, [string]$Color = 'Cyan') { Write-Host $Msg -ForegroundColor $Color }

# Installed Unreal Engine 5 versions (Epic Games Launcher), newest first, or the one asked for.
function Find-Engine([string]$Want = '') {
  $found = @()
  $dat = Join-Path $env:ProgramData 'Epic\UnrealEngineLauncher\LauncherInstalled.dat'
  if (Test-Path $dat) {
    foreach ($i in (Get-Content $dat -Raw | ConvertFrom-Json).InstallationList) {
      if ($i.AppName -match '^UE_5\.(\d+)') { $found += [pscustomobject]@{ Minor = [int]$Matches[1]; Dir = $i.InstallLocation } }
    }
  }
  foreach ($d in @(Get-ChildItem (Join-Path $env:ProgramFiles 'Epic Games') -Directory -Filter 'UE_5.*' -ErrorAction SilentlyContinue)) {
    if ($d.Name -match '^UE_5\.(\d+)') { $found += [pscustomobject]@{ Minor = [int]$Matches[1]; Dir = $d.FullName } }
  }
  $found = @($found | Where-Object { Test-Path (Join-Path $_.Dir 'Engine\Binaries\Win64\UnrealEditor.exe') } | Sort-Object Minor -Descending)
  if ($found.Count -eq 0) {
    throw 'Unreal Engine 5 er ikke installeret. Åbn Epic Games Launcher -> Unreal Engine -> Library -> "+" ved Engine Versions -> Install.'
  }
  $e = $found[0]
  if ($Want -match '^5\.(\d+)') {
    $match = @($found | Where-Object { $_.Minor -eq [int]$Matches[1] })
    if ($match.Count) { $e = $match[0] } else { Say "Unreal $Want er ikke installeret, bruger 5.$($e.Minor)." 'Yellow' }
  }
  $e | Add-Member -NotePropertyName Editor -NotePropertyValue (Join-Path $e.Dir 'Engine\Binaries\Win64\UnrealEditor.exe') -PassThru
}

function Assert-NoUnreal {
  if (Get-Process UnrealEditor -ErrorAction SilentlyContinue) { throw 'Luk Unreal Engine først (alle vinduer), og kør så kommandoen igen.' }
}

function Invoke-Setup {
  Assert-NoUnreal
  $e = Find-Engine
  New-Item -ItemType Directory -Force (Join-Path $ProjectDir 'Content') | Out-Null
  if (-not (Test-Path $Uproject)) {
    $proj = [ordered]@{
      FileVersion       = 3
      EngineAssociation = "5.$($e.Minor)"
      Category          = ''
      Description       = 'SniperValley: export of Megascans assets (scripts/megascans)'
      Plugins           = @(
        [ordered]@{ Name = 'PythonScriptPlugin'; Enabled = $true },
        [ordered]@{ Name = 'EditorScriptingUtilities'; Enabled = $true },
        [ordered]@{ Name = 'GLTFExporter'; Enabled = $true }
      )
    }
    [IO.File]::WriteAllText($Uproject, ($proj | ConvertTo-Json -Depth 5))
  }
  Say "Unreal-projektet er lavet: $Uproject (Unreal 5.$($e.Minor))"
  Say 'Unreal åbner nu én gang, så Epic Games Launcher kan finde projektet. Første gang tager det lidt tid.'
  Start-Process -FilePath $e.Editor -ArgumentList "`"$Uproject`""
  Say ''
  Say 'NÆSTE SKRIDT:' 'Green'
  Say '  1. Når Unreal er åbent: luk det igen.'
  Say "  2. Epic Games Launcher -> Unreal Engine -> Library -> Fab Library -> European Beech -> Add to Project -> $ProjectName"
  Say '     (står projektet ikke på listen: sæt hak i "Show all projects" og vælg det; spørger den om version, tag den nyeste).'
  Say '  3. Vent til downloaden er færdig, og kør:  powershell -ExecutionPolicy Bypass -File scripts\megascans\megascans.ps1 export'
}

function Invoke-Export {
  Assert-NoUnreal
  if (-not (Test-Path $Uproject)) { throw "Kør først: powershell -ExecutionPolicy Bypass -File scripts\megascans\megascans.ps1 setup" }
  $e = Find-Engine ((Get-Content $Uproject -Raw | ConvertFrom-Json).EngineAssociation)
  $hits = @(Get-ChildItem (Join-Path $ProjectDir 'Content') -Recurse -Filter '*.uasset' -ErrorAction SilentlyContinue | Where-Object { $_.FullName -like "*$Pack*" })
  if ($hits.Count -eq 0) {
    throw "Pakken er ikke i projektet endnu. Epic Games Launcher -> Library -> Fab Library -> European Beech -> Add to Project -> $ProjectName"
  }
  Say "Fandt $($hits.Count) Unreal-filer fra pakken."
  # fresh output (keep .git from an earlier upload)
  New-Item -ItemType Directory -Force $OutDir | Out-Null
  Get-ChildItem $OutDir -Force | Where-Object { $_.Name -ne '.git' } | Remove-Item -Recurse -Force
  [IO.File]::WriteAllText((Join-Path $OutDir 'LICENSE-NOTE.txt'),
    "Quixel Megascans content from Fab, Fab Standard License.`r`nPRIVATE: do not share or publish these files. For use inside SniperValley only.`r`n")
  $env:SV_EXPORT_DIR = $OutDir
  $env:SV_PACK = $Pack
  $py = Join-Path $PSScriptRoot 'export_megascans.py'
  Say 'Unreal starter og eksporterer. Det kan tage 10-60 minutter første gang. Lad vinduet være.'
  $p = Start-Process -FilePath $e.Editor -ArgumentList "`"$Uproject`" -ExecutePythonScript=`"$py`"" -PassThru
  $done = Join-Path $OutDir 'done.txt'
  $report = Join-Path $OutDir 'report.txt'
  $start = Get-Date
  $last = ''
  while (-not (Test-Path $done) -and -not $p.HasExited) {
    Start-Sleep -Seconds 10
    if (Test-Path $report) {
      $line = Get-Content $report -Tail 1 -ErrorAction SilentlyContinue
      if ($line -and $line -ne $last) { Write-Host ('[{0:N0} min] {1}' -f ((Get-Date) - $start).TotalMinutes, $line); $last = $line }
    }
  }
  if (-not $p.HasExited) {
    Start-Sleep -Seconds 10
    if (-not $p.HasExited) { Stop-Process -Id $p.Id -Force }   # nothing to save: the project only lends its content
  }
  if (-not (Test-Path $done)) { throw "Unreal lukkede før eksporten var færdig. Send Claude filen $report (og fortæl hvad Unreal viste)." }

  # textures above $MaxTexture px -> $MaxTexture (the game and the browser use no more)
  Add-Type -AssemblyName System.Drawing
  foreach ($f in @(Get-ChildItem (Join-Path $OutDir 'textures') -Filter '*.png' -ErrorAction SilentlyContinue)) {
    $img = [System.Drawing.Image]::FromFile($f.FullName)
    $w = $img.Width; $h = $img.Height
    if ([Math]::Max($w, $h) -le $MaxTexture) { $img.Dispose(); continue }
    $k = $MaxTexture / [Math]::Max($w, $h)
    $nw = [int][Math]::Round($w * $k); $nh = [int][Math]::Round($h * $k)
    $bmp = New-Object System.Drawing.Bitmap $nw, $nh, ([System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.CompositingMode = [System.Drawing.Drawing2D.CompositingMode]::SourceCopy
    $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
    $attr = New-Object System.Drawing.Imaging.ImageAttributes
    $attr.SetWrapMode([System.Drawing.Drawing2D.WrapMode]::TileFlipXY)
    $g.DrawImage($img, (New-Object System.Drawing.Rectangle 0, 0, $nw, $nh), 0, 0, $w, $h, [System.Drawing.GraphicsUnit]::Pixel, $attr)
    $g.Dispose(); $img.Dispose()
    $bmp.Save($f.FullName, [System.Drawing.Imaging.ImageFormat]::Png)
    $bmp.Dispose()
    Write-Host ("  {0}: {1}x{2} -> {3}x{4}" -f $f.Name, $w, $h, $nw, $nh)
  }

  $files = @(Get-ChildItem $OutDir -Recurse -File | Where-Object { $_.FullName -notlike '*\.git\*' })
  $mb = ($files | Measure-Object Length -Sum).Sum / 1MB
  $glb = @($files | Where-Object Extension -eq '.glb').Count
  $tex = @($files | Where-Object { $_.DirectoryName -like '*\textures' }).Count
  Say ''
  Say ("Eksport færdig: {0} modeller (.glb), {1} teksturer, {2:N0} MB i {3}" -f $glb, $tex, $mb, $OutDir) 'Green'
  foreach ($big in @($files | Where-Object { $_.Length -gt 95MB })) { Say ("  For stor til GitHub (over 95 MB): {0}" -f $big.Name) 'Yellow' }
  Get-Content $report -Tail 3
  Say ''
  Say "NÆSTE SKRIDT: lav et PRIVAT repo på github.com/new med navnet $Repo (Private, uden README), og kør:" 'Green'
  Say '  powershell -ExecutionPolicy Bypass -File scripts\megascans\megascans.ps1 upload'
}

function Invoke-Upload {
  if (-not (Test-Path (Join-Path $OutDir 'inventory.json'))) { throw "Kør først: powershell -ExecutionPolicy Bypass -File scripts\megascans\megascans.ps1 export" }
  $origin = (git -C $Root remote get-url origin)
  if ($origin -notmatch 'github\.com[:/]([^/]+)/') { throw "Kunne ikke finde din GitHub-bruger ud fra '$origin'." }
  $owner = $Matches[1]
  $url = "https://github.com/$owner/$Repo.git"
  # never push Fab files to a public repository (an anonymous lookup only sees public ones)
  $public = $false
  try {
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    $r = Invoke-RestMethod -Uri "https://api.github.com/repos/$owner/$Repo" -Headers @{ 'User-Agent' = 'SniperValley-megascans' }
    $public = -not $r.private
  } catch { }
  if ($public) { throw "STOP: $owner/$Repo er OFFENTLIGT. Fab-licensen tillader ikke det. Gør det privat (Settings -> Danger Zone -> Change visibility) og prøv igen." }
  Push-Location $OutDir
  try {
    if (-not (Test-Path '.git')) { git init -q; git symbolic-ref HEAD refs/heads/main }
    if (-not (git config user.name)) { git config user.name 'SniperValley export' }
    if (-not (git config user.email)) { git config user.email 'export@localhost' }
    if (@(git remote) -contains 'origin') { git remote set-url origin $url } else { git remote add origin $url }
    git add -A
    git commit -q -m "Megascans export: $Pack"
    git push -u origin main
    if ($LASTEXITCODE -ne 0) { throw "Upload fejlede. Findes det private repo $owner/$Repo på github.com (Private, uden README)?" }
  } finally { Pop-Location }
  Say ''
  Say "Uploadet til $url" 'Green'
  Say "Skriv til Claude: 'Megascans er uploadet til $Repo'." 'Green'
}

switch ($Step) {
  'setup' { Invoke-Setup }
  'export' { Invoke-Export }
  'upload' { Invoke-Upload }
}
