; Installer hooks: remove payload that older versions of this application installed.
;
; WHY THIS EXISTS. NSIS uninstalls what its own manifest recorded. A file an EARLIER version shipped
; and the current one does not is unknown to both the new installer and the new uninstaller, so it
; survives an upgrade and it survives a clean uninstall. Measured on this machine: after installing
; the current build over a July build and then uninstalling, exactly one file remained —
; `workers\osg_render_worker.mjs`, the worker of the JavaScript renderer this project removed.
;
; That matters beyond tidiness. The removal is only true of the application if the application on
; disk no longer contains it, and "we stopped shipping it" does not reach a machine that already had
; it. Deleting it explicitly is the only thing that does.
;
; Entries here are permanent. A path is added when a version stops shipping a file, and it is never
; removed, because the install it needs to clean up may be years old.

!macro NSIS_HOOK_PREINSTALL
  ; Before laying down the new payload, so an upgrade never leaves the two side by side.
  Delete "$INSTDIR\workers\osg_render_worker.mjs"
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  ; And again after uninstalling, so a machine that never runs the new installer still ends clean.
  Delete "$INSTDIR\workers\osg_render_worker.mjs"
  ; Only removes the directory when it is empty; the current workers are deleted by the manifest.
  RMDir "$INSTDIR\workers"
  RMDir "$INSTDIR"
!macroend
