@echo off
rem Starts the shared calendar in the background at logon.
set PORT=8790
set DATA_DIR=D:\timetree-oss\data3
"D:\rea-toolchain\node-v24.18.0-win-x64\node.exe" "D:\timetree-oss\src\server.ts" >> "D:\timetree-oss\server-autostart.log" 2>&1
