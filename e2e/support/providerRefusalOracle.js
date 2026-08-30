/**
 * Shared oracle for the credential-free refusal boundary every native Gemini text/document/
 * translation call shares.
 *
 * GROUND TRUTH: src/platform/nativeGeminiJobLifecycle.js's createNativeGeminiJobRunner resolves a
 * credential BEFORE calling into Rust. With none available, `getCredentialId()` resolves null, the
 * attempt loop breaks immediately, and it throws the fixed error `fixedError('geminiCredentialUnavailable')`
 * (name `NativeGeminiError`, message exactly "The native Gemini operation could not be completed") --
 * no native command is ever invoked, so no job/artifact row is ever written. Every consumer of
 * src/platform/nativeGeminiText.js (document consolidate/summarize via
 * src/services/gemini/documentRequest.js, and translation via src/services/gemini/translation.js)
 * propagates that exact error unchanged: neither wraps it in a friendlier message the way
 * transcription's UI layer does. bulkTranslationFileIO.journey.js already asserts this same text for
 * the BULK translation path (`/native gemini operation could not be completed/i`); this module is
 * the single place that constant lives so a future journey does not retype it.
 */

/* global document, getComputedStyle */

export const NATIVE_GEMINI_REFUSAL_MESSAGE = 'The native Gemini operation could not be completed';

/** Native job kinds every credential-gated Gemini text call can register -- see geminiCredentialBoundary.journey.js. */
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
