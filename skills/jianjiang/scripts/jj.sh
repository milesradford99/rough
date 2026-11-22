#!/bin/sh
# 剪讲技能的入口脚本（和画讲共用一个引擎仓库）。
#   jj.sh setup        找到（或下载）引擎，检查更新，装好依赖。每次开始工作前跑一次
#   jj.sh <jj 的参数>   运行 jj 命令，例如 jj.sh status work/demo
# 引擎就是这个仓库。技能目录在仓库里（软链接安装）时直接用仓库；技能是单独拷贝的，就把仓库放在 ~/.huajiang。
set -eu
REPO="${HUAJIANG_REPO:-https://github.com/milesradford99/rough.git}"
SELF="$(cd "$(dirname "$(readlink -f "$0" 2>/dev/null || realpath "$0" 2>/dev/null || echo "$0")")" && pwd)"
SKILL="$(dirname "$SELF")"
if [ -f "$SKILL/../../package.json" ] && grep -q '"name": "huajiang"' "$SKILL/../../package.json"; then
  ENGINE="$(cd "$SKILL/../.." && pwd)"
else
  ENGINE="${HUAJIANG_HOME:-$HOME/.huajiang}"
fi

setup() {
  command -v node >/dev/null 2>&1 || { echo "✗ 需要 Node.js 20 以上（https://nodejs.org）"; exit 1; }
  command -v ffmpeg >/dev/null 2>&1 || echo "! 没有找到 ffmpeg：看素材、渲染、免费配音都需要它，先装上"
  command -v yt-dlp >/dev/null 2>&1 || echo "! 没有找到 yt-dlp：抓视频平台的素材要用它（pip install -U yt-dlp）"
  python3 -c "import faster_whisper" >/dev/null 2>&1 || echo "· 没有 faster-whisper：jj hear 转文字要用它（pip install faster-whisper）；有平台字幕的视频不需要"
  node -e "require('playwright')" >/dev/null 2>&1 || (cd "$ENGINE" 2>/dev/null && node -e "require('playwright')" >/dev/null 2>&1) || echo "· 没有 Playwright：网页截图（jj snap、抓网页）要用它（npm install -g playwright && npx playwright install chromium）"
  if [ ! -d "$ENGINE" ]; then
    echo "· 下载引擎到 $ENGINE"
    git clone --depth 50 -q "$REPO" "$ENGINE"
  fi
  before="$(git -C "$ENGINE" rev-parse HEAD 2>/dev/null || echo none)"
  if [ -d "$ENGINE/.git" ]; then
    if [ -n "$(git -C "$ENGINE" status --porcelain 2>/dev/null)" ]; then
      echo "· 引擎目录有没提交的改动，跳过更新（$ENGINE）"
    elif git -C "$ENGINE" pull --ff-only -q 2>/dev/null; then :; else
      echo "· 检查更新失败（没有网络，或当前分支没有上游），用现有版本继续"
    fi
  fi
  after="$(git -C "$ENGINE" rev-parse HEAD 2>/dev/null || echo none)"
  if [ ! -d "$ENGINE/node_modules" ] || [ "$ENGINE/package-lock.json" -nt "$ENGINE/node_modules/.package-lock.json" ]; then
    echo "· 安装依赖"
    # npm ci 不会改动 package-lock.json：引擎目录保持干净，下次才能自动更新
    (cd "$ENGINE" && (npm ci --no-audit --no-fund --silent 2>/dev/null || npm install --no-save --no-audit --no-fund --silent))
  fi
  # 技能是单独拷贝的：把说明同步成引擎里的最新版
  if [ "$SKILL" != "$ENGINE/skills/jianjiang" ] && [ -d "$ENGINE/skills/jianjiang" ]; then
    cp -R "$ENGINE/skills/jianjiang/." "$SKILL/"
  fi
  ver="$(node "$ENGINE/bin/hj.mjs" --version)"
  if [ "$before" != "$after" ] && [ "$before" != "none" ]; then echo "✓ 已更新到 $ver（$after）。技能的说明可能也变了：重新读一遍 SKILL.md"; else echo "✓ 剪讲（引擎 $ver）已就绪"; fi
  echo "  引擎：$ENGINE"
  echo "  之后的命令都写成：sh $SELF/jj.sh <命令>   （下文简写为 jj）"
}

case "${1:-}" in
  setup) setup ;;
  "") echo "用法：jj.sh setup | jj.sh <jj 的命令和参数>"; exit 1 ;;
  *)
    [ -d "$ENGINE/node_modules" ] || { echo "✗ 引擎还没装好，先运行：sh $SELF/jj.sh setup"; exit 1; }
    exec node "$ENGINE/bin/jj.mjs" "$@" ;;
esac
