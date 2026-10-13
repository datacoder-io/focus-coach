# Saves a picture of Dota's top bar (the 10 hero portraits around the clock) for the AI to read.
# Only this strip of the primary screen is captured, nothing else.
param([Parameter(Mandatory)][string]$Out)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
Add-Type @"
using System.Runtime.InteropServices;
public static class CaptureDpi { [DllImport("user32.dll")] public static extern bool SetProcessDPIAware(); [DllImport("user32.dll")] public static extern int GetSystemMetrics(int i); }
"@
[void][CaptureDpi]::SetProcessDPIAware()
$sw = [CaptureDpi]::GetSystemMetrics(0)
$sh = [CaptureDpi]::GetSystemMetrics(1)

# The top bar sits in the middle of the screen's top edge.
$x = [int]($sw * 0.18); $w = [int]($sw * 0.64)
$h = [int]($sh * 0.075)
$src = New-Object System.Drawing.Bitmap $w, $h
$g = [System.Drawing.Graphics]::FromImage($src)
$g.CopyFromScreen($x, 0, 0, 0, $src.Size)
$g.Dispose()

# Keep it around 1800px wide: enough detail for small portraits, fewer tokens.
$scale = [Math]::Min(1.0, 1800.0 / $w) # 1.0, not 1: an int here makes PowerShell pick Min(int,int) and round to 1
$dst = New-Object System.Drawing.Bitmap ([int]($w * $scale)), ([int]($h * $scale))
$g2 = [System.Drawing.Graphics]::FromImage($dst)
$g2.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
$g2.DrawImage($src, 0, 0, $dst.Width, $dst.Height)
$g2.Dispose()
$dst.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png)
$size = "$($dst.Width)x$($dst.Height)"
$src.Dispose(); $dst.Dispose()
Write-Output "ok $size"
