#!/bin/sh
set -eu

# 使用脚本所在目录，确保从其他路径调用时仍能找到构建产物。
rotor_script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
cd "$rotor_script_dir"

if ! command -v node >/dev/null 2>&1; then
  printf '%s\n' '未找到 Node.js。请先安装 Node.js 20.19 或以上，建议使用 22.12 以上的 22.x 或 24.x。' >&2
  exit 1
fi

if ! node -e 'const [major,minor]=process.versions.node.split(".").map(Number);process.exit(major>20||(major===20&&minor>=19)?0:1)'; then
  printf '%s\n' '当前 Node.js 版本过低。项目要求 Node.js 20.19 或以上。' >&2
  node --version
  exit 1
fi

if [ ! -f dist/index.html ]; then
  printf '%s\n' '未找到 dist/index.html。请完整解压交付包；运行源代码时请先执行 npm install 和 npm run build。' >&2
  exit 1
fi

printf '\n%s\n' 'Rotor Studio 即将启动。'
printf '启动成功后，请在 Chrome 或 Edge 中打开 http://%s:%s\n' "${HOST:-127.0.0.1}" "${PORT:-4173}"
printf '%s\n\n' '请保持此终端打开。按 Ctrl+C 可停止服务。'
exec node server.mjs
