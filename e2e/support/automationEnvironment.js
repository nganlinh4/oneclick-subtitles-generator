/** Remove every ambient capability that could redirect an unattended desktop run. */
export const scrubAutomationEnvironment = (environment) => Object.fromEntries(
  Object.entries(environment).filter(([key]) => (
    !key.startsWith('OSG_E2E_')
    && !key.startsWith('WEBVIEW2_')
    && !key.startsWith('WDIO_')
    && !key.startsWith('__WDIO_TAURI_')
    && key !== 'TAURI_WEBDRIVER_PORT'
    && key !== 'TAURI_DATA_DIR'
    && key !== 'REMOTE_WEBDRIVER_URL'
  )),
);
