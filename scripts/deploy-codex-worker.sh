#!/bin/bash
# 把 Codex 邀请自动化同步到 DMIT-2 的 /opt/codex-worker。
#
# 为什么要有这个脚本：两份 server/automation*.js 长期靠手工同步，
# vault ops-002 的 D3 就记着「两份可能已分叉、scripts/ 里没有部署脚本」。
# 手工 scp 的问题不是麻烦，是**漏一个文件不会报错**——
# 2026-08-25 实测 VPS 上的 automationMatch.js 还带着少一个 OTP 发件人的老版本，
# 表现是某类验证码信永远收不到，而两边看起来都「跑着」。
#
# 三条硬规则：
#   1) 只列具体文件，绝不整目录同步 —— /opt/codex-worker 下有 .env、data/、shots/，
#      整目录推上去会覆盖凭据和现场证据
#   2) 默认只比对不写。要真的推，显式加 --yes
#   3) 推完打印远端 git status —— 那边已纳入版本控制，看得见才回得去
set -u
# 不给默认值：默认值指向别人的服务器，比报错危险得多。
KEY=${CODEX_WORKER_KEY:?请先设置 CODEX_WORKER_KEY（SSH 私钥路径）}
HOST=${CODEX_WORKER_HOST:?请先设置 CODEX_WORKER_HOST（如 root@203.0.113.11）}
REMOTE=/opt/codex-worker
SSH="ssh -o ConnectTimeout=20 -o StrictHostKeyChecking=no -i $KEY $HOST"
ROOT=$(cd "$(dirname "$0")/.." && pwd)
cd "$ROOT" || exit 1

# worker 真正 import 的那些。多推无害，少推静默出错，所以宁可全列。
FILES="
server/automation.js
server/automationBrowser.js
server/automationMatch.js
server/mailKind.js
server/cloudflareEmail.js
server/config.js
server/extract.js
server/heroSms.js
server/mime.js
server/smtpMail.js
server/mailProvider.js
server/accountPool.js
server/accountLine.js
server/outlookToken.js
server/desktopJudge.js
server/outlookMail.js
server/outlookGrant.js
server/pop3Mail.js
server/webmailOutlook.js
server/codexLiveness.js
server/codexTurnCli.js
server/codexDeviceAuth.js
scripts/outlook-auth.mjs
scripts/outlook-mail-probe.mjs
scripts/outlook-pop3-probe.mjs
scripts/outlook-grant-token.mjs
scripts/pool.mjs
scripts/invite-worker.mjs
server/runLock.js
scripts/codex-device-probe.mjs
scripts/codex-turn-cli.mjs
"

echo "== 比对本地与 DMIT-2 =="
# md5sum 遇到远端还没有的文件会返回非零，那不是「连不上」。
# 用输出是否为空来判断连通，别拿退出码当连通性判据 —— 会把「新增文件」误报成「网络断了」。
REMOTE_SUMS=$($SSH "cd $REMOTE && md5sum $(echo $FILES | tr '\n' ' ') 2>/dev/null; true")
[ -z "$REMOTE_SUMS" ] && { echo "连不上 DMIT-2，或远端目录不对，先查网络/密钥"; exit 1; }

DIFFER=""
for f in $FILES; do
  [ -f "$f" ] || { echo "  本地缺失 $f（跳过）"; continue; }
  local_sum=$(md5sum "$f" | awk '{print $1}')
  remote_sum=$(echo "$REMOTE_SUMS" | awk -v p="$f" '$2==p{print $1}')
  if [ "$local_sum" = "$remote_sum" ]; then
    echo "  同 $f"
  else
    echo "  差 $f  (远端: ${remote_sum:-不存在})"
    DIFFER="$DIFFER $f"
  fi
done

# 桌面端主脚本：仓库放 scripts/desktop/，远端必须落在 worker 根目录
# （它 import 的是 ./server/xxx.js，放子目录会全部找不到），所以路径要单独比。
DESKTOP_DIFF=""
DK_LOCAL=$(md5sum scripts/desktop/desktop-run.mjs 2>/dev/null | awk '{print $1}')
DK_REMOTE=$($SSH "md5sum $REMOTE/desktop-run.mjs 2>/dev/null; true" | awk '{print $1}')
if [ -n "$DK_LOCAL" ] && [ "$DK_LOCAL" != "$DK_REMOTE" ]; then
  echo "  差 desktop-run.mjs  (远端: ${DK_REMOTE:-不存在})"
  DESKTOP_DIFF=1
else
  echo "  同 desktop-run.mjs"
fi

# 🔴 systemd **不会**因为文件变了就重载。2026-08-27 实测：部署了新的
# invite-worker.mjs 却没重启，服务继续跑三个半小时前的代码 ——
# 表现是「自带令牌的号还是去跑了一遍设备码授权」，而部署脚本一路报成功。
#
# 而且这一步在「文件一致」那条路上也必须跑：文件一致 ≠ 进程不旧。
restart_worker() {
  echo
  echo "== worker 状态（新代码要真正生效）=="
  $SSH "systemctl is-active --quiet codex-invite-worker || { echo 'worker 未在运行'; exit 0; }
    systemctl restart codex-invite-worker
    sleep 3
    echo \"worker: \$(systemctl is-active codex-invite-worker)\"
    cd $REMOTE
    S=\$(date -d \"\$(systemctl show codex-invite-worker -p ActiveEnterTimestamp --value)\" +%s 2>/dev/null || echo 0)
    F=\$(stat -c %Y scripts/invite-worker.mjs)
    # 判据落在**进程比文件新**上，不落在「restart 返回 0」上
    if [ \"\$S\" -ge \"\$F\" ]; then echo '✅ 进程比文件新，新代码已生效'; else echo \"⚠️ 进程比文件旧（\$S < \$F）—— 新代码没生效\"; fi"
}

[ -z "$DIFFER" ] && [ -z "$DESKTOP_DIFF" ] && { echo "== 两边一致，无需部署 =="; restart_worker; exit 0; }

if [ "${1:-}" != "--yes" ]; then
  echo
  echo "== 只比对，没有写入。确认无误后加 --yes 真正部署 =="
  exit 0
fi

echo
echo "== 上传（远端先留一份 git stash 之外的现场）=="
# scripts/ 在远端可能还不存在，scp 到不存在的目录会静默按文件名落地
$SSH "mkdir -p $REMOTE/server $REMOTE/scripts $REMOTE/secrets && chmod 700 $REMOTE/secrets"
$SSH "cd $REMOTE && git status --porcelain > /tmp/codex-worker-before.txt"
for f in $DIFFER; do
  scp -o ConnectTimeout=20 -o StrictHostKeyChecking=no -i "$KEY" "$f" "$HOST:$REMOTE/$f" >/dev/null || {
    echo "  上传失败：$f"; exit 1; }
  echo "  已传 $f"
done

# 桌面端主脚本在仓库里放 scripts/desktop/，但在远端必须落在 worker 根目录 ——
# 它 import 的是 ./server/xxx.js，放进子目录会全部找不到。
if [ -n "$DESKTOP_DIFF" ]; then
  if ! scp -o ConnectTimeout=20 -o StrictHostKeyChecking=no -i "$KEY" scripts/desktop/desktop-run.mjs "$HOST:$REMOTE/desktop-run.mjs" >/dev/null; then
    echo "  上传失败：desktop-run.mjs"; exit 1
  fi
  echo "  已传 desktop-run.mjs → $REMOTE/desktop-run.mjs（路径已改写）"
fi

echo
echo "== 远端 git 状态（要回滚就在那边 git checkout -- <file>）=="
$SSH "cd $REMOTE && git status --short && echo '--- 改动规模 ---' && git diff --stat"

echo
echo "== 语法自检（只 import，不跑任务）=="
$SSH "cd $REMOTE && node -e \"import('./server/automation.js').then(()=>console.log('automation.js 载入正常')).catch(e=>{console.error('载入失败:',e.message);process.exit(1)})\""
# 主流程脚本也要查。原来只 import automation.js —— desktop-run.mjs 有语法错误也会
# 静默部署成功，等到真跑那一刻才炸，而那时候邀请名额已经花出去了。
$SSH "cd $REMOTE && node --check desktop-run.mjs && node --check scripts/pool.mjs && echo '主流程 + 号池 CLI 语法 OK'"

restart_worker
