#!/bin/bash
# 部署到 DMIT-1。
#   · 服务端按 import 图谱算（扫目录会把别的项目的文件也带上去，手挑会漏）
#   · 静态资源打成一个 tar 走单条 SSH —— 逐个 scp 195 面国旗要 195 次握手，实测跑不完
set -u
# 部署目标不写死 —— 每个人的机器和服务器都不一样。缺一个就直接报错退出，
# 不给默认值：默认值指向别人的服务器，比报错危险得多。
#   VEND_DEPLOY_KEY   SSH 私钥路径
#   VEND_DEPLOY_HOST  user@host
#
# ⚠ 远端这三样目前是写死的，改服务器的话要在本文件里一起改：
#     /opt/vend            应用目录
#     vend-sms             systemd 服务名
#     /etc/vend/vend.env   环境变量文件（校验步骤从里面读端口）
#   没做成变量是有原因的：下面的远端命令走单引号传给对方 shell，
#   里面还有给**远端**用的 $(...) 和 $f。改成双引号会让本地先展开一遍，
#   坏法是静默的 —— 脚本照跑，但传过去的命令已经不是你写的那条了。
#   要改就整段一起改，别只把引号换掉。
KEY=${VEND_DEPLOY_KEY:?请先设置 VEND_DEPLOY_KEY（SSH 私钥路径）}
HOST=${VEND_DEPLOY_HOST:?请先设置 VEND_DEPLOY_HOST（如 root@203.0.113.10）}
SSH="ssh -o ConnectTimeout=20 -o StrictHostKeyChecking=no -o ControlMaster=no -i $KEY $HOST"
ROOT=$(cd "$(dirname "$0")/.." && pwd)
cd "$ROOT" || exit 1

echo "== 给静态资源打内容哈希（防新HTML配旧CSS）=="
node $ROOT/scripts/stamp-assets.mjs || exit 1

GRAPH=$(node $ROOT/scripts/import-graph.mjs) || exit 1

echo "== 服务端文件（import 图谱）=="
echo "$GRAPH" | tr '\n' ' '; echo

echo "== 打包上传（服务端 + 静态资源一次过）=="
# ⚠ 只列具体文件，**绝不能写 data/** —— 那个目录里有生产库 vend.sqlite，
# 整目录打包上去会把真实卡密和取号记录覆盖掉。
DATA_FILES="data/country-cn.json data/hero-countries.json"
# 号池 CLI 及其依赖：不在 import 图谱里（图谱只算 vend-server 的依赖），
# 但运维要在这台机器上加号/查状态，漏传就会和线上代码漂移。
ADMIN_FILES="scripts/pool.mjs server/accountLine.js server/outlookToken.js server/runLock.js"
tar -czf - $GRAPH $ADMIN_FILES public/vend $DATA_FILES | $SSH 'tar -xzf - -C /opt/vend' || { echo "✖ 上传失败"; exit 1; }

echo "== 清理不属于 vend 的残留 + 属主 + 重启 =="
$SSH '
# ⚠ 这份清单只能列**确实不属于 vend 的**文件。
# 2026-08-27 事故：inviteSweep.js 开始 import automationMatch.js（复用邀请信匹配器），
# 而这里还在删它 —— 部署完网站直接崩溃重启，而部署脚本报的是成功。
# 加依赖时务必回来看一眼这行。
cd /opt/vend/server 2>/dev/null && rm -f server.js routes.js codexDeviceAuth.js automation.js automationBrowser.js
rm -rf /opt/vend/public/vend/vendor
chown -R vend:vend /opt/vend/server /opt/vend/public
echo "server/: $(ls /opt/vend/server | tr "\n" " ")"
echo "国旗数: $(ls /opt/vend/public/vend/flags 2>/dev/null | wc -l)"
echo "图片: $(ls /opt/vend/public/vend/img 2>/dev/null | tr "\n" " ")"
systemctl restart vend-sms && sleep 4 && echo "服务: $(systemctl is-active vend-sms)"
journalctl -u vend-sms -n 12 --no-pager | grep -E "预热|启动|rror" | tail -3
'

# 🔴 判据落在**服务真的活着**上，不落在「restart 返回 0」上。
# 2026-08-27 事故：清理清单误删了 inviteSweep 依赖的 automationMatch.js，
# 网站崩溃重启循环，而部署脚本一路打印成功、只在中间闪过一个 activating。
echo
echo "== 上线校验（不通过就非零退出）=="
$SSH '
fail=0
# 1) import 图谱里的文件必须一个不少 —— 清理清单误删依赖就是这么漏过去的
for f in '"$(echo $GRAPH | tr "
" " ")"'; do
  [ -f "/opt/vend/$f" ] || { echo "✖ 缺文件: $f"; fail=1; }
done
# 2) 服务必须是 active，不是 activating/failed
sleep 2
st=$(systemctl is-active vend-sms)
[ "$st" = "active" ] || { echo "✖ 服务状态: $st"; journalctl -u vend-sms -n 15 --no-pager | tail -8; fail=1; }
# 3) 首页真的能打开
code=$(curl -s -m 10 -o /dev/null -w "%{http_code}" "http://127.0.0.1:$(grep -oE "^VEND_PORT=.*" /etc/vend/vend.env | cut -d= -f2)/")
[ "$code" = "200" ] || { echo "✖ 首页 HTTP $code"; fail=1; }
[ "$fail" = "0" ] && echo "✅ 文件齐、服务 active、首页 200" || exit 1
' || { echo "✖ 上线校验没通过，上面有原因"; exit 1; }
