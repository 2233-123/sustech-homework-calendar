!include "nsDialogs.nsh"

!macro customPageAfterChangeDir
  Page custom ShortcutPageCreate ShortcutPageLeave
!macroend

!ifndef BUILD_UNINSTALLER
Var DesktopSC
Var StartSC
Var DesktopSCState
Var StartSCState

Function ShortcutPageCreate
  nsDialogs::Create 1018
  Pop $0
  StrCmp $0 "error" 0 shortcut_page_ok
    Abort
  shortcut_page_ok:
  ${NSD_CreateCheckbox} 0 0 100% 12u "创建桌面快捷方式"
  Pop $DesktopSC
  ${NSD_Check} $DesktopSC
  ${NSD_CreateCheckbox} 0 20u 100% 12u "创建开始菜单快捷方式"
  Pop $StartSC
  ${NSD_Check} $StartSC
  nsDialogs::Show
FunctionEnd

Function ShortcutPageLeave
  ${NSD_GetState} $DesktopSC $DesktopSCState
  ${NSD_GetState} $StartSC $StartSCState
FunctionEnd
!endif

!macro customInstall
  IfSilent shortcut_silent
  Goto shortcut_not_silent
  shortcut_silent:
    StrCpy $DesktopSCState 1
    StrCpy $StartSCState 1
  shortcut_not_silent:
  StrCmp $DesktopSCState "1" 0 shortcut_skip_desktop
    CreateShortCut "$DESKTOP\${SHORTCUT_NAME}.lnk" "$INSTDIR\${APP_EXECUTABLE_FILENAME}" "" "$INSTDIR\${APP_EXECUTABLE_FILENAME}" 0
  shortcut_skip_desktop:
  StrCmp $StartSCState "1" 0 shortcut_skip_start
    CreateShortCut "$SMPROGRAMS\${SHORTCUT_NAME}.lnk" "$INSTDIR\${APP_EXECUTABLE_FILENAME}" "" "$INSTDIR\${APP_EXECUTABLE_FILENAME}" 0
  shortcut_skip_start:
!macroend

!macro customUnInstall
  Delete "$DESKTOP\${SHORTCUT_NAME}.lnk"
  Delete "$SMPROGRAMS\${SHORTCUT_NAME}.lnk"
!macroend
