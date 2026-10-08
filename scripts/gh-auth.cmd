@echo off
echo ============================================
echo  GitHub 登录（浏览器授权）
echo  1. 复制下方 one-time code
echo  2. 浏览器打开的页面中粘贴并授权
echo ============================================
rem 先认 PATH 里的 gh；找不到再试默认安装位置，别再硬编一条绝对路径
where gh >nul 2>&1
if %errorlevel%==0 (
  gh auth login --hostname github.com --git-protocol https --web
) else if exist "C:\Program Files\GitHub CLI\gh.exe" (
  "C:\Program Files\GitHub CLI\gh.exe" auth login --hostname github.com --git-protocol https --web
) else (
  echo 没找到 gh.exe：请安装 GitHub CLI，或把它加进 PATH 后重试。
  exit /b 1
)
echo.
echo 完成！这个窗口可以关掉了。
pause
