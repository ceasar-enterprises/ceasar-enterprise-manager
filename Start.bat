@echo off
echo Starting CEASAR ENTERPRISE Manager...
start "" http://localhost:3002
node "%~dp0index.js"
pause
