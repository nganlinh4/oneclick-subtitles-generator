import { useEffect, useState } from 'react';

import { fontCapabilitySnapshot, subscribeToFontReadiness } from './fontCapability';

/**
 * The current managed-font capability, re-rendering when native publishes a new one.
 *
 * WHY A SUBSCRIPTION AND NOT A READ. Native waits a bounded time for the font during startup; when
 * that wait expires the installation keeps running and can finish seconds later. A component that
 * read the capability once would show "unavailable" for the rest of the session, which is exactly
 * the defect this replaces. Every change advances an epoch, so a late success reaches the surface
 * that is on screen at the time.
 *
 * The snapshot is read again from the authority on every notification rather than taken from the
 * event, so there is one source of truth and no payload racing the global it describes.
 */
export const useFontReadiness = () => {
  const [capability, setCapability] = useState(fontCapabilitySnapshot);

  useEffect(() => {
    // Re-read on mount: native may have published between the initial render and this effect.
    setCapability(fontCapabilitySnapshot());
    return subscribeToFontReadiness(setCapability);
  }, []);

  return capability;
};

export default useFontReadiness;
