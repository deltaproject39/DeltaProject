# Builds Delta.exe (her desktop app) into the DeltaProject folder, using the C# compiler that
# comes with Windows (.NET Framework 4). Run: right-click > "Run with PowerShell".

$ErrorActionPreference = "Stop"
$here = $PSScriptRoot
$repo = Split-Path $here -Parent
$csc = "$env:WINDIR\Microsoft.NET\Framework64\v4.0.30319\csc.exe"

& $csc /nologo /target:winexe /optimize+ "/win32icon:$here\delta.ico" "/out:$repo\Delta.exe" `
    /r:System.Windows.Forms.dll /r:System.Drawing.dll "$here\DeltaApp.cs"
if ($LASTEXITCODE -ne 0) { throw "Build failed" }
Write-Host "Built $repo\Delta.exe" -ForegroundColor Green
