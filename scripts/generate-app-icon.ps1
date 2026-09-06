# 生成 app-icon.png（1024x1024 透明底）作为 tauri icon 命令的源图
# 用法：powershell -NoProfile -ExecutionPolicy Bypass -File scripts/generate-app-icon.ps1
Add-Type -AssemblyName System.Drawing

$bmp = New-Object System.Drawing.Bitmap(1024, 1024)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$g.Clear([System.Drawing.Color]::Transparent)

function New-SolidBrush([string]$hex) {
    return New-Object System.Drawing.SolidBrush([System.Drawing.ColorTranslator]::FromHtml($hex))
}

# 身体 + 高光
$g.FillEllipse((New-SolidBrush "#F5923E"), 132, 172, 760, 760)
$g.FillEllipse((New-SolidBrush "#FFC078"), 250, 250, 190, 150)

# 眼睛
foreach ($ex in 372, 652) {
    $g.FillEllipse((New-SolidBrush "#FFFFFF"), ($ex - 70), 390, 140, 150)
    $g.FillEllipse((New-SolidBrush "#40270A"), ($ex - 18), 430, 72, 80)
    $g.FillEllipse((New-SolidBrush "#FFFFFF"), ($ex + 2), 420, 26, 26)
}

# 腮红
$g.FillEllipse((New-SolidBrush "#F7A08A"), 236, 560, 120, 72)
$g.FillEllipse((New-SolidBrush "#F7A08A"), 668, 560, 120, 72)

# 微笑弧线
$pen = New-Object System.Drawing.Pen([System.Drawing.ColorTranslator]::FromHtml("#5B3A12"), 22)
$pen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
$pen.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
$g.DrawArc($pen, 412, 520, 200, 140, 20, 140)

$g.Dispose()
$out = Join-Path $PSScriptRoot "..\app-icon.png"
$bmp.Save($out, [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose()
Write-Host "generated $out"
