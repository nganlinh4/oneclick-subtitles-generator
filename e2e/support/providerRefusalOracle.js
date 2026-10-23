/**
 * Shared oracle for the credential-free refusal boundary every native Gemini text/document/
 * translation call shares.
 *
 * GROUND TRUTH: src/platform/nativeGeminiJobLifecycle.js's createNativeGeminiJobRunner resolves a
 * credential BEFORE calling into Rust. With none available, `getCredentialId()` resolves null, the
 * attempt loop breaks immediately, and it throws `fixedError('geminiCredentialUnavailable')` (name
 * `NativeGeminiError`, code `geminiCredentialUnavailable`, message the English
 * `settings.geminiCredentialRequired` text below) -- no native command is ever invoked, so no
 * job/artifact row is ever written. Document consolidate/summarize, main-track translation and bulk
 * translation all surface that message unchanged; this module is the single place it lives so a
 * journey does not retype it.
 */

/* global document, getComputedStyle */

export const GEMINI_CREDENTIAL_REQUIRED_MESSAGE = 'No Gemini API key is currently usable. Add or check a key in Settings → API Keys.';

/** Native job kinds every credential-gated Gemini text call can register -- see providerBoundaries.journey.js. */
export const PROVIDER_JOB_KINDS = Object.freeze(['transcribe', 'translate', 'analyzeSubtitles']);

/**
 * Read every currently-visible toast from the TOP document only (never an iframe): the same
 * `.toast-item.live .toast.toast-error` shape workflowEvidence.js's own screenshot guard reads, so a
 * journey's own probe and the guard's independent probe never disagree about what is "visible".
 */
export const collectTopDocumentToasts = () => {
  const visible = (node) => {
    const style = getComputedStyle(node);
    const rect = node.getBoundingClientRect();
    return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
  };
  const text = (node) => (node.innerText || node.textContent || '').trim().replace(/\s+/g, ' ');
  const toastMessage = (toast) => text(toast.querySelector('p') ?? toast);
  const errorNodes = [...document.querySelectorAll('.toast-item.live .toast.toast-error')]
    .filter(visible);
  const warningNodes = [...document.querySelectorAll('.toast-item.live .toast.toast-warning')]
    .filter(visible);
  return {
    // Complete customer-visible text is retained for workflowEvidence's exact screenshot
    // allowance. Semantic assertions use the message body so a close icon or localized heading
    // cannot masquerade as a provider error-code change.
    errorToasts: errorNodes.map(text).filter(Boolean),
    errorMessages: errorNodes.map(toastMessage).filter(Boolean),
    warningToasts: warningNodes.map(text).filter(Boolean),
    warningMessages: warningNodes.map(toastMessage).filter(Boolean),
    inlineErrors: [...document.querySelectorAll('.error, .error-message, [role="alert"]')]
      .filter((node) => node.closest('.toast-item') === null && visible(node))
      .map(text).filter(Boolean),
  };
};
