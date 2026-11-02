@echo off
node "%~dp0bridge\install-native.cjs"
if errorlevel 1 pause
