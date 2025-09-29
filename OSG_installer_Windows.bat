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

:: --- Fixed Settings (Bilingual Menu) ---
SET "MENU_LABEL=MainMenuVI"
SET "PROMPT_CHOICE=Enter your choice (Nhap lua chon cua ban) (1-7): "
SET "TITLE_TEXT=OneClick Subtitle Generator Manager (Quan Ly Trinh Tao Phu De OneClick)"

TITLE %TITLE_TEXT%

:: --- Check for Administrator Privileges ---
powershell -NoProfile -ExecutionPolicy Bypass -Command "Write-Host '[?] Checking administrator privileges (Kiem tra quyen quan tri)...' -ForegroundColor Yellow; if (-NOT ([Security.Principal.WindowsPrincipal] [Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole] 'Administrator')) { Write-Host ''; Write-Host ([char]0x2554 + ([char]0x2550).ToString() * 77 + [char]0x2557) -ForegroundColor Cyan; Write-Host ([char]0x2551 + '                    [ERROR] Administrator privileges required (Can quyen quan tri).               ' + [char]0x2551) -ForegroundColor Red; Write-Host ([char]0x2551 + '                   [INFO] Requesting administrator privileges (Yeu cau quyen quan tri)...             ' + [char]0x2551) -ForegroundColor Blue; Write-Host ([char]0x255A + ([char]0x2550).ToString() * 77 + [char]0x255D) -ForegroundColor Cyan; Start-Process '%~f0' -Verb RunAs; exit 1 } else { Write-Host '[OK] Administrator privileges confirmed (Da xac nhan quyen quan tri).' -ForegroundColor Green; Write-Host '' }"
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
SET /P "INSTALL_DEPS=Run 'npm install' now? (c/k): "
IF /I "%INSTALL_DEPS%"=="c" (
    ECHO Changing directory to "%PROJECT_PATH%"
    PUSHD "%PROJECT_PATH%"
    IF %ERRORLEVEL% NEQ 0 (
        ECHO ERROR: Failed to change directory for npm install.
        PAUSE
        GOTO MainMenuVI
    )
    ECHO Running 'npm install'...
    CALL npm install
     IF %ERRORLEVEL% NEQ 0 (
        ECHO WARNING: 'npm install' encountered errors. Check messages above.
    ) ELSE (
        ECHO 'npm install' completed.
    )
    POPD
)

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

powershell -NoProfile -ExecutionPolicy Bypass -Command "Write-Host '[SETUP] Refreshing environment variables (Cap nhat bien moi truong)...' -ForegroundColor Cyan"
CALL :RefreshEnvironment
IF %ERRORLEVEL% NEQ 0 (
    powershell -NoProfile -ExecutionPolicy Bypass -Command "Write-Host '[ERROR] Failed to refresh environment variables (Loi cap nhat bien moi truong). Continuing anyway...' -ForegroundColor Red"
)

powershell -NoProfile -ExecutionPolicy Bypass -Command "Write-Host '[SETUP] Configuring PowerShell security settings (Cau hinh cai dat bao mat PowerShell)...' -ForegroundColor Cyan"
powershell -NoProfile -ExecutionPolicy Bypass -Command "[System.Net.ServicePointManager]::SecurityProtocol = [System.Net.ServicePointManager]::SecurityProtocol -bor 3072;" > nul
IF %ERRORLEVEL% NEQ 0 (
    powershell -NoProfile -ExecutionPolicy Bypass -Command "Write-Host '[RESTART] Restarting to refresh environment (Khoi dong lai de cap nhat moi truong)...' -ForegroundColor Blue"
    EXIT /B 1
)



:: Check all prerequisites first and collect missing ones
SET "NEEDS_RESTART=0"
SET "MISSING_TOOLS="


powershell -NoProfile -ExecutionPolicy Bypass -Command "Write-Host '[?] Checking for Git (Kiem tra Git)...' -ForegroundColor Yellow"
REM Primary detection via PATH
WHERE git >nul 2>nul
IF %ERRORLEVEL% EQU 0 (
    powershell -NoProfile -ExecutionPolicy Bypass -Command "Write-Host '[OK] Git already installed (Git da duoc cai dat).' -ForegroundColor Green"
) ELSE (
    REM Fallback: check registry InstallPath and common locations
    SET "GIT_INSTALL_DIR="
    FOR /F "usebackq delims=" %%i IN (`powershell -NoProfile -ExecutionPolicy Bypass -Command "try { (Get-ItemProperty -Path 'HKLM:\SOFTWARE\GitForWindows').InstallPath } catch { '' }"`) DO SET "GIT_INSTALL_DIR=%%i"
    IF DEFINED GIT_INSTALL_DIR (
        IF EXIST "!GIT_INSTALL_DIR!\cmd\git.exe" (
            SET "PATH=%PATH%;!GIT_INSTALL_DIR!\cmd"
            powershell -NoProfile -ExecutionPolicy Bypass -Command "Write-Host '[OK] Git installed (detected via registry) (Git da duoc cai dat (phat hien qua registry)).' -ForegroundColor Green"
        ) ELSE (
            SET "NEEDS_RESTART=1"
            SET "MISSING_TOOLS=%MISSING_TOOLS% Git"
            powershell -NoProfile -ExecutionPolicy Bypass -Command "Write-Host '[MISSING] Git not found - will be installed (Git khong tim thay - se duoc cai dat).' -ForegroundColor Yellow"
        )
    ) ELSE (
        IF EXIST "%ProgramFiles%\Git\cmd\git.exe" (
            SET "PATH=%PATH%;%ProgramFiles%\Git\cmd"
            powershell -NoProfile -ExecutionPolicy Bypass -Command "Write-Host '[OK] Git installed (found in Program Files) (Git da duoc cai dat (tim thay trong Program Files)).' -ForegroundColor Green"
        ) ELSE (
            SET "NEEDS_RESTART=1"
            SET "MISSING_TOOLS=%MISSING_TOOLS% Git"
            powershell -NoProfile -ExecutionPolicy Bypass -Command "Write-Host '[MISSING] Git not found - will be installed (Git khong tim thay - se duoc cai dat).' -ForegroundColor Yellow"
        )
    )
)

powershell -NoProfile -ExecutionPolicy Bypass -Command "Write-Host '[?] Checking for Node.js (Kiem tra Node.js)...' -ForegroundColor Yellow"
WHERE node >nul 2>nul
IF %ERRORLEVEL% NEQ 0 (
    SET "NEEDS_RESTART=1"
    SET "MISSING_TOOLS=%MISSING_TOOLS% Node.js"
    powershell -NoProfile -ExecutionPolicy Bypass -Command "Write-Host '[MISSING] Node.js not found - will be installed (Node.js khong tim thay - se duoc cai dat).' -ForegroundColor Yellow"
) ELSE (
    powershell -NoProfile -ExecutionPolicy Bypass -Command "Write-Host '[OK] Node.js already installed (Node.js da duoc cai dat).' -ForegroundColor Green"
)

powershell -NoProfile -ExecutionPolicy Bypass -Command "Write-Host '[?] Checking for FFmpeg (Kiem tra FFmpeg)...' -ForegroundColor Yellow"
SET "FFMPEG_FOUND=0"
SET "FFMPEG_PATH="
CALL :DetectFFmpeg
IF DEFINED FFMPEG_PATH SET "PATH=%PATH%;%FFMPEG_PATH%"
IF "%FFMPEG_FOUND%"=="1" (
  powershell -NoProfile -ExecutionPolicy Bypass -Command "Write-Host '[OK] FFmpeg already installed (FFmpeg da duoc cai dat).' -ForegroundColor Green"
) ELSE (
  SET "NEEDS_RESTART=1"
  SET "MISSING_TOOLS=%MISSING_TOOLS% FFmpeg"
  powershell -NoProfile -ExecutionPolicy Bypass -Command "Write-Host '[MISSING] FFmpeg not found - will be installed (FFmpeg khong tim thay - se duoc cai dat).' -ForegroundColor Yellow"
)

powershell -NoProfile -ExecutionPolicy Bypass -Command "Write-Host '[?] Checking for uv Python package manager (Kiem tra trinh quan ly goi uv Python)...' -ForegroundColor Yellow"
WHERE uv >nul 2>nul
IF %ERRORLEVEL% NEQ 0 (
    SET "NEEDS_RESTART=1"
    SET "MISSING_TOOLS=%MISSING_TOOLS% uv"
    powershell -NoProfile -ExecutionPolicy Bypass -Command "Write-Host '[MISSING] uv not found - will be installed (uv khong tim thay - se duoc cai dat).' -ForegroundColor Yellow"
) ELSE (
    powershell -NoProfile -ExecutionPolicy Bypass -Command "Write-Host '[OK] uv already installed (uv da duoc cai dat).' -ForegroundColor Green"
)

:: Install all missing tools in batch if any are missing
IF "%NEEDS_RESTART%"=="1" (
    ECHO.
    powershell -NoProfile -ExecutionPolicy Bypass -Command "Write-Host '[BATCH INSTALL] Installing missing prerequisites (Cai dat cac tien quyet thieu):%MISSING_TOOLS%' -ForegroundColor Cyan"

    :: Install Git if it was marked as missing
    IF "!MISSING_TOOLS!" NEQ "!MISSING_TOOLS: Git=!" (
        powershell -NoProfile -ExecutionPolicy Bypass -Command "Write-Host '[SETUP] Installing Git version control (Cai dat kiem soat phien ban Git)...' -ForegroundColor Cyan"
        winget install --id Git.Git -e --source winget
        SET "GIT_WINGET_EXIT=!ERRORLEVEL!"
        REM Regardless of winget exit code, verify availability
        WHERE git >nul 2>nul
        IF !ERRORLEVEL! EQU 0 (
            powershell -NoProfile -ExecutionPolicy Bypass -Command "Write-Host '[OK] Git installed and available on PATH (Git da duoc cai dat va san sang tren PATH).' -ForegroundColor Green"
        ) ELSE (
            SET "GIT_INSTALL_DIR="
            FOR /F "usebackq delims=" %%i IN (`powershell -NoProfile -ExecutionPolicy Bypass -Command "try { (Get-ItemProperty -Path 'HKLM:\SOFTWARE\GitForWindows').InstallPath } catch { '' }"`) DO SET "GIT_INSTALL_DIR=%%i"
            IF DEFINED GIT_INSTALL_DIR IF EXIST "!GIT_INSTALL_DIR!\cmd\git.exe" (
                SET "PATH=%PATH%;!GIT_INSTALL_DIR!\cmd"
                powershell -NoProfile -ExecutionPolicy Bypass -Command "Write-Host '[OK] Git installed (accessed via registry path) (Git da duoc cai dat, su dung duong dan tu registry).' -ForegroundColor Green"
            ) ELSE IF EXIST "%ProgramFiles%\Git\cmd\git.exe" (
                SET "PATH=%PATH%;%ProgramFiles%\Git\cmd"
                powershell -NoProfile -ExecutionPolicy Bypass -Command "Write-Host '[OK] Git installed (found in Program Files) (Git da duoc cai dat (tim thay trong Program Files)).' -ForegroundColor Green"
            ) ELSE (
                powershell -NoProfile -ExecutionPolicy Bypass -Command "Write-Host '[ERROR] Git installation failed and git not found (Cai dat Git that bai va khong tim thay git).' -ForegroundColor Red"
            )
        )
    )

    :: Install Node.js if it was marked as missing
    IF "!MISSING_TOOLS!" NEQ "!MISSING_TOOLS: Node.js=!" (
        powershell -NoProfile -ExecutionPolicy Bypass -Command "Write-Host '[SETUP] Installing Node.js runtime (Cai dat moi truong chay Node.js)...' -ForegroundColor Cyan"
        winget install --id OpenJS.NodeJS.LTS --exact --accept-package-agreements --accept-source-agreements -s winget
        IF !ERRORLEVEL! NEQ 0 (
            powershell -NoProfile -ExecutionPolicy Bypass -Command "Write-Host '[ERROR] Node.js installation failed (Cai dat Node.js that bai).' -ForegroundColor Red"
        ) ELSE (
            powershell -NoProfile -ExecutionPolicy Bypass -Command "Write-Host '[OK] Node.js installed successfully (Cai dat Node.js thanh cong).' -ForegroundColor Green"
        )
    )

    :: Install FFmpeg if it was marked as missing
    IF "!MISSING_TOOLS!" NEQ "!MISSING_TOOLS: FFmpeg=!" (
        powershell -NoProfile -ExecutionPolicy Bypass -Command "Write-Host '[SETUP] Installing FFmpeg media processor (Cai dat bo xu ly da phuong tien FFmpeg)...' -ForegroundColor Cyan"
        winget install --id Gyan.FFmpeg --accept-package-agreements --accept-source-agreements -s winget
        IF !ERRORLEVEL! NEQ 0 (
            powershell -NoProfile -ExecutionPolicy Bypass -Command "Write-Host '[ERROR] FFmpeg installation failed (Cai dat FFmpeg that bai).' -ForegroundColor Red"
        ) ELSE (
            powershell -NoProfile -ExecutionPolicy Bypass -Command "Write-Host '[OK] FFmpeg installed successfully (Cai dat FFmpeg thanh cong).' -ForegroundColor Green"
        )
    )

    :: Install uv if it was marked as missing
    IF "!MISSING_TOOLS!" NEQ "!MISSING_TOOLS: uv=!" (
        powershell -NoProfile -ExecutionPolicy Bypass -Command "Write-Host '[SETUP] Installing uv Python package manager (Cai dat trinh quan ly goi uv Python)...' -ForegroundColor Cyan"
        powershell -NoProfile -ExecutionPolicy Bypass -Command "irm https://astral.sh/uv/install.ps1 | iex"
        IF !ERRORLEVEL! NEQ 0 (
            powershell -NoProfile -ExecutionPolicy Bypass -Command "Write-Host '[ERROR] uv installation failed (Cai dat uv that bai).' -ForegroundColor Red"
        ) ELSE (
            powershell -NoProfile -ExecutionPolicy Bypass -Command "Write-Host '[OK] uv installed successfully (Cai dat uv thanh cong).' -ForegroundColor Green"
        )
    )

    ECHO.
    powershell -NoProfile -ExecutionPolicy Bypass -Command "Write-Host '[VERIFY] Checking installation results (Kiem tra ket qua cai dat)...' -ForegroundColor Cyan"

    :: Refresh environment and re-check installations
    CALL :RefreshEnvironment

    :: Re-check each tool that was supposed to be installed
    IF "!MISSING_TOOLS!" NEQ "!MISSING_TOOLS: Git=!" (
        WHERE git >nul 2>nul
        IF !ERRORLEVEL! EQU 0 (
            powershell -NoProfile -ExecutionPolicy Bypass -Command "Write-Host '[VERIFY] Git installation confirmed (Xac nhan cai dat Git).' -ForegroundColor Green"
        ) ELSE (
            SET "GIT_INSTALL_DIR="
            FOR /F "usebackq delims=" %%i IN (`powershell -NoProfile -ExecutionPolicy Bypass -Command "try { (Get-ItemProperty -Path 'HKLM:\SOFTWARE\GitForWindows').InstallPath } catch { '' }"`) DO SET "GIT_INSTALL_DIR=%%i"
            IF DEFINED GIT_INSTALL_DIR IF EXIST "!GIT_INSTALL_DIR!\cmd\git.exe" (
                SET "PATH=%PATH%;!GIT_INSTALL_DIR!\cmd"
                powershell -NoProfile -ExecutionPolicy Bypass -Command "Write-Host '[VERIFY] Git installation confirmed via registry; PATH updated for this session (Xac nhan cai dat Git qua registry; cap nhat PATH tam thoi).' -ForegroundColor Green"
            ) ELSE IF EXIST "%ProgramFiles%\Git\cmd\git.exe" (
                SET "PATH=%PATH%;%ProgramFiles%\Git\cmd"
                powershell -NoProfile -ExecutionPolicy Bypass -Command "Write-Host '[VERIFY] Git installation confirmed in Program Files; PATH updated for this session (Xac nhan cai dat Git trong Program Files; cap nhat PATH tam thoi).' -ForegroundColor Green"
            ) ELSE (
                powershell -NoProfile -ExecutionPolicy Bypass -Command "Write-Host '[WARN] Git may need environment refresh (Git co the can cap nhat moi truong).' -ForegroundColor Yellow"
            )
        )
    )

    IF "!MISSING_TOOLS!" NEQ "!MISSING_TOOLS: Node.js=!" (
        WHERE node >nul 2>nul
        IF !ERRORLEVEL! EQU 0 (
            powershell -NoProfile -ExecutionPolicy Bypass -Command "Write-Host '[VERIFY] Node.js installation confirmed (Xac nhan cai dat Node.js).' -ForegroundColor Green"
        ) ELSE (
            powershell -NoProfile -ExecutionPolicy Bypass -Command "Write-Host '[WARN] Node.js may need environment refresh (Node.js co the can cap nhat moi truong).' -ForegroundColor Yellow"
        )
    )

    IF "!MISSING_TOOLS!" NEQ "!MISSING_TOOLS: FFmpeg=!" (
        REM Robust verification: require ffmpeg -version to succeed; also try known paths if needed
        SET "VERIFY_FAIL="
        SET "_FF_OK=0"
        FOR /F "usebackq tokens=* delims=" %%i IN (`powershell -NoProfile -ExecutionPolicy Bypass -Command "& { $ErrorActionPreference='SilentlyContinue'; try { & ffmpeg -version | Out-Null; if ($LASTEXITCODE -eq 0) { 'OK' } } catch {} }"`) DO IF "%%i"=="OK" SET "_FF_OK=1"
        IF NOT "%_FF_OK%"=="1" FOR %%P IN (
            "C:\\Program Files\\ffmpeg\\bin\\ffmpeg.exe"
            "C:\\ProgramData\\chocolatey\\bin\\ffmpeg.exe"
            "%LOCALAPPDATA%\\Microsoft\\WindowsApps\\ffmpeg.exe"
            "%USERPROFILE%\\scoop\\shims\\ffmpeg.exe"
            "C:\\ffmpeg\\bin\\ffmpeg.exe"
        ) DO (
            IF "%_FF_OK%"=="1" GOTO :_FF_VERIFY_DONE
            IF EXIST "%%~P" (
                FOR /F "usebackq tokens=* delims=" %%r IN (`powershell -NoProfile -ExecutionPolicy Bypass -Command "& { $ErrorActionPreference='SilentlyContinue'; try { & '%%~P' -version | Out-Null; if ($LASTEXITCODE -eq 0) { 'OK' } } catch {} }"`) DO IF "%%r"=="OK" (
                    SET "_FF_OK=1"
                    SET "PATH=%PATH%;%%~dpP"
                )
            )
        )
        :_FF_VERIFY_DONE
        IF "%_FF_OK%"=="1" (
            powershell -NoProfile -ExecutionPolicy Bypass -Command "Write-Host '[VERIFY] FFmpeg installation confirmed (Xac nhan cai dat FFmpeg).' -ForegroundColor Green"
        ) ELSE (
            powershell -NoProfile -ExecutionPolicy Bypass -Command "Write-Host '[WARN] FFmpeg may need environment refresh (FFmpeg co the can cap nhat moi truong).' -ForegroundColor Yellow"
            SET "VERIFY_FAIL=1"
        )
    )

    IF "!MISSING_TOOLS!" NEQ "!MISSING_TOOLS: uv=!" (
        WHERE uv >nul 2>nul
        IF !ERRORLEVEL! EQU 0 (
            powershell -NoProfile -ExecutionPolicy Bypass -Command "Write-Host '[VERIFY] uv installation confirmed (Xac nhan cai dat uv).' -ForegroundColor Green"
        ) ELSE (
            powershell -NoProfile -ExecutionPolicy Bypass -Command "Write-Host '[WARN] uv may need environment refresh (uv co the can cap nhat moi truong).' -ForegroundColor Yellow"
        )
    )

    ECHO.
    powershell -NoProfile -ExecutionPolicy Bypass -Command "Write-Host '[BATCH COMPLETE] All missing tools installed (Tat ca cong cu thieu da duoc cai dat).' -ForegroundColor Green"
    IF "%VERIFY_FAIL%"=="1" (
        powershell -NoProfile -ExecutionPolicy Bypass -Command "Write-Host '[RESTART] Restarting to refresh environment for installations that require it (Khoi dong lai de cap nhat moi truong cho cac cai dat can thiet)...' -ForegroundColor Blue"
        EXIT /B 1
    ) ELSE (
        powershell -NoProfile -ExecutionPolicy Bypass -Command "Write-Host '[NO RESTART] Tools are available in this session (Khong can khoi dong lai: Cong cu da san sang trong phien nay).' -ForegroundColor Green"
        SET "NEEDS_RESTART=0"
        EXIT /B 0
    )
) ELSE (
    powershell -NoProfile -ExecutionPolicy Bypass -Command "Write-Host '[OK] All prerequisites already installed (Tat ca tien quyet da duoc cai dat).' -ForegroundColor Green"
)
:: *********************************

powershell -NoProfile -ExecutionPolicy Bypass -Command "Write-Host '[SETUP] Finalizing PowerShell configuration (Hoan thien cau hinh PowerShell)...' -ForegroundColor Cyan"
powershell -NoProfile -Command "Set-ExecutionPolicy -ExecutionPolicy RemoteSigned -Scope CurrentUser -Force" > nul

powershell -NoProfile -ExecutionPolicy Bypass -Command "Write-Host '[SETUP] Optimizing Windows for GPU acceleration (Toi uu hoa Windows cho gia toc GPU)...' -ForegroundColor Cyan"
CALL :EnableGpuScheduling

ECHO.
powershell -NoProfile -ExecutionPolicy Bypass -Command "Write-Host '[OK] System requirements check completed (Kiem tra yeu cau he thong hoan tat).' -ForegroundColor Green"
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
:ExitScript
:: Clear saved choice on exit
IF EXIST "%LAST_CHOICE_FILE%" DEL "%LAST_CHOICE_FILE%" >nul 2>&1
EXIT /B 0




REM ==============================================================================
:: Subroutine: Detect FFmpeg outside of parenthesis to avoid parser issues
:DetectFFmpeg
SETLOCAL DisableDelayedExpansion
SET "_FOUND=0"
SET "_PATH="

REM 0) If current user's WindowsApps has ffmpeg.exe, prefer making it visible
IF EXIST "%LOCALAPPDATA%\Microsoft\WindowsApps\ffmpeg.exe" SET "PATH=%PATH%;%LOCALAPPDATA%\Microsoft\WindowsApps"

REM 1) Try running from PATH
ffmpeg -version >nul 2>nul
IF NOT ERRORLEVEL 1 SET "_FOUND=1"

REM 2) Try WHERE
IF NOT "%_FOUND%"=="1" (
    WHERE ffmpeg >nul 2>nul
    IF NOT ERRORLEVEL 1 SET "_FOUND=1"
)

REM 3) Known locations (verify by executing)
IF NOT "%_FOUND%"=="1" FOR %%P IN (
    "C:\Program Files\ffmpeg\bin\ffmpeg.exe"
    "C:\ProgramData\chocolatey\bin\ffmpeg.exe"
    "%LOCALAPPDATA%\Microsoft\WindowsApps\ffmpeg.exe"
    "%LOCALAPPDATA%\Microsoft\WinGet\Links\ffmpeg.exe"
    "%USERPROFILE%\scoop\shims\ffmpeg.exe"
    "C:\ffmpeg\bin\ffmpeg.exe"
) DO (
    IF EXIST "%%~P" (
        "%%~P" -version >nul 2>nul
        IF NOT ERRORLEVEL 1 (
            SET "_FOUND=1"
            SET "_PATH=%%~dpP"
        )
    )
)

REM 4) Scan all users' WindowsApps/WinGet Links for a runnable alias
IF NOT "%_FOUND%"=="1" FOR /D %%U IN ("C:\Users\*") DO (
    IF EXIST "%%U\AppData\Local\Microsoft\WindowsApps\ffmpeg.exe" (
        "%%U\AppData\Local\Microsoft\WindowsApps\ffmpeg.exe" -version >nul 2>nul
        IF NOT ERRORLEVEL 1 (
            SET "_FOUND=1"
            SET "_PATH=%%U\AppData\Local\Microsoft\WindowsApps\"
        )
    ) ELSE IF EXIST "%%U\AppData\Local\Microsoft\WinGet\Links\ffmpeg.exe" (
        "%%U\AppData\Local\Microsoft\WinGet\Links\ffmpeg.exe" -version >nul 2>nul
        IF NOT ERRORLEVEL 1 (
            SET "_FOUND=1"
            SET "_PATH=%%U\AppData\Local\Microsoft\WinGet\Links\"
        )
    )
)



ENDLOCAL & SET "FFMPEG_FOUND=%_FOUND%" & IF NOT "%_PATH%"=="" SET "FFMPEG_PATH=%_PATH%"
EXIT /B 0

