export const getStatusIcon = (status) => {
  switch (status) {
    case 'pending':
      return (
        <span className="material-symbols-rounded" style={{ fontSize: '16px' }}>schedule</span>
      );
    case 'processing':
      return (
        <span className="material-symbols-rounded" style={{ fontSize: '16px' }}>hourglass_top</span>
      );
    case 'completed':
      return (
        <span className="material-symbols-rounded" style={{ fontSize: '16px' }}>check</span>
      );
    case 'failed':
      return (
        <span className="material-symbols-rounded" style={{ fontSize: '16px' }}>error</span>
      );
    case 'canceled':
      return (
        <span className="material-symbols-rounded" style={{ fontSize: '16px' }}>block</span>
      );
    default:
      return (
        <span className="material-symbols-rounded" style={{ fontSize: '16px' }}>description</span>
      );
  }
};

export const getStatusColor = (status) => {
  switch (status) {
    case 'pending':
      return 'var(--accent-color)';
    case 'processing':
      return 'var(--warning-color)';
    case 'completed':
      return 'var(--success-color)';
    case 'failed':
      return 'var(--error-color)';
    case 'canceled':
      return 'var(--text-secondary)';
    default:
      return 'var(--text-secondary)';
  }
};

// Compute effective status that respects local cancel regardless of server response
export const getEffectiveStatusForItem = (item, isLocallyCanceled) =>
  (isLocallyCanceled(item.id) ? 'canceled' : item.status);

export const formatTime = (timestamp) => {
  if (!timestamp) return '';
  // Handle both number timestamps and string timestamps
  const date = typeof timestamp === 'number' ? new Date(timestamp) : new Date(timestamp);
  return isNaN(date.getTime()) ? '' : date.toLocaleTimeString();
};

// Generate persistent video number based on timestamp
export const getVideoNumber = (item) => {
  // Get or extract timestamp for this item
  let timestamp = item.timestamp;

  // If no timestamp property, try to extract from ID (format: render_TIMESTAMP_randomstring)
  if (!timestamp && item.id) {
    const idParts = item.id.split('_');
    if (idParts.length >= 2 && idParts[0] === 'render') {
      timestamp = parseInt(idParts[1]);
    }
  }

  // Fallback to current time if no timestamp found
  if (!timestamp) {
    timestamp = Date.now();
  }

  // Use localStorage to maintain a persistent counter across sessions
  const STORAGE_KEY = 'videoRenderCounter';
  const TIMESTAMP_MAP_KEY = 'videoTimestampMap';

  // Get existing timestamp-to-number mapping
  let timestampMap = {};
  try {
    const stored = localStorage.getItem(TIMESTAMP_MAP_KEY);
    if (stored) {
      timestampMap = JSON.parse(stored);
    }
  } catch (e) {
    // ignore
  }

  if (timestampMap[timestamp]) {
    return timestampMap[timestamp];
  }

  let counter = 1;
  try {
    const storedCounter = localStorage.getItem(STORAGE_KEY);
    if (storedCounter) {
      counter = parseInt(storedCounter) + 1;
    }
  } catch (e) {
    // ignore
  }

  timestampMap[timestamp] = counter;

  try {
    localStorage.setItem(STORAGE_KEY, counter.toString());
    localStorage.setItem(TIMESTAMP_MAP_KEY, JSON.stringify(timestampMap));
  } catch (e) {
    // ignore
  }

  return counter;
};

// Helpers for preview info via server (ffprobe-backed)
export const extractVideoIdFromUrl = (url) => {
  try {
    if (!url) return null;
    if (!url.includes('/videos/')) return null;
    let full = url.split('/videos/')[1];
    if (full.includes('?')) full = full.split('?')[0];
    if (full.endsWith('.mp4')) full = full.slice(0, -4);
    const m = full.match(/(.+)_\d{13}$/);
    return m ? m[1] : full;
  } catch {
    return null;
  }
};

export const gcd = (a, b) => (b === 0 ? a : gcd(b, a % b));

export const getAspectRatio = (w, h) => {
  if (!w || !h) return null;
  const g = gcd(w, h);
  return `${Math.round(w / g)}:${Math.round(h / g)}`;
};

export const heightToQuality = (h) => {
  if (!h) return 'Unknown';
  if (h >= 2160) return '4K';
  if (h >= 1440) return '1440p';
  if (h >= 1080) return '1080p';
  if (h >= 720) return '720p';
  if (h >= 480) return '480p';
  if (h >= 360) return '360p';
  return `${h}p`;
};

export const formatBytes = (bytes) => {
  if (!Number.isFinite(bytes)) return null;
  const units = ['B','KB','MB','GB','TB'];
  let i = 0; let val = bytes;
  while (val >= 1024 && i < units.length - 1) { val /= 1024; i++; }
  return `${val.toFixed(val >= 100 ? 0 : val >= 10 ? 1 : 2)} ${units[i]}`;
};
