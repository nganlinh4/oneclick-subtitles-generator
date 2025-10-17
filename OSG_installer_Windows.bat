@ECHO OFF
SETLOCAL EnableDelayedExpansion
CLS

:: --- Configuration ---
SET "PROJECT_FOLDER_NAME=oneclick-subtitles-generator"
SET "GIT_REPO_URL=https://github.com/nganlinh4/oneclick-subtitles-generator.git"
SET "SCRIPT_DIR=%~dp0"
SET "PROJECT_PATH=%SCRIPT_DIR%%PROJECT_FOLDER_NAME%"
IF "%PROJECT_PATH:~-1%"=="\" SET "PROJECT_PATH=%PROJECT_PATH:~0,-1%"
SET "LAST_CHOICE_FILE=%SCRIPT_DIR%last_choice.tmp"
SET "PREREQ_FLAG_FILE=%SCRIPT_DIR%prereqs_installed.flag"

:: --- Fixed Settings (Bilingual Menu) ---
SET "MENU_LABEL=MainMenuVI"
SET "PROMPT_CHOICE=Enter your choice (Nhap lua chon cua ban) (1-7): "
SET "TITLE_TEXT=OneClick Subtitle Generator Manager (Quan Ly Trinh Tao Phu De OneClick)"

TITLE %TITLE_TEXT%

:: --- Check for Administrator Privileges ---
powershell -NoProfile -ExecutionPolicy Bypass -Command "Write-Host '[?] Checking administrator privileges (Kiem tra quyen quan tri)...' -ForegroundColor Yellow; if (-NOT ([Security.Principal.WindowsPrincipal] [Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole] 'Administrator')) { Write-Host ''; Write-Host '[ERROR] Administrator privileges required (Can quyen quan tri).' -ForegroundColor Red; Write-Host '[INFO] Requesting administrator privileges (Yeu cau quyen quan tri)...' -ForegroundColor Blue; Write-Host ''; Start-Process '%~f0' -Verb RunAs; exit 1 } else { Write-Host '[OK] Administrator privileges confirmed (Da xac nhan quyen quan tri).' -ForegroundColor Green; Write-Host '' }"
IF %ERRORLEVEL% NEQ 0 EXIT /B

:: Check if we have a saved choice from previous error
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
        powershell -NoProfile -ExecutionPolicy Bypass -Command "Write-Host '[AUTO-RESTART] Using previous choice (Su dung lua chon truoc): !CHOICE!' -ForegroundColor Magenta"
        ECHO.
        GOTO ProcessChoice
    ) ELSE (
        powershell -NoProfile -ExecutionPolicy Bypass -Command "Write-Host '[WARN] Invalid saved choice detected. Showing menu (Phat hien lua chon khong hop le. Hien thi menu)...' -ForegroundColor Yellow"
    )
)

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
powershell -NoProfile -ExecutionPolicy Bypass -Command "Write-Host 'INSTALLATION / SETUP (CAI DAT / THIET LAP):' -ForegroundColor Green -BackgroundColor Black; Write-Host '  1. Install OSG (Full version with Voice Cloning) (Cai dat OSG (Phien ban day du voi Nhan ban giong noi))' -ForegroundColor White; Write-Host '     (Gemini AI + F5-TTS + Chatterbox + Video Rendering)' -ForegroundColor Cyan; Write-Host '     (Note: Will use more storage space) (Luu y: Se ton nhieu dung luong luu tru hon)' -ForegroundColor Yellow; Write-Host '  2. Install OSG Lite (Standard version) (Cai dat OSG Lite (Phien ban tieu chuan))' -ForegroundColor White; Write-Host '     (Gemini AI + Video Rendering, no Voice Cloning) (Gemini AI + Render Video, khong co Nhan ban giong noi)' -ForegroundColor Cyan"
ECHO.
powershell -NoProfile -ExecutionPolicy Bypass -Command "Write-Host 'MAINTENANCE / USAGE (BAO TRI / SU DUNG):' -ForegroundColor Blue -BackgroundColor Black; Write-Host '  3. Update Application (Cap nhat Ung dung)' -ForegroundColor White; Write-Host '  4. Run OSG Lite (Standard mode) (Chay OSG Lite (Che do tieu chuan))' -ForegroundColor White; Write-Host '  5. Run OSG (Full mode with Voice Cloning) (Chay OSG (Che do day du voi Nhan ban giong noi))' -ForegroundColor White"
ECHO.
powershell -NoProfile -ExecutionPolicy Bypass -Command "Write-Host 'UNINSTALL (GO CAI DAT):' -ForegroundColor Red -BackgroundColor Black; Write-Host '  6. Uninstall Application (Go cai dat Ung dung)' -ForegroundColor White"
ECHO.
powershell -NoProfile -ExecutionPolicy Bypass -Command "Write-Host '  7. Exit (Thoat)' -ForegroundColor Gray; Write-Host (([char]0x2550).ToString() * 77) -ForegroundColor Cyan"
ECHO.
powershell -NoProfile -ExecutionPolicy Bypass -Command "Write-Host '%PROMPT_CHOICE%' -ForegroundColor Yellow -NoNewline"
SET /P "CHOICE="

:ProcessChoice
:: Validate input
IF NOT "%CHOICE%"=="" SET CHOICE=%CHOICE:~0,1%

:: Save choice before processing (for auto-restart on error - only for installation options)
IF "%CHOICE%"=="1" (ECHO 1) >"%LAST_CHOICE_FILE%"
IF "%CHOICE%"=="2" (ECHO 2) >"%LAST_CHOICE_FILE%"

IF "%CHOICE%"=="1" GOTO InstallNarration
IF "%CHOICE%"=="2" GOTO InstallNoNarration
IF "%CHOICE%"=="3" GOTO UpdateApp
IF "%CHOICE%"=="4" GOTO RunApp
IF "%CHOICE%"=="5" GOTO RunAppCUDA
IF "%CHOICE%"=="6" GOTO UninstallApp
IF "%CHOICE%"=="7" GOTO ExitScript

powershell -NoProfile -ExecutionPolicy Bypass -Command "Write-Host '[INFO] Invalid choice. Please try again (Lua chon khong hop le. Vui long thu lai).' -ForegroundColor Yellow"
TIMEOUT /T 2 /NOBREAK > NUL
:: Clear saved choice for invalid input
IF EXIST "%LAST_CHOICE_FILE%" DEL "%LAST_CHOICE_FILE%" >nul 2>&1
GOTO %MENU_LABEL%

REM ==============================================================================
:InstallNarration
ECHO.
powershell -NoProfile -ExecutionPolicy Bypass -Command "Write-Host ([char]0x2554 + ([char]0x2550).ToString() * 77 + [char]0x2557) -ForegroundColor Cyan; Write-Host ([char]0x2551 + '                   [SETUP] Install OSG (Full Version)                        ' + [char]0x2551) -ForegroundColor White -BackgroundColor DarkGreen; Write-Host ([char]0x2551 + '                        with Voice Cloning                                   ' + [char]0x2551) -ForegroundColor White -BackgroundColor DarkGreen; Write-Host ([char]0x255A + ([char]0x2550).ToString() * 77 + [char]0x255D) -ForegroundColor Cyan"
ECHO.

CALL :InstallPrerequisites
IF %ERRORLEVEL% NEQ 0 GOTO ErrorOccurred

:: Clear saved choice after successful prerequisite installation
IF EXIST "%LAST_CHOICE_FILE%" DEL "%LAST_CHOICE_FILE%" >nul 2>&1

CALL :CleanInstall "%PROJECT_PATH%"
IF %ERRORLEVEL% NEQ 0 GOTO ErrorOccurred

powershell -NoProfile -ExecutionPolicy Bypass -Command "Write-Host '[SETUP] Downloading application (Tai ung dung)...' -ForegroundColor Cyan"
git clone %GIT_REPO_URL% "%PROJECT_PATH%" >nul 2>&1
IF %ERRORLEVEL% NEQ 0 (
    powershell -NoProfile -ExecutionPolicy Bypass -Command "Write-Host '[RESTART] Restarting to refresh environment (Khoi dong lai de cap nhat moi truong)...' -ForegroundColor Blue"
    GOTO ErrorOccurred
)
powershell -NoProfile -ExecutionPolicy Bypass -Command "Write-Host '[OK] Application downloaded successfully (Tai ung dung thanh cong).' -ForegroundColor Green"

powershell -NoProfile -ExecutionPolicy Bypass -Command "Write-Host '[SETUP] Changing to project directory (Chuyen den thu muc du an)...' -ForegroundColor Cyan"
PUSHD "%PROJECT_PATH%"
IF %ERRORLEVEL% NEQ 0 (
    powershell -NoProfile -ExecutionPolicy Bypass -Command "Write-Host '[RESTART] Restarting to refresh environment (Khoi dong lai de cap nhat moi truong)...' -ForegroundColor Blue"
    POPD
    GOTO ErrorOccurred
)

powershell -NoProfile -ExecutionPolicy Bypass -Command "Write-Host '[SETUP] Configuring npm workspaces for optimal performance (Cau hinh npm workspaces de hieu suat toi uu)...' -ForegroundColor Cyan"
CALL node setup-workspaces.js
IF %ERRORLEVEL% NEQ 0 (
    powershell -NoProfile -ExecutionPolicy Bypass -Command "Write-Host '[WARN] Workspace setup had issues, continuing with standard install (Cau hinh workspace gap van de, tiep tuc voi cai dat tieu chuan)...' -ForegroundColor Yellow"
)

powershell -NoProfile -ExecutionPolicy Bypass -Command "Write-Host '[SETUP] Installing dependencies... (takes long time) (Cai dat phu thuoc... mat thoi gian dai)' -ForegroundColor Cyan"
CALL npm run install:all
IF %ERRORLEVEL% NEQ 0 (
    powershell -NoProfile -ExecutionPolicy Bypass -Command "Write-Host '[RESTART] Restarting to refresh environment (Khoi dong lai de cap nhat moi truong)...' -ForegroundColor Blue"
    POPD
    GOTO ErrorOccurred
)

powershell -NoProfile -ExecutionPolicy Bypass -Command "Write-Host '[SETUP] Finalizing installation (Hoan thien cai dat)...' -ForegroundColor Cyan"
CALL npm run install:yt-dlp
IF %ERRORLEVEL% NEQ 0 (
    powershell -NoProfile -ExecutionPolicy Bypass -Command "Write-Host '[WARN] YouTube downloader installation had issues (Cai dat trinh tai YouTube gap van de).' -ForegroundColor Yellow"
    powershell -NoProfile -ExecutionPolicy Bypass -Command "Write-Host '[INFO] You can fix this later with ''npm run install:yt-dlp'' (Ban co the sua loi nay sau bang lenh ''npm run install:yt-dlp'').' -ForegroundColor Blue"
)

ECHO.
powershell -NoProfile -ExecutionPolicy Bypass -Command "Write-Host '[OK] Installation completed successfully (Cai dat hoan tat thanh cong)!' -ForegroundColor Green"
powershell -NoProfile -ExecutionPolicy Bypass -Command "Write-Host '[START] Launching application with voice cloning features (Khoi chay ung dung voi tinh nang nhan ban giong noi)...' -ForegroundColor Magenta"
powershell -NoProfile -ExecutionPolicy Bypass -Command "Write-Host '[INFO] Press Ctrl+C to stop the application (Nhan Ctrl+C de dung ung dung).' -ForegroundColor Blue"
ECHO.
CALL npm run dev:cuda
POPD
GOTO %MENU_LABEL%

REM ==============================================================================
:InstallNoNarration
ECHO.
powershell -NoProfile -ExecutionPolicy Bypass -Command "Write-Host ([char]0x2554 + ([char]0x2550).ToString() * 77 + [char]0x2557) -ForegroundColor Cyan; Write-Host ([char]0x2551 + '                    [SETUP] Install OSG Lite (Standard)                      ' + [char]0x2551) -ForegroundColor White -BackgroundColor DarkBlue; Write-Host ([char]0x255A + ([char]0x2550).ToString() * 77 + [char]0x255D) -ForegroundColor Cyan"
ECHO.

CALL :InstallPrerequisites
IF %ERRORLEVEL% NEQ 0 GOTO ErrorOccurred

:: Clear saved choice after successful prerequisite installation
IF EXIST "%LAST_CHOICE_FILE%" DEL "%LAST_CHOICE_FILE%" >nul 2>&1

CALL :CleanInstall "%PROJECT_PATH%"
IF %ERRORLEVEL% NEQ 0 GOTO ErrorOccurred

powershell -NoProfile -ExecutionPolicy Bypass -Command "Write-Host '[SETUP] Downloading application (Tai ung dung)...' -ForegroundColor Cyan"
git clone %GIT_REPO_URL% "%PROJECT_PATH%" >nul 2>&1
IF %ERRORLEVEL% NEQ 0 (
    powershell -NoProfile -ExecutionPolicy Bypass -Command "Write-Host '[RESTART] Restarting to refresh environment (Khoi dong lai de cap nhat moi truong)...' -ForegroundColor Blue"
    GOTO ErrorOccurred
)
powershell -NoProfile -ExecutionPolicy Bypass -Command "Write-Host '[OK] Application downloaded successfully (Tai ung dung thanh cong).' -ForegroundColor Green"

powershell -NoProfile -ExecutionPolicy Bypass -Command "Write-Host '[SETUP] Changing to project directory (Chuyen den thu muc du an)...' -ForegroundColor Cyan"
PUSHD "%PROJECT_PATH%"
IF %ERRORLEVEL% NEQ 0 (
    powershell -NoProfile -ExecutionPolicy Bypass -Command "Write-Host '[RESTART] Restarting to refresh environment (Khoi dong lai de cap nhat moi truong)...' -ForegroundColor Blue"
    POPD
    GOTO ErrorOccurred
)

powershell -NoProfile -ExecutionPolicy Bypass -Command "Write-Host '[SETUP] Configuring npm workspaces for optimal performance (Cau hinh npm workspaces de hieu suat toi uu)...' -ForegroundColor Cyan"
CALL node setup-workspaces.js
IF %ERRORLEVEL% NEQ 0 (
    powershell -NoProfile -ExecutionPolicy Bypass -Command "Write-Host '[WARN] Workspace setup had issues, continuing with standard install (Cau hinh workspace gap van de, tiep tuc voi cai dat tieu chuan)...' -ForegroundColor Yellow"
)

powershell -NoProfile -ExecutionPolicy Bypass -Command "Write-Host '[SETUP] Installing dependencies... (takes long time) (Cai dat phu thuoc... mat thoi gian dai)' -ForegroundColor Cyan"
CALL npm install
IF %ERRORLEVEL% NEQ 0 (
    powershell -NoProfile -ExecutionPolicy Bypass -Command "Write-Host '[RESTART] Restarting to refresh environment (Khoi dong lai de cap nhat moi truong)...' -ForegroundColor Blue"
    POPD
    GOTO ErrorOccurred
)

powershell -NoProfile -ExecutionPolicy Bypass -Command "Write-Host '[SETUP] Finalizing installation (Hoan thien cai dat)...' -ForegroundColor Cyan"
CALL npm run install:yt-dlp
IF %ERRORLEVEL% NEQ 0 (
    powershell -NoProfile -ExecutionPolicy Bypass -Command "Write-Host '[WARN] YouTube downloader installation had issues.' -ForegroundColor Yellow"
    powershell -NoProfile -ExecutionPolicy Bypass -Command "Write-Host '[INFO] You can fix this later with ''npm run install:yt-dlp''.' -ForegroundColor Blue"
)

ECHO.
powershell -NoProfile -ExecutionPolicy Bypass -Command "Write-Host '[OK] Installation completed successfully (Cai dat hoan tat thanh cong)!' -ForegroundColor Green"
powershell -NoProfile -ExecutionPolicy Bypass -Command "Write-Host '[START] Launching application (Khoi chay ung dung)...' -ForegroundColor Magenta"
powershell -NoProfile -ExecutionPolicy Bypass -Command "Write-Host '[INFO] Press Ctrl+C to stop the application (Nhan Ctrl+C de dung ung dung).' -ForegroundColor Blue"
ECHO.
CALL npm run dev
POPD
GOTO %MENU_LABEL%

REM ==============================================================================
:UpdateApp
ECHO *** Option 3: Update Application ***
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
ECHO *** Option 4: Run Application ***
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
:RunAppCUDA
ECHO *** Option 5: Run App with Voice Cloning ***
ECHO *** (F5-TTS + Chatterbox Narration) ***
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

ECHO Starting application with Voice Cloning (using npm run dev:cuda)...
ECHO Note: GPU will be used if available, otherwise will run on CPU.
ECHO Press Ctrl+C in this window to stop the application later.
CALL npm run dev:cuda
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
ECHO *** Option 6: Uninstall Application ***
IF NOT EXIST "%PROJECT_PATH%" (
    ECHO INFO: Project folder not found.
    ECHO Application may not be installed.
    PAUSE
    GOTO MainMenuVI
)

ECHO WARNING: This will permanently delete the project folder:
ECHO %PROJECT_PATH%
ECHO.
SET /P "CONFIRM_UNINSTALL=Continue? (c/k): "
IF /I NOT "%CONFIRM_UNINSTALL%"=="c" (
    ECHO Uninstall cancelled.
    PAUSE
    GOTO MainMenuVI
)

ECHO Deleting project folder: %PROJECT_PATH%...
RMDIR /S /Q "%PROJECT_PATH%"
IF %ERRORLEVEL% NEQ 0 (
    ECHO ERROR: Cannot delete project folder.
    ECHO Check permissions or if files are in use.
    PAUSE
    GOTO MainMenuVI
)

ECHO Uninstall completed. Project folder has been deleted.
PAUSE
GOTO MainMenuVI

REM ==============================================================================
:: Subroutine: Install Prerequisites (Git, Node, FFmpeg, uv)
:InstallPrerequisites
ECHO.
powershell -NoProfile -ExecutionPolicy Bypass -Command "Write-Host '--- Checking System Requirements ---' -ForegroundColor White -BackgroundColor DarkMagenta"

:: --- STATE CHECK: The Core of the Fix ---
IF EXIST "%PREREQ_FLAG_FILE%" (
    powershell -NoProfile -ExecutionPolicy Bypass -Command "Write-Host '[SKIP] Prerequisites were installed on the previous run. Continuing installation...' -ForegroundColor Blue"
    DEL "%PREREQ_FLAG_FILE%" >nul 2>&1
    GOTO PrerequisitesVerified
)

:: --- PHASE 1: DETECT MISSING TOOLS ---
SET "MISSING_TOOLS="

powershell -NoProfile -ExecutionPolicy Bypass -Command "Write-Host '[?] Checking for Git...' -ForegroundColor Yellow"
git --version >nul 2>&1
IF %ERRORLEVEL% NEQ 0 SET "MISSING_TOOLS=%MISSING_TOOLS% Git"

powershell -NoProfile -ExecutionPolicy Bypass -Command "Write-Host '[?] Checking for Node.js...' -ForegroundColor Yellow"
node --version >nul 2>&1
IF %ERRORLEVEL% NEQ 0 SET "MISSING_TOOLS=%MISSING_TOOLS% Node.js"

powershell -NoProfile -ExecutionPolicy Bypass -Command "Write-Host '[?] Checking for FFmpeg...' -ForegroundColor Yellow"
ffmpeg -version >nul 2>&1
IF %ERRORLEVEL% NEQ 0 SET "MISSING_TOOLS=%MISSING_TOOLS% FFmpeg"

powershell -NoProfile -ExecutionPolicy Bypass -Command "Write-Host '[?] Checking for uv...' -ForegroundColor Yellow"
uv --version >nul 2>&1
IF %ERRORLEVEL% NEQ 0 SET "MISSING_TOOLS=%MISSING_TOOLS% uv"

:: --- PHASE 2: INSTALL & RESTART (if needed) ---
IF NOT "%MISSING_TOOLS%"=="" (
    ECHO.
    powershell -NoProfile -ExecutionPolicy Bypass -Command "Write-Host '[INSTALL] The following are missing and will be installed:!MISSING_TOOLS!' -ForegroundColor Cyan"
    ECHO.

    :: Call the safe subroutine for each tool
    CALL :InstallTool "Git"
    CALL :InstallTool "Node.js"
    CALL :InstallTool "FFmpeg"
    CALL :InstallTool "uv"

    ECHO.
    powershell -NoProfile -ExecutionPolicy Bypass -Command "Write-Host '[IMPORTANT] Prerequisites installed.' -ForegroundColor Green"
    
    powershell -NoProfile -ExecutionPolicy Bypass -Command "Write-Host '[MEMORY] Creating a flag to skip this check on the next run...' -ForegroundColor Blue"
    ECHO 1 > "%PREREQ_FLAG_FILE%"

    powershell -NoProfile -ExecutionPolicy Bypass -Command "Write-Host '[RESTART REQUIRED] The script must restart to use the new software. This is normal.' -ForegroundColor Magenta"
    
    EXIT /B 1
)

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
:: Subroutine: Clean Install - Removes existing project folder (Modified: No Confirmation)
:CleanInstall
SET "FOLDER_TO_CLEAN=%~1"
powershell -NoProfile -ExecutionPolicy Bypass -Command "Write-Host '[?] Checking for existing installation (Kiem tra cai dat hien co): %FOLDER_TO_CLEAN%' -ForegroundColor Yellow"
IF EXIST "%FOLDER_TO_CLEAN%" (
    powershell -NoProfile -ExecutionPolicy Bypass -Command "Write-Host '[WARN] Found existing installation. Removing for clean install (Tim thay cai dat hien co. Xoa de cai dat sach)...' -ForegroundColor Yellow"
    powershell -NoProfile -ExecutionPolicy Bypass -Command "Write-Host '[SETUP] Removing existing project folder (Xoa thu muc du an hien co)...' -ForegroundColor Cyan"
    RMDIR /S /Q "%FOLDER_TO_CLEAN%" >nul 2>&1
    IF %ERRORLEVEL% NEQ 0 (
        powershell -NoProfile -ExecutionPolicy Bypass -Command "Write-Host '[RESTART] Restarting to refresh environment (Khoi dong lai de cap nhat moi truong)...' -ForegroundColor Blue"
        EXIT /B 1
    )
    powershell -NoProfile -ExecutionPolicy Bypass -Command "Write-Host '[OK] Existing installation removed successfully (Xoa cai dat hien co thanh cong).' -ForegroundColor Green"
) ELSE (
    powershell -NoProfile -ExecutionPolicy Bypass -Command "Write-Host '[OK] No existing installation found. Proceeding with fresh install (Khong tim thay cai dat hien co. Tien hanh cai dat moi).' -ForegroundColor Green"
)
EXIT /B 0
:: End of CleanInstall Subroutine

REM ==============================================================================
:ErrorOccurred
ECHO.
powershell -NoProfile -ExecutionPolicy Bypass -Command "Write-Host '[AUTO-RESTART] An installation step requires an environment refresh.' -ForegroundColor Magenta"
powershell -NoProfile -ExecutionPolicy Bypass -Command "Write-Host '[INFO] The script will now restart itself to continue the installation...' -ForegroundColor Blue"
TIMEOUT /T 3 /NOBREAK > NUL
powershell -NoProfile -ExecutionPolicy Bypass -Command "Start-Process -FilePath '%~f0' -WindowStyle Normal; exit"
EXIT

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
    SET /P SystemPATH=<"%TEMP_SYSTEM_PATH%"
    DEL "%TEMP_SYSTEM_PATH%" >nul 2>&1
)

:: Read user PATH from temp file
IF EXIST "%TEMP_USER_PATH%" (
    SET /P UserPATH=<"%TEMP_USER_PATH%"
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
IF %ERRORLEVEL% NEQ 0 GOTO :EOF

IF /I "%TOOL_NAME%"=="Git" (
    powershell -NoProfile -ExecutionPolicy Bypass -Command "Write-Host '[SETUP] Installing Git...' -ForegroundColor Cyan"
    winget install --id Git.Git -e --source winget
)
IF /I "%TOOL_NAME%"=="Node.js" (
    powershell -NoProfile -ExecutionPolicy Bypass -Command "Write-Host '[SETUP] Installing Node.js...' -ForegroundColor Cyan"
    winget install --id OpenJS.NodeJS.LTS --exact --accept-package-agreements --accept-source-agreements -s winget
)
IF /I "%TOOL_NAME%"=="FFmpeg" (
    powershell -NoProfile -ExecutionPolicy Bypass -Command "Write-Host '[SETUP] Installing FFmpeg...' -ForegroundColor Cyan"
    winget install --id Gyan.FFmpeg --accept-package-agreements --accept-source-agreements -s winget
)
IF /I "%TOOL_NAME%"=="uv" (
    powershell -NoProfile -ExecutionPolicy Bypass -Command "Write-Host '[SETUP] Installing uv...' -ForegroundColor Cyan"
    powershell -NoProfile -ExecutionPolicy Bypass -Command "irm https://astral.sh/uv/install.ps1 | iex"
)
GOTO :EOF
REM End of InstallTool Subroutine

REM ==============================================================================
:ExitScript
:: Clear saved choice and any flags on exit
IF EXIST "%LAST_CHOICE_FILE%" DEL "%LAST_CHOICE_FILE%" >nul 2>&1
IF EXIST "%PREREQ_FLAG_FILE%" DEL "%PREREQ_FLAG_FILE%" >nul 2>&1
EXIT /B 0