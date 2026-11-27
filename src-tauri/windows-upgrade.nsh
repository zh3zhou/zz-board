; Tauri owns the maintenance wizard and the actual uninstaller. On an upgrade
; its second radio button keeps the existing installation and pinned shortcut.
; The hook is included before Tauri declares its variables. Modern UI calls
; this global NSIS label after .onInit has restored the install path.
!define MUI_CUSTOMFUNCTION_GUIINIT ":.zzbSelectInPlaceUpgrade"

!macro NSIS_HOOK_PREINSTALL
  Goto zzbInstall
  .zzbSelectInPlaceUpgrade:
    ReadRegStr $0 SHCTX "${MANUPRODUCTKEY}" ""
    StrCmp $0 "" zzbSelectionDone
    StrCmp $0 $INSTDIR 0 zzbSelectionDone
    IfFileExists "$INSTDIR\${MAINBINARYNAME}.exe" 0 zzbSelectionDone
    ReadRegStr $1 SHCTX "${UNINSTKEY}" "DisplayVersion"
    StrCmp $1 "" zzbSelectionDone
    nsis_tauri_utils::SemverCompare "${VERSION}" $1
    Pop $0
    StrCmp $0 1 0 zzbSelectionDone
    StrCpy $ReinstallPageCheck 2
  zzbSelectionDone:
    Return
  zzbInstall:
  ; A retained installation already has its user's preferred shortcuts.
  ; Reuse Tauri's update branch so it leaves them in place.
    ReadRegStr $0 SHCTX "${MANUPRODUCTKEY}" ""
    StrCmp $0 $INSTDIR 0 zzbInstallReady
    IfFileExists "$INSTDIR\${MAINBINARYNAME}.exe" 0 zzbInstallReady
    StrCpy $UpdateMode 1
  zzbInstallReady:
!macroend
