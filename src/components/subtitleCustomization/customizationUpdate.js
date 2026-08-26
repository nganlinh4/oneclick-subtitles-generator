/**
 * Build one field patch for the project-owned subtitle scene.
 *
 * Controls can publish after the event that created them (slider throttles are the common case), so
 * they must never carry a complete customization snapshot captured during render. The scene
 * authority supplies its latest value when it applies this function; unrelated edits therefore
 * survive regardless of callback order.
 */
export const patchSubtitleCustomization = (updates) => (previous) => ({
  ...previous,
  ...updates,
  preset: 'custom',
});
