param(
  [Parameter(Position=0)][string]$EncodedArgs,
  [Parameter(Position=1)][string]$SimulatorPath,
  [switch]$HostMode
)
$ErrorActionPreference = 'Stop'
$script:DesktopHandles = @{}
try { [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false) } catch { }
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes, System.Drawing, Accessibility
Add-Type -ReferencedAssemblies ([Accessibility.IAccessible].Assembly.Location) -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class GarminWin {
 [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
 [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X, Y; }
 [StructLayout(LayoutKind.Sequential)] public struct MONITORINFO { public int cbSize; public RECT rcMonitor; public RECT rcWork; public uint dwFlags; }
 [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
 [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr context);
 [DllImport("user32.dll")] public static extern IntPtr MonitorFromWindow(IntPtr h, uint flags);
 [DllImport("user32.dll")] public static extern bool GetMonitorInfo(IntPtr monitor, ref MONITORINFO info);
 [DllImport("shcore.dll")] public static extern int GetDpiForMonitor(IntPtr monitor, int type, out uint x, out uint y);
 [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
 [DllImport("user32.dll")] public static extern bool GetClientRect(IntPtr h, out RECT r);
 [DllImport("user32.dll")] public static extern bool ClientToScreen(IntPtr h, ref POINT p);
 [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
 [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int n);
 [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
 [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
 [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
 [DllImport("user32.dll")] public static extern IntPtr SendMessageTimeout(IntPtr h, uint message, UIntPtr w, IntPtr l, uint flags, uint timeout, out UIntPtr result);
 [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint process);
 [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr h, uint flags);
 [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(POINT p);
 [DllImport("user32.dll")] public static extern IntPtr GetTopWindow(IntPtr h);
 [DllImport("user32.dll")] public static extern IntPtr GetWindow(IntPtr h, uint cmd);
 [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, System.Text.StringBuilder s, int n);
 [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassName(IntPtr h, System.Text.StringBuilder s, int n);
 [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags);
 [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint attach, uint attachTo, bool doAttach);
 [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
 [DllImport("user32.dll")] public static extern IntPtr SetFocus(IntPtr h);
 [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr h);
 [DllImport("oleacc.dll")] private static extern int AccessibleObjectFromWindow(IntPtr h, uint objectId, ref Guid iid, [MarshalAs(UnmanagedType.Interface)] out Accessibility.IAccessible accessible);
 public static void InvokeDefaultAction(IntPtr h) {
   var iid = new Guid("618736e0-3c3d-11cf-810c-00aa00389b71");
   Accessibility.IAccessible accessible;
   int hr = AccessibleObjectFromWindow(h, 0xfffffffc, ref iid, out accessible);
   if (hr != 0) Marshal.ThrowExceptionForHR(hr);
   try {
     if (String.IsNullOrEmpty(accessible.get_accDefaultAction(0))) throw new InvalidOperationException("Element has no native default action");
     accessible.accDoDefaultAction(0);
   } finally { Marshal.ReleaseComObject(accessible); }
 }
 [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h, IntPtr dc, uint flags);
 [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
 public struct STARTUPINFO { public int cb; public string lpReserved; public string lpDesktop; public string lpTitle; public int dwX; public int dwY; public int dwXSize; public int dwYSize; public int dwXCountChars; public int dwYCountChars; public int dwFillAttribute; public int dwFlags; public short wShowWindow; public short cbReserved2; public IntPtr lpReserved2; public IntPtr hStdInput; public IntPtr hStdOutput; public IntPtr hStdError; }
 [StructLayout(LayoutKind.Sequential)]
 public struct PROCESS_INFORMATION { public IntPtr hProcess; public IntPtr hThread; public int dwProcessId; public int dwThreadId; }
 public delegate bool EnumDesktopProc(IntPtr h, IntPtr l);
 [DllImport("user32.dll", CharSet=CharSet.Unicode, SetLastError=true)] public static extern IntPtr CreateDesktop(string name, IntPtr device, IntPtr devmode, int flags, uint access, IntPtr sa);
 [DllImport("user32.dll", SetLastError=true)] public static extern IntPtr OpenDesktop(string name, int flags, bool inherit, uint access);
 [DllImport("user32.dll", SetLastError=true)] public static extern bool CloseDesktop(IntPtr h);
 [DllImport("user32.dll", SetLastError=true)] public static extern bool EnumDesktopWindows(IntPtr desk, EnumDesktopProc cb, IntPtr l);
 [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] public static extern bool CreateProcess(string app, System.Text.StringBuilder cmd, IntPtr pa, IntPtr ta, bool inherit, uint flags, IntPtr env, string cwd, ref STARTUPINFO si, out PROCESS_INFORMATION pi);
 [DllImport("kernel32.dll")] public static extern bool CloseHandle(IntPtr h);
 [DllImport("kernel32.dll", SetLastError=true)] public static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
 [DllImport("advapi32.dll", SetLastError=true)] public static extern bool OpenProcessToken(IntPtr process, uint access, out IntPtr token);
 [DllImport("advapi32.dll", SetLastError=true)] public static extern bool GetTokenInformation(IntPtr token, int cls, out uint info, uint len, out uint ret);
 public static bool IsProcessElevated(uint pid) {
   IntPtr process = OpenProcess(0x1000, false, pid);
   if (process == IntPtr.Zero) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
   try {
     IntPtr token;
     if (!OpenProcessToken(process, 0x0008, out token)) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
     try {
       uint elevated;
       uint returned;
       if (!GetTokenInformation(token, 20, out elevated, 4, out returned)) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
       return elevated != 0;
     } finally { CloseHandle(token); }
   } finally { CloseHandle(process); }
 }
 public static bool IsCurrentElevated() { return IsProcessElevated((uint)System.Diagnostics.Process.GetCurrentProcess().Id); }
 [DllImport("user32.dll", SetLastError=true)] public static extern IntPtr SendMessage(IntPtr h, uint msg, IntPtr w, IntPtr l);
 public static IntPtr[] DesktopWindows(string name) {
   var desk = OpenDesktop(name, 0, false, 0x01FF);
   if (desk == IntPtr.Zero) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
   var list = new System.Collections.Generic.List<IntPtr>();
   try { EnumDesktopWindows(desk, delegate(IntPtr h, IntPtr l) { list.Add(h); return true; }, IntPtr.Zero); }
   finally { CloseDesktop(desk); }
   return list.ToArray();
 }
 public static int LaunchOnDesktop(string desktop, string exe, string args, string cwd) {
   var si = new STARTUPINFO();
   si.cb = Marshal.SizeOf(typeof(STARTUPINFO));
   si.lpDesktop = "winsta0\\" + desktop;
   var cmd = new System.Text.StringBuilder("\"" + exe + "\"");
   if (!String.IsNullOrEmpty(args)) cmd.Append(" ").Append(args);
   PROCESS_INFORMATION pi;
   if (!CreateProcess(exe, cmd, IntPtr.Zero, IntPtr.Zero, false, 0, IntPtr.Zero, cwd, ref si, out pi)) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
   CloseHandle(pi.hThread); CloseHandle(pi.hProcess);
   return pi.dwProcessId;
 }
 [DllImport("user32.dll")] public static extern IntPtr GetMenu(IntPtr h);
 [DllImport("user32.dll")] public static extern IntPtr GetSubMenu(IntPtr h, int index);
 [DllImport("user32.dll")] public static extern int GetMenuItemCount(IntPtr h);
 [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetMenuString(IntPtr h, uint item, System.Text.StringBuilder value, int max, uint flags);
 [DllImport("user32.dll")] public static extern uint GetMenuItemID(IntPtr h, int index);
 [DllImport("user32.dll")] public static extern uint GetMenuState(IntPtr h, uint item, uint flags);
 [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h, uint msg, UIntPtr w, IntPtr l);
 [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
 [DllImport("user32.dll")] public static extern void mouse_event(uint f, uint x, uint y, uint d, UIntPtr e);
 [DllImport("user32.dll")] public static extern void keybd_event(byte v, byte s, uint f, UIntPtr e);
 public static string Title(IntPtr h) { var sb = new System.Text.StringBuilder(512); GetWindowText(h, sb, 512); return sb.ToString(); }
 public static string Cls(IntPtr h) { var sb = new System.Text.StringBuilder(256); GetClassName(h, sb, 256); return sb.ToString(); }
}
'@
if (![GarminWin]::SetProcessDpiAwarenessContext([IntPtr](-4))) { [void][GarminWin]::SetProcessDPIAware() }
function output($v) { $v | ConvertTo-Json -Depth 30 -Compress }
function opt($name, $default) { $i = [array]::IndexOf($a, $name); if ($i -ge 0 -and $i + 1 -lt $a.Count) { return $a[$i+1] }; return $default }
function simulator {
  if (!$SimulatorPath) { throw 'Missing Garmin simulator executable path' }
  $candidates = @(Get-Process simulator -ErrorAction SilentlyContinue | Where-Object {
    $_.MainWindowHandle -ne 0 -and $_.Path -and [string]::Equals([IO.Path]::GetFullPath($_.Path), $SimulatorPath, [StringComparison]::OrdinalIgnoreCase)
  })
  if ($candidates.Count -gt 1) { throw 'Multiple Garmin simulators match the SDK executable; close the extra instances' }
  if ($candidates.Count -eq 1) { return $candidates[0] }
}
function simulatorAny {
  if (!$SimulatorPath) { throw 'Missing Garmin simulator executable path' }
  $candidates = @(Get-Process simulator -ErrorAction SilentlyContinue | Where-Object {
    $_.Path -and [string]::Equals([IO.Path]::GetFullPath($_.Path), $SimulatorPath, [StringComparison]::OrdinalIgnoreCase)
  })
  if ($candidates.Count -gt 1) { throw 'Multiple Garmin simulators match the SDK executable; close the extra instances' }
  if ($candidates.Count -eq 1) { return $candidates[0] }
}
function win { $p = simulator; if (!$p) { throw 'Connect IQ simulator window is not running' }; return $p }
function assertIntegrity($ownerPid) {
  if ([GarminWin]::IsProcessElevated([uint32]$ownerPid) -ne [GarminWin]::IsCurrentElevated()) {
    throw 'E_INTEGRITY_MISMATCH: The server and the simulator run at different integrity levels; window messages will be dropped. Run both elevated or both non-elevated.'
  }
}
function clientSize($process) {
  $cr = New-Object GarminWin+RECT
  if (![GarminWin]::GetClientRect($process.MainWindowHandle, [ref]$cr)) { return $null }
  return @{width=($cr.Right - $cr.Left); height=($cr.Bottom - $cr.Top)}
}
function blockerInfo {
  $fg = [GarminWin]::GetForegroundWindow()
  if ($null -eq $fg) { return @{foregroundWindowId=0; blockerTitle='(none)'; blockerPid=0} }
  $owner = [uint32]0
  [void][GarminWin]::GetWindowThreadProcessId($fg, [ref]$owner)
  return @{foregroundWindowId=$fg.ToInt64(); blockerTitle=[GarminWin]::Title($fg); blockerPid=$owner}
}
function waitForeground($handle) {
  for ($i = 0; $i -lt 4; $i++) {
    if ([GarminWin]::GetForegroundWindow() -eq $handle) { return $true }
    Start-Sleep -Milliseconds 60
  }
  return ([GarminWin]::GetForegroundWindow() -eq $handle)
}
function focusWindow($process) {
  $handle = $process.MainWindowHandle
  $previousFg = [GarminWin]::GetForegroundWindow()
  $previous = if ($null -eq $previousFg) { [long]0 } else { $previousFg.ToInt64() }
  if ([GarminWin]::IsIconic($handle)) { [void][GarminWin]::ShowWindow($handle, 9) }
  $path = 'already'
  if ([GarminWin]::GetForegroundWindow() -ne $handle) {
    [void][GarminWin]::SetForegroundWindow($handle)
    $path = 'setforeground'
    [void](waitForeground $handle)
  }
  if ([GarminWin]::GetForegroundWindow() -ne $handle) {
    # An ALT pulse unlocks the Windows foreground lock for this thread.
    [GarminWin]::keybd_event(0x12, 0, 0, [UIntPtr]::Zero); Start-Sleep -Milliseconds 40
    [GarminWin]::keybd_event(0x12, 0, 2, [UIntPtr]::Zero); Start-Sleep -Milliseconds 60
    [void][GarminWin]::SetForegroundWindow($handle)
    $path = 'alt'
    [void](waitForeground $handle)
  }
  if ([GarminWin]::GetForegroundWindow() -ne $handle) {
    $fg = [GarminWin]::GetForegroundWindow()
    $fgPid = [uint32]0
    $fgThread = [GarminWin]::GetWindowThreadProcessId($fg, [ref]$fgPid)
    $attached = [GarminWin]::AttachThreadInput([GarminWin]::GetCurrentThreadId(), $fgThread, $true)
    try {
      [void][GarminWin]::BringWindowToTop($handle)
      [void][GarminWin]::SetForegroundWindow($handle)
      [void][GarminWin]::SetFocus($handle)
      $path = 'attach'
    } finally {
      if ($attached) { [void][GarminWin]::AttachThreadInput([GarminWin]::GetCurrentThreadId(), $fgThread, $false) }
    }
    Start-Sleep -Milliseconds 120
  }
  $foreground = [GarminWin]::GetForegroundWindow()
  $foregroundLong = if ($null -eq $foreground) { [long]0 } else { $foreground.ToInt64() }
  $handleLong = $handle.ToInt64()
  $ok = ($foregroundLong -eq $handleLong)
  if (!$ok) { $path = 'denied' }
  $response = @{ok=$ok; path=$path; windowId=$handleLong; previousForegroundWindowId=$previous; foregroundWindowId=$foregroundLong}
  if (!$ok) {
    if ($foregroundLong -eq 0) {
      $response.blockerTitle = '(no foreground window)'
      $response.blockerPid = 0
      $response.error = 'No foreground window exists, so input is blocked. The Windows session is locked or has no interactive desktop; unlock it and retry.'
    } else {
      $blocker = blockerInfo
      $response.blockerTitle = $blocker.blockerTitle
      $response.blockerPid = $blocker.blockerPid
      $response.error = "Windows did not focus the simulator (blocked by '$($blocker.blockerTitle)', pid $($blocker.blockerPid)). Bring its main window to the foreground and retry."
    }
  }
  return $response
}
function inputWindow {
  $process = win
  if ([GarminWin]::GetForegroundWindow() -ne $process.MainWindowHandle) { throw 'Simulator is not the foreground window; no input was sent. Bring its main window to the foreground and retry.' }
  return $process
}
function assertPointOver($process, $x, $y) {
  $pt = New-Object GarminWin+POINT; $pt.X = [int]$x; $pt.Y = [int]$y
  $target = [GarminWin]::WindowFromPoint($pt)
  $root = if ($target -eq [IntPtr]::Zero) { [IntPtr]::Zero } else { [GarminWin]::GetAncestor($target, 2) }
  if ($root -eq $process.MainWindowHandle) { return }
  $title = if ($root -eq [IntPtr]::Zero) { 'none' } else { [GarminWin]::Title($root) }
  $owner = [uint32]0
  if ($root -ne [IntPtr]::Zero) { [void][GarminWin]::GetWindowThreadProcessId($root, [ref]$owner) }
  throw "Another window is on top of the simulator at that point; no input was sent. Blocking window: '$title' (pid $owner)."
}
function root($p) { [System.Windows.Automation.AutomationElement]::FromHandle($p.MainWindowHandle) }
function children($el) { $w=[System.Windows.Automation.TreeWalker]::ControlViewWalker; $r=@(); $c=$w.GetFirstChild($el); while ($null -ne $c) { $r += $c; $c=$w.GetNextSibling($c) }; return ,$r }
function invokeElement($el) {
  $process = win
  if ($el.Current.ProcessId -ne $process.Id -or !$el.Current.IsEnabled) { throw 'Element is disabled or belongs to another process' }
  $pattern=$null
  if ($el.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern,[ref]$pattern)) { $pattern.Invoke(); return }
  $handle=[IntPtr]$el.Current.NativeWindowHandle; $owner=[uint32]0
  if ($handle -eq [IntPtr]::Zero) { throw 'Element has no native window or invocation pattern' }
  [void][GarminWin]::GetWindowThreadProcessId($handle,[ref]$owner)
  if ($owner -ne $process.Id) { throw 'Native control belongs to another process' }
  # wxWidgets buttons expose MSAA default actions instead of UI Automation InvokePattern.
  [GarminWin]::InvokeDefaultAction($handle)
}
function storageEditor($process) {
  $name = New-Object System.Windows.Automation.PropertyCondition ([System.Windows.Automation.AutomationElement]::NameProperty),'Modify Object Store'
  $owner = New-Object System.Windows.Automation.PropertyCondition ([System.Windows.Automation.AutomationElement]::ProcessIdProperty),$process.Id
  $condition = New-Object System.Windows.Automation.AndCondition $name,$owner
  return (root $process).FindFirst([System.Windows.Automation.TreeScope]::Subtree,$condition)
}
function awaitWinRT($operation, $type) {
  $method = [System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.IsGenericMethod -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1' } | Select-Object -First 1
  $task = $method.MakeGenericMethod($type).Invoke($null, @($operation)); $task.GetAwaiter().GetResult()
}
function tree($el,$route,$depth,$max) {
  $script:count++; $kids=children $el
  $node=@{path=@($route); AXRole=$el.Current.ControlType.ProgrammaticName; AXTitle=$el.Current.Name; AXIdentifier=$el.Current.AutomationId; AXEnabled=$el.Current.IsEnabled; childCount=$kids.Count}
  if ($depth -lt $max -and $script:count -lt 5000) { $nodes=@(); for ($i=0; $i -lt $kids.Count -and $script:count -lt 5000; $i++) { $nodes += (tree $kids[$i] ($route + $i) ($depth+1) $max) }; $node.children=$nodes } elseif ($kids.Count) { $node.truncated=$true }; return $node
}
function captureHandle($hwnd, $path, $scale) {
  $r = New-Object GarminWin+RECT
  [void][GarminWin]::GetWindowRect([IntPtr]$hwnd, [ref]$r)
  $s = [double]$scale
  if ($s -le 0) { $s = 1 }
  $b = New-Object System.Drawing.Bitmap ([Math]::Max(1,[int](($r.Right-$r.Left)/$s))),([Math]::Max(1,[int](($r.Bottom-$r.Top)/$s)))
  $g = [System.Drawing.Graphics]::FromImage($b)
  try {
    $dc = $g.GetHdc()
    try { if (![GarminWin]::PrintWindow([IntPtr]$hwnd,$dc,2)) { throw 'Unable to capture simulator window' } } finally { $g.ReleaseHdc($dc) }
    $b.Save([string]$path,[System.Drawing.Imaging.ImageFormat]::Png)
  } finally { $g.Dispose(); $b.Dispose() }
}
function captureWindow($process, $path, $scale) {
  captureHandle $process.MainWindowHandle $path $scale
}
function simWindows($process) {
  $list = @()
  $h = [GarminWin]::GetTopWindow([IntPtr]::Zero)
  while ($h -ne [IntPtr]::Zero) {
    $owner = [uint32]0
    [void][GarminWin]::GetWindowThreadProcessId($h, [ref]$owner)
    if ($owner -eq $process.Id) {
      $r = New-Object GarminWin+RECT
      [void][GarminWin]::GetWindowRect($h, [ref]$r)
      $list += @{hwnd=$h.ToInt64(); title=[GarminWin]::Title($h); class=[GarminWin]::Cls($h); visible=[GarminWin]::IsWindowVisible($h); rect=@{x=$r.Left; y=$r.Top; width=($r.Right-$r.Left); height=($r.Bottom-$r.Top)}}
    }
    $h = [GarminWin]::GetWindow($h, 2)
  }
  return $list
}
function childWindows($parent, $depth) {
  $list = @()
  $h = [GarminWin]::GetWindow([IntPtr]$parent, 5)
  while ($h -ne [IntPtr]::Zero) {
    $r = New-Object GarminWin+RECT
    [void][GarminWin]::GetWindowRect($h, [ref]$r)
    $node = @{hwnd=$h.ToInt64(); class=[GarminWin]::Cls($h); title=[GarminWin]::Title($h); visible=[GarminWin]::IsWindowVisible($h); rect=@{x=$r.Left; y=$r.Top; width=($r.Right-$r.Left); height=($r.Bottom-$r.Top)}}
    if ($depth -gt 1) {
      $kids = @(childWindows $h ($depth - 1))
      if ($kids.Count -gt 0) { $node.children = $kids }
    }
    $list += $node
    $h = [GarminWin]::GetWindow($h, 2)
  }
  return $list
}
function Invoke-One($a) {
 switch ($a[0]) {
 'integrity' {
   $targetPid=[uint32](opt '--pid' 0)
   $hostElev=[GarminWin]::IsCurrentElevated()
   $targetElev=$null
   if ($targetPid -ne 0) { $targetElev=[GarminWin]::IsProcessElevated($targetPid) }
   output @{ok=$true; hostElevated=$hostElev; targetPid=$targetPid; targetElevated=$targetElev; same=($null -eq $targetElev -or $hostElev -eq $targetElev)}
 }
 'create-desktop' {
   $name=opt '--name' ''; if (!$name) { throw 'Desktop name is required' }
   if (!$script:DesktopHandles.ContainsKey($name)) {
     $h=[GarminWin]::CreateDesktop($name,[IntPtr]::Zero,[IntPtr]::Zero,0,0x01FF,[IntPtr]::Zero)
     if ($h -eq [IntPtr]::Zero) { throw ('CreateDesktop failed: ' + [Runtime.InteropServices.Marshal]::GetLastWin32Error()) }
     $script:DesktopHandles[$name]=$h
   }
   output @{ok=$true; name=$name}
 }
 'close-desktop' {
   $name=opt '--name' ''; if (!$name) { throw 'Desktop name is required' }
   if ($script:DesktopHandles.ContainsKey($name)) {
     [void][GarminWin]::CloseDesktop($script:DesktopHandles[$name]); $script:DesktopHandles.Remove($name)
     output @{ok=$true; name=$name}; break
   }
   $h=[GarminWin]::OpenDesktop($name,0,$false,0x01FF)
   if ($h -eq [IntPtr]::Zero) { output @{ok=$true; alreadyClosed=$true}; break }
   [void][GarminWin]::CloseDesktop($h)
   output @{ok=$true; name=$name}
 }
 'launch-on-desktop' {
   $desktop=opt '--desktop' ''; $exe=opt '--exe' ''; $extra=opt '--args' ''
   if (!$desktop -or !$exe) { throw 'desktop and exe are required' }
   if (!$script:DesktopHandles.ContainsKey($desktop)) {
     $h=[GarminWin]::CreateDesktop($desktop,[IntPtr]::Zero,[IntPtr]::Zero,0,0x01FF,[IntPtr]::Zero)
     if ($h -eq [IntPtr]::Zero) { throw ('CreateDesktop failed: ' + [Runtime.InteropServices.Marshal]::GetLastWin32Error()) }
     $script:DesktopHandles[$desktop]=$h
   }
   $procId=[GarminWin]::LaunchOnDesktop($desktop,$exe,$extra,(Get-Location).Path)
   output @{ok=$true; pid=$procId; desktop=$desktop; exe=$exe}
 }
 'desktop-click' {
   $desktop=opt '--desktop' ''; $hwnd=[IntPtr][long](opt '--hwnd' 0)
   if (!$desktop -or $hwnd -eq [IntPtr]::Zero) { throw 'desktop and hwnd are required' }
   $x=[int](opt '--x' 0); $y=[int](opt '--y' 0); $hold=[Math]::Max(1,[int](opt '--hold-ms' 80))
   $owner=[uint32]0; [void][GarminWin]::GetWindowThreadProcessId($hwnd,[ref]$owner)
   $proc=if ($owner -ne 0) { Get-Process -Id $owner -ErrorAction SilentlyContinue } else { $null }
   if (!$proc -or $proc.ProcessName -ne 'simulator') { throw 'Click target does not belong to a simulator process' }
   assertIntegrity $owner
   $lp=[IntPtr](($y -shl 16) -bor ($x -band 0xFFFF))
   [void][GarminWin]::SendMessage($hwnd,0x0200,[IntPtr]::Zero,$lp)
   [void][GarminWin]::SendMessage($hwnd,0x0201,[IntPtr]1,$lp)
   Start-Sleep -Milliseconds $hold
   [void][GarminWin]::SendMessage($hwnd,0x0202,[IntPtr]::Zero,$lp)
   output @{ok=$true; hwnd=$hwnd.ToInt64(); x=$x; y=$y; holdMs=$hold}
 }
 'desktop-drag' {
   $desktop=opt '--desktop' ''; $hwnd=[IntPtr][long](opt '--hwnd' 0)
   if (!$desktop -or $hwnd -eq [IntPtr]::Zero) { throw 'desktop and hwnd are required' }
   $x1=[int](opt '--x1' 0); $y1=[int](opt '--y1' 0); $x2=[int](opt '--x2' 0); $y2=[int](opt '--y2' 0)
   $duration=[Math]::Max(20,[int](opt '--duration-ms' 400))
   $owner=[uint32]0; [void][GarminWin]::GetWindowThreadProcessId($hwnd,[ref]$owner)
   $proc=if ($owner -ne 0) { Get-Process -Id $owner -ErrorAction SilentlyContinue } else { $null }
   if (!$proc -or $proc.ProcessName -ne 'simulator') { throw 'Drag target does not belong to a simulator process' }
   assertIntegrity $owner
   $start=[IntPtr](($y1 -shl 16) -bor ($x1 -band 0xFFFF))
   [void][GarminWin]::SendMessage($hwnd,0x0200,[IntPtr]::Zero,$start)
   [void][GarminWin]::SendMessage($hwnd,0x0201,[IntPtr]1,$start)
   try {
     for ($i=1;$i -le 20;$i++) {
       $mx=[int]($x1+($x2-$x1)*$i/20); $my=[int]($y1+($y2-$y1)*$i/20)
       $lp=[IntPtr](($my -shl 16) -bor ($mx -band 0xFFFF))
       [void][GarminWin]::SendMessage($hwnd,0x0200,[IntPtr]1,$lp)
       Start-Sleep -Milliseconds ([int]($duration/20))
     }
   } finally {
     $end=[IntPtr](($y2 -shl 16) -bor ($x2 -band 0xFFFF))
     [void][GarminWin]::SendMessage($hwnd,0x0202,[IntPtr]::Zero,$end)
   }
   output @{ok=$true; hwnd=$hwnd.ToInt64(); x1=$x1; y1=$y1; x2=$x2; y2=$y2}
 }
 'desktop-key' {
   $desktop=opt '--desktop' ''; $hwnd=[IntPtr][long](opt '--hwnd' 0)
   if (!$desktop -or $hwnd -eq [IntPtr]::Zero) { throw 'desktop and hwnd are required' }
   $v=[int](opt '--code' 0); $hold=[Math]::Max(1,[int](opt '--hold-ms' 80))
   $owner=[uint32]0; [void][GarminWin]::GetWindowThreadProcessId($hwnd,[ref]$owner)
   assertIntegrity $owner
   [void][GarminWin]::SendMessage($hwnd,0x0100,[IntPtr]$v,[IntPtr]0x001C0001)
   Start-Sleep -Milliseconds $hold
   [void][GarminWin]::SendMessage($hwnd,0x0101,[IntPtr]$v,[IntPtr]([int64]0xC01C0001))
   output @{ok=$true; hwnd=$hwnd.ToInt64(); code=$v}
 }
 'window-info' {
  $permissions=@{screenRecording=$true; accessibility=$true}
  $desktop=opt '--desktop' ''
  if ($desktop) {
    try { $wins=[GarminWin]::DesktopWindows($desktop) } catch { output @{running=$false; isolated=$true; desktop=$desktop; permissions=$permissions; error=$_.Exception.Message}; break }
    $main=[IntPtr]::Zero
    foreach ($w in $wins) { if ([GarminWin]::Title($w) -like 'CIQ Simulator*') { $main=$w; break } }
    if ($main -eq [IntPtr]::Zero) { output @{running=$false; isolated=$true; desktop=$desktop; permissions=$permissions; error="Connect IQ simulator is not running on desktop $desktop"}; break }
    $r=New-Object GarminWin+RECT; [void][GarminWin]::GetWindowRect($main,[ref]$r)
    $pt=New-Object GarminWin+POINT; [void][GarminWin]::ClientToScreen($main,[ref]$pt)
    $cr=New-Object GarminWin+RECT; [void][GarminWin]::GetClientRect($main,[ref]$cr)
    $owner=[uint32]0; [void][GarminWin]::GetWindowThreadProcessId($main,[ref]$owner)
    output @{running=$true; pid=$owner; windowId=$main.ToInt64(); bounds=@{x=$r.Left; y=$r.Top; width=($r.Right-$r.Left); height=($r.Bottom-$r.Top)}; clientSize=@{width=($cr.Right-$cr.Left); height=($cr.Bottom-$cr.Top)}; contentOffset=@{x=($pt.X-$r.Left); y=($pt.Y-$r.Top)}; scale=1; foreground=$false; isolated=$true; desktop=$desktop; permissions=$permissions}
    break
  }
  $p=simulator
  if (!$p) { output @{running=$false; permissions=$permissions; error='Connect IQ simulator is not running'}; break }
  $r=New-Object GarminWin+RECT; [void][GarminWin]::GetWindowRect($p.MainWindowHandle,[ref]$r)
  $pt=New-Object GarminWin+POINT; [void][GarminWin]::ClientToScreen($p.MainWindowHandle,[ref]$pt)
  $dpiX=[uint32]0; $dpiY=[uint32]0; if ([GarminWin]::GetDpiForMonitor([GarminWin]::MonitorFromWindow($p.MainWindowHandle,2),0,[ref]$dpiX,[ref]$dpiY) -ne 0 -or $dpiX -eq 0) { throw 'Unable to determine simulator monitor DPI' }
  $cs = clientSize $p
  output @{running=$true; pid=$p.Id; windowId=$p.MainWindowHandle.ToInt64(); bounds=@{x=$r.Left; y=$r.Top; width=($r.Right-$r.Left); height=($r.Bottom-$r.Top)}; clientSize=$cs; contentOffset=@{x=($pt.X-$r.Left); y=($pt.Y-$r.Top)}; scale=($dpiX/96.0); foreground=([GarminWin]::GetForegroundWindow() -eq $p.MainWindowHandle); permissions=$permissions}
 }
 { $_ -in 'activate','raise','focus' } { $p=win; output (focusWindow $p) }
 'restore-focus' {
   $id=[long](opt '--hwnd' 0)
   if ($id -eq 0) { output @{ok=$true; skipped=$true}; break }
   $target=[IntPtr]$id
   $ok=[GarminWin]::SetForegroundWindow($target)
   if (!$ok) {
     [GarminWin]::keybd_event(0x12,0,0,[UIntPtr]::Zero); Start-Sleep -Milliseconds 30
     [GarminWin]::keybd_event(0x12,0,2,[UIntPtr]::Zero); Start-Sleep -Milliseconds 50
     $ok=[GarminWin]::SetForegroundWindow($target)
   }
   output @{ok=$ok; foregroundWindowId=([GarminWin]::GetForegroundWindow()).ToInt64()}
 }
 'place' {
   $p=win; $h=$p.MainWindowHandle
   $r=New-Object GarminWin+RECT; [void][GarminWin]::GetWindowRect($h,[ref]$r)
   $w=[int](opt '--width' ($r.Right-$r.Left)); $ht=[int](opt '--height' ($r.Bottom-$r.Top))
   $mi=New-Object GarminWin+MONITORINFO; $mi.cbSize=[System.Runtime.InteropServices.Marshal]::SizeOf($mi)
   if (![GarminWin]::GetMonitorInfo([GarminWin]::MonitorFromWindow($h,2),[ref]$mi)) { throw 'Unable to read monitor work area' }
   $wa=$mi.rcWork
   $x=[int](opt '--x' $r.Left); $y=[int](opt '--y' $r.Top)
   $intersectW=[Math]::Max(0,[Math]::Min($r.Right,$wa.Right)-[Math]::Max($r.Left,$wa.Left))
   $intersectH=[Math]::Max(0,[Math]::Min($r.Bottom,$wa.Bottom)-[Math]::Max($r.Top,$wa.Top))
   $visible=if ((($r.Right-$r.Left) -gt 0) -and (($r.Bottom-$r.Top) -gt 0)) { ($intersectW*$intersectH)/(($r.Right-$r.Left)*($r.Bottom-$r.Top)) } else { 0 }
   $moved=$false
   if ($visible -lt 0.5 -and -not ($a -contains '--x') -and -not ($a -contains '--y')) { $x=$wa.Left+20; $y=$wa.Top+20; $moved=$true }
   $x=[Math]::Max($wa.Left,[Math]::Min($x,$wa.Right-$w)); $y=[Math]::Max($wa.Top,[Math]::Min($y,$wa.Bottom-$ht))
   if ($x -ne $r.Left -or $y -ne $r.Top -or $w -ne ($r.Right-$r.Left) -or $ht -ne ($r.Bottom-$r.Top)) {
     if (![GarminWin]::SetWindowPos($h,[IntPtr]::Zero,$x,$y,$w,$ht,0x0014)) { throw 'Unable to move simulator window' }
     $moved=$true
   }
   $nr=New-Object GarminWin+RECT; [void][GarminWin]::GetWindowRect($h,[ref]$nr)
   output @{ok=$true; moved=$moved; visibleRatio=[Math]::Round($visible,3); bounds=@{x=$nr.Left; y=$nr.Top; width=($nr.Right-$nr.Left); height=($nr.Bottom-$nr.Top)}; workArea=@{x=$wa.Left; y=$wa.Top; width=($wa.Right-$wa.Left); height=($wa.Bottom-$wa.Top)}}
 }
 'probe-point' {
   $x=[int](opt '--x' 0); $y=[int](opt '--y' 0)
   $pt=New-Object GarminWin+POINT; $pt.X=$x; $pt.Y=$y
   $target=[GarminWin]::WindowFromPoint($pt)
   $root=if ($target -eq [IntPtr]::Zero) { [IntPtr]::Zero } else { [GarminWin]::GetAncestor($target,2) }
   $owner=[uint32]0
   if ($root -ne [IntPtr]::Zero) { [void][GarminWin]::GetWindowThreadProcessId($root,[ref]$owner) }
   output @{ok=$true; x=$x; y=$y; hwnd=$root.ToInt64(); targetHwnd=$target.ToInt64(); title=if($root -eq [IntPtr]::Zero){''}else{[GarminWin]::Title($root)}; class=if($target -eq [IntPtr]::Zero){''}else{[GarminWin]::Cls($target)}; pid=$owner}
 }
 'children' {
   $hwnd=[long](opt '--hwnd' 0); $depth=[int](opt '--depth' 3)
   if ($hwnd -eq 0) { $p=win; $hwnd=$p.MainWindowHandle.ToInt64() }
   output @{ok=$true; hwnd=$hwnd; children=@(childWindows $hwnd $depth)}
 }
 'windows' {
   $desktop=opt '--desktop' ''
   if ($desktop) {
     $wins=[GarminWin]::DesktopWindows($desktop); $list=@()
     foreach ($h in $wins) {
       $r=New-Object GarminWin+RECT; [void][GarminWin]::GetWindowRect($h,[ref]$r)
       $owner=[uint32]0; [void][GarminWin]::GetWindowThreadProcessId($h,[ref]$owner)
       $list += @{hwnd=$h.ToInt64(); title=[GarminWin]::Title($h); class=[GarminWin]::Cls($h); visible=[GarminWin]::IsWindowVisible($h); pid=$owner; rect=@{x=$r.Left; y=$r.Top; width=($r.Right-$r.Left); height=($r.Bottom-$r.Top)}}
     }
     output @{ok=$true; desktop=$desktop; windows=$list}; break
   }
   $p=win; output @{ok=$true; pid=$p.Id; windows=@(simWindows $p)}
 }
 'close-window' {
   $hwnd=[IntPtr][long](opt '--hwnd' 0)
   if ($hwnd -eq [IntPtr]::Zero) { $p=win; $hwnd=$p.MainWindowHandle }
   $owner=[uint32]0; [void][GarminWin]::GetWindowThreadProcessId($hwnd,[ref]$owner)
   $proc=if ($owner -ne 0) { Get-Process -Id $owner -ErrorAction SilentlyContinue } else { $null }
   if (!$proc -or $proc.ProcessName -ne 'simulator') { throw 'Window does not belong to a simulator process' }
   [void][GarminWin]::PostMessage($hwnd,0x0010,[UIntPtr]::Zero,[IntPtr]::Zero)
   Start-Sleep -Milliseconds 300
   output @{ok=$true; hwnd=$hwnd.ToInt64(); visible=[GarminWin]::IsWindowVisible($hwnd)}
 }
 'capture' {
   $hwnd=[IntPtr][long]$a[1]
   $owner=[uint32]0; [void][GarminWin]::GetWindowThreadProcessId($hwnd,[ref]$owner)
   $proc=if ($owner -ne 0) { Get-Process -Id $owner -ErrorAction SilentlyContinue } else { $null }
   if (!$proc -or $proc.ProcessName -ne 'simulator') { throw 'Capture target does not belong to a simulator process' }
   captureHandle $hwnd $a[2] ([double]::Parse($a[3],[System.Globalization.CultureInfo]::InvariantCulture)); output @{ok=$true; hwnd=$hwnd.ToInt64()}
 }
 'click' {
   $p=inputWindow; $x=[int](opt '--x' 0); $y=[int](opt '--y' 0)
   assertPointOver $p $x $y
   [void][GarminWin]::SetCursorPos($x,$y); [GarminWin]::mouse_event(2,0,0,0,[UIntPtr]::Zero)
   try { Start-Sleep -Milliseconds ([int](opt '--hold-ms' 80)) } finally { [GarminWin]::mouse_event(4,0,0,0,[UIntPtr]::Zero) }
   output @{ok=$true; x=$x; y=$y}
 }
 'drag' {
   $p=inputWindow; $x1=[int](opt '--x1' 0); $y1=[int](opt '--y1' 0); $x2=[int](opt '--x2' 0); $y2=[int](opt '--y2' 0)
   assertPointOver $p $x1 $y1
   $duration=[Math]::Max(20,[int](opt '--duration-ms' 400))
   [void][GarminWin]::SetCursorPos($x1,$y1); [GarminWin]::mouse_event(2,0,0,0,[UIntPtr]::Zero)
   try { for ($i=1;$i -le 20;$i++) { [void][GarminWin]::SetCursorPos([int]($x1+($x2-$x1)*$i/20),[int]($y1+($y2-$y1)*$i/20)); Start-Sleep -Milliseconds ([int]($duration/20)) } } finally { [GarminWin]::mouse_event(4,0,0,0,[UIntPtr]::Zero) }
   output @{ok=$true; x1=$x1; y1=$y1; x2=$x2; y2=$y2}
 }
 'key' { [void](inputWindow); $v=[byte](opt '--code' 0); [GarminWin]::keybd_event($v,0,0,[UIntPtr]::Zero); try { Start-Sleep -Milliseconds ([int](opt '--hold-ms' 80)) } finally { [GarminWin]::keybd_event($v,0,2,[UIntPtr]::Zero) }; output @{ok=$true} }
 'menu' { $hwnd=[long](opt '--hwnd' 0); if ($hwnd -eq 0) { $p=win; $hwnd=$p.MainWindowHandle.ToInt64() }; $owner=[uint32]0; [void][GarminWin]::GetWindowThreadProcessId([IntPtr]$hwnd,[ref]$owner); assertIntegrity $owner; $menu=[GarminWin]::GetMenu([IntPtr]$hwnd); $parts=@($a[2..($a.Count-1)]); for ($j=0;$j -lt $parts.Count;$j++) { $found=-1; for ($i=0;$i -lt [GarminWin]::GetMenuItemCount($menu);$i++) { $label=New-Object System.Text.StringBuilder 512; [void][GarminWin]::GetMenuString($menu,$i,$label,512,1024); if (($label.ToString().Split("`t")[0] -replace '&','').Trim() -eq $parts[$j]) { $found=$i; break } }; if ($found -lt 0) { throw "Menu item not found: $($parts[$j])" }; if (([GarminWin]::GetMenuState($menu,$found,1024) -band 3) -ne 0) { throw "Menu item is disabled: $($parts[$j])" }; if ($j -eq $parts.Count-1) { $id=[GarminWin]::GetMenuItemID($menu,$found); if ($id -eq [uint32]::MaxValue -or ![GarminWin]::PostMessage([IntPtr]$hwnd,273,[UIntPtr]$id,[IntPtr]::Zero)) { throw 'Unable to invoke menu item' } } else { $menu=[GarminWin]::GetSubMenu($menu,$found); if ($menu -eq [IntPtr]::Zero) { throw 'Menu has no submenu' } } }; output @{ok=$true; path=$parts} }
 'menu-id' {
   $hwnd=[long](opt '--hwnd' 0)
   if ($hwnd -eq 0) { $p=win; $hwnd=$p.MainWindowHandle.ToInt64() }
   $owner=[uint32]0; [void][GarminWin]::GetWindowThreadProcessId([IntPtr]$hwnd,[ref]$owner)
   assertIntegrity $owner
   $id=[uint32](opt '--id' 0)
   if (![GarminWin]::PostMessage([IntPtr]$hwnd,273,[UIntPtr]$id,[IntPtr]::Zero)) { throw 'Unable to invoke menu item' }
   output @{ok=$true; id=$id; hwnd=$hwnd}
 }
 'ui-tree' {
   $script:count=0; $hwnd=[long](opt '--hwnd' 0)
   if ($hwnd -ne 0) {
     $owner=[uint32]0; [void][GarminWin]::GetWindowThreadProcessId([IntPtr]$hwnd,[ref]$owner)
     $proc=if ($owner -ne 0) { Get-Process -Id $owner -ErrorAction SilentlyContinue } else { $null }
     if (!$proc -or $proc.ProcessName -ne 'simulator') { throw 'Window does not belong to a simulator process' }
     $el=[System.Windows.Automation.AutomationElement]::FromHandle([IntPtr]$hwnd); $target=$hwnd; $procId=$owner
   } else { $p=win; $el=root $p; $target=$p.MainWindowHandle.ToInt64(); $procId=$p.Id }
   output @{ok=$true; pid=$procId; hwnd=$target; tree=(tree $el @() 0 ([Math]::Min(14,[Math]::Max(1,[int]$a[1]))))}
 }
 'ui-action' {
   $hwnd=[long](opt '--hwnd' 0)
   if ($hwnd -ne 0) {
     $owner=[uint32]0; [void][GarminWin]::GetWindowThreadProcessId([IntPtr]$hwnd,[ref]$owner)
     $proc=if ($owner -ne 0) { Get-Process -Id $owner -ErrorAction SilentlyContinue } else { $null }
     if (!$proc -or $proc.ProcessName -ne 'simulator') { throw 'Window does not belong to a simulator process' }
     $el=[System.Windows.Automation.AutomationElement]::FromHandle([IntPtr]$hwnd)
   } else { $p=win; $el=root $p }
   foreach ($part in $a[1].Split('.')) { $kids=children $el; $i=0; if (![int]::TryParse($part,[ref]$i) -or $i -lt 0 -or $i -ge $kids.Count) { throw 'Invalid or stale element path' }; $el=$kids[$i] }; switch ($a[2]) { 'focus' { $el.SetFocus() } 'select' { $el.GetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern).Select() } 'set' { $el.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern).SetValue([string]$a[3]) } { $_ -in 'AXPress','AXConfirm' } { invokeElement $el } { $_ -in 'AXIncrement','AXDecrement' } { $p=$el.GetCurrentPattern([System.Windows.Automation.RangeValuePattern]::Pattern); $delta=$p.Current.SmallChange; if ($_ -eq 'AXDecrement') { $delta=-$delta }; $p.SetValue([Math]::Max($p.Current.Minimum,[Math]::Min($p.Current.Maximum,$p.Current.Value+$delta))) } default { throw 'Unsupported UI action' } }; output @{ok=$true}
 }
 'storage-close' {
  $p=win; $dialog=storageEditor $p
  if (!$dialog) { output @{ok=$true; alreadyClosed=$true}; break }
  $condition=New-Object System.Windows.Automation.PropertyCondition ([System.Windows.Automation.AutomationElement]::NameProperty),'Cancel'
  $button=$dialog.FindFirst([System.Windows.Automation.TreeScope]::Descendants,$condition)
  if (!$button) { throw 'Cancel button not found' }
  invokeElement $button
  for ($i=0; $i -lt 20; $i++) {
    Start-Sleep -Milliseconds 100
    if (!(storageEditor $p)) { output @{ok=$true; closed=$true}; break }
  }
  if ($i -eq 20) { throw 'Storage editor remained open after cancellation' }
 }
 'ocr' {
  Add-Type -AssemblyName System.Runtime.WindowsRuntime
  [void][Windows.Storage.StorageFile,Windows.Storage,ContentType=WindowsRuntime]; [void][Windows.Graphics.Imaging.BitmapDecoder,Windows.Foundation,ContentType=WindowsRuntime]; [void][Windows.Media.Ocr.OcrEngine,Windows.Foundation,ContentType=WindowsRuntime]
  $file=awaitWinRT ([Windows.Storage.StorageFile]::GetFileFromPathAsync([IO.Path]::GetFullPath($a[1]))) ([Windows.Storage.StorageFile])
  $stream=awaitWinRT ($file.OpenReadAsync()) ([Windows.Storage.Streams.IRandomAccessStreamWithContentType])
  try {
    $decoder=awaitWinRT ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
    $bitmap=awaitWinRT ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
    try {
      $engine=[Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages(); if (!$engine) { throw 'Windows OCR language pack is unavailable' }
      $recognized=awaitWinRT ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult]); $lines=@()
      foreach ($line in $recognized.Lines) { if (!$line.Words.Count) { continue }; $left=($line.Words | ForEach-Object {$_.BoundingRect.X} | Measure-Object -Minimum).Minimum; $top=($line.Words | ForEach-Object {$_.BoundingRect.Y} | Measure-Object -Minimum).Minimum; $right=($line.Words | ForEach-Object {$_.BoundingRect.X+$_.BoundingRect.Width} | Measure-Object -Maximum).Maximum; $bottom=($line.Words | ForEach-Object {$_.BoundingRect.Y+$_.BoundingRect.Height} | Measure-Object -Maximum).Maximum; $lines += @{text=$line.Text; bounds=@{x=$left/$bitmap.PixelWidth; y=1-$bottom/$bitmap.PixelHeight; width=($right-$left)/$bitmap.PixelWidth; height=($bottom-$top)/$bitmap.PixelHeight}} }
      output @{ok=$true; lines=$lines}
    } finally { $bitmap.Dispose() }
  } finally { $stream.Dispose() }
 }
 'terminate' {
   $p=simulatorAny
   if (!$p) { output @{ok=$true; alreadyStopped=$true}; break }
   if ($a -contains '--force' -or $p.MainWindowHandle -eq 0) { $p.Kill() } else { [void]$p.CloseMainWindow() }
   $stopped=$p.WaitForExit(5000); output @{ok=$stopped; terminated=$stopped; pid=$p.Id}
 }
 default { throw "Unsupported Windows bridge command: $($a[0])" }
 }
}
if ($HostMode) {
  while ($true) {
    $line = [Console]::In.ReadLine()
    if ($null -eq $line) { break }
    if ($line.Trim().Length -eq 0) { continue }
    $reqId = $null
    try {
      $req = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($line)) | ConvertFrom-Json
      $reqId = [long]$req.id
      $script:SimulatorPath = [string]$req.simulatorPath
      $result = Invoke-One @($req.args)
      $json = if ($result -is [string]) { $result } else { output $result }
    } catch {
      $json = @{ok=$false; error=$_.Exception.Message} | ConvertTo-Json -Compress
    }
    if ($null -ne $reqId) { $json = '{"id":' + $reqId + ',"result":' + $json + '}' }
    [Console]::Out.WriteLine($json)
    [Console]::Out.Flush()
  }
} else {
  $a = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($EncodedArgs)) | ConvertFrom-Json
  try { $result = Invoke-One @($a); if ($result -is [string]) { [Console]::Out.WriteLine($result) } else { output $result } } catch { output @{ok=$false; error=$_.Exception.Message} }
}
