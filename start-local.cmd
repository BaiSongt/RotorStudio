@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo 未找到 Node.js。请先安装 Node.js 20.19 或以上，建议使用 22.12 以上的 22.x 或 24.x。
  echo 安装后请重新打开此启动文件。
  pause
  exit /b 1
)

node -e "const [major,minor]=process.versions.node.split('.').map(Number);process.exit(major>20||(major===20&&minor>=19)?0:1)"
if errorlevel 1 (
  echo 当前 Node.js 版本过低。项目要求 Node.js 20.19 或以上。
  node --version
  pause
  exit /b 1
)

if not exist "dist\index.html" (
  echo 未找到 dist\index.html。请完整解压交付包。
  echo 若正在运行源代码，请先执行 npm install 和 npm run build。
  pause
  exit /b 1
)

set "rotorHost=%HOST%"
if not defined rotorHost set "rotorHost=127.0.0.1"
set "rotorPort=%PORT%"
if not defined rotorPort set "rotorPort=4173"
echo.
echo Rotor Studio 即将启动。
echo 启动成功后，请在 Chrome 或 Edge 中打开 http://%rotorHost%:%rotorPort%
echo 请保持此窗口打开。按 Ctrl+C 可停止服务。
echo.
node server.mjs
set "rotorExitCode=%errorlevel%"
echo.
echo 本地服务已停止。
pause
exit /b %rotorExitCode%
