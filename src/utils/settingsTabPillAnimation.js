/**
 * Handles the pill sliding animation for settings tab components
 * This adds a Material Design 3 style pill background that slides between tabs
 */

/**
 * Initialize the pill sliding animation for the settings tabs
 * @param {string} tabsSelector - CSS selector for the settings tabs container
 */
// Goo filter (shared id with other tabs) + physics-based spring for settings droplet
const ensureGooFilter = () => {
  if (document.getElementById('goo')) return;
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('style', 'position:absolute;width:0;height:0;');
  svg.setAttribute('aria-hidden', 'true');
  svg.innerHTML = `
    <defs>
      <filter id="goo">
        <feGaussianBlur in="SourceGraphic" stdDeviation="8" result="blur" />
        <feColorMatrix in="blur" mode="matrix" values="
          1 0 0 0 0
          0 1 0 0 0
          0 0 1 0 0
          0 0 0 22 -10" result="goo" />
        <feBlend in="SourceGraphic" in2="goo" />
      </filter>
    </defs>`;
  document.body.appendChild(svg);
};

const settingsGooSims = new WeakMap();
const startSettingsGooSim = (tabContainer, targetLeft, targetWidth, dir) => {
  const overlay = tabContainer.querySelector('.pill-overlay');
  if (!overlay) return;
  const blob = overlay.querySelector('.goo-blob');
  if (!blob) return;

  let sim = settingsGooSims.get(tabContainer);
  let now = performance.now();
  if (!sim) {
    const computed = getComputedStyle(blob);
    const w0 = parseFloat(computed.width) || targetWidth;
    const bRect = blob.getBoundingClientRect();
    const oRect = overlay.getBoundingClientRect();
    let x0 = bRect.left - oRect.left;
    if (!Number.isFinite(x0)) x0 = targetLeft;
    sim = { x: x0, v: 0, w: w0, vw: 0, targetX: targetLeft, targetW: targetWidth, raf: 0 };
    settingsGooSims.set(tabContainer, sim);
  } else {
    sim.targetX = targetLeft;
    sim.targetW = targetWidth;
  }

  function step(ts) {
    const dt = Math.min(0.032, (ts - now) / 1000) || 0.016;
    now = ts;
    // Position spring
    const k = 130, c = 20;
    const ax = -k * (sim.x - sim.targetX) - c * sim.v;
    sim.v += ax * dt; sim.x += sim.v * dt;
    // Width spring coupled to distance + velocity for early blend
    const kW = 220, cW = 24;
    const dist = Math.abs(sim.targetX - sim.x);
    const vel = Math.abs(sim.v);
    const extra = Math.min(36, 0.32 * dist + 0.12 * vel);
    const dynamicTargetW = sim.targetW + extra;
    const aw = -kW * (sim.w - dynamicTargetW) - cW * sim.vw;
    sim.vw += aw * dt; sim.w += sim.vw * dt;

    // Apply
    blob.style.left = `${sim.x}px`;
    blob.style.width = `${Math.max(24, sim.w)}px`;

    // Subtle velocity squish
    const speed = Math.min(900, Math.abs(sim.v) * 60);
    const sx = 1 + (speed / 900) * 0.16;
    const sy = Math.max(0.88, 1 - (speed / 900) * 0.10);
    blob.style.transformOrigin = (dir >= 0 ? '0% 50%' : '100% 50%');
    blob.style.transform = `translateY(-50%) scaleX(${sx.toFixed(3)}) scaleY(${sy.toFixed(3)})`;

    const atRestX = Math.abs(sim.x - sim.targetX) < 0.5 && Math.abs(sim.v) < 5;
    const atRestW = Math.abs(sim.w - sim.targetW) < 0.5 && Math.abs(sim.vw) < 5;
    if (atRestX && atRestW) {
      blob.style.transform = 'translateY(-50%) scaleX(1) scaleY(1)';
      sim.raf = 0; return;
    }
    sim.raf = requestAnimationFrame(step);
  }

  if (!sim.raf) sim.raf = requestAnimationFrame(step);
};

export const initSettingsTabPillAnimation = (tabsSelector = '.settings-tabs') => {
  // Find all settings tab containers
  const tabContainers = document.querySelectorAll(tabsSelector);
  if (!tabContainers.length) return;

  // Prepare goo filter once
  ensureGooFilter();

  // For each tab container, set up the overlay and animation
  tabContainers.forEach(tabContainer => {
    // Ensure goo overlay exists
    if (!tabContainer.querySelector('.pill-overlay')) {
      const overlay = document.createElement('div');
      overlay.className = 'pill-overlay';
      overlay.innerHTML = '<div class="goo-blob"></div>';
      tabContainer.appendChild(overlay);
      tabContainer.classList.add('goo-ready');
    }

    // Initial positioning of the pill
    positionPillForActiveTab(tabContainer);

    // Add event listeners to all tab buttons
    const tabButtons = tabContainer.querySelectorAll('.settings-tab');
    tabButtons.forEach(button => {
      button.addEventListener('click', () => {
        // Reset wasActive and lastActive flags on all tabs when any tab is clicked
        tabButtons.forEach(tab => {
          if (tab !== button) {
            tab.dataset.wasActive = 'false';
            tab.dataset.lastActive = 'false';
          }
        });
        // Small delay to allow the active class to be applied
        setTimeout(() => positionPillForActiveTab(tabContainer), 10);
      });
    });

    // Also handle window resize events
    window.addEventListener('resize', () => {
      // Reset wasActive and lastActive flags on resize to ensure proper recalculation
      tabButtons.forEach(tab => {
        tab.dataset.wasActive = 'false';
        tab.dataset.lastActive = 'false';
      });
      positionPillForActiveTab(tabContainer);
    });
  });
};

/**
 * Position the pill background for the active tab
 * @param {HTMLElement} tabContainer - The tabs container element
 */
const positionPillForActiveTab = (tabContainer) => {
  const activeTab = tabContainer.querySelector('.settings-tab.active');

  // If no active tab, hide the pill
  if (!activeTab) {
    tabContainer.style.setProperty('--settings-pill-width', '0px');
    tabContainer.style.setProperty('--settings-pill-left', '0px');
    return;
  }

  // Check if pill width is already set and this is just a re-click on the same tab
  // Only skip recalculation if it's the same tab being clicked again
  const currentPillWidth = tabContainer.style.getPropertyValue('--settings-pill-width');
  const isReclick = activeTab.dataset.wasActive === 'true' &&
                    activeTab.dataset.lastActive === 'true';

  if (currentPillWidth && currentPillWidth !== '0px' && isReclick) {
    // This is a re-click on the same tab, no need to recalculate
    return;
  }

  // Mark all tabs as not being the last active tab
  const allTabs = tabContainer.querySelectorAll('.settings-tab');
  allTabs.forEach(tab => {
    tab.dataset.lastActive = 'false';
  });

  // Mark this tab as having been active and as the last active tab
  activeTab.dataset.wasActive = 'true';
  activeTab.dataset.lastActive = 'true';

  // Get the position and dimensions of the active tab
  const tabRect = activeTab.getBoundingClientRect();
  const containerRect = tabContainer.getBoundingClientRect();

  // Calculate the left position relative to the container
  let left = tabRect.left - containerRect.left + tabContainer.scrollLeft;

  // Add a small padding to make the pill slightly wider than the tab for a more modern look
  const pillPadding = 6; // total extra width (3px per side)

  // Create a clone of the active tab to measure its true width without scaling
  const tabClone = activeTab.cloneNode(true);
  tabClone.style.transform = 'none'; // Remove any transform
  tabClone.style.position = 'absolute';
  tabClone.style.visibility = 'hidden';
  tabClone.style.display = 'flex'; // Ensure it's displayed the same way
  tabClone.classList.remove('active'); // Remove active class to avoid scaling
  document.body.appendChild(tabClone);

  // Get the natural width of the tab without scaling
  const naturalWidth = tabClone.getBoundingClientRect().width;

  // Clean up
  document.body.removeChild(tabClone);

  // Calculate pill width based on the natural width plus padding
  const pillWidth = naturalWidth + pillPadding;

  // Adjust the left position to account for the scaling effect
  // The scaling happens from the center, so we need to adjust the left position
  const widthDifference = tabRect.width - (naturalWidth);
  left = left + (widthDifference / 2);

  // Set the custom properties for the CSS fallback/background
  tabContainer.style.setProperty('--settings-pill-width', `${pillWidth}px`);
  const cssLeft = left - (pillPadding / 2);
  tabContainer.style.setProperty('--settings-pill-left', `${cssLeft}px`);

  // Physics-driven goo droplet
  const computed = getComputedStyle(tabContainer);
  const prevLeftVal = parseFloat(computed.getPropertyValue('--settings-pill-left')) || parseFloat(tabContainer.style.getPropertyValue('--settings-pill-left')) || 0;
  const newLeftVal = left - (pillPadding / 2);
  const travel = Math.abs(newLeftVal - prevLeftVal);
  const dir = (newLeftVal >= prevLeftVal) ? 1 : -1;

  // Slight visual offset to look more liquid like the input tabs
  startSettingsGooSim(tabContainer, newLeftVal, pillWidth, dir);
};

export default initSettingsTabPillAnimation;
