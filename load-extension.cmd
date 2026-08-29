@echo off
REM Chrome 不能静默把未打包扩展塞进当前用户配置，只能打开扩展页 + 目录。
start "" "%ProgramFiles%\Google\Chrome\Application\chrome.exe" "chrome://extensions/"
start "" explorer.exe "%~dp0extension"
echo 1. 打开右上角「开发者模式」
echo 2. 点「加载已解压的扩展程序」
echo 3. 选这个目录：%~dp0extension
pause
