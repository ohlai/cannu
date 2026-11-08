@echo off
rem Starts the dashboard from this folder. If one is already running, this
rem copy can't get port 4000 and exits.
cd /d "%~dp0"
if not exist local mkdir local
set NODE=node
if exist "C:\Program Files\nodejs\node.exe" set NODE="C:\Program Files\nodejs\node.exe"
%NODE% server.js >> local\dashboard.log 2>&1
