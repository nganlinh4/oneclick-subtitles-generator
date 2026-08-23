const MAX_REGISTERED_BLOBS = 16;
const blobs = new Map();

const validBlobUrl = (value) => typeof value === 'string' && value.startsWith('blob:');

export const registerBrowserMediaBlob = (url, blob) => {
  if (!validBlobUrl(url) || !(blob instanceof Blob)) {
    throw new TypeError('A browser media blob and its object URL are required');
  }
  blobs.delete(url);
  blobs.set(url, blob);
  while (blobs.size > MAX_REGISTERED_BLOBS) {
    blobs.delete(blobs.keys().next().value);
  }
  return url;
};

export const getBrowserMediaBlob = (url) => (
  validBlobUrl(url) ? blobs.get(url) ?? null : null
);

export const forgetBrowserMediaBlob = (url) => (
  validBlobUrl(url) ? blobs.delete(url) : false
);

export const clearBrowserMediaBlobs = () => blobs.clear();
