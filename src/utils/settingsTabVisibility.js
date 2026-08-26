const clamp = (value, minimum, maximum) => Math.min(maximum, Math.max(minimum, value));

/** Return a bounded scrollLeft that centres one tab inside its own strip. */
export const settingsTabScrollTarget = ({
  clientWidth,
  scrollWidth,
  scrollLeft,
  containerLeft,
  activeLeft,
  activeWidth,
}) => {
  const values = [
    clientWidth, scrollWidth, scrollLeft, containerLeft, activeLeft, activeWidth,
  ];
  if (!values.every(Number.isFinite) || clientWidth <= 0 || activeWidth < 0) return null;

  const maximum = Math.max(0, scrollWidth - clientWidth);
  if (maximum === 0) return null;
  const activeCentreInScrollSpace = activeLeft - containerLeft
    + scrollLeft
    + (activeWidth / 2);
  const target = clamp(activeCentreInScrollSpace - (clientWidth / 2), 0, maximum);
  return Math.abs(target - scrollLeft) < 0.5 ? null : target;
};

/** Scroll only the Settings tabs strip; never a modal ancestor or the document. */
export const scrollActiveSettingsTab = (tabs, activeButton) => {
  if (!tabs || !activeButton) return null;
  const containerRect = tabs.getBoundingClientRect();
  const activeRect = activeButton.getBoundingClientRect();
  const target = settingsTabScrollTarget({
    clientWidth: tabs.clientWidth,
    scrollWidth: tabs.scrollWidth,
    scrollLeft: tabs.scrollLeft,
    containerLeft: containerRect.left,
    activeLeft: activeRect.left,
    activeWidth: activeRect.width,
  });
  if (target === null) return null;

  if (typeof tabs.scrollTo === 'function') {
    tabs.scrollTo({ left: target, behavior: 'smooth' });
  } else {
    tabs.scrollLeft = target;
  }
  return target;
};
