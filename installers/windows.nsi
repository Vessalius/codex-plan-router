Unicode true
Name "Codex Plan Router"
OutFile "${OUTPUT}"
InstallDir "$LOCALAPPDATA\Programs\Codex Plan Router"
InstallDirRegKey HKCU "Software\Codex Plan Router" "InstallDir"
RequestExecutionLevel user
SetCompressor /SOLID lzma
ShowInstDetails show

!include "MUI2.nsh"
!include "LogicLib.nsh"
!define MUI_ABORTWARNING
!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_LICENSE "${PAYLOAD}\LICENSE"
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "English"
!insertmacro MUI_LANGUAGE "SimpChinese"

Section "Install"
  IfFileExists "$INSTDIR\runtime\node.exe" 0 copy_files
  ExecWait '"$INSTDIR\runtime\node.exe" "$INSTDIR\cli.mjs" stop' $0
  ${If} $0 != 0
    MessageBox MB_ICONSTOP "Stop Codex Plan Router and finish any running requests before updating." /SD IDOK
    Abort
  ${EndIf}
  copy_files:
  SetOutPath "$INSTDIR"
  File /r "${PAYLOAD}\*.*"
  WriteUninstaller "$INSTDIR\Uninstall.exe"
  CreateDirectory "$SMPROGRAMS\Codex Plan Router"
  CreateShortCut "$SMPROGRAMS\Codex Plan Router\Codex Plan Router.lnk" "$INSTDIR\runtime\node.exe" '"$INSTDIR\cli.mjs" launch'
  CreateShortCut "$SMPROGRAMS\Codex Plan Router\Stop Codex Plan Router.lnk" "$INSTDIR\runtime\node.exe" '"$INSTDIR\cli.mjs" stop'
  WriteRegStr HKCU "Software\Codex Plan Router" "InstallDir" "$INSTDIR"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Codex Plan Router" "DisplayName" "Codex Plan Router (${ARCH})"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Codex Plan Router" "DisplayVersion" "${VERSION}"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Codex Plan Router" "UninstallString" '"$INSTDIR\Uninstall.exe"'
  WriteRegDWORD HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Codex Plan Router" "NoModify" 1
  WriteRegDWORD HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Codex Plan Router" "NoRepair" 1
SectionEnd

Section "Uninstall"
  IfFileExists "$INSTDIR\runtime\node.exe" 0 remove_files
  ExecWait '"$INSTDIR\runtime\node.exe" "$INSTDIR\cli.mjs" stop --restore-direct' $0
  ${If} $0 != 0
    MessageBox MB_ICONSTOP "Finish running requests and restore direct connection before uninstalling." /SD IDOK
    Abort
  ${EndIf}
  remove_files:
  Delete "$SMPROGRAMS\Codex Plan Router\Codex Plan Router.lnk"
  Delete "$SMPROGRAMS\Codex Plan Router\Stop Codex Plan Router.lnk"
  RMDir "$SMPROGRAMS\Codex Plan Router"
  DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Codex Plan Router"
  DeleteRegKey HKCU "Software\Codex Plan Router"
  Delete "$INSTDIR\allocation.mjs"
  Delete "$INSTDIR\cli.mjs"
  Delete "$INSTDIR\config.mjs"
  Delete "$INSTDIR\core.mjs"
  Delete "$INSTDIR\platform.mjs"
  Delete "$INSTDIR\quota.mjs"
  Delete "$INSTDIR\quota-native.mjs"
  Delete "$INSTDIR\server.mjs"
  Delete "$INSTDIR\ui.mjs"
  Delete "$INSTDIR\package.json"
  Delete "$INSTDIR\README.md"
  Delete "$INSTDIR\LICENSE"
  Delete "$INSTDIR\runtime\node.exe"
  Delete "$INSTDIR\runtime\LICENSE"
  RMDir "$INSTDIR\runtime"
  Delete "$INSTDIR\Uninstall.exe"
  RMDir "$INSTDIR"
SectionEnd
