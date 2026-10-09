#Requires -RunAsAdministrator
param([string]$ParcelPrinter = '', [string]$LetterPrinter = '')
$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$stationDir = Join-Path $env:ProgramData 'AvyCloud Print Agent'
$taskName = 'AvyCloud Print Agent'
$verifyName = 'AvyCloud Print Agent Setup Check'
$backend = 'https://product-hub-backend-79205549235.europe-west3.run.app'
$apiKey = 'AIzaSyBP0YAdmyTiGTIJwA1q5bvEF2lUxmHoq9U'
$utf8 = New-Object System.Text.UTF8Encoding($false)

if (-not [Environment]::Is64BitOperatingSystem) { throw 'Windows 64 Bit ist erforderlich.' }

# Check available printers before downloads or changes to an existing station.
$inventoryJson = & (Join-Path $PSScriptRoot 'lib\windows-printers.ps1')
$parsedPrinters = $inventoryJson | ConvertFrom-Json
$all = @($parsedPrinters)
function Test-PrinterPaper($paper, [double]$width, [double]$height) {
  # Keep aligned with lib/windows.js. The real QL-1110 fixed 103x164 form
  # reports 103.63x164.34 mm. Extra tolerance requires its exact fixed name.
  $tolerance = 0.6
  $size = [regex]::Match(([string]$paper.name).Trim(), '^(\d+(?:[.,]\d+)?)\s*mm\s*[x\u00d7]\s*(\d+(?:[.,]\d+)?)\s*mm(?:\s*\([^)]*\))?$', 'IgnoreCase')
  if ($size.Success) {
    $culture = [Globalization.CultureInfo]::InvariantCulture
    $namedWidth = [double]::Parse($size.Groups[1].Value.Replace(',', '.'), $culture)
    $namedHeight = [double]::Parse($size.Groups[2].Value.Replace(',', '.'), $culture)
    if ($namedWidth -eq $width -and $namedHeight -eq $height) { $tolerance = 1.0 }
  }
  return $paper.kind -gt 0 -and [Math]::Abs($paper.widthMm - $width) -le $tolerance -and [Math]::Abs($paper.heightMm - $height) -le $tolerance
}
function Choose-Printer([string]$role, [double]$width, [double]$height, [string]$selected) {
  $choices = @($all | Where-Object { @($_.papers | Where-Object {
    Test-PrinterPaper $_ $width $height
  }).Count -gt 0 })
  if ($selected) {
    if (-not ($choices | Where-Object { $_.name -eq $selected })) { throw "Drucker/Formate fuer $role nicht gefunden: $selected" }
    return $selected
  }
  if ($choices.Count -eq 0) {
    Write-Host ('Vorhandene Windows-Drucker: ' + (($all | ForEach-Object { $_.name }) -join ', '))
    if ($role -eq 'Paket (DHL/DPD)') {
      throw 'Kein Windows-Treiber meldet ein passendes Rollenformat 103 x 164 mm. Der Drucker kann bereits installiert sein. Treiber und Papierformate mit der AvyCloud-Druckerdiagnose pruefen.'
    }
    throw "Kein Drucker mit $width x $height mm. Brother-Treiber und Rollenformat zuerst einrichten."
  }
  Write-Host "`n$role - $width x $height mm"
  for ($i=0; $i -lt $choices.Count; $i++) { Write-Host ('  {0}: {1}' -f ($i+1), $choices[$i].name) }
  $answer = Read-Host 'Drucker-Nummer'
  $number = 0
  if (-not [int]::TryParse($answer, [ref]$number) -or $number -lt 1 -or $number -gt $choices.Count) { throw 'Ungueltige Auswahl.' }
  return $choices[$number-1].name
}
$parcel = Choose-Printer 'Paket (DHL/DPD)' 103 164 $ParcelPrinter
$letter = Choose-Printer 'Brief (Deutsche Post)' 62 100 $LetterPrinter
if ($parcel -eq $letter) { throw 'Paket und Brief brauchen zwei verschiedene Drucker.' }

New-Item -ItemType Directory -Path $stationDir -Force | Out-Null
# The daemon needs no administrator rights. Only LocalService, SYSTEM and
# administrators may read the refresh session or change its executable.
$acl = New-Object System.Security.AccessControl.DirectorySecurity
$acl.SetAccessRuleProtection($true, $false)
foreach ($sid in @('S-1-5-18', 'S-1-5-32-544', 'S-1-5-19')) {
  $identity = New-Object System.Security.Principal.SecurityIdentifier($sid)
  $rule = New-Object System.Security.AccessControl.FileSystemAccessRule($identity, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')
  $acl.AddAccessRule($rule)
}
Set-Acl -LiteralPath $stationDir -AclObject $acl
$runtime = Join-Path $stationDir 'runtime'
New-Item -ItemType Directory -Path $runtime -Force | Out-Null
$manifest = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'windows-runtime.json') -Raw | ConvertFrom-Json

Write-Host 'AvyCloud Druckstation: Windows-Laufzeit vorbereiten ...'
foreach ($entry in @(@{ spec=$manifest.node; target='node.exe' }, @{ spec=$manifest.sumatra; target='SumatraPDF.exe' })) {
  $archive = Join-Path $runtime ($entry.target + '.zip')
  $expanded = Join-Path $runtime ($entry.target + '.files')
  Invoke-WebRequest -UseBasicParsing -Uri $entry.spec.url -OutFile $archive
  if ((Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash -ne $entry.spec.sha256) {
    throw ('Pruefsumme stimmt nicht: ' + $entry.target)
  }
  Expand-Archive -LiteralPath $archive -DestinationPath $expanded -Force
  $source = Join-Path $expanded $entry.spec.executable
  # Do not replace executables underneath an active daemon.
  if (Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue) {
    Disable-ScheduledTask -TaskName $taskName | Out-Null
    Stop-ScheduledTask -TaskName $taskName
    $deadline = (Get-Date).AddSeconds(30)
    while ((Get-ScheduledTask -TaskName $taskName).State -eq 'Running') {
      if ((Get-Date) -gt $deadline) { throw 'Druckdienst beendet sich nicht. Update abgebrochen.' }
      Start-Sleep -Milliseconds 300
    }
  }
  Copy-Item -LiteralPath $source -Destination (Join-Path $runtime $entry.target) -Force
}

$current = Join-Path $stationDir 'current'
New-Item -ItemType Directory -Path $current -Force | Out-Null
foreach ($name in @('index.js', 'windows-run.js', 'package.json', 'lib', 'fixtures')) {
  Copy-Item -LiteralPath (Join-Path $PSScriptRoot $name) -Destination $current -Recurse -Force
}
$config = @{ backend=$backend; apiKey=$apiKey; parcel=$parcel; letter=$letter }
[IO.File]::WriteAllText((Join-Path $stationDir 'config.json'), ($config | ConvertTo-Json), $utf8)

# Verify under the actual unattended identity, including one TEST label per
# role. No order, shipping purchase, production print claim or stock write.
$principal = New-ScheduledTaskPrincipal -UserId 'S-1-5-19' -LogonType ServiceAccount
$node = Join-Path $runtime 'node.exe'
$runner = Join-Path $current 'windows-run.js'
$verification = Join-Path $stationDir 'verification.json'
if (Test-Path -LiteralPath $verification) { Remove-Item -LiteralPath $verification }
$verifyAction = New-ScheduledTaskAction -Execute $node -Argument ('"' + $runner + '" --verify') -WorkingDirectory $current
$verifySettings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Minutes 5) -MultipleInstances IgnoreNew
Register-ScheduledTask -TaskName $verifyName -Action $verifyAction -Principal $principal -Settings $verifySettings -Force | Out-Null
try {
  Start-ScheduledTask -TaskName $verifyName
  $deadline = (Get-Date).AddMinutes(5)
  while (-not (Test-Path -LiteralPath $verification)) {
    if ((Get-Date) -gt $deadline) { throw "Drucktest ohne Ergebnis. Protokoll: $stationDir\agent.log" }
    Start-Sleep -Seconds 1
  }
  $result = Get-Content -LiteralPath $verification -Raw | ConvertFrom-Json
  if (-not $result.ok) { throw $result.error }
} finally {
  Stop-ScheduledTask -TaskName $verifyName -ErrorAction SilentlyContinue
  Unregister-ScheduledTask -TaskName $verifyName -Confirm:$false -ErrorAction SilentlyContinue
}
Write-Host "`nEs wurden ZWEI TEST-Etiketten ueber das spaetere Dienstkonto ausgegeben."
$confirmed = Read-Host 'Sind beide vollstaendig, auf der richtigen Rolle und die Testcodes scanbar? JA eingeben'
if ($confirmed -cne 'JA') { throw 'Druckstation noch nicht freigegeben. Rollen/Treiber pruefen und Setup wiederholen.' }

$email = Read-Host 'AvyCloud E-Mail der Druckstation'
$secure = Read-Host 'AvyCloud Passwort (wird NICHT gespeichert)' -AsSecureString
$pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
try {
  $password = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)
  $body = @{ email=$email; password=$password; returnSecureToken=$true } | ConvertTo-Json -Compress
  try {
    $auth = Invoke-RestMethod -Method Post -Uri "https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=$apiKey" -ContentType 'application/json' -Body $body -TimeoutSec 30
  } catch { throw 'AvyCloud-Anmeldung fehlgeschlagen. E-Mail/Passwort pruefen.' }
} finally {
  [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer)
  $password = $null; $body = $null; $secure.Dispose()
}
$headers = @{ Authorization=('Bearer ' + $auth.idToken) }
$permission = Invoke-RestMethod -Uri "$backend/api/me/permissions" -Headers $headers -TimeoutSec 30
$p = $permission.data.permissions
if (-not ($p.'*'.'*' -eq $true -or $p.orders.'*' -eq $true -or ($p.orders.read -eq $true -and $p.orders.ship -eq $true))) {
  throw 'Konto braucht Auftraege lesen und Versand/Druck. Rechte wurden nicht geaendert.'
}
[IO.File]::WriteAllText((Join-Path $stationDir 'session.json'), (@{refreshToken=$auth.refreshToken} | ConvertTo-Json -Compress), $utf8)
$action = New-ScheduledTaskAction -Execute $node -Argument ('"' + $runner + '"') -WorkingDirectory $current
$trigger = New-ScheduledTaskTrigger -AtStartup
$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null
Enable-ScheduledTask -TaskName $taskName | Out-Null
$startedAt = [DateTimeOffset]::UtcNow
Start-ScheduledTask -TaskName $taskName
$expectedId = 'print-agent-' + [System.Net.Dns]::GetHostName()
for ($attempt=0; $attempt -lt 20; $attempt++) {
  Start-Sleep -Seconds 2
  $status = Invoke-RestMethod -Uri "$backend/api/print/status" -Headers $headers -TimeoutSec 15
  if ($status.data.agents | Where-Object { $_.agentId -eq $expectedId -and $_.online -and [DateTimeOffset]$_.lastSeenAt -ge $startedAt }) {
    if ($status.data.protocolVersion -ne 2) {
      Write-Host 'Station eingerichtet und getestet. Wartet auf das AvyCloud-Backend-Update (Protokoll 2).'
    } else { Write-Host 'Druckstation ONLINE. AvyCloud kann jetzt direkt drucken.' }
    Write-Host "Automatischer Start auch ohne Windows-Anmeldung. Protokoll: $stationDir\agent.log"
    exit 0
  }
}
throw "Dienst eingerichtet, aber kein frischer Heartbeat. Protokoll: $stationDir\agent.log"
