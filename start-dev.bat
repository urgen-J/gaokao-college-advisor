@echo off
set "PATH=C:\Users\江友敬\.workbuddy\binaries\node\versions\22.22.2;%PATH%"
cd /d D:\workboddyproject\project2\gaokao-college-advisor
REM 释放可能被旧进程占用的端口（避免冲突）
for /f "tokens=5" %%a in ('netstat -aon ^| findstr :5173 ^| findstr LISTENING') do taskkill /f /pid %%a
for /f "tokens=5" %%a in ('netstat -aon ^| findstr :3000 ^| findstr LISTENING') do taskkill /f /pid %%a
start "" http://localhost:5173
npm run dev
