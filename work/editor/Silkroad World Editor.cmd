@echo off
rem Silkroad World Editor (docs/WORLD_EDITOR.md D2): starts the editor on http://127.0.0.1:5185 and opens it in the browser.
rem Close this window to stop the editor. A copy on the Desktop works too (it falls back to C:/dev/silkroad).
title Silkroad World Editor
set "SRO_REPO=%~dp0..\.."
if not exist "%SRO_REPO%\apps\viewer\editor-api" set "SRO_REPO=C:\dev\silkroad"
cd /d "%SRO_REPO%"
call pnpm editor
if errorlevel 1 (
  echo.
  echo The World Editor did not start. If it says the port is in use, it is already open: look for its browser tab.
  pause
)
