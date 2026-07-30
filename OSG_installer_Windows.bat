@ECHO OFF
SETLOCAL EnableDelayedExpansion
CLS

:: --- Configuration ---
SET "PROJECT_FOLDER_NAME=oneclick-subtitles-generator"
SET "GIT_REPO_URL=https://github.com/nganlinh4/oneclick-subtitles-generator.git"
SET "SCRIPT_DIR=%~dp0"
SET "PROJECT_PATH=%SCRIPT_DIR%%PROJECT_FOLDER_NAME%"
IF "%PROJECT_PATH:~-1%"=="\" SET "PROJECT_PATH=%PROJECT_PATH:~0,-1%"
SET "STAGING_PATH=%PROJECT_PATH%.installing"
SET "BACKUP_PATH=%PROJECT_PATH%.backup"
SET "LAST_CHOICE_FILE=%SCRIPT_DIR%last_choice.tmp"
SET "LEGACY_PREREQ_FLAG_FILE=%SCRIPT_DIR%prereqs_installed.flag"

:: --- Self-update settings ---
:: Bump SELF_VERSION to match the release tag whenever you cut a NEW .bat release.
:: On a fresh launch the installer compares this to the latest GitHub release and, if
:: newer, offers to download + swap itself in place so users never re-download manually.
SET "SELF_VERSION=2.6.1"
SET "SELFBAT=%~f0"
SET "OSG_REPO=nganlinh4/oneclick-subtitles-generator"
SET "NEWBAT=%SCRIPT_DIR%OSG_installer_Windows.new.bat"

:: --- Fixed Settings (Bilingual Menu) ---
SET "MENU_LABEL=MainMenuVI"
SET "PROMPT_CHOICE=Enter your choice (Nhap lua chon cua ban) (1-5): "
SET "TITLE_TEXT=OneClick Subtitle Generator Manager (Quan Ly Trinh Tao Phu De OneClick)"

TITLE %TITLE_TEXT%

:: --- Check for Administrator Privileges ---
powershell -NoProfile -ExecutionPolicy Bypass -Command "Write-Host '[?] Checking administrator privileges (Kiem tra quyen quan tri)...' -ForegroundColor Yellow; if (-NOT ([Security.Principal.WindowsPrincipal] [Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole] 'Administrator')) { Write-Host ''; Write-Host '[ERROR] Administrator privileges required (Can quyen quan tri).' -ForegroundColor Red; Write-Host '[INFO] Requesting administrator privileges (Yeu cau quyen quan tri)...' -ForegroundColor Blue; Write-Host ''; Start-Process '%~f0' -Verb RunAs; exit 1 } else { Write-Host '[OK] Administrator privileges confirmed (Da xac nhan quyen quan tri).' -ForegroundColor Green; Write-Host '' }"
IF %ERRORLEVEL% NEQ 0 EXIT /B

:: --- Self-update: on a fresh launch, offer to update the installer file itself ---
:: Flat/GOTO style (no nested blocks) so batch paren-parsing stays safe. Any failure or
:: no-internet falls straight through to the normal menu. Skipped while a saved install
:: choice is active so the script is never swapped during setup or recovery.
IF EXIST "%LAST_CHOICE_FILE%" GOTO SkipSelfUpdate
DEL "%TEMP%\osg_latest.txt" >nul 2>&1
powershell -NoProfile -ExecutionPolicy Bypass -Command "try { $r=Invoke-RestMethod -Uri 'https://api.github.com/repos/%OSG_REPO%/releases/latest' -Headers @{'User-Agent'='OSG-Installer'} -TimeoutSec 8; $l=($r.tag_name).TrimStart('v'); if([version]$l -gt [version]'%SELF_VERSION%'){ Out-File -InputObject $r.tag_name -FilePath ($env:TEMP + '\osg_latest.txt') -Encoding ascii } } catch {}"
IF NOT EXIST "%TEMP%\osg_latest.txt" GOTO SkipSelfUpdate
SET "LATEST_TAG="
SET /P "LATEST_TAG="<"%TEMP%\osg_latest.txt"
DEL "%TEMP%\osg_latest.txt" >nul 2>&1
IF NOT DEFINED LATEST_TAG GOTO SkipSelfUpdate
ECHO.
powershell -NoProfile -ExecutionPolicy Bypass -Command "Write-Host ('[UPDATE] A newer installer %LATEST_TAG% is available (you have v%SELF_VERSION%) / Co ban cai dat moi %LATEST_TAG% (ban dang dung v%SELF_VERSION%).') -ForegroundColor Cyan"
SET "DO_UPDATE=Y"
SET /P "DO_UPDATE=Update the installer now? Cap nhat trinh cai dat ngay? (Y/n): "
IF /I "%DO_UPDATE%"=="n" GOTO SkipSelfUpdate
GOTO SelfUpdate
:SkipSelfUpdate

:: Resume an install choice left by an interrupted or relaunched setup.
IF EXIST "%LAST_CHOICE_FILE%" (
    SET "CHOICE="
    SET /P SAVED_CHOICE=<"%LAST_CHOICE_FILE%"
    DEL "%LAST_CHOICE_FILE%" >nul 2>&1
    :: Validate the saved choice
    IF "!SAVED_CHOICE!"=="1" SET "CHOICE=1"
    IF "!SAVED_CHOICE!"=="2" SET "CHOICE=2"
    IF "!SAVED_CHOICE!"=="3" SET "CHOICE=3"
    IF "!SAVED_CHOICE!"=="4" SET "CHOICE=4"
    IF "!SAVED_CHOICE!"=="5" SET "CHOICE=5"
    IF DEFINED CHOICE (
        powershell -NoProfile -ExecutionPolicy Bypass -Command "Write-Host '[RESUME] Using previous choice (Su dung lua chon truoc): !CHOICE!' -ForegroundColor Magenta"
        ECHO.
        GOTO ProcessChoice
    ) ELSE (
        powershell -NoProfile -ExecutionPolicy Bypass -Command "Write-Host '[WARN] Invalid saved choice detected. Showing menu (Phat hien lua chon khong hop le. Hien thi menu)...' -ForegroundColor Yellow"
    )
)

GOTO %MENU_LABEL%

:: =============================================================================
:: SELF-UPDATE: download the latest installer, swap this file in place, relaunch
:: =============================================================================
:SelfUpdate
ECHO.
powershell -NoProfile -ExecutionPolicy Bypass -Command "Write-Host '[UPDATE] Downloading the new installer (Dang tai trinh cai dat moi)...' -ForegroundColor Yellow; try { Invoke-WebRequest -Uri 'https://github.com/%OSG_REPO%/releases/latest/download/OSG_installer_Windows.bat' -OutFile '%NEWBAT%' -UseBasicParsing -TimeoutSec 120 } catch { exit 1 }"
IF %ERRORLEVEL% NEQ 0 GOTO SelfUpdateFail
:: Validate the download before trusting it (exists, non-trivial size, real OSG installer).
powershell -NoProfile -ExecutionPolicy Bypass -Command "if((Test-Path '%NEWBAT%') -and ((Get-Item '%NEWBAT%').Length -gt 5000) -and (Select-String -Path '%NEWBAT%' -Pattern 'PROJECT_FOLDER_NAME' -Quiet)){ exit 0 } else { exit 1 }"
IF %ERRORLEVEL% NEQ 0 GOTO SelfUpdateFail
powershell -NoProfile -ExecutionPolicy Bypass -Command "Write-Host '[UPDATE] Applying update and restarting (Dang cap nhat va khoi dong lai)...' -ForegroundColor Green"
:: Hand off to a detached PowerShell: wait for this script to exit, swap the file, relaunch.
start "" powershell -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -Command "Start-Sleep -Seconds 2; try { Copy-Item -LiteralPath '%NEWBAT%' -Destination '%SELFBAT%' -Force } catch {}; Remove-Item -LiteralPath '%NEWBAT%' -Force -ErrorAction SilentlyContinue; Start-Process -FilePath '%SELFBAT%'"
EXIT /B

:SelfUpdateFail
powershell -NoProfile -ExecutionPolicy Bypass -Command "Write-Host '[WARN] Update failed; continuing with the current installer (Cap nhat that bai; tiep tuc).' -ForegroundColor Yellow"
IF EXIST "%NEWBAT%" DEL "%NEWBAT%" >nul 2>&1
GOTO %MENU_LABEL%

:: =============================================================================
:: BILINGUAL MENU (English/Vietnamese - Hardcoded)
:: =============================================================================
:MainMenuVI
CLS
ECHO.
:: Display the new Unicode ASCII logo with smooth blue gradient (left-to-right diagonal)
powershell -NoProfile -ExecutionPolicy Bypass -Command "Write-Host ('     ' + [char]27 + '[38;2;230;255;255m' + [char]0x2588 + [char]0x2588 + [char]0x2588 + [char]0x2588 + [char]0x2588 + [char]0x2588 + [char]0x2588 + [char]0x2588 + [char]0x2588 + [char]0x2588 + [char]0x2588 + [char]0x2557 + [char]27 + '[38;2;210;245;255m' + [char]0x2591 + [char]0x2591 + [char]0x2591 + [char]0x2591 + [char]27 + '[38;2;190;235;255m' + [char]0x2588 + [char]0x2588 + [char]0x2588 + [char]0x2588 + [char]0x2588 + [char]0x2588 + [char]0x2588 + [char]0x2588 + [char]0x2588 + [char]0x2588 + [char]0x2588 + [char]0x2557 + [char]27 + '[38;2;170;225;255m' + [char]0x2591 + [char]0x2591 + [char]0x2591 + [char]0x2591 + [char]27 + '[38;2;150;215;255m' + [char]0x2588 + [char]0x2588 + [char]0x2588 + [char]0x2588 + [char]0x2588 + [char]0x2588 + [char]0x2588 + [char]0x2588 + [char]0x2588 + [char]0x2588 + [char]0x2588 + [char]0x2557 + [char]27 + '[0m'); Write-Host ('  ' + [char]27 + '[38;2;220;250;255m' + [char]0x2588 + [char]0x2588 + [char]0x2588 + [char]0x2588 + [char]0x2588 + [char]0x2588 + [char]0x2588 + [char]0x2588 + [char]0x2588 + [char]0x2588 + [char]0x2588 + [char]0x2588 + [char]0x2588 + [char]0x2588 + [char]0x2588 + [char]0x2588 + [char]0x2588 + [char]0x2557 + [char]27 + '[38;2;195;240;255m' + [char]0x2591 + [char]0x2591 + [char]27 + '[38;2;175;230;255m' + [char]0x2588 + [char]0x2588 + [char]0x2588 + [char]0x2588 + [char]0x2588 + [char]0x2588 + [char]0x2588 + [char]0x2588 + [char]0x2588 + [char]0x2588 + [char]0x2588 + [char]0x2588 + [char]0x2588 + [char]0x2557 + [char]27 + '[38;2;155;220;255m' + [char]0x2591 + [char]0x2591 + [char]27 + '[38;2;135;210;255m' + [char]0x2588 + [char]0x2588 + [char]0x2588 + [char]0x2588 + [char]0x2588 + [char]0x2588 + [char]0x2588 + [char]0x2588 + [char]0x2588 + [char]0x2588 + [char]0x2588 + [char]0x2588 + [char]0x2557 + [char]27 + '[0m'); Write-Host (' ' + [char]27 + '[38;2;210;245;255m' + [char]0x2588 + [char]0x2588 + [char]0x2588 + [char]0x2588 + [char]0x2554 + [char]0x2550 + [char]0x2550 + [char]0x2550 + [char]0x2550 + [char]0x2550 + [char]0x2550 + [char]0x2550 + [char]0x2550 + [char]0x2550 + [char]0x2550 + [char]0x2588 + [char]0x2588 + [char]0x2588 + [char]0x2588 + [char]0x2557 + [char]27 + '[38;2;185;235;255m' + [char]0x2591 + [char]0x2591 + [char]27 + '[38;2;165;225;255m' + [char]0x2588 + [char]0x2588 + [char]0x2554 + [char]0x2550 + [char]0x2550 + [char]0x2550 + [char]0x2550 + [char]0x2550 + [char]0x2550 + [char]0x2550 + [char]0x2550 + [char]0x2550 + [char]0x255D + [char]27 + '[38;2;145;215;255m' + [char]0x2591 + [char]0x2591 + [char]0x2591 + [char]27 + '[38;2;125;205;255m' + [char]0x2588 + [char]0x2588 + [char]0x2554 + [char]0x2550 + [char]0x2550 + [char]0x2550 + [char]0x2550 + [char]0x2550 + [char]0x2550 + [char]0x2550 + [char]0x2550 + [char]0x255D + [char]27 + '[38;2;105;195;255m' + [char]0x2591 + [char]27 + '[0m'); Write-Host ([char]27 + '[38;2;200;240;255m' + [char]0x2588 + [char]0x2588 + [char]0x2588 + [char]0x2588 + [char]0x2554 + [char]0x255D + [char]27 + '[38;2;180;230;255m' + [char]0x2591 + [char]0x2591 + [char]0x2591 + [char]0x2591 + [char]0x2591 + [char]0x2591 + [char]0x2591 + [char]0x2591 + [char]0x2591 + [char]0x2591 + [char]0x2591 + [char]27 + '[38;2;160;220;255m' + [char]0x2588 + [char]0x2588 + [char]0x2588 + [char]0x2588 + [char]0x2557 + [char]27 + '[38;2;140;210;255m' + [char]0x2591 + [char]0x2591 + [char]27 + '[38;2;120;200;255m' + [char]0x2588 + [char]0x2588 + [char]0x2557 + [char]27 + '[38;2;100;190;255m' + [char]0x2591 + [char]0x2591 + [char]0x2591 + [char]0x2591 + [char]0x2591 + [char]0x2591 + [char]0x2591 + [char]0x2591 + [char]0x2591 + [char]0x2591 + [char]0x2591 + [char]0x2591 + [char]0x2591 + [char]27 + '[38;2;80;180;255m' + [char]0x2588 + [char]0x2588 + [char]0x2551 + [char]27 + '[38;2;60;170;255m' + [char]0x2591 + [char]0x2591 + [char]0x2591 + [char]0x2591 + [char]0x2591 + [char]0x2591 + [char]0x2591 + [char]0x2591 + [char]0x2591 + [char]0x2591 + [char]27 + '[0m'); Write-Host ([char]27 + '[38;2;190;235;255m' + [char]0x2588 + [char]0x2588 + [char]0x2588 + [char]0x2588 + [char]0x2551 + [char]27 + '[38;2;170;225;255m' + [char]0x2591 + [char]0x2591 + [char]0x2591 + [char]0x2591 + [char]0x2591 + [char]0x2591 + [char]0x2591 + [char]0x2591 + [char]0x2591 + [char]0x2591 + [char]0x2591 + [char]0x2591 + [char]27 + '[38;2;150;215;255m' + [char]0x2588 + [char]0x2588 + [char]0x2588 + [char]0x2588 + [char]0x2551 + [char]27 + '[38;2;130;205;255m' + [char]0x2591 + [char]0x2591 + [char]27 + '[38;2;110;195;255m' + [char]0x2588 + [char]0x2588 + [char]0x2588 + [char]0x2588 + [char]0x2588 + [char]0x2588 + [char]0x2588 + [char]0x2588 + [char]0x2588 + [char]0x2588 + [char]0x2588 + [char]0x2588 + [char]0x2588 + [char]0x2557 + [char]27 + '[38;2;90;185;255m' + [char]0x2591 + [char]0x2591 + [char]27 + '[38;2;70;175;255m' + [char]0x2588 + [char]0x2588 + [char]0x2551 + [char]27 + '[38;2;50;165;255m' + [char]0x2591 + [char]0x2591 + [char]27 + '[38;2;30;155;255m' + [char]0x2588 + [char]0x2588 + [char]0x2588 + [char]0x2588 + [char]0x2588 + [char]0x2588 + [char]0x2588 + [char]0x2588 + [char]0x2557 + [char]27 + '[0m'); Write-Host ([char]27 + '[38;2;180;230;255m' + [char]0x2588 + [char]0x2588 + [char]0x2588 + [char]0x2588 + [char]0x2551 + [char]27 + '[38;2;160;220;255m' + [char]0x2591 + [char]0x2591 + [char]0x2591 + [char]0x2591 + [char]0x2591 + [char]0x2591 + [char]0x2591 + [char]0x2591 + [char]0x2591 + [char]0x2591 + [char]0x2591 + [char]0x2591 + [char]27 + '[38;2;140;210;255m' + [char]0x2588 + [char]0x2588 + [char]0x2588 + [char]0x2588 + [char]0x2551 + [char]27 + '[38;2;120;200;255m' + [char]0x2591 + [char]0x2591 + [char]27 + '[38;2;100;190;255m' + [char]0x2588 + [char]0x2588 + [char]0x2588 + [char]0x2588 + [char]0x2588 + [char]0x2588 + [char]0x2588 + [char]0x2588 + [char]0x2588 + [char]0x2588 + [char]0x2588 + [char]0x2588 + [char]0x2588 + [char]0x2551 + [char]27 + '[38;2;80;180;255m' + [char]0x2591 + [char]0x2591 + [char]27 + '[38;2;60;170;255m' + [char]0x2588 + [char]0x2588 + [char]0x2551 + [char]27 + '[38;2;40;160;255m' + [char]0x2591 + [char]0x2591 + [char]27 + '[38;2;20;150;255m' + [char]0x2588 + [char]0x2588 + [char]0x2588 + [char]0x2588 + [char]0x2588 + [char]0x2588 + [char]0x2588 + [char]0x2588 + [char]0x2551 + [char]27 + '[0m'); Write-Host ([char]27 + '[38;2;170;225;255m' + [char]0x2588 + [char]0x2588 + [char]0x2588 + [char]0x2588 + [char]0x2551 + [char]27 + '[38;2;150;215;255m' + [char]0x2591 + [char]0x2591 + [char]0x2591 + [char]0x2591 + [char]0x2591 + [char]0x2591 + [char]0x2591 + [char]0x2591 + [char]0x2591 + [char]0x2591 + [char]0x2591 + [char]0x2591 + [char]27 + '[38;2;130;205;255m' + [char]0x2588 + [char]0x2588 + [char]0x2588 + [char]0x2588 + [char]0x2551 + [char]27 + '[38;2;110;195;255m' + [char]0x2591 + [char]0x2591 + [char]27 + '[38;2;90;185;255m' + [char]0x255A + [char]0x2550 + [char]0x2550 + [char]0x2550 + [char]0x2550 + [char]0x2550 + [char]0x2550 + [char]0x2588 + [char]0x2588 + [char]0x2588 + [char]0x2588 + [char]0x2588 + [char]0x2588 + [char]0x2551 + [char]27 + '[38;2;70;175;255m' + [char]0x2591 + [char]0x2591 + [char]27 + '[38;2;50;165;255m' + [char]0x2588 + [char]0x2588 + [char]0x2551 + [char]27 + '[38;2;30;155;255m' + [char]0x2591 + [char]0x2591 + [char]0x2591 + [char]0x2591 + [char]0x2591 + [char]27 + '[38;2;10;145;255m' + [char]0x2588 + [char]0x2588 + [char]0x2588 + [char]0x2588 + [char]0x2588 + [char]0x2551 + [char]27 + '[0m '); Write-Host (' ' + [char]27 + '[38;2;160;220;255m' + [char]0x2588 + [char]0x2588 + [char]0x2588 + [char]0x2588 + [char]0x2551 + [char]27 + '[38;2;140;210;255m' + [char]0x2591 + [char]0x2591 + [char]0x2591 + [char]0x2591 + [char]0x2591 + [char]0x2591 + [char]0x2591 + [char]0x2591 + [char]0x2591 + [char]0x2591 + [char]27 + '[38;2;120;200;255m' + [char]0x2588 + [char]0x2588 + [char]0x2588 + [char]0x2588 + [char]0x2554 + [char]0x255D + [char]27 + '[38;2;100;190;255m' + [char]0x2591 + [char]0x2591 + [char]0x2591 + [char]0x2591 + [char]0x2591 + [char]0x2591 + [char]0x2591 + [char]0x2591 + [char]27 + '[38;2;80;180;255m' + [char]0x2588 + [char]0x2588 + [char]0x2588 + [char]0x2588 + [char]0x2588 + [char]0x2588 + [char]0x2554 + [char]0x255D + [char]27 + '[38;2;60;170;255m' + [char]0x2591 + [char]0x2591 + [char]27 + '[38;2;40;160;255m' + [char]0x2588 + [char]0x2588 + [char]0x2551 + [char]27 + '[38;2;20;150;255m' + [char]0x2591 + [char]0x2591 + [char]0x2591 + [char]0x2591 + [char]0x2591 + [char]27 + '[38;2;0;140;255m' + [char]0x2588 + [char]0x2588 + [char]0x2588 + [char]0x2588 + [char]0x2554 + [char]0x255D + [char]27 + '[0m'); Write-Host (' ' + [char]27 + '[38;2;150;215;255m' + [char]0x255A + [char]0x2588 + [char]0x2588 + [char]0x2588 + [char]0x2588 + [char]0x2588 + [char]0x2588 + [char]0x2588 + [char]0x2588 + [char]0x2588 + [char]0x2588 + [char]0x2588 + [char]0x2588 + [char]0x2588 + [char]0x2588 + [char]0x2588 + [char]0x2588 + [char]0x2588 + [char]0x2554 + [char]0x255D + [char]27 + '[38;2;130;205;255m' + [char]0x2591 + [char]0x2591 + [char]27 + '[38;2;110;195;255m' + [char]0x2588 + [char]0x2588 + [char]0x2588 + [char]0x2588 + [char]0x2588 + [char]0x2588 + [char]0x2588 + [char]0x2588 + [char]0x2588 + [char]0x2588 + [char]0x2588 + [char]0x2588 + [char]0x2554 + [char]0x255D + [char]27 + '[38;2;90;185;255m' + [char]0x2591 + [char]0x2591 + [char]27 + '[38;2;70;175;255m' + [char]0x2588 + [char]0x2588 + [char]0x2588 + [char]0x2588 + [char]0x2588 + [char]0x2588 + [char]0x2588 + [char]0x2588 + [char]0x2588 + [char]0x2588 + [char]0x2588 + [char]0x2554 + [char]0x2550 + [char]0x255D + [char]27 + '[0m'); Write-Host ('    ' + [char]27 + '[38;2;140;210;255m' + [char]0x255A + [char]0x2588 + [char]0x2588 + [char]0x2588 + [char]0x2588 + [char]0x2588 + [char]0x2588 + [char]0x2588 + [char]0x2588 + [char]0x2588 + [char]0x2588 + [char]0x2588 + [char]0x2554 + [char]0x2550 + [char]0x2550 + [char]0x255D + [char]27 + '[38;2;120;200;255m' + [char]0x2591 + [char]0x2591 + [char]27 + '[38;2;100;190;255m' + [char]0x2588 + [char]0x2588 + [char]0x2588 + [char]0x2588 + [char]0x2588 + [char]0x2588 + [char]0x2588 + [char]0x2588 + [char]0x2588 + [char]0x2588 + [char]0x2554 + [char]0x2550 + [char]0x2550 + [char]0x255D + [char]27 + '[38;2;80;180;255m' + [char]0x2591 + [char]0x2591 + [char]27 + '[38;2;60;170;255m' + [char]0x2588 + [char]0x2588 + [char]0x2588 + [char]0x2588 + [char]0x2588 + [char]0x2588 + [char]0x2588 + [char]0x2588 + [char]0x2588 + [char]0x2554 + [char]0x2550 + [char]0x2550 + [char]0x255D + [char]27 + '[0m'); Write-Host ('      ' + [char]27 + '[38;2;130;205;255m' + [char]0x255A + [char]0x2550 + [char]0x2550 + [char]0x2550 + [char]0x2550 + [char]0x2550 + [char]0x2550 + [char]0x2550 + [char]0x2550 + [char]0x2550 + [char]0x255D + [char]27 + '[38;2;110;195;255m' + [char]0x2591 + [char]0x2591 + [char]0x2591 + [char]0x2591 + [char]0x2591 + [char]27 + '[38;2;90;185;255m' + [char]0x255A + [char]0x2550 + [char]0x2550 + [char]0x2550 + [char]0x2550 + [char]0x2550 + [char]0x2550 + [char]0x2550 + [char]0x2550 + [char]0x2550 + [char]0x255D + [char]27 + '[38;2;70;175;255m' + [char]0x2591 + [char]0x2591 + [char]0x2591 + [char]0x2591 + [char]0x2591 + [char]27 + '[38;2;50;165;255m' + [char]0x255A + [char]0x2550 + [char]0x2550 + [char]0x2550 + [char]0x2550 + [char]0x2550 + [char]0x2550 + [char]0x2550 + [char]0x2550 + [char]0x255D + [char]27 + '[0m')"
ECHO.
powershell -NoProfile -ExecutionPolicy Bypass -Command "Write-Host ([char]0x2554 + ([char]0x2550).ToString() * 77) -ForegroundColor Cyan; Write-Host ([char]0x2551 + '%TITLE_TEXT%') -ForegroundColor White -BackgroundColor DarkBlue; Write-Host ([char]0x2551 + ' Location (Vi tri): %SCRIPT_DIR%                                             ') -ForegroundColor Gray; Write-Host ([char]0x2551 + ' Project Folder (Thu muc Du an): %PROJECT_FOLDER_NAME%                       ') -ForegroundColor Gray; Write-Host ([char]0x255A + ([char]0x2550).ToString() * 77) -ForegroundColor Cyan; Write-Host 'Please choose an option (Vui long chon mot tuy chon):' -ForegroundColor Yellow"
ECHO.
powershell -NoProfile -ExecutionPolicy Bypass -Command "Write-Host 'INSTALLATION / SETUP (CAI DAT / THIET LAP):' -ForegroundColor Green -BackgroundColor Black; Write-Host '  1. Install OSG (Cai dat OSG)' -ForegroundColor White; Write-Host '     (Gemini AI + Video Rendering. Voice cloning & local transcription engines install on demand inside the app.)' -ForegroundColor Cyan; Write-Host '     (Engine nhan ban giong noi & nhan dang cai theo nhu cau trong ung dung.)' -ForegroundColor Cyan"
ECHO.
powershell -NoProfile -ExecutionPolicy Bypass -Command "Write-Host 'MAINTENANCE / USAGE (BAO TRI / SU DUNG):' -ForegroundColor Blue -BackgroundColor Black; Write-Host '  2. Update Application (Cap nhat Ung dung)' -ForegroundColor White; Write-Host '  3. Run OSG (Chay OSG)' -ForegroundColor White"
ECHO.
powershell -NoProfile -ExecutionPolicy Bypass -Command "Write-Host 'UNINSTALL (GO CAI DAT):' -ForegroundColor Red -BackgroundColor Black; Write-Host '  4. Uninstall Application (Go cai dat Ung dung)' -ForegroundColor White"
ECHO.
powershell -NoProfile -ExecutionPolicy Bypass -Command "Write-Host '  5. Exit (Thoat)' -ForegroundColor Gray; Write-Host (([char]0x2550).ToString() * 77) -ForegroundColor Cyan"
ECHO.
powershell -NoProfile -ExecutionPolicy Bypass -Command "Write-Host '%PROMPT_CHOICE%' -ForegroundColor Yellow -NoNewline"
SET "CHOICE="
SET /P "CHOICE="

:ProcessChoice
:: Validate input
IF NOT "%CHOICE%"=="" SET CHOICE=%CHOICE:~0,1%

:: Keep the install choice until prerequisite verification completes, allowing a
:: relaunched or interrupted setup to resume safely.
IF "%CHOICE%"=="1" (
    >"%LAST_CHOICE_FILE%" ECHO 1
)

IF "%CHOICE%"=="1" GOTO InstallNarration
IF "%CHOICE%"=="2" GOTO UpdateApp
IF "%CHOICE%"=="3" GOTO RunApp
IF "%CHOICE%"=="4" GOTO UninstallApp
IF "%CHOICE%"=="5" GOTO ExitScript

powershell -NoProfile -ExecutionPolicy Bypass -Command "Write-Host '[INFO] Invalid choice. Please try again (Lua chon khong hop le. Vui long thu lai).' -ForegroundColor Yellow"
TIMEOUT /T 2 /NOBREAK > NUL
:: Clear saved choice for invalid input
IF EXIST "%LAST_CHOICE_FILE%" DEL "%LAST_CHOICE_FILE%" >nul 2>&1
GOTO %MENU_LABEL%

REM ==============================================================================
:InstallNarration
ECHO.
powershell -NoProfile -ExecutionPolicy Bypass -Command "Write-Host ([char]0x2554 + ([char]0x2550).ToString() * 77 + [char]0x2557) -ForegroundColor Cyan; Write-Host ([char]0x2551 + '                            [SETUP] Install OSG                              ' + [char]0x2551) -ForegroundColor White -BackgroundColor DarkGreen; Write-Host ([char]0x255A + ([char]0x2550).ToString() * 77 + [char]0x255D) -ForegroundColor Cyan"
ECHO.

SET "INSTALL_TRANSACTION_ACTIVE="
SET "INSTALL_ERROR_STEP=checking prerequisites"
CALL :InstallPrerequisites
IF %ERRORLEVEL% NEQ 0 GOTO ErrorOccurred

:: Clear saved choice after successful prerequisite installation
IF EXIST "%LAST_CHOICE_FILE%" DEL "%LAST_CHOICE_FILE%" >nul 2>&1

SET "INSTALL_ERROR_STEP=preparing a safe installation"
CALL :PrepareInstallTransaction
IF %ERRORLEVEL% NEQ 0 GOTO ErrorOccurred

powershell -NoProfile -ExecutionPolicy Bypass -Command "Write-Host '[SETUP] Downloading application (Tai ung dung)...' -ForegroundColor Cyan"
SET "INSTALL_ERROR_STEP=downloading the application"
git clone %GIT_REPO_URL% "%STAGING_PATH%"
IF %ERRORLEVEL% NEQ 0 (
    powershell -NoProfile -ExecutionPolicy Bypass -Command "Write-Host '[ERROR] Application download failed. The current installation was not changed (Tai ung dung that bai. Ban cai dat hien tai khong bi thay doi).' -ForegroundColor Red"
    GOTO ErrorOccurred
)
powershell -NoProfile -ExecutionPolicy Bypass -Command "Write-Host '[OK] Application downloaded successfully (Tai ung dung thanh cong).' -ForegroundColor Green"

SET "INSTALL_ERROR_STEP=activating the downloaded application"
CALL :ActivateStagedInstall
IF %ERRORLEVEL% NEQ 0 GOTO ErrorOccurred

powershell -NoProfile -ExecutionPolicy Bypass -Command "Write-Host '[SETUP] Changing to project directory (Chuyen den thu muc du an)...' -ForegroundColor Cyan"
PUSHD "%PROJECT_PATH%"
IF %ERRORLEVEL% NEQ 0 (
    SET "INSTALL_ERROR_STEP=opening the project directory"
    GOTO ErrorOccurred
)

powershell -NoProfile -ExecutionPolicy Bypass -Command "Write-Host '[SETUP] Configuring npm workspaces for optimal performance (Cau hinh npm workspaces de hieu suat toi uu)...' -ForegroundColor Cyan"
CALL node setup-workspaces.js
IF %ERRORLEVEL% NEQ 0 (
    powershell -NoProfile -ExecutionPolicy Bypass -Command "Write-Host '[WARN] Workspace setup had issues, continuing with standard install (Cau hinh workspace gap van de, tiep tuc voi cai dat tieu chuan)...' -ForegroundColor Yellow"
)

powershell -NoProfile -ExecutionPolicy Bypass -Command "Write-Host '[SETUP] Installing dependencies... (takes long time) (Cai dat phu thuoc... mat thoi gian dai)' -ForegroundColor Cyan"
SET "INSTALL_ERROR_STEP=installing application dependencies"
CALL npm run install:all
IF %ERRORLEVEL% NEQ 0 (
    POPD
    GOTO ErrorOccurred
)

powershell -NoProfile -ExecutionPolicy Bypass -Command "Write-Host '[SETUP] Finalizing installation (Hoan thien cai dat)...' -ForegroundColor Cyan"
CALL npm run install:yt-dlp
IF %ERRORLEVEL% NEQ 0 (
    powershell -NoProfile -ExecutionPolicy Bypass -Command "Write-Host '[WARN] YouTube downloader installation had issues (Cai dat trinh tai YouTube gap van de).' -ForegroundColor Yellow"
    powershell -NoProfile -ExecutionPolicy Bypass -Command "Write-Host '[INFO] You can fix this later with ''npm run install:yt-dlp'' (Ban co the sua loi nay sau bang lenh ''npm run install:yt-dlp'').' -ForegroundColor Blue"
)

POPD
SET "INSTALL_ERROR_STEP=finalizing the installation"
CALL :CommitInstallTransaction
IF %ERRORLEVEL% NEQ 0 (
    powershell -NoProfile -ExecutionPolicy Bypass -Command "Write-Host '[WARN] OSG is installed, but the previous-version backup could not be removed (OSG da duoc cai dat, nhung khong the xoa ban sao luu cu).' -ForegroundColor Yellow"
)

ECHO.
powershell -NoProfile -ExecutionPolicy Bypass -Command "Write-Host '[OK] Installation completed successfully (Cai dat hoan tat thanh cong)!' -ForegroundColor Green"
powershell -NoProfile -ExecutionPolicy Bypass -Command "Write-Host '[START] Launching OSG. Voice cloning & transcription engines install on demand in Settings (Khoi chay OSG. Engine cai theo nhu cau trong Cai dat)...' -ForegroundColor Magenta"
powershell -NoProfile -ExecutionPolicy Bypass -Command "Write-Host '[INFO] Press Ctrl+C to stop the application (Nhan Ctrl+C de dung ung dung).' -ForegroundColor Blue"
ECHO.
PUSHD "%PROJECT_PATH%"
IF %ERRORLEVEL% NEQ 0 GOTO MainMenuVI
CALL npm run dev
POPD
GOTO %MENU_LABEL%

REM ==============================================================================
:UpdateApp
ECHO *** Option 2: Update Application ***
IF NOT EXIST "%PROJECT_PATH%\.git" (
    ECHO ERROR: Project folder not found or not a git repository.
    ECHO Please use one of the Install options first.
    PAUSE
    GOTO MainMenuVI
)

ECHO Changing directory to "%PROJECT_PATH%"
PUSHD "%PROJECT_PATH%"
IF %ERRORLEVEL% NEQ 0 (
    ECHO ERROR: Failed to change directory to project folder.
    PAUSE
    GOTO MainMenuVI
)

ECHO Pulling latest changes from repository...
git reset --hard origin/main
git pull
uv pip install --python .venv --upgrade yt-dlp
IF %ERRORLEVEL% NEQ 0 (
    ECHO ERROR: Failed to pull updates. Check messages above.
    POPD
    PAUSE
    GOTO MainMenuVI
)
ECHO Update check completed.
POPD

ECHO.
ECHO Changing directory to "%PROJECT_PATH%"
PUSHD "%PROJECT_PATH%"
IF %ERRORLEVEL% NEQ 0 (
    ECHO ERROR: Failed to change directory for npm install.
    PAUSE
    GOTO MainMenuVI
)
ECHO Configuring npm workspaces...
CALL node setup-workspaces.js
ECHO Running 'npm install'...
CALL npm install
 IF %ERRORLEVEL% NEQ 0 (
    ECHO WARNING: 'npm install' encountered errors. Check messages above.
) ELSE (
    ECHO 'npm install' completed.
)
POPD

PAUSE
GOTO MainMenuVI

REM ==============================================================================
:RunApp
ECHO *** Option 3: Run Application ***
IF NOT EXIST "%PROJECT_PATH%\package.json" (
    ECHO ERROR: Project folder or package.json not found.
    ECHO Please use one of the Install options first.
    PAUSE
    GOTO MainMenuVI
)

ECHO Changing directory to "%PROJECT_PATH%"
PUSHD "%PROJECT_PATH%"
IF %ERRORLEVEL% NEQ 0 (
    ECHO ERROR: Failed to change directory to project folder.
    PAUSE
    GOTO MainMenuVI
)

ECHO Starting application (using npm run dev)...
ECHO Press Ctrl+C in this window to stop the application later.
CALL npm run dev
IF %ERRORLEVEL% NEQ 0 (
    ECHO ERROR: Failed to start application. Check messages above.
    POPD
    PAUSE
    GOTO MainMenuVI
)
POPD
PAUSE
GOTO MainMenuVI

REM ==============================================================================
:UninstallApp
ECHO *** Option 4: Uninstall Application ***
IF NOT EXIST "%PROJECT_PATH%" IF NOT EXIST "%STAGING_PATH%" IF NOT EXIST "%BACKUP_PATH%" (
    ECHO INFO: Project folder not found.
    ECHO Application may not be installed.
    PAUSE
    GOTO MainMenuVI
)

ECHO WARNING: This will permanently delete the application and installer recovery folders:
ECHO %PROJECT_PATH%
IF EXIST "%STAGING_PATH%" ECHO %STAGING_PATH%
IF EXIST "%BACKUP_PATH%" ECHO %BACKUP_PATH%
ECHO.
SET "CONFIRM_UNINSTALL="
SET /P "CONFIRM_UNINSTALL=Continue? (c/k): "
IF /I NOT "%CONFIRM_UNINSTALL%"=="c" (
    ECHO Uninstall cancelled.
    PAUSE
    GOTO MainMenuVI
)

ECHO Deleting application folders...
CALL :RemoveFolderIfExists "%PROJECT_PATH%"
IF ERRORLEVEL 1 GOTO UninstallFailed
CALL :RemoveFolderIfExists "%STAGING_PATH%"
IF ERRORLEVEL 1 GOTO UninstallFailed
CALL :RemoveFolderIfExists "%BACKUP_PATH%"
IF ERRORLEVEL 1 GOTO UninstallFailed

ECHO Uninstall completed. Application folders have been deleted.
PAUSE
GOTO MainMenuVI

:UninstallFailed
    ECHO ERROR: Cannot delete one or more application folders.
    ECHO Check permissions or if files are in use.
    PAUSE
    GOTO MainMenuVI

REM ==============================================================================
:: Subroutine: Install Prerequisites (Git, Node, FFmpeg, uv)
:InstallPrerequisites
ECHO.
powershell -NoProfile -ExecutionPolicy Bypass -Command "Write-Host '--- Checking System Requirements ---' -ForegroundColor White -BackgroundColor DarkMagenta"

:: v2.2-v2.5 used this flag to skip verification after a restart. Never trust it.
IF EXIST "%LEGACY_PREREQ_FLAG_FILE%" DEL "%LEGACY_PREREQ_FLAG_FILE%" >nul 2>&1

powershell -NoProfile -ExecutionPolicy Bypass -Command "Write-Host '[SETUP] Refreshing environment variables before checking tools (Cap nhat bien moi truong truoc khi kiem tra cong cu)...' -ForegroundColor Cyan"
CALL :RefreshEnvironment
IF %ERRORLEVEL% NEQ 0 (
    powershell -NoProfile -ExecutionPolicy Bypass -Command "Write-Host '[WARN] Environment refresh had issues; direct tool checks will still run (Cap nhat moi truong gap su co; van tiep tuc kiem tra truc tiep).' -ForegroundColor Yellow"
)

CALL :DetectMissingTools
IF NOT DEFINED MISSING_TOOLS GOTO PrerequisitesVerified

ECHO.
powershell -NoProfile -ExecutionPolicy Bypass -Command "Write-Host '[INSTALL] The following are missing and will be installed:!MISSING_TOOLS!' -ForegroundColor Cyan"
ECHO.

SET "INSTALL_FAILURES="
CALL :InstallTool "Git"
CALL :InstallTool "Node.js"
CALL :InstallTool "FFmpeg"
CALL :InstallTool "uv"

ECHO.
powershell -NoProfile -ExecutionPolicy Bypass -Command "Write-Host '[VERIFY] Refreshing the environment and verifying every prerequisite (Cap nhat moi truong va xac minh tung cong cu)...' -ForegroundColor Cyan"
CALL :RefreshEnvironment
CALL :DetectMissingTools

IF DEFINED MISSING_TOOLS (
    powershell -NoProfile -ExecutionPolicy Bypass -Command "Write-Host '[ERROR] Prerequisite verification failed. Still unavailable:!MISSING_TOOLS!' -ForegroundColor Red"
    IF DEFINED INSTALL_FAILURES powershell -NoProfile -ExecutionPolicy Bypass -Command "Write-Host '[ERROR] Installer commands also reported failures for:!INSTALL_FAILURES!' -ForegroundColor Red"
    powershell -NoProfile -ExecutionPolicy Bypass -Command "Write-Host '[INFO] OSG installation has stopped before changing the current project folder (Da dung cai dat OSG truoc khi thay doi thu muc du an hien tai).' -ForegroundColor Blue"
    EXIT /B 1
)

IF DEFINED INSTALL_FAILURES powershell -NoProfile -ExecutionPolicy Bypass -Command "Write-Host '[WARN] Some installer commands returned errors, but all tools passed final verification:!INSTALL_FAILURES!' -ForegroundColor Yellow"

:PrerequisitesVerified
powershell -NoProfile -ExecutionPolicy Bypass -Command "Write-Host '[OK] All prerequisites are present.' -ForegroundColor Green"

powershell -NoProfile -ExecutionPolicy Bypass -Command "Write-Host '[SETUP] Finalizing PowerShell configuration...' -ForegroundColor Cyan"
powershell -NoProfile -Command "Set-ExecutionPolicy -ExecutionPolicy RemoteSigned -Scope CurrentUser -Force" > nul

powershell -NoProfile -ExecutionPolicy Bypass -Command "Write-Host '[SETUP] Optimizing Windows for GPU acceleration...' -ForegroundColor Cyan"
CALL :EnableGpuScheduling

ECHO.
powershell -NoProfile -ExecutionPolicy Bypass -Command "Write-Host '[OK] System requirements check completed.' -ForegroundColor Green"
ECHO.
EXIT /B 0
:: End of InstallPrerequisites Subroutine

REM ==============================================================================
:: Detect every command needed by the installer. npm is verified with Node.js because
:: npm is required even when node.exe itself is available.
:DetectMissingTools
SET "MISSING_TOOLS="

powershell -NoProfile -ExecutionPolicy Bypass -Command "Write-Host '[?] Checking for Git...' -ForegroundColor Yellow"
git --version >nul 2>&1
IF ERRORLEVEL 1 SET "MISSING_TOOLS=%MISSING_TOOLS% Git"

SET "NODE_TOOL_MISSING="
powershell -NoProfile -ExecutionPolicy Bypass -Command "Write-Host '[?] Checking for Node.js and npm...' -ForegroundColor Yellow"
node --version >nul 2>&1
IF ERRORLEVEL 1 SET "NODE_TOOL_MISSING=1"
CALL npm --version >nul 2>&1
IF ERRORLEVEL 1 SET "NODE_TOOL_MISSING=1"
IF DEFINED NODE_TOOL_MISSING SET "MISSING_TOOLS=%MISSING_TOOLS% Node.js"

powershell -NoProfile -ExecutionPolicy Bypass -Command "Write-Host '[?] Checking for FFmpeg...' -ForegroundColor Yellow"
ffmpeg -version >nul 2>&1
IF ERRORLEVEL 1 SET "MISSING_TOOLS=%MISSING_TOOLS% FFmpeg"

powershell -NoProfile -ExecutionPolicy Bypass -Command "Write-Host '[?] Checking for uv...' -ForegroundColor Yellow"
uv --version >nul 2>&1
IF ERRORLEVEL 1 SET "MISSING_TOOLS=%MISSING_TOOLS% uv"

EXIT /B 0
:: End of DetectMissingTools Subroutine

REM ==============================================================================
:: Prepare a sibling staging folder without touching the current installation.
:PrepareInstallTransaction
powershell -NoProfile -ExecutionPolicy Bypass -Command "Write-Host '[SETUP] Preparing a failure-safe installation (Chuan bi cai dat an toan khi co loi)...' -ForegroundColor Cyan"

IF EXIST "%BACKUP_PATH%" (
    IF EXIST "%PROJECT_PATH%" (
        powershell -NoProfile -ExecutionPolicy Bypass -Command "Write-Host '[ERROR] Both the project and its recovery backup exist. Refusing to overwrite either folder (Ca thu muc du an va ban sao luu deu ton tai. Khong ghi de).' -ForegroundColor Red"
        powershell -NoProfile -ExecutionPolicy Bypass -Command "Write-Host '[INFO] Backup folder: %BACKUP_PATH%' -ForegroundColor Blue"
        EXIT /B 1
    )
    powershell -NoProfile -ExecutionPolicy Bypass -Command "Write-Host '[RECOVERY] Restoring the previous installation before continuing (Khoi phuc ban cai dat truoc khi tiep tuc)...' -ForegroundColor Yellow"
    MOVE /Y "%BACKUP_PATH%" "%PROJECT_PATH%" >nul
    IF ERRORLEVEL 1 (
        powershell -NoProfile -ExecutionPolicy Bypass -Command "Write-Host '[ERROR] Could not restore the previous installation (Khong the khoi phuc ban cai dat truoc).' -ForegroundColor Red"
        EXIT /B 1
    )
)

CALL :RemoveFolderIfExists "%STAGING_PATH%"
IF ERRORLEVEL 1 EXIT /B 1
EXIT /B 0
:: End of PrepareInstallTransaction Subroutine

REM ==============================================================================
:: Swap the successfully cloned staging tree into place while keeping the old tree.
:ActivateStagedInstall
IF NOT EXIST "%STAGING_PATH%\package.json" (
    powershell -NoProfile -ExecutionPolicy Bypass -Command "Write-Host '[ERROR] Downloaded staging folder is incomplete; package.json is missing (Thu muc tam khong day du; thieu package.json).' -ForegroundColor Red"
    EXIT /B 1
)

IF EXIST "%PROJECT_PATH%" (
    powershell -NoProfile -ExecutionPolicy Bypass -Command "Write-Host '[BACKUP] Preserving the current installation until setup succeeds (Giu lai ban cai dat hien tai den khi cai dat thanh cong)...' -ForegroundColor Yellow"
    MOVE /Y "%PROJECT_PATH%" "%BACKUP_PATH%" >nul
    IF ERRORLEVEL 1 (
        powershell -NoProfile -ExecutionPolicy Bypass -Command "Write-Host '[ERROR] Could not create the rollback backup (Khong the tao ban sao luu de khoi phuc).' -ForegroundColor Red"
        EXIT /B 1
    )
)

:: From this point forward, any failure must remove the new target and restore
:: the backup (when present), including a failure during the MOVE itself.
SET "INSTALL_TRANSACTION_ACTIVE=1"
MOVE /Y "%STAGING_PATH%" "%PROJECT_PATH%" >nul
IF ERRORLEVEL 1 (
    powershell -NoProfile -ExecutionPolicy Bypass -Command "Write-Host '[ERROR] Could not activate the downloaded application (Khong the kich hoat ung dung da tai).' -ForegroundColor Red"
    EXIT /B 1
)

EXIT /B 0
:: End of ActivateStagedInstall Subroutine

REM ==============================================================================
:CommitInstallTransaction
SET "INSTALL_TRANSACTION_ACTIVE="
CALL :RemoveFolderIfExists "%STAGING_PATH%"
IF ERRORLEVEL 1 EXIT /B 1
CALL :RemoveFolderIfExists "%BACKUP_PATH%"
IF ERRORLEVEL 1 EXIT /B 1
EXIT /B 0

REM ==============================================================================
:RollbackInstallTransaction
SET "ROLLBACK_FAILED="

IF DEFINED INSTALL_TRANSACTION_ACTIVE (
    powershell -NoProfile -ExecutionPolicy Bypass -Command "Write-Host '[ROLLBACK] Removing the incomplete installation (Xoa ban cai dat chua hoan tat)...' -ForegroundColor Yellow"
    CALL :RemoveFolderIfExists "%PROJECT_PATH%"
    IF ERRORLEVEL 1 SET "ROLLBACK_FAILED=1"

    IF NOT EXIST "%PROJECT_PATH%" IF EXIST "%BACKUP_PATH%" (
        powershell -NoProfile -ExecutionPolicy Bypass -Command "Write-Host '[ROLLBACK] Restoring the previous installation (Khoi phuc ban cai dat truoc)...' -ForegroundColor Yellow"
        MOVE /Y "%BACKUP_PATH%" "%PROJECT_PATH%" >nul
        IF ERRORLEVEL 1 SET "ROLLBACK_FAILED=1"
    )

    IF EXIST "%PROJECT_PATH%" IF EXIST "%BACKUP_PATH%" (
        powershell -NoProfile -ExecutionPolicy Bypass -Command "Write-Host '[WARNING] Rollback kept the recovery backup separate because the incomplete target could not be removed (Giu ban sao luu rieng vi khong the xoa thu muc loi).' -ForegroundColor Yellow"
        SET "ROLLBACK_FAILED=1"
    )
)

CALL :RemoveFolderIfExists "%STAGING_PATH%"
IF ERRORLEVEL 1 SET "ROLLBACK_FAILED=1"
SET "INSTALL_TRANSACTION_ACTIVE="

IF DEFINED ROLLBACK_FAILED EXIT /B 1
EXIT /B 0

REM ==============================================================================
:RemoveFolderIfExists
SET "FOLDER_TO_REMOVE=%~1"
IF NOT EXIST "%FOLDER_TO_REMOVE%" EXIT /B 0
RMDIR /S /Q "%FOLDER_TO_REMOVE%" >nul 2>&1
IF EXIST "%FOLDER_TO_REMOVE%" (
    powershell -NoProfile -ExecutionPolicy Bypass -Command "Write-Host '[ERROR] Could not remove folder: %FOLDER_TO_REMOVE%' -ForegroundColor Red"
    EXIT /B 1
)
EXIT /B 0

REM ==============================================================================
:ErrorOccurred
ECHO.
powershell -NoProfile -ExecutionPolicy Bypass -Command "Write-Host '[ERROR] Installation stopped while %INSTALL_ERROR_STEP% (Da dung cai dat khi %INSTALL_ERROR_STEP%).' -ForegroundColor Red"
CALL :RollbackInstallTransaction
SET "ROLLBACK_RESULT=%ERRORLEVEL%"
IF EXIST "%LAST_CHOICE_FILE%" DEL "%LAST_CHOICE_FILE%" >nul 2>&1
IF EXIST "%LEGACY_PREREQ_FLAG_FILE%" DEL "%LEGACY_PREREQ_FLAG_FILE%" >nul 2>&1
IF NOT "%ROLLBACK_RESULT%"=="0" (
    powershell -NoProfile -ExecutionPolicy Bypass -Command "Write-Host '[WARNING] Automatic cleanup/rollback was incomplete. Inspect recovery folders: %STAGING_PATH% and %BACKUP_PATH%' -ForegroundColor Yellow"
) ELSE (
    powershell -NoProfile -ExecutionPolicy Bypass -Command "Write-Host '[SAFE] No incomplete installation was kept. Any previous working installation was preserved (Khong giu ban cai dat loi. Ban cu dang hoat dong da duoc bao toan).' -ForegroundColor Green"
)
powershell -NoProfile -ExecutionPolicy Bypass -Command "Write-Host '[INFO] Review the error above, then choose Install again after correcting it (Xem loi phia tren, sau do chon Cai dat lai khi da sua).' -ForegroundColor Blue"
PAUSE
GOTO %MENU_LABEL%

REM ==============================================================================
:: Subroutine: Enable Windows GPU Scheduling for optimal video rendering performance
:EnableGpuScheduling
powershell -NoProfile -ExecutionPolicy Bypass -Command "Write-Host '[?] Checking Windows Hardware-accelerated GPU scheduling (Kiem tra lap lich GPU tang toc phan cung Windows)...' -ForegroundColor Yellow"

:: Check current GPU scheduling status
FOR /F "tokens=*" %%i IN ('powershell -NoProfile -ExecutionPolicy Bypass -Command "try { Get-ItemProperty -Path \"HKLM:\SYSTEM\CurrentControlSet\Control\GraphicsDrivers\" -Name HwSchMode -ErrorAction SilentlyContinue | Select-Object -ExpandProperty HwSchMode } catch { Write-Output \"0\" }"') DO SET GPU_SCHEDULING_STATUS=%%i

IF "%GPU_SCHEDULING_STATUS%"=="2" (
    powershell -NoProfile -ExecutionPolicy Bypass -Command "Write-Host '[OK] Windows Hardware-accelerated GPU scheduling is already enabled (Lap lich GPU tang toc phan cung Windows da duoc bat).' -ForegroundColor Green"
    powershell -NoProfile -ExecutionPolicy Bypass -Command "Write-Host '[INFO] This will provide optimal GPU acceleration for video rendering (Dieu nay se cung cap gia toc GPU toi uu cho render video).' -ForegroundColor Blue"
    EXIT /B 0
)

IF "%GPU_SCHEDULING_STATUS%"=="1" (
    powershell -NoProfile -ExecutionPolicy Bypass -Command "Write-Host '[WARN] Windows Hardware-accelerated GPU scheduling is disabled (Lap lich GPU tang toc phan cung Windows bi vo hieu hoa).' -ForegroundColor Yellow"
) ELSE (
    powershell -NoProfile -ExecutionPolicy Bypass -Command "Write-Host '[WARN] Windows GPU scheduling status unknown - attempting to enable (Trang thai lap lich GPU Windows khong ro - dang thu bat).' -ForegroundColor Yellow"
)

powershell -NoProfile -ExecutionPolicy Bypass -Command "Write-Host '[SETUP] Enabling Windows Hardware-accelerated GPU scheduling (Bat lap lich GPU tang toc phan cung Windows)...' -ForegroundColor Cyan"
powershell -NoProfile -ExecutionPolicy Bypass -Command "Write-Host '[INFO] This will significantly improve video rendering performance (30-70%% faster) (Dieu nay se cai thien dang ke hieu suat render video (nhanh hon 30-70%%)).' -ForegroundColor Blue"

:: Enable GPU scheduling
powershell -NoProfile -ExecutionPolicy Bypass -Command "try { Set-ItemProperty -Path \"HKLM:\SYSTEM\CurrentControlSet\Control\GraphicsDrivers\" -Name HwSchMode -Value 2; Write-Host '[OK] Windows Hardware-accelerated GPU scheduling enabled successfully (Bat lap lich GPU tang toc phan cung Windows thanh cong).' -ForegroundColor Green } catch { Write-Host '[ERROR] Failed to enable GPU scheduling. You may need to enable it manually (Khong the bat lap lich GPU. Ban co the can bat thu cong).' -ForegroundColor Red; Write-Host '[INFO] Manual steps: Windows Settings > System > Display > Graphics settings > Enable Hardware-accelerated GPU scheduling (Cac buoc thu cong: Cai dat Windows > He thong > Hien thi > Cai dat do hoa > Bat lap lich GPU tang toc phan cung)' -ForegroundColor Blue }"

powershell -NoProfile -ExecutionPolicy Bypass -Command "Write-Host '[IMPORTANT] RESTART REQUIRED: Please restart your computer for GPU acceleration to take effect (CAN KHOI DONG LAI: Vui long khoi dong lai may tinh de gia toc GPU co hieu luc).' -ForegroundColor Magenta"
powershell -NoProfile -ExecutionPolicy Bypass -Command "Write-Host '[INFO] After restart, video rendering will be significantly faster (Sau khi khoi dong lai, render video se nhanh hon dang ke)!' -ForegroundColor Blue"

EXIT /B 0
:: End of EnableGpuScheduling Subroutine

REM ==============================================================================
:: Subroutine: Refresh Environment Variables
:RefreshEnvironment
powershell -NoProfile -ExecutionPolicy Bypass -Command "Write-Host '[SETUP] Refreshing environment variables (Cap nhat bien moi truong)...' -ForegroundColor Cyan"

:: Initialize variables
SET "SystemPATH="
SET "UserPATH="

:: Use PowerShell to safely read PATH from registry (avoids FOR loop issues)
:: Create temp files for PowerShell output
SET "TEMP_SYSTEM_PATH=%TEMP%\osg_system_path.txt"
SET "TEMP_USER_PATH=%TEMP%\osg_user_path.txt"

:: Use PowerShell to read system PATH
powershell -NoProfile -ExecutionPolicy Bypass -Command "try { $systemPath = [Microsoft.Win32.Registry]::LocalMachine.OpenSubKey('SYSTEM\CurrentControlSet\Control\Session Manager\Environment').GetValue('PATH', ''); Write-Output $systemPath } catch { Write-Output '' }" > "%TEMP_SYSTEM_PATH%" 2>nul

:: Use PowerShell to read user PATH
powershell -NoProfile -ExecutionPolicy Bypass -Command "try { $userPath = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment').GetValue('PATH', ''); Write-Output $userPath } catch { Write-Output '' }" > "%TEMP_USER_PATH%" 2>nul

:: Read system PATH from temp file
IF EXIST "%TEMP_SYSTEM_PATH%" (
    FOR /F "usebackq delims=" %%A IN ("%TEMP_SYSTEM_PATH%") DO IF NOT DEFINED SystemPATH SET "SystemPATH=%%A"
    DEL "%TEMP_SYSTEM_PATH%" >nul 2>&1
)

:: Read user PATH from temp file
IF EXIST "%TEMP_USER_PATH%" (
    FOR /F "usebackq delims=" %%A IN ("%TEMP_USER_PATH%") DO IF NOT DEFINED UserPATH SET "UserPATH=%%A"
    DEL "%TEMP_USER_PATH%" >nul 2>&1
)

:: Fallback if PowerShell method failed
IF NOT DEFINED SystemPATH (
    powershell -NoProfile -ExecutionPolicy Bypass -Command "Write-Host '[WARNING] Could not read system PATH from registry, using current PATH (Khong doc duoc system PATH, dung PATH hien tai)' -ForegroundColor Yellow"
    SET "SystemPATH=%PATH%"
)

:: Combine paths safely
IF DEFINED UserPATH (
    IF DEFINED SystemPATH (
        SET "PATH=%SystemPATH%;%UserPATH%"
    ) ELSE (
        SET "PATH=%UserPATH%"
    )
) ELSE (
    IF DEFINED SystemPATH (
        SET "PATH=%SystemPATH%"
    ) ELSE (
        powershell -NoProfile -ExecutionPolicy Bypass -Command "Write-Host '[WARNING] No PATH variables found, keeping current PATH (Khong tim thay PATH, giu PATH hien tai)' -ForegroundColor Yellow"
    )
)

powershell -NoProfile -ExecutionPolicy Bypass -Command "Write-Host '[OK] Environment variables refreshed (Bien moi truong da duoc cap nhat).' -ForegroundColor Green"
EXIT /B 0
:: End of RefreshEnvironment Subroutine

REM ==============================================================================
:: Subroutine: Install a single tool if it's in the MISSING_TOOLS list
:InstallTool
SET "TOOL_NAME=%~1"
ECHO "!MISSING_TOOLS!" | FINDSTR /I /C:"%TOOL_NAME%" > NUL
IF ERRORLEVEL 1 EXIT /B 0

SET "TOOL_INSTALL_EXIT=0"

IF /I "%TOOL_NAME%"=="Git" (
    powershell -NoProfile -ExecutionPolicy Bypass -Command "Write-Host '[SETUP] Installing Git...' -ForegroundColor Cyan"
    winget install --id Git.Git -e --source winget --accept-package-agreements --accept-source-agreements
    SET "TOOL_INSTALL_EXIT=!ERRORLEVEL!"
)
IF /I "%TOOL_NAME%"=="Node.js" (
    powershell -NoProfile -ExecutionPolicy Bypass -Command "Write-Host '[SETUP] Installing Node.js...' -ForegroundColor Cyan"
    winget install --id OpenJS.NodeJS.LTS --exact --accept-package-agreements --accept-source-agreements -s winget
    SET "TOOL_INSTALL_EXIT=!ERRORLEVEL!"
)
IF /I "%TOOL_NAME%"=="FFmpeg" (
    powershell -NoProfile -ExecutionPolicy Bypass -Command "Write-Host '[SETUP] Installing FFmpeg...' -ForegroundColor Cyan"
    winget install --id Gyan.FFmpeg --accept-package-agreements --accept-source-agreements -s winget
    SET "TOOL_INSTALL_EXIT=!ERRORLEVEL!"
)
IF /I "%TOOL_NAME%"=="uv" (
    powershell -NoProfile -ExecutionPolicy Bypass -Command "Write-Host '[SETUP] Installing uv...' -ForegroundColor Cyan"
    powershell -NoProfile -ExecutionPolicy Bypass -Command "irm https://astral.sh/uv/install.ps1 | iex"
    SET "TOOL_INSTALL_EXIT=!ERRORLEVEL!"
)

IF NOT "!TOOL_INSTALL_EXIT!"=="0" (
    SET "INSTALL_FAILURES=!INSTALL_FAILURES! %TOOL_NAME%"
    powershell -NoProfile -ExecutionPolicy Bypass -Command "Write-Host '[ERROR] Installer command failed for %TOOL_NAME% with exit code !TOOL_INSTALL_EXIT!.' -ForegroundColor Red"
    EXIT /B 1
)

EXIT /B 0
REM End of InstallTool Subroutine

REM ==============================================================================
:ExitScript
:: Clear saved choice and the unsafe flag left by v2.2-v2.5 installers.
IF EXIST "%LAST_CHOICE_FILE%" DEL "%LAST_CHOICE_FILE%" >nul 2>&1
IF EXIST "%LEGACY_PREREQ_FLAG_FILE%" DEL "%LEGACY_PREREQ_FLAG_FILE%" >nul 2>&1
EXIT /B 0
