export const SPEAKER_LABEL_STYLES = ['hidden', 'colon', 'brackets', 'newLine'];
export const isValidSpeakerName = (text) => typeof text === 'string' && !!text.trim()
  && [...text].length <= 200 && ![...text].some((char) => {
    const code = char.codePointAt(0);
    return code <= 31 || (code >= 127 && code <= 159);
  });

// Speaker presentation is separate from editable/provider text. Do not prefix cue.text in place.
export function normalizeSpeaker(value) {
  if (value == null) return null;
  let speaker = typeof value === 'string'
    ? { id: value, name: value, labelStyle: 'hidden' } : value;
  if (!speaker || typeof speaker !== 'object' || Array.isArray(speaker)) throw new Error('Invalid speaker');
  const descriptors = Object.getOwnPropertyDescriptors(speaker);
  if (Object.values(descriptors).some((descriptor) => !('value' in descriptor))) throw new Error('Invalid speaker');
  speaker = Object.fromEntries(Object.entries(descriptors).map(([key, descriptor]) => [key, descriptor.value]));
  for (const key of ['id', 'name']) {
    const text = speaker[key];
    if (!isValidSpeakerName(text)) {
      throw new Error('Invalid speaker identity or name');
    }
  }
  const labelStyle = speaker.labelStyle ?? 'hidden';
  if (!SPEAKER_LABEL_STYLES.includes(labelStyle)) throw new Error('Invalid speaker label style');
  return { id: speaker.id, name: speaker.name, labelStyle };
}

export function subtitleDisplayText(cue) {
  const speaker = normalizeSpeaker(cue?.speaker);
  if (!speaker || speaker.labelStyle === 'hidden') return cue?.text;
  if (speaker.labelStyle === 'brackets') return `[${speaker.name}] ${cue.text}`;
  if (speaker.labelStyle === 'newLine') return `${speaker.name}\n${cue.text}`;
  return `${speaker.name}: ${cue.text}`;
}
