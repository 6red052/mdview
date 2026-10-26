@echo off
rem mdview launcher: works from Explorer double-click, a console, or Win+R.
rem The Node path is recorded at install time so Node does not have to be on PATH.
setlocal
set "HERE=%~dp0"
set "MDVIEW-NODE="
if exist "%HERE%mdview-node.txt" set /p MDVIEW-NODE=<"%HERE%mdview-node.txt"
if not defined MDVIEW-NODE set "MDVIEW-NODE=node"
rem Installed layout: server.mjs sits next to this file.
rem Repo layout: this file lives in windows\, server.mjs one level up.
set "SERVER=%HERE%server.mjs"
if not exist "%SERVER%" set "SERVER=%HERE%..\server.mjs"
"%MDVIEW-NODE%" "%SERVER%" %*
endlocal
