@echo off
setlocal
"%~dp0resources\runtime\node.exe" "%~dp0scripts\install-portable.mjs" --source "%~dp0." --choose --apply
set "ZZB_EXIT=%ERRORLEVEL%"
pause
exit /b %ZZB_EXIT%
