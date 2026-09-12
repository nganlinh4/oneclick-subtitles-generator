# Workspace Agent Guidance

## Launching the debug application

- When the user asks to launch the current debug app, run `npm run tauri:dev` from the repository
  root. Never launch `target/debug/osg-desktop.exe` directly: that binary loads the configured Vite
  development URL and displays `ERR_CONNECTION_REFUSED` without the managed dev server.
- Keep the managed Tauri command alive for as long as the user is testing. Closing its terminal
  session also closes Vite and invalidates the running WebView.
- Do not report that the app is running merely because an `osg-desktop` process exists. Verify all
  three launch receipts first:
  1. `http://127.0.0.1:3030/` returns HTTP 200.
  2. The live `osg-desktop` executable comes from the managed development cache.
  3. The newest application instance records `app.page_load_finished` in `logs/osg.log`.
- If any receipt is absent, treat the launch as failed and repair it before handing control back.
- Do not use Windows GUI automation for ordinary development launches or inspection unless the
  user explicitly authorizes it for that task.
