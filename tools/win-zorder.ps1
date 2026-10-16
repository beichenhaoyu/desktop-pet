# tools/win-zorder.ps1 —— 现场量 Windows 上「宠物窗 vs 插件 overlay」的 z 序（必须用 pwsh 7）
#
# 为什么需要它：两条 topmost 窗口的相对次序不是配置能读出来的。`tauri.conf.json` 与
# `overlay.rs` 里宠物窗和 overlay 都是 `alwaysOnTop(true)`，同层之内谁最后被置顶/创建谁在上——
# 2026-10-16 实测：**overlay 压在宠物之上**（三次采样一致）。所以「宿主永远在上层」这种承诺
# 只能拿真窗次序断言，不能靠读代码或读配置断定。
#
# 两个坑（都在这份脚本里踩过，别再踩）：
#   1. `DllImport` 默认 `CharSet.Ansi`，而 Win32 的 `*W` 函数写的是 UTF-16。
#      用 StringBuilder 接会只拿到第一个字符（"DesktopPet" 变成 "D"），
#      现象是「枚举成功但一个窗口都匹配不上」——看着像窗口不存在，其实是解码坏了。
#   2. 交给 `EnumWindows` 的委托必须有静态根，没根时它会「返回 true 却一次都不回调」。
#
# 用法：
#   pwsh -NoProfile -File tools/win-zorder.ps1 -Dump              # 列出可见有标题顶层窗（z 序自上而下）
#   pwsh -NoProfile -File tools/win-zorder.ps1 -Seconds 120       # 轮询到宠物窗与 overlay 同框，宠物在上退 0
param([int]$Seconds = 120, [switch]$Dump, [string]$PetTitle = "DesktopPet")

Add-Type @"
using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public class WinZOrder {
  delegate bool EnumProc(IntPtr h, IntPtr lp);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern bool EnumWindows(EnumProc cb, IntPtr lp);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowTextW(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] static extern int GetWindowTextLengthW(IntPtr h);
  [DllImport("user32.dll")] static extern int GetWindowLongW(IntPtr h, int idx);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  static EnumProc rooted = OnWin;                 // 委托的静态根
  static List<string> bag;
  static bool OnWin(IntPtr h, IntPtr lp) {
    if (!IsWindowVisible(h)) return true;
    int n = GetWindowTextLengthW(h);
    if (n == 0) return true;                      // 无标题的工具窗不参与，噪声会盖过信号
    var sb = new StringBuilder(n + 2);
    GetWindowTextW(h, sb, sb.Capacity);
    int ex = GetWindowLongW(h, -20);              // GWL_EXSTYLE
    bag.Add((((ex & 0x8) != 0 ? "TOPMOST " : "plain   ")) + sb.ToString());
    return true;
  }
  public static List<string> TopDown() {          // EnumWindows 的回调顺序就是 z 序自上而下
    bag = new List<string>();
    EnumWindows(rooted, IntPtr.Zero);
    var r = new List<string>();
    for (int i = 0; i < bag.Count; i++) r.Add((i + 1).ToString("D3") + " | " + bag[i]);
    return r;
  }
}
"@

function Show($rows) { $rows | ForEach-Object { Write-Host "   $_" } }

if ($Dump) {
  $rows = [WinZOrder]::TopDown() | Where-Object { $_ -like "*$PetTitle*" -or $_ -like "*Overlay*" }
  Write-Host ("-- 与本体相关的窗（z 序自上而下）：{0} 扇" -f @($rows).Count)
  Show $rows
  exit 0
}

$deadline = (Get-Date).AddSeconds($Seconds)
$samples = 0
$verdict = $null
while ((Get-Date) -lt $deadline -and $samples -lt 3) {
  $rows = [WinZOrder]::TopDown()
  $petIdx = -1
  $ovIdx = -1
  for ($i = 0; $i -lt $rows.Count; $i++) {
    $t = $rows[$i]
    if ($petIdx -lt 0 -and ($t -like "* $PetTitle")) { $petIdx = $i + 1 }
    if ($ovIdx -lt 0 -and ($t -like "*Overlay*")) { $ovIdx = $i + 1 }
  }
  if ($petIdx -gt 0 -and $ovIdx -gt 0) {
    $samples++
    Write-Host ("采样 {0}：宠物窗第 {1} 位，最近的 overlay 第 {2} 位" -f $samples, $petIdx, $ovIdx)
    Show ($rows | Where-Object { $_ -like "*$PetTitle*" -or $_ -like "*Overlay*" })
    $verdict = if ($petIdx -lt $ovIdx) { "pet-top" } else { "overlay-covers-pet" }
  }
  Start-Sleep -Milliseconds 400
}
if ($samples -eq 0) {
  Write-Host "结论：整个窗口期没有同时看到宠物窗与 overlay（overlay 没开起来，或标题变了）"
  # 机器读的那一行刻意用纯 ASCII：pwsh 子进程的 stdout 在中文 Windows 上按 GBK 落字节，
  # node 侧按 utf8 解会得到乱码（今天就被这个坑成「没有结论行」）。人读中文，程序读这行。
  Write-Host "ZORDER samples=0 verdict=no-overlapping-sample"
  exit 2
}
Write-Host "结论：$verdict"
Write-Host "ZORDER samples=$samples verdict=$verdict"
if ($verdict -eq "pet-top") { exit 0 } else { exit 1 }
