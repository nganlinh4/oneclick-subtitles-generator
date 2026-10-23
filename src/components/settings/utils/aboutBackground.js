import { readPreference, writePreference } from '../../../platform/preferences/store';

/** Picks the About tab background, avoiding the last three picks. */
export const pickNextAboutBackground = () => {
  const allBackgroundOptions = ['default', 'alternative', '1', '2', '3', '4', '5'];

  let recentBackgrounds = [...readPreference('about_background_history')];

  // Filter out recently used backgrounds (if we have enough options)
  // We'll avoid reusing the last 3 backgrounds if possible
  let availableOptions = [...allBackgroundOptions];

  // Only filter if we have enough options to choose from
  if (allBackgroundOptions.length > recentBackgrounds.length) {
    availableOptions = allBackgroundOptions.filter(
      option => !recentBackgrounds.includes(option)
    );
  }

  // If we somehow filtered out all options, use all backgrounds
  if (availableOptions.length === 0) {
    availableOptions = [...allBackgroundOptions];
  }

  // Select a random background from available options
  const randomBackground = availableOptions[Math.floor(Math.random() * availableOptions.length)];

  // Update the history - add the new background and keep only the last 3
  recentBackgrounds.unshift(randomBackground);
  if (recentBackgrounds.length > 3) {
    recentBackgrounds = recentBackgrounds.slice(0, 3);
  }

  writePreference('about_background_history', recentBackgrounds);
  writePreference('about_background_type', randomBackground);

  return randomBackground;
};
