// Keyboard activation for a non-<button> element with role="button": Enter or Space clicks it,
// as a native button would. Pair with role="button" and tabIndex={0} next to the onClick.
export function activateOnKey(event) {
  // Keys typed into a nested control (input, real button) belong to that control.
  if (event.target !== event.currentTarget) return;
  if (event.key !== 'Enter' && event.key !== ' ') return;
  event.preventDefault(); // Space would otherwise scroll the page.
  event.currentTarget.click();
}
