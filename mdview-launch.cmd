@echo off
rem mdview launcher: works from Explorer double-click, a console, or Win+R.
rem The Node path is recorded at install time so Node does not have to be on PATH.
setlocal
set "HERE=%~dp0"
set "MDVIEW-NODE="
if exist "%HERE%mdview-node.txt" set /p MDVIEW-NODE=<"%HERE%mdview-node.txt"
if not defined MDVIEW-NODE set "MDVIEW-NODE=node"
"%MDVIEW-NODE%" "%HERE%server.mjs" %*
endlocal
