@echo off
echo ============================================
echo  GitHub 登录（浏览器授权）
echo  1. 复制下方 one-time code
echo  2. 浏览器打开的页面中粘贴并授权
echo ============================================
"C:\Program Files\GitHub CLI\gh.exe" auth login --hostname github.com --git-protocol https --web
echo.
echo 完成！这个窗口可以关掉了。
pause
