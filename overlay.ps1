# Opens the small coach window over Dota 2: always on top, and click-through (mouse clicks go to the game).
# Dota must be in "Borderless Window" display mode (exclusive fullscreen hides every other window).
#   overlay.ps1          open (or re-open) the overlay, then stay running for the hotkey
#   overlay.ps1 -Close   close it
# Ctrl+Alt+M toggles "move mode": clickable so it can be dragged/resized; pressing it again locks it and saves the spot.
param([switch]$Close)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$config = [IO.File]::ReadAllText((Join-Path $root 'config.json')) | ConvertFrom-Json
$url = "http://localhost:$($config.port)/?overlay=1"
$title = 'Dota Coach Overlay'

Add-Type @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class CoachWin {
    public delegate bool EnumProc(IntPtr h, IntPtr p);
    [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr p);
    // InternalGetWindowText never messages the window, so a busy window (like Dota mid-match) can't stall us
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int InternalGetWindowText(IntPtr h, StringBuilder s, int n);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
    [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int w, int hh, uint flags);
    [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
    [DllImport("user32.dll")] public static extern uint GetDpiForWindow(IntPtr h);
    [DllImport("user32.dll")] public static extern int GetSystemMetrics(int i);
    [DllImport("user32.dll")] public static extern int GetWindowLong(IntPtr h, int i);
    [DllImport("user32.dll")] public static extern int SetWindowLong(IntPtr h, int i, int v);
    [DllImport("user32.dll")] public static extern bool SetLayeredWindowAttributes(IntPtr h, uint key, byte alpha, uint flags);
    [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h, uint msg, IntPtr w, IntPtr l);
    public static IntPtr Find(string text) {
        IntPtr found = IntPtr.Zero;
        EnumWindows((h, p) => {
            if (!IsWindowVisible(h)) return true;
            var sb = new StringBuilder(256);
            InternalGetWindowText(h, sb, 256);
            if (sb.ToString().Contains(text)) { found = h; return false; }
            return true;
        }, IntPtr.Zero);
        return found;
    }
}
"@
[void][CoachWin]::SetProcessDPIAware()

function Close-Overlay {
    for ($i = 0; $i -lt 20; $i++) {
        $h = [CoachWin]::Find($title)
        if ($h -eq [IntPtr]::Zero) { return }
        [void][CoachWin]::PostMessage($h, 0x0010, [IntPtr]::Zero, [IntPtr]::Zero) # WM_CLOSE
        Start-Sleep -Milliseconds 250
    }
}

$closedMarker = Join-Path $root 'cache\overlay.closed'
if ($Close) {
    [IO.File]::WriteAllText($closedMarker, 'closed on purpose') # tells the watchdog below not to reopen it
    Close-Overlay
    Write-Host 'Overlay closed'
    exit 0
}
Remove-Item $closedMarker -ErrorAction SilentlyContinue
# The newest copy of this script owns the overlay; an older copy whose window we're about to close must not reopen it.
$ownerFile = Join-Path $root 'cache\overlay.owner'
[IO.File]::WriteAllText($ownerFile, "$PID")
$self = $PSCommandPath
Close-Overlay

# wait for the coach server (START.bat starts it at the same time).
# 127.0.0.1, not localhost: "localhost" tries IPv6 first and burns ~2s per attempt.
for ($i = 0; $i -lt 60; $i++) {
    try { Invoke-WebRequest -UseBasicParsing -TimeoutSec 3 "http://127.0.0.1:$($config.port)/api/config" | Out-Null; break } catch { Start-Sleep -Milliseconds 500 }
}

# Its own Edge instance: a click-through window can't be clicked to unlock audio,
# so this instance is started with autoplay (and speech) allowed without a click.
$profileDir = Join-Path $root 'cache\edge-overlay'
Start-Process -FilePath 'msedge.exe' -ArgumentList @(
    "--user-data-dir=`"$profileDir`"", '--no-first-run', '--no-default-browser-check',
    '--autoplay-policy=no-user-gesture-required', "--app=$url")
$h = [IntPtr]::Zero
for ($i = 0; $i -lt 60 -and $h -eq [IntPtr]::Zero; $i++) {
    Start-Sleep -Milliseconds 250
    $h = [CoachWin]::Find($title)
}
if ($h -eq [IntPtr]::Zero) { Write-Host 'Could not find the coach window.'; exit 1 }

# click-through: WS_EX_LAYERED + WS_EX_TRANSPARENT, slightly see-through
$GWL_EXSTYLE = -20
$ex = [CoachWin]::GetWindowLong($h, $GWL_EXSTYLE)
[void][CoachWin]::SetWindowLong($h, $GWL_EXSTYLE, ($ex -bor 0x80000 -bor 0x20))
[void][CoachWin]::SetLayeredWindowAttributes($h, 0, 230, 0x2) # LWA_ALPHA

# where you last left it (Ctrl+Alt+M), otherwise the right side of the screen just under Dota's top bar
$scale = [Math]::Max(1, [CoachWin]::GetDpiForWindow($h) / 96)
$screenW = [CoachWin]::GetSystemMetrics(0)
$screenH = [CoachWin]::GetSystemMetrics(1)
$w = [int](300 * $scale)
$hh = [int](235 * $scale)
$x = $screenW - $w - [int](12 * $scale)
$y = [int]($screenH * 0.09)
$posFile = Join-Path $root 'cache\overlay-pos.txt'
if (Test-Path $posFile) {
    $p = [IO.File]::ReadAllText($posFile).Trim().Split(',') | ForEach-Object { [int]$_ }
    if ($p.Count -eq 4 -and $p[2] -gt 100 -and $p[3] -gt 60 -and $p[0] -gt -50 -and $p[1] -gt -50 -and $p[0] -lt $screenW - 50 -and $p[1] -lt $screenH - 50) {
        $x, $y, $w, $hh = $p
    }
}
$HWND_TOPMOST = [IntPtr](-1)
# ASYNC: don't wait on the browser's window thread; NOACTIVATE: don't steal focus from Dota; FRAMECHANGED: apply new styles
$flags = 0x4000 -bor 0x0040 -bor 0x0010 -bor 0x0020
[void][CoachWin]::SetWindowPos($h, $HWND_TOPMOST, $x, $y, $w, $hh, $flags)
Write-Host "Overlay pinned on top (click-through) at $x,$y ($w x $hh)"

# ---- stay running: Ctrl+Alt+M hotkey for move mode; exit when the overlay window closes ----
Add-Type -ReferencedAssemblies System.Windows.Forms @"
using System;
using System.IO;
using System.Media;
using System.Windows.Forms;
using System.Runtime.InteropServices;
public class OverlayMover : NativeWindow {
    [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
    [DllImport("user32.dll")] static extern bool RegisterHotKey(IntPtr h, int id, uint mods, uint vk);
    [DllImport("user32.dll")] static extern bool IsWindow(IntPtr h);
    [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out RECT r);
    [DllImport("user32.dll")] static extern int GetWindowLong(IntPtr h, int i);
    [DllImport("user32.dll")] static extern int SetWindowLong(IntPtr h, int i, int v);
    [DllImport("user32.dll")] static extern bool SetLayeredWindowAttributes(IntPtr h, uint key, byte alpha, uint flags);
    [DllImport("user32.dll")] static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int w, int hh, uint flags);
    [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr h);
    readonly IntPtr target;
    readonly string posFile;
    bool moving;
    public OverlayMover(IntPtr target, string posFile) {
        this.target = target;
        this.posFile = posFile;
        CreateHandle(new CreateParams());
    }
    // Ctrl+Alt+M (MOD_CONTROL | MOD_ALT | MOD_NOREPEAT)
    public bool Register() { return RegisterHotKey(Handle, 1, 0x0002 | 0x0001 | 0x4000, 0x4D); }
    public bool Alive() { return IsWindow(target); }
    protected override void WndProc(ref Message m) {
        if (m.Msg == 0x0312) Toggle(); // WM_HOTKEY
        base.WndProc(ref m);
    }
    void Toggle() {
        int ex = GetWindowLong(target, -20);
        if (!moving) {
            SetWindowLong(target, -20, ex & ~0x20);   // clickable: drag the title bar, resize from the edges
            SetLayeredWindowAttributes(target, 0, 255, 2);
            SetForegroundWindow(target);
            SystemSounds.Asterisk.Play();
        } else {
            SetWindowLong(target, -20, ex | 0x20 | 0x80000);   // click-through again
            SetLayeredWindowAttributes(target, 0, 230, 2);
            SetWindowPos(target, (IntPtr)(-1), 0, 0, 0, 0, 0x0001 | 0x0002 | 0x0010 | 0x0020 | 0x4000);
            RECT r;
            if (GetWindowRect(target, out r)) File.WriteAllText(posFile, r.L + "," + r.T + "," + (r.R - r.L) + "," + (r.B - r.T));
            SystemSounds.Exclamation.Play();
        }
        moving = !moving;
    }
}
"@
$mover = New-Object OverlayMover -ArgumentList $h, $posFile
$registered = $false
for ($i = 0; $i -lt 12 -and -not $registered; $i++) {
    $registered = $mover.Register() # an older copy of this script may still hold the hotkey for a moment
    if (-not $registered) { Start-Sleep -Milliseconds 500 }
}
$status = "$(Get-Date -Format s) overlay at $x,$y ($w x $hh); Ctrl+Alt+M: " + $(if ($registered) { 'ready' } else { 'hotkey unavailable' })
Write-Host $status
[IO.File]::WriteAllText((Join-Path $root 'cache\overlay.log'), $status)
$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 2000
$timer.add_Tick({
    if ($mover.Alive()) { return }
    # Window gone. Closed by accident mid-match? Bring it back (not after "overlay.ps1 -Close", and not once Dota is closed).
    $stillOwner = ([IO.File]::ReadAllText($ownerFile).Trim() -eq "$PID")
    if ($stillOwner -and -not (Test-Path $closedMarker) -and (Get-Process dota2 -ErrorAction SilentlyContinue)) {
        Start-Process -FilePath 'powershell.exe' -WindowStyle Hidden -ArgumentList '-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', "`"$self`""
    }
    [System.Windows.Forms.Application]::ExitThread()
})
$timer.Start()
[System.Windows.Forms.Application]::Run()
