@echo off
REM Odysseus_Code installer — double-click on Windows.
setlocal
cd /d "%~dp0"
where py >nul 2>nul && (py install.py %* & goto :done)
where python >nul 2>nul && (python install.py %* & goto :done)
echo Python not found. Install Python 3, then run: python install.py
:done
echo.
pause
