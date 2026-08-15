import { useState, useCallback, useEffect } from 'react';
import { normalizeLanguageChain } from '../utils/translationOwnership';

const MAX_LANGUAGE_CHAIN_STORAGE_BYTES = 16 * 1024;
let languageChainIdSequence = 0;
const nextLanguageChainId = () => {
  languageChainIdSequence = (languageChainIdSequence + 1) % Number.MAX_SAFE_INTEGER;
  return `chain-${Date.now().toString(36)}-${languageChainIdSequence.toString(36)}`;
};

const defaultLanguageChain = (includeOriginal) => {
  const items = [];
  if (includeOriginal) {
    items.push({
      id: nextLanguageChainId(),
      type: 'language',
      value: 'Original',
      isOriginal: true,
    });
  }
  items.push({
    id: nextLanguageChainId(),
    type: 'language',
    value: '',
    isOriginal: false,
  });
  return normalizeLanguageChain(items, { allowEmptyLanguage: true });
};

export const loadPersistedLanguageChain = (serialized, includeOriginal = false) => {
  if (typeof serialized !== 'string' || serialized.length === 0
      || new TextEncoder().encode(serialized).byteLength > MAX_LANGUAGE_CHAIN_STORAGE_BYTES) {
    return defaultLanguageChain(includeOriginal);
  }
  try {
    let normalized = normalizeLanguageChain(JSON.parse(serialized), { allowEmptyLanguage: true });
    if (includeOriginal && !normalized.some((item) => (
      item.type === 'language' && item.isOriginal
    ))) {
      normalized = normalizeLanguageChain([
        {
          id: nextLanguageChainId(),
          type: 'language',
          value: 'Original',
          isOriginal: true,
        },
        ...normalized,
      ], { allowEmptyLanguage: true });
    }
    return normalized;
  } catch {
    return defaultLanguageChain(includeOriginal);
  }
};

/**
 * Custom hook to manage the language chain state
 * @param {boolean} includeOriginal - Whether to include the original language in the chain
 * @returns {Object} - Language chain state and handlers
 */
const useLanguageChain = (includeOriginal = false) => {
  // Chain items can be languages or delimiters
  // Languages: { id: number, type: 'language', value: string, isOriginal: boolean }
  // Delimiters: { id: number, type: 'delimiter', value: string, style: { open: string, close: string } }
  const [chainItems, setChainItems] = useState(() => {
    try {
      const savedChain = localStorage.getItem('language_chain_items');
      return loadPersistedLanguageChain(savedChain, includeOriginal);
    } catch {
      return defaultLanguageChain(includeOriginal);
    }
  });

  /**
   * Add a new language to the chain
   */
  const addLanguage = useCallback(() => {
    setChainItems(items => {
      // Create a new language item
      const newLanguage = {
        id: nextLanguageChainId(),
        type: 'language',
        value: '',
        isOriginal: false
      };

      // If there's more than one item, add a delimiter before the new language
      if (items.length > 0) {
        const newDelimiter = {
          id: nextLanguageChainId(),
          type: 'delimiter',
          value: ' ', // Default to space
          style: { open: '', close: '' }
        };

        return normalizeLanguageChain([...items, newDelimiter, newLanguage], {
          allowEmptyLanguage: true,
        });
      }

      return normalizeLanguageChain([...items, newLanguage], { allowEmptyLanguage: true });
    });
  }, []);

  /**
   * Add a new delimiter to the chain
   * @param {Object} delimiter - The delimiter to add
   */
  const addDelimiter = useCallback((delimiter) => {
    setChainItems(items => {
      return normalizeLanguageChain([...items, delimiter], { allowEmptyLanguage: true });
    });
  }, []);

  /**
   * Add the original language to the chain
   */
  const addOriginalLanguage = useCallback(() => {
    setChainItems(items => {
      // Check if original language already exists
      if (items.some(item => item.type === 'language' && item.isOriginal)) {
        return items;
      }

      // Create a new original language item
      const originalLanguage = {
        id: nextLanguageChainId(),
        type: 'language',
        value: 'Original',
        isOriginal: true
      };

      // If there's more than one item, add a delimiter before the original language
      if (items.length > 0) {
        const newDelimiter = {
          id: nextLanguageChainId(),
          type: 'delimiter',
          value: ' ', // Default to space
          style: { open: '', close: '' }
        };

        return normalizeLanguageChain([...items, newDelimiter, originalLanguage], {
          allowEmptyLanguage: true,
        });
      }

      return normalizeLanguageChain([...items, originalLanguage], { allowEmptyLanguage: true });
    });
  }, []);

  /**
   * Remove an item from the chain
   * @param {number} id - ID of the item to remove
   */
  const removeItem = useCallback((id) => {
    setChainItems(items => {
      const index = items.findIndex(item => item.id === id);
      if (index === -1) return items;

      const newItems = [...items];

      // If removing a language, also remove the delimiter before or after it
      if (newItems[index].type === 'language') {
        // If there's a delimiter before this language, remove it
        if (index > 0 && newItems[index - 1].type === 'delimiter') {
          newItems.splice(index - 1, 2); // Remove delimiter and language
        }
        // If there's a delimiter after this language, remove it
        else if (index < newItems.length - 1 && newItems[index + 1].type === 'delimiter') {
          newItems.splice(index, 2); // Remove language and delimiter
        }
        // Otherwise just remove the language
        else {
          newItems.splice(index, 1);
        }
      }
      // If removing a delimiter, just remove it
      else {
        newItems.splice(index, 1);
      }

      return normalizeLanguageChain(newItems, { allowEmptyLanguage: true });
    });
  }, []);

  /**
   * Update a language value
   * @param {number} id - ID of the language to update
   * @param {string} value - New value
   */
  const updateLanguage = useCallback((id, value) => {
    setChainItems(items => normalizeLanguageChain(
      items.map(item =>
        item.id === id && item.type === 'language'
          ? { ...item, value }
          : item
      ),
      { allowEmptyLanguage: true }
    ));
  }, []);

  /**
   * Update a delimiter value
   * @param {number} id - ID of the delimiter to update
   * @param {string} value - New value
   * @param {Object} style - Optional bracket style { open, close }
   */
  const updateDelimiter = useCallback((id, value, style = null) => {
    setChainItems(items => normalizeLanguageChain(
      items.map(item => {
        if (item.id === id && item.type === 'delimiter') {
          const updatedItem = { ...item, value };
          if (style) {
            updatedItem.style = style;
          }
          return updatedItem;
        }
        return item;
      }),
      { allowEmptyLanguage: true }
    ));
  }, []);

  /**
   * Move an item in the chain
   * @param {number} fromIndex - Index to move from
   * @param {number} toIndex - Index to move to
   */
  const moveItem = useCallback((fromIndex, toIndex) => {
    setChainItems(items => {
      const newItems = [...items];
      const [movedItem] = newItems.splice(fromIndex, 1);
      newItems.splice(toIndex, 0, movedItem);
      return normalizeLanguageChain(newItems, { allowEmptyLanguage: true });
    });
  }, []);

  /**
   * Get all language values from the chain
   * @returns {Array} - Array of language values
   */
  const getLanguageValues = useCallback(() => {
    return chainItems
      .filter(item => item.type === 'language' && !item.isOriginal)
      .map(item => item.value.trim())
      .filter(value => value !== '');
  }, [chainItems]);

  /**
   * Get all delimiter values from the chain
   * @returns {Array} - Array of delimiter values
   */
  const getDelimiterValues = useCallback(() => {
    return chainItems
      .filter(item => item.type === 'delimiter')
      .map(item => ({ value: item.value, style: item.style }));
  }, [chainItems]);

  /**
   * Check if the chain has at least one valid language
   * @returns {boolean} - True if at least one language has a value
   */
  const hasValidLanguage = useCallback(() => {
    return chainItems.some(item =>
      item.type === 'language' && !item.isOriginal && item.value.trim() !== ''
    );
  }, [chainItems]);

  /**
   * Check if the chain has only the original language
   * @returns {boolean} - True if only the original language is in the chain
   */
  const hasOnlyOriginalLanguage = useCallback(() => {
    // Check if there's at least one original language
    const hasOriginal = chainItems.some(item =>
      item.type === 'language' && item.isOriginal
    );

    // Check if there are no non-original languages with values
    const hasNoTargetLanguages = !chainItems.some(item =>
      item.type === 'language' && !item.isOriginal && item.value.trim() !== ''
    );

    return hasOriginal && hasNoTargetLanguages;
  }, [chainItems]);

  /**
   * Reset the chain to its initial state and clear localStorage
   */
  const resetChain = useCallback(() => {
    // Clear saved chain from localStorage
    try {
      localStorage.removeItem('language_chain_items');

    } catch (error) {
      console.error('Error clearing saved chain from localStorage:', error);
    }

    // Reset to initial state
    setChainItems(() => {
      return defaultLanguageChain(includeOriginal);
    });
  }, [includeOriginal]);

  // Save chain items to localStorage whenever they change
  useEffect(() => {
    try {
      // Don't save if the chain is empty or only has default items
      if (chainItems.length > 0) {
        const normalized = normalizeLanguageChain(chainItems, { allowEmptyLanguage: true });
        localStorage.setItem('language_chain_items', JSON.stringify(normalized));

      }
    } catch (error) {
      console.error('Error saving chain to localStorage:', error);
    }
  }, [chainItems]);

  return {
    chainItems,
    addLanguage,
    addOriginalLanguage,
    addDelimiter,
    removeItem,
    updateLanguage,
    updateDelimiter,
    moveItem,
    getLanguageValues,
    getDelimiterValues,
    hasValidLanguage,
    hasOnlyOriginalLanguage,
    resetChain
  };
};

export default useLanguageChain;
