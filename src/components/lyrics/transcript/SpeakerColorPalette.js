/**
 * Deterministic speaker color hashing for speaker avatars and badges.
 * Maps speaker IDs to Material Design 3 harmonic color schemes.
 */

export const SPEAKER_PALETTES = Object.freeze([
  {
    id: 'speaker-indigo',
    bg: '#5D5FEF',
    text: '#FFFFFF',
    container: '#E8E7FF',
    onContainer: '#1E1968',
    border: '#5D5FEF',
  },
  {
    id: 'speaker-teal',
    bg: '#00897B',
    text: '#FFFFFF',
    container: '#D0F8CE',
    onContainer: '#003822',
    border: '#00897B',
  },
  {
    id: 'speaker-amber',
    bg: '#E65100',
    text: '#FFFFFF',
    container: '#FFE0B2',
    onContainer: '#4E2600',
    border: '#E65100',
  },
  {
    id: 'speaker-purple',
    bg: '#8E24AA',
    text: '#FFFFFF',
    container: '#F3E5F5',
    onContainer: '#3B0054',
    border: '#8E24AA',
  },
  {
    id: 'speaker-cyan',
    bg: '#0097A7',
    text: '#FFFFFF',
    container: '#E0F7FA',
    onContainer: '#00363A',
    border: '#0097A7',
  },
  {
    id: 'speaker-rose',
    bg: '#D81B60',
    text: '#FFFFFF',
    container: '#FCE4EC',
    onContainer: '#49001E',
    border: '#D81B60',
  },
  {
    id: 'speaker-green',
    bg: '#2E7D32',
    text: '#FFFFFF',
    container: '#E8F5E9',
    onContainer: '#0A3812',
    border: '#2E7D32',
  },
  {
    id: 'speaker-blue',
    bg: '#1976D2',
    text: '#FFFFFF',
    container: '#E3F2FD',
    onContainer: '#002C6E',
    border: '#1976D2',
  },
]);

const DEFAULT_PALETTE = Object.freeze({
  id: 'speaker-default',
  bg: '#79747E',
  text: '#FFFFFF',
  container: '#E7E0EC',
  onContainer: '#1D1A22',
  border: '#79747E',
});

/**
 * Returns the deterministic color palette for a given speakerId.
 * @param {string|null|undefined} speakerId
 * @returns {object} palette
 */
export function getSpeakerPalette(speakerId) {
  if (!speakerId || typeof speakerId !== 'string') {
    return DEFAULT_PALETTE;
  }
  let hash = 0;
  for (let i = 0; i < speakerId.length; i++) {
    hash = (hash << 5) - hash + speakerId.charCodeAt(i);
    hash |= 0;
  }
  const index = Math.abs(hash) % SPEAKER_PALETTES.length;
  return SPEAKER_PALETTES[index];
}

/**
 * Derives a 1-3 letter avatar monogram for a speaker.
 * @param {string} displayName
 * @returns {string} monogram
 */
export function getSpeakerMonogram(displayName) {
  if (!displayName || typeof displayName !== 'string') return '?';
  const parts = displayName.trim().split(/\s+/);
  if (parts.length >= 2) {
    return (parts[0][0] + parts[1][0]).toUpperCase();
  }
  return displayName.slice(0, 2).toUpperCase();
}
