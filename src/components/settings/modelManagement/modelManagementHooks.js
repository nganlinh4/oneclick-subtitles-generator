import { useState, useEffect, useCallback } from 'react';
import { getModels, getModelDownloadStatus, getModelStorageInfo, scanModelsDirectory } from '../../../services/modelService';
import { invalidateModelsCache } from '../../../services/modelAvailabilityService';
import { checkNarrationStatus } from '../../../services/narrationService';

/**
 * Custom hook for managing models
 * @returns {Object} - Models state and functions
 */
export const useModels = () => {
  const [models, setModels] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [isScanning, setIsScanning] = useState(false);
  const [modelSizes, setModelSizes] = useState({});
  const [isServiceAvailable, setIsServiceAvailable] = useState(false);

  // Check if narration service is available
  const checkServiceAvailability = useCallback(async () => {
    try {
      const status = await checkNarrationStatus();
      setIsServiceAvailable(status.available);
      return status.available;
    } catch (error) {
      console.error('Error checking narration service availability:', error);
      setIsServiceAvailable(false);
      return false;
    }
  }, []);

  // Fetch models from API
  const fetchModels = useCallback(async () => {
    try {
      // First check if service is available
      const available = await checkServiceAvailability();
      if (!available) {
        setLoading(false);
        return null;
      }

      setLoading(true);
      const data = await getModels(false); // Never include cache models
      setModels(data.models || []);

      // Invalidate the models cache to notify other components
      invalidateModelsCache();

      setError(null);
      return data;
    } catch (err) {
      setError(err.message || 'Failed to fetch models');
      console.error('Error fetching models:', err);
      return null;
    } finally {
      setLoading(false);
    }
  }, [checkServiceAvailability]);

  // Function to scan for models in the f5_tts directory
  const scanForModels = useCallback(async () => {
    // Don't scan if already scanning or if service is not available
    if (isScanning) return;

    // Check if service is available before scanning
    const available = await checkServiceAvailability();
    if (!available) {
      return;
    }

    try {
      setIsScanning(true);
      // Starting model directory scan

      // Call the simple Node.js scan API
      try {
        const scanResult = await scanModelsDirectory();

        if (scanResult.success) {
          // Models scan completed successfully

          // Refresh the models list from the updated registry
          const data = await getModels(false);
          setModels(data.models || []);
          invalidateModelsCache();

          // Models list refreshed
        } else {
          // Model scan failed
        }
      } catch (scanError) {
        // Scan API failed
      }

      // Update model sizes for all models
      const sizes = {};
      for (const model of models) {
        if (model.model_path && model.id !== 'f5tts-v1-base') {
          try {
            const storageInfo = await getModelStorageInfo(model.id);
            if (storageInfo && storageInfo.size) {
              sizes[model.id] = storageInfo.size;
            }
          } catch (error) {
            // Error getting model size
          }
        }
      }

      setModelSizes(prev => ({...prev, ...sizes}));
    } catch (error) {
      // Error scanning for models
    } finally {
      setIsScanning(false);
    }
  }, [isScanning, models, setIsScanning, setModels, setModelSizes, checkServiceAvailability]);

  // Fetch models on component mount
  useEffect(() => {
    fetchModels();
  }, [fetchModels]);

  // Check service availability on component mount
  useEffect(() => {
    checkServiceAvailability();
  }, [checkServiceAvailability]);

  // Set up periodic scanning for models in the f5_tts directory
  useEffect(() => {
    // Run a single delayed scan when the tab mounts (e.g., when switching to Settings)
    const initialScanTimeout = setTimeout(() => {
      // Only scan when the document is visible to avoid hidden-tab noise
      if (typeof document === 'undefined' || !document.hidden) {
        scanForModels();
      }
    }, 2000);

    // No recurring interval: manual refresh and tab switches are sufficient

    return () => {
      clearTimeout(initialScanTimeout);
    };
  }, [scanForModels]);

  return {
    models,
    loading,
    error,
    isScanning,
    modelSizes,
    isServiceAvailable,
    fetchModels,
    scanForModels,
    checkServiceAvailability
  };
};

/**
 * Custom hook for managing downloads
 * @param {Function} fetchModels - Function to fetch models
 * @returns {Object} - Downloads state and functions
 */
export const useDownloads = (fetchModels) => {
  const [downloads, setDownloads] = useState({});
  const [isServiceAvailable, setIsServiceAvailable] = useState(false);

  // Check if narration service is available
  const checkServiceAvailability = useCallback(async () => {
    try {
      const status = await checkNarrationStatus();
      setIsServiceAvailable(status.available);
      return status.available;
    } catch (error) {
      console.error('Error checking narration service availability in useDownloads:', error);
      setIsServiceAvailable(false);
      return false;
    }
  }, []);

  // Check service availability on component mount
  useEffect(() => {
    checkServiceAvailability();
  }, [checkServiceAvailability]);

  // Set up polling for download status
  useEffect(() => {
    const checkDownloadStatus = async () => {
      // Check status of all downloads (only if there is something to track)
      const downloadIds = Object.keys(downloads);
      if (downloadIds.length === 0) return;

      // Respect current service availability without re-checking every tick
      if (!isServiceAvailable) return;

      for (const modelId of downloadIds) {
        const downloadInfo = downloads[modelId];

        // Only check status for downloads in progress
        // Skip cancelled downloads
        if (downloadInfo.status === 'downloading' && downloadInfo.status !== 'cancelled') {
          try {
            const statusData = await getModelDownloadStatus(modelId);

            if (statusData.status === null) {
              // If status is null, it means the download is no longer tracked by the server
              // This could happen if the download completed and the server removed the status
              // Refresh models and remove from downloads state
              fetchModels();
              setDownloads(prev => {
                const newDownloads = { ...prev };
                delete newDownloads[modelId];
                return newDownloads;
              });
            } else if (statusData.status) {
              // Update download status
              setDownloads(prev => ({
                ...prev,
                [modelId]: {
                  status: statusData.status,
                  progress: statusData.progress,
                  error: statusData.error
                }
              }));

              // If download is complete, refresh models and remove from downloads state after a delay
              if (statusData.status === 'completed') {
                // Refresh models immediately to show the new model in the installed section
                fetchModels();

                // Remove the completed download from state after a short delay
                setTimeout(() => {
                  setDownloads(prev => {
                    const newDownloads = { ...prev };
                    delete newDownloads[modelId];
                    return newDownloads;
                  });
                }, 1000); // 1 second delay to show completion
              }
            }
          } catch (err) {
            console.error(`Error checking download status for ${modelId}:`, err);
          }
        }
      }
    };

    // Poll every 2 seconds
    const interval = setInterval(checkDownloadStatus, 2000);

    return () => clearInterval(interval);
  }, [downloads, fetchModels, isServiceAvailable]);

  // Update downloads with server data
  const updateDownloads = (serverDownloads) => {
    if (serverDownloads) {
      setDownloads(serverDownloads);
    }
  };

  return {
    downloads,
    setDownloads,
    updateDownloads,
    isServiceAvailable
  };
};
