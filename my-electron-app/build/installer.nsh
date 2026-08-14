!include "MUI2.nsh"
!include "nsDialogs.nsh"
!include "LogicLib.nsh"
!include "WinMessages.nsh"

!ifndef BUILD_UNINSTALLER
Var AddRcloneToPath
Var AddRcloneToPathCheckbox
Var RclonePathDetectionLabel
!endif

LangString RclonePageTitle 1033 "rclone command-line access"
LangString RclonePageTitle 2052 "rclone 命令行访问"
LangString RclonePageTitle 1041 "rclone コマンドラインアクセス"

LangString RclonePageSubtitle 1033 "Optional terminal integration"
LangString RclonePageSubtitle 2052 "可选的终端集成"
LangString RclonePageSubtitle 1041 "オプションのターミナル統合"

LangString RclonePageDescription 1033 "BOBOCloudEditer uses its bundled rclone directly and does not require PATH. Enable this only if you also want to run rclone from Command Prompt or PowerShell. It can change which rclone version a terminal resolves."
LangString RclonePageDescription 2052 "BOBOCloudEditer 会直接使用内置 rclone，无需配置 PATH。仅当你还需要在命令提示符或 PowerShell 中直接运行 rclone 时才启用；这可能改变终端解析到的 rclone 版本。"
LangString RclonePageDescription 1041 "BOBOCloudEditer は同梱の rclone を直接使用するため、PATH は不要です。コマンドプロンプトまたは PowerShell から rclone を実行する場合のみ有効にしてください。ターミナルで解決される rclone のバージョンが変わる可能性があります。"

LangString RclonePathCheckbox 1033 "Add the bundled rclone directory to the system PATH"
LangString RclonePathCheckbox 2052 "将内置 rclone 目录添加到系统 PATH"
LangString RclonePathCheckbox 1041 "同梱 rclone のディレクトリをシステム PATH に追加する"

LangString RclonePathDetected 1033 "An rclone command is already available in PATH. Leave this unchecked to keep the current terminal version."
LangString RclonePathDetected 2052 "PATH 中已经存在 rclone 命令。如需保留终端当前使用的版本，请不要勾选。"
LangString RclonePathDetected 1041 "PATH には既に rclone コマンドがあります。現在のターミナル版を維持するには、チェックを外したままにしてください。"

!macro customInit
  StrCpy $AddRcloneToPath "0"
  ReadRegStr $R0 HKLM "Software\BOBOCloudEditer" "RclonePathEntry"
  ${If} $R0 != ""
    StrCpy $AddRcloneToPath "1"
  ${EndIf}
!macroend

!macro customPageAfterChangeDir
  Page custom RclonePathPageCreate RclonePathPageLeave
!macroend

!ifndef BUILD_UNINSTALLER
Function RclonePathPageCreate
  !insertmacro MUI_HEADER_TEXT "$(RclonePageTitle)" "$(RclonePageSubtitle)"
  nsDialogs::Create 1018
  Pop $R0
  ${If} $R0 == error
    Abort
  ${EndIf}

  ${NSD_CreateLabel} 0 0 100% 46u "$(RclonePageDescription)"
  Pop $R1

  ${NSD_CreateCheckbox} 0 54u 100% 18u "$(RclonePathCheckbox)"
  Pop $AddRcloneToPathCheckbox
  ${If} $AddRcloneToPath == "1"
    ${NSD_Check} $AddRcloneToPathCheckbox
  ${Else}
    ${NSD_Uncheck} $AddRcloneToPathCheckbox
  ${EndIf}

  nsExec::ExecToStack '"$SYSDIR\where.exe" rclone.exe'
  Pop $R2
  Pop $R3
  ${If} $R2 == 0
    ${NSD_CreateLabel} 0 80u 100% 28u "$(RclonePathDetected)"
    Pop $RclonePathDetectionLabel
  ${EndIf}

  nsDialogs::Show
FunctionEnd

Function RclonePathPageLeave
  ${NSD_GetState} $AddRcloneToPathCheckbox $R0
  ${If} $R0 == ${BST_CHECKED}
    StrCpy $AddRcloneToPath "1"
  ${Else}
    StrCpy $AddRcloneToPath "0"
  ${EndIf}
FunctionEnd
!endif

!macro customInstall
  ReadRegStr $R2 HKLM "Software\BOBOCloudEditer" "RclonePathEntry"
  StrCpy $R3 "$INSTDIR\resources\rclone"
  StrCpy $R4 "0"
  StrCpy $R5 "0"
  ${If} $R2 != ""
    StrCpy $R5 "1"
  ${ElseIf} $AddRcloneToPath == "1"
    StrCpy $R5 "1"
  ${EndIf}

  ${If} $R5 == "1"
    InitPluginsDir
    File /oname=$PLUGINSDIR\rclone-path.ps1 "${BUILD_RESOURCES_DIR}\rclone-path.ps1"
  ${EndIf}

  # Remove the exact previous installer-managed entry when the user opts out
  # or changes the installation directory. Keep the marker if cleanup fails.
  ${If} $R2 != ""
    StrCpy $R5 "0"
    ${If} $AddRcloneToPath == "0"
      StrCpy $R5 "1"
    ${ElseIf} $R2 != $R3
      StrCpy $R5 "1"
    ${EndIf}

    ${If} $R5 == "1"
      nsExec::ExecToStack '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$PLUGINSDIR\rclone-path.ps1" -Action remove -Entry "$R2"'
      Pop $R0
      Pop $R1
      ${If} $R0 == 0
      ${OrIf} $R0 == 10
        DeleteRegValue HKLM "Software\BOBOCloudEditer" "RclonePathEntry"
        DeleteRegKey /ifempty HKLM "Software\BOBOCloudEditer"
        ${If} $R0 == 0
          SendMessage ${HWND_BROADCAST} ${WM_SETTINGCHANGE} 0 "STR:Environment" /TIMEOUT=5000
        ${EndIf}
      ${Else}
        StrCpy $R4 "1"
        DetailPrint "Unable to remove the previous bundled rclone PATH entry: $R1"
      ${EndIf}
    ${EndIf}
  ${EndIf}

  ${If} $AddRcloneToPath == "1"
  ${AndIf} $R4 == "0"
    ${If} ${FileExists} "$R3\rclone.exe"
      nsExec::ExecToStack '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$PLUGINSDIR\rclone-path.ps1" -Action add -Entry "$INSTDIR\resources\rclone"'
      Pop $R0
      Pop $R1
      ${If} $R0 == 0
        ClearErrors
        WriteRegStr HKLM "Software\BOBOCloudEditer" "RclonePathEntry" "$R3"
        ${If} ${Errors}
          nsExec::ExecToStack '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$PLUGINSDIR\rclone-path.ps1" -Action remove -Entry "$R3"'
          Pop $R0
          Pop $R1
          ${If} $R0 == 0
          ${OrIf} $R0 == 10
            DetailPrint "Unable to record ownership of the bundled rclone PATH entry; the entry was rolled back."
          ${Else}
            DetailPrint "Unable to record ownership of the bundled rclone PATH entry, and rollback failed: $R1"
          ${EndIf}
        ${Else}
          SendMessage ${HWND_BROADCAST} ${WM_SETTINGCHANGE} 0 "STR:Environment" /TIMEOUT=5000
        ${EndIf}
      ${ElseIf} $R0 == 10
        # The target was already present and belongs to the user. Do not claim
        # ownership, unless this is an upgrade of our existing managed entry.
        ${If} $R2 == $R3
        ${AndIf} $R2 != ""
          DetailPrint "Keeping ownership of the existing bundled rclone PATH entry."
        ${EndIf}
      ${Else}
        DetailPrint "Unable to add bundled rclone to PATH: $R1"
      ${EndIf}
    ${EndIf}
  ${EndIf}
!macroend

!macro customUnInstall
  ReadRegStr $R2 HKLM "Software\BOBOCloudEditer" "RclonePathEntry"
  ${If} $R2 != ""
    InitPluginsDir
    File /oname=$PLUGINSDIR\rclone-path.ps1 "${BUILD_RESOURCES_DIR}\rclone-path.ps1"
    nsExec::ExecToStack '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$PLUGINSDIR\rclone-path.ps1" -Action remove -Entry "$R2"'
    Pop $R0
    Pop $R1
    ${If} $R0 == 0
    ${OrIf} $R0 == 10
      DeleteRegValue HKLM "Software\BOBOCloudEditer" "RclonePathEntry"
      DeleteRegKey /ifempty HKLM "Software\BOBOCloudEditer"
      ${If} $R0 == 0
        SendMessage ${HWND_BROADCAST} ${WM_SETTINGCHANGE} 0 "STR:Environment" /TIMEOUT=5000
      ${EndIf}
    ${Else}
      DetailPrint "Unable to remove bundled rclone from PATH: $R1"
    ${EndIf}
  ${EndIf}
!macroend
