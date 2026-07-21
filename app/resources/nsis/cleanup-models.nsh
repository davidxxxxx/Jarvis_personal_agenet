!include "${PROJECT_DIR}\resources\nsis\model-pack-release.generated.nsh"

!macro customHeader
  ManifestDPIAware true
!macroend

!ifndef BUILD_UNINSTALLER
Var /GLOBAL jarvisModelArchive
Var /GLOBAL jarvisModelArchiveHash

!macro customInit
  StrCpy $jarvisModelArchive "$EXEDIR\${JARVIS_MODEL_ARCHIVE_NAME}"
  ${IfNot} ${FileExists} "$jarvisModelArchive"
    MessageBox MB_OK|MB_ICONSTOP "Jarvis model component is missing.$\r$\nJarvis 模型组件缺失：${JARVIS_MODEL_ARCHIVE_NAME}"
    Abort
  ${EndIf}
  ${StdUtils.HashFile} $jarvisModelArchiveHash "SHA2-512" "$jarvisModelArchive"
  ${If} $jarvisModelArchiveHash != "${JARVIS_MODEL_ARCHIVE_SHA512}"
    MessageBox MB_OK|MB_ICONSTOP "Jarvis model component checksum does not match.$\r$\nJarvis 模型组件校验失败，请重新下载安装包。"
    Abort
  ${EndIf}
!macroend

!macro customInstall
  DetailPrint "Installing verified Jarvis AI Model Pack"
  RMDir /r "$INSTDIR\resources\jarvis-ai-model-pack"
  CreateDirectory "$INSTDIR\resources\jarvis-ai-model-pack"
  Push $OUTDIR
  SetOutPath "$INSTDIR\resources\jarvis-ai-model-pack"
  Nsis7z::Extract "$jarvisModelArchive"
  Pop $R0
  SetOutPath "$R0"
  ${IfNot} ${FileExists} "$INSTDIR\resources\jarvis-ai-model-pack\manifest.json"
    MessageBox MB_OK|MB_ICONSTOP "Jarvis model component could not be installed.$\r$\nJarvis 模型组件安装失败。"
    Abort
  ${EndIf}
!macroend
!endif

!macro customUnInstall
  ${ifNot} ${isUpdated}
    StrCpy $0 "$PROFILE\.cache\openwhispr\models"
    IfFileExists "$0\*.*" 0 +3
      RMDir /r "$0"
      DetailPrint "Removed OpenWhispr cached models"
    StrCpy $1 "$PROFILE\.cache\openwhispr"
    RMDir "$1"
  ${endIf}
!macroend
