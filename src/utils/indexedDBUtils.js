/**
 * IndexedDB utilities for storing large data that exceeds localStorage limits
 */

// Database configuration
const DB_NAME = 'OneClickSubtitlesDB';
const DB_VERSION = 1;
const STORES = {
  BACKGROUND_IMAGES: 'background_images'
};

/**
 * Opens the IndexedDB database and creates object stores if needed
 * @returns {Promise<IDBDatabase>}
 */
const openDB = () => {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result);

    request.onupgradeneeded = (event) => {
      const db = event.target.result;

      // Create object stores if they don't exist
      if (!db.objectStoreNames.contains(STORES.BACKGROUND_IMAGES)) {
        db.createObjectStore(STORES.BACKGROUND_IMAGES, { keyPath: 'id', autoIncrement: true });
      }
    };
  });
};

/**
 * Stores data in IndexedDB
 * @param {string} storeName - The object store name
 * @param {any} data - The data to store
 * @param {string|number} key - Optional key for the record
 * @returns {Promise<void>}
 */
const setItem = async (storeName, data, key = null) => {
  try {
    const db = await openDB();
    const transaction = db.transaction([storeName], 'readwrite');
    const store = transaction.objectStore(storeName);

    return new Promise((resolve, reject) => {
      let request;
      if (key !== null) {
        request = store.put({ ...data, id: key });
      } else {
        request = store.add(data);
      }

      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);

      transaction.oncomplete = () => db.close();
    });
  } catch (error) {
    console.error('Error storing data in IndexedDB:', error);
    throw error;
  }
};

/**
 * Retrieves data from IndexedDB
 * @param {string} storeName - The object store name
 * @param {string|number} key - The key to retrieve
 * @returns {Promise<any>}
 */
const getItem = async (storeName, key) => {
  try {
    const db = await openDB();
    const transaction = db.transaction([storeName], 'readonly');
    const store = transaction.objectStore(storeName);
    const request = store.get(key);

    return new Promise((resolve, reject) => {
      request.onsuccess = () => {
        resolve(request.result);
        db.close();
      };
      request.onerror = () => reject(request.error);
    });
  } catch (error) {
    console.error('Error retrieving data from IndexedDB:', error);
    throw error;
  }
};

/**
 * Retrieves all data from an object store
 * @param {string} storeName - The object store name
 * @returns {Promise<Array>}
 */
const getAllItems = async (storeName) => {
  try {
    const db = await openDB();
    const transaction = db.transaction([storeName], 'readonly');
    const store = transaction.objectStore(storeName);
    const request = store.getAll();

    return new Promise((resolve, reject) => {
      request.onsuccess = () => {
        resolve(request.result || []);
        db.close();
      };
      request.onerror = () => reject(request.error);
    });
  } catch (error) {
    console.error('Error retrieving all data from IndexedDB:', error);
    throw error;
  }
};

/**
 * Deletes data from IndexedDB
 * @param {string} storeName - The object store name
 * @param {string|number} key - The key to delete
 * @returns {Promise<void>}
 */
const removeItem = async (storeName, key) => {
  try {
    const db = await openDB();
    const transaction = db.transaction([storeName], 'readwrite');
    const store = transaction.objectStore(storeName);
    const request = store.delete(key);

    return new Promise((resolve, reject) => {
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);

      transaction.oncomplete = () => db.close();
    });
  } catch (error) {
    console.error('Error deleting data from IndexedDB:', error);
    throw error;
  }
};

/**
 * Clears all data from an object store
 * @param {string} storeName - The object store name
 * @returns {Promise<void>}
 */
const clearStore = async (storeName) => {
  try {
    const db = await openDB();
    const transaction = db.transaction([storeName], 'readwrite');
    const store = transaction.objectStore(storeName);
    const request = store.clear();

    return new Promise((resolve, reject) => {
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);

      transaction.oncomplete = () => db.close();
    });
  } catch (error) {
    console.error('Error clearing store in IndexedDB:', error);
    throw error;
  }
};

// Background images specific functions
export const BACKGROUND_IMAGES_KEY = 'background_generated_images';

/**
 * Saves background images to IndexedDB
 * @param {Array} images - Array of background image objects
 * @returns {Promise<void>}
 */
export const saveBackgroundImages = async (images) => {
  if (!images || images.length === 0) {
    // If no images, we still want to clear the old localStorage entry
    try {
      localStorage.removeItem(BACKGROUND_IMAGES_KEY);
    } catch (error) {
      console.warn('Could not remove old localStorage entry:', error);
    }
    return;
  }

  try {
    await setItem(STORES.BACKGROUND_IMAGES, { images, timestamp: Date.now() }, BACKGROUND_IMAGES_KEY);
    // Remove from localStorage if it exists
    try {
      localStorage.removeItem(BACKGROUND_IMAGES_KEY);
    } catch (error) {
      console.warn('Could not remove old localStorage entry:', error);
    }
  } catch (error) {
    console.error('Error saving background images to IndexedDB:', error);
    throw error;
  }
};

/**
 * Loads background images from IndexedDB
 * @returns {Promise<Array>} Array of background image objects
 */
export const loadBackgroundImages = async () => {
  try {
    const data = await getItem(STORES.BACKGROUND_IMAGES, BACKGROUND_IMAGES_KEY);
    if (data && data.images) {
      return data.images;
    }

    // Fallback to localStorage for backward compatibility
    try {
      const localStorageData = localStorage.getItem(BACKGROUND_IMAGES_KEY);
      if (localStorageData) {
        const images = JSON.parse(localStorageData);
        // Migrate to IndexedDB
        if (images && images.length > 0) {
          await saveBackgroundImages(images);
          localStorage.removeItem(BACKGROUND_IMAGES_KEY);
        }
        return images || [];
      }
    } catch (error) {
      console.warn('Error loading from localStorage fallback:', error);
    }

    return [];
  } catch (error) {
    console.error('Error loading background images from IndexedDB:', error);

    // Fallback to localStorage
    try {
      const localStorageData = localStorage.getItem(BACKGROUND_IMAGES_KEY);
      return localStorageData ? JSON.parse(localStorageData) : [];
    } catch (fallbackError) {
      console.error('Error loading from localStorage fallback:', fallbackError);
      return [];
    }
  }
};

/**
 * Clears all background images from IndexedDB
 * @returns {Promise<void>}
 */
export const clearBackgroundImages = async () => {
  try {
    await removeItem(STORES.BACKGROUND_IMAGES, BACKGROUND_IMAGES_KEY);
    // Also remove from localStorage if it exists
    try {
      localStorage.removeItem(BACKGROUND_IMAGES_KEY);
    } catch (error) {
      console.warn('Could not remove localStorage entry:', error);
    }
  } catch (error) {
    console.error('Error clearing background images from IndexedDB:', error);
    throw error;
  }
};

// Export general functions for potential future use
export { setItem, getItem, getAllItems, removeItem, clearStore };
