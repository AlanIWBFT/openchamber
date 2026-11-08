# electron-builder inserts this file at the top of the NSIS installer and
# uninstaller scripts. The build.nsis.include option in package.json points
# here.
#
# An executable that declares no DPI awareness is scaled by Windows as a
# bitmap, so the installer and the uninstaller look blurred at a display scale
# factor above 100 percent. NSIS scales its own dialogs when the manifest
# declares DPI awareness.
!macro customHeader
  ManifestDPIAware true
!macroend

!ifndef BUILD_UNINSTALLER
  !ifdef INSTALL_MODE_PER_ALL_USERS
    !define MIGRATION_KEY "Software\${APP_ID}\PerUserMigration"
    !define RUN_KEY "Software\Microsoft\Windows\CurrentVersion\Run"
    Var migrationRunCommand
    Var migrationRunArguments

    # The per-user uninstaller removes INSTALL_REGISTRY_KEY. Keep only the source
    # path separately so rerunning after a failed installation can still repair
    # the original Run entry. Profile data stays in its existing location.
    !macro customInit
      StrCpy $migrationRunCommand ""
      ReadRegStr $0 HKCU "${INSTALL_REGISTRY_KEY}" InstallLocation
      ${If} $0 == ""
        ReadRegStr $0 HKCU "${MIGRATION_KEY}" Source
      ${EndIf}
      ${If} $0 != ""
        ReadRegStr $1 HKCU "${RUN_KEY}" "${APP_ID}"
        StrCpy $2 '$\"$0\${APP_EXECUTABLE_FILENAME}$\"'
        StrLen $3 $2
        StrCpy $4 $1 $3
        ${If} $4 == $2
          StrCpy $migrationRunArguments $1 "" $3
          StrCpy $4 $migrationRunArguments 1
          ${If} $migrationRunArguments == ""
          ${OrIf} $4 == " "
            ClearErrors
            WriteRegStr HKCU "${MIGRATION_KEY}" Source "$0"
            ${If} ${Errors}
              Abort "Unable to preserve the OpenChamber startup entry. The previous installation has not been removed."
            ${EndIf}
            StrCpy $migrationRunCommand $1
          ${EndIf}
        ${EndIf}
      ${EndIf}
    !macroend

    !macro customInstall
      ${If} $migrationRunCommand != ""
        ReadRegStr $0 HKCU "${RUN_KEY}" "${APP_ID}"
        ${If} $0 == $migrationRunCommand
          ClearErrors
          WriteRegStr HKCU "${RUN_KEY}" "${APP_ID}" '$\"$INSTDIR\${APP_EXECUTABLE_FILENAME}$\"$migrationRunArguments'
          ${If} ${Errors}
            Abort "OpenChamber is installed, but its startup entry could not be updated. Run this installer again to finish migration."
          ${EndIf}
        ${EndIf}
      ${EndIf}
      DeleteRegKey HKCU "${MIGRATION_KEY}"
    !macroend
  !endif
!endif
