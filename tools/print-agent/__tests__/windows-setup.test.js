const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const powershell = process.platform === 'win32' ? 'powershell.exe' : 'pwsh';
const available = spawnSync(powershell, ['-NoProfile', '-Command', 'exit 0'], { timeout: 10000 }).status === 0;

test('Windows setup verification and daemon can start and continue on battery power',
  { skip: !available && 'PowerShell is not installed' }, async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'avycloud-setup-power-'));
    const harness = `param([string]$Installer)
$ErrorActionPreference = 'Stop'
$tokens = $null; $errors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile($Installer, [ref]$tokens, [ref]$errors)
if ($errors.Count) { throw 'Installer syntax failed' }
# Model the Windows cmdlet defaults; execute only the actual settings expressions.
# No task is registered or started by this test.
function New-ScheduledTaskSettingsSet {
  param([TimeSpan]$ExecutionTimeLimit, [string]$MultipleInstances, [int]$RestartCount,
    [TimeSpan]$RestartInterval, [switch]$StartWhenAvailable,
    [switch]$AllowStartIfOnBatteries, [switch]$DontStopIfGoingOnBatteries)
  return @{ DisallowStartIfOnBatteries = -not $AllowStartIfOnBatteries;
    StopIfGoingOnBatteries = -not $DontStopIfGoingOnBatteries }
}
$calls = @($ast.FindAll({param($n)
  $n -is [System.Management.Automation.Language.CommandAst] -and
    $n.GetCommandName() -eq 'New-ScheduledTaskSettingsSet'
}, $true))
if ($calls.Count -ne 2) { throw 'Expected verification and daemon settings' }
foreach ($call in $calls) {
  $settings = & ([scriptblock]::Create($call.Extent.Text))
  if ($settings.DisallowStartIfOnBatteries) { throw 'Task would not start on battery power' }
  if ($settings.StopIfGoingOnBatteries) { throw 'Task would stop when power is unplugged' }
}
Write-Output 'Both tasks allow battery operation'
`;
    try {
      const harnessFile = path.join(directory, 'verify.ps1');
      await fs.writeFile(harnessFile, harness);
      const result = spawnSync(powershell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
        '-File', harnessFile, path.resolve(__dirname, '../install-windows.ps1')],
      { encoding: 'utf8', timeout: 30000, shell: false });
      assert.equal(result.status, 0, result.stdout + result.stderr);
      assert.match(result.stdout, /Both tasks allow battery operation/);
    } finally { await fs.rm(directory, { recursive: true, force: true }); }
  });

test('Windows setup accepts actual Brother fixed forms and rejects mismatched/unnamed sizes before installation',
  { skip: !available && 'PowerShell is not installed' }, async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'avycloud-setup-formats-'));
    const fixture = [
      { name: 'QL1110', papers: [{ name: '103mm x 164mm', kind: 385, widthMm: 103.63, heightMm: 164.34 }] },
      { name: 'DP Label', papers: [{ name: '62mm x 100mm', kind: 275, widthMm: 61.98, heightMm: 99.82 }] },
      { name: 'Generic', papers: [{ name: '103mm', kind: 265, widthMm: 103.63, heightMm: 164.34 }] },
      { name: 'WrongWidth', papers: [{ name: '103mm x 164mm', kind: 385, widthMm: 104.01, heightMm: 164.34 }] },
      { name: 'WrongHeight', papers: [{ name: '103mm x 164mm', kind: 385, widthMm: 103.63, heightMm: 165.01 }] },
      { name: 'WrongName', papers: [{ name: '104mm x 164mm', kind: 385, widthMm: 103.63, heightMm: 164.34 }] },
    ];
    const harness = `param([string]$Installer, [string]$Fixture)
$ErrorActionPreference = 'Stop'
$tokens = $null; $errors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile($Installer, [ref]$tokens, [ref]$errors)
if ($errors.Count) { throw 'Installer syntax failed' }
# Load only selection functions. Never run installer downloads, service changes or printing.
foreach ($fn in $ast.FindAll({param($n) $n -is [System.Management.Automation.Language.FunctionDefinitionAst]}, $false)) {
  . ([scriptblock]::Create($fn.Extent.Text))
}
$items = Get-Content -LiteralPath $Fixture -Raw | ConvertFrom-Json
$all = @($items)
if ((Choose-Printer 'Paket (DHL/DPD)' 103 164 'QL1110') -ne 'QL1110') { throw 'Actual parcel form rejected' }
if ((Choose-Printer 'Brief (Deutsche Post)' 62 100 'DP Label') -ne 'DP Label') { throw 'Actual letter form rejected' }
foreach ($name in @('Generic','WrongWidth','WrongHeight','WrongName')) {
  $rejected = $false
  try { $null = Choose-Printer 'Paket (DHL/DPD)' 103 164 $name } catch { $rejected = $true }
  if (-not $rejected) { throw ('Invalid printer format accepted: ' + $name) }
}
Write-Output 'Windows printer selection passed'
`;
    try {
      await fs.writeFile(path.join(directory, 'printers.json'), JSON.stringify(fixture));
      await fs.writeFile(path.join(directory, 'verify.ps1'), harness);
      const result = spawnSync(powershell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
        '-File', path.join(directory, 'verify.ps1'), path.resolve(__dirname, '../install-windows.ps1'),
        path.join(directory, 'printers.json')], { encoding: 'utf8', timeout: 30000, shell: false });
      assert.equal(result.status, 0, result.stdout + result.stderr);
      assert.match(result.stdout, /Windows printer selection passed/);
    } finally { await fs.rm(directory, { recursive: true, force: true }); }
  });
