// Compatibility surface for callers that still distinguish a legacy HTTP helper from direct
// provider/native execution. The Tauri application never starts or probes that helper.
const LEGACY_SERVICE_AVAILABLE = false;

export const probeServerAvailability = async () => LEGACY_SERVICE_AVAILABLE;
export const getServerAvailabilityCached = () => LEGACY_SERVICE_AVAILABLE;
export const isFrontendOnly = async () => true;
export const isServerAvailableSync = () => LEGACY_SERVICE_AVAILABLE;
export const isFrontendOnlySync = () => true;
