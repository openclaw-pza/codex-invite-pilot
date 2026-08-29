@echo off
REM Node 24 + NODE_USE_ENV_PROXY=1 读不了系统里的 socks5h://127.0.0.1:10808，会直接崩。
REM 本服务访问的邮箱/HeroSMS 直连已通，启动时只清当前进程环境，不改系统代理。
set HTTP_PROXY=
set HTTPS_PROXY=
set ALL_PROXY=
set http_proxy=
set https_proxy=
set all_proxy=
set NODE_USE_ENV_PROXY=0
cd /d "%~dp0"
echo Starting mail-sms-pilot at http://127.0.0.1:8787
node server/server.js
