$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
Add-Type -AssemblyName System.Drawing
$printers = @(foreach ($name in [System.Drawing.Printing.PrinterSettings]::InstalledPrinters) {
  $settings = New-Object System.Drawing.Printing.PrinterSettings
  $settings.PrinterName = $name
  if (-not $settings.IsValid) { continue }
  $papers = @(foreach ($paper in $settings.PaperSizes) {
    [PSCustomObject]@{
      name = $paper.PaperName
      kind = [int]$paper.RawKind
      widthMm = [Math]::Round($paper.Width * 0.254, 2)
      heightMm = [Math]::Round($paper.Height * 0.254, 2)
    }
  })
  [PSCustomObject]@{ name = [string]$name; papers = $papers }
})
ConvertTo-Json -InputObject $printers -Depth 5 -Compress
