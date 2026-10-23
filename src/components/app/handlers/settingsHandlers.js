import { cancelNativeVideoDownload } from "../../../platform/nativeUrlDownloadAdapter";
import {
  getCredentialAvailability,
  getCredentialStateSnapshot,
  initializeCredentialState,
} from "../../../platform/credentialStateController";
import { readPreference, writePreference } from "../../../platform/preferences/store";

const getNativeCredentialAvailability = (snapshot, useOAuth = false) => (
  getCredentialAvailability(snapshot, { useOAuth })
);


/**
 * Create settings/navigation handlers (save API keys, tab change, cancel download).
 * Closes over the app state setters passed in.
 */
export const createSettingsHandlers = ({
  currentDownloadId,
  setActiveTab,
  setStatus,
  setApiKeysSet,
  t,
}) => {
  /**
   * Handle cancelling the current download
   */
  const handleCancelDownload = () => {
    if (!currentDownloadId) return undefined;

    // The native URL adapter settles the exact operation's subscriber before this promise
    // resolves. `downloadAndPrepareYouTubeVideo` owns the resulting progress/status cleanup behind
    // its presentation token. Repeating that cleanup here has no ownership check: a delayed Cancel
    // for A could otherwise clear a newer B which became active while the command was in flight.
    return cancelNativeVideoDownload(currentDownloadId).then(
      () => undefined,
      () => undefined,
    );
  };

  /**
   * Handle tab change
   */
  const handleTabChange = (tab, isUserInitiated = true) => {
    // Only update user preference if this is a user-initiated change
    if (isUserInitiated) {
      writePreference("userPreferredTab", tab);
    }

    // Always update the current active tab
    writePreference("lastActiveTab", tab);
    setActiveTab(tab);

    // Choosing another acquisition surface is navigation, not a media mutation. The currently
    // active native project remains usable until a replacement is fully admitted and published.
    // This prevents a tab click from splitting React state away from Rust/session authority.
    if (isUserInitiated) setStatus({});
  };

  /**
   * Refresh app state after the Settings modal saved. Preferences have already been committed and
   * published by the preference store, and credentials by the native vault.
   */
  const saveApiKeys = async () => {
    // Update state based on the selected authentication method
    const useOAuth = readPreference("use_youtube_oauth");
    try {
      await initializeCredentialState();
      setApiKeysSet(getNativeCredentialAvailability(
        getCredentialStateSnapshot(),
        useOAuth
      ));
    } catch {
      setApiKeysSet({ gemini: false, youtube: false, genius: false });
    }

    // Show success notification
    setStatus({
      message: t("settings.savedSuccessfully", "Settings saved successfully!"),
      type: "success",
    });
  };

  return {
    handleCancelDownload,
    handleTabChange,
    saveApiKeys,
  };
};
