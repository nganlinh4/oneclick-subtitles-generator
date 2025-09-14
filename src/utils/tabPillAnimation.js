/**
 * Handles the pill sliding animation for tab components
 * This adds a Material Design 3 style pill background that slides between tabs
 */

/**
 * Initialize the pill sliding animation for the given tabs container
 * @param {string} tabsSelector - CSS selector for the tabs container
 */
// Ensure a reusable SVG goo filter exists in the DOM
const ensureGooFilter = () => {
  if (document.getElementById('goo-filter-defs')) return;
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('id', 'goo-filter-defs');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  Object.assign(svg.style, { position: 'absolute', width: '0', height: '0', pointerEvents: 'none', visibility: 'hidden' });

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

// Simple spring physics animator for goo blob (per-container)
const gooSims = new WeakMap();

const startGooSim = (tabContainer, targetLeft, targetWidth, dir) => {
  const overlay = tabContainer.querySelector('.pill-overlay');
  if (!overlay) return;
  const blob = overlay.querySelector('.goo-blob');
  if (!blob) return;

  let sim = gooSims.get(tabContainer);
  let now = performance.now();

  if (!sim) {
    const computed = getComputedStyle(blob);
    const w0 = parseFloat(computed.width) || targetWidth;
    // Compute current left relative to overlay
    const bRect = blob.getBoundingClientRect();
    const oRect = overlay.getBoundingClientRect();
    let x0 = bRect.left - oRect.left;
    if (!Number.isFinite(x0)) x0 = targetLeft;
    sim = { x: x0, v: 0, w: w0, vw: 0, targetX: targetLeft, targetW: targetWidth, raf: 0 };
    gooSims.set(tabContainer, sim);
  } else {
    sim.targetX = targetLeft;
    sim.targetW = targetWidth;
  }

  function step(ts) {
    const dt = Math.min(0.032, (ts - now) / 1000) || 0.016;
    now = ts;

    // Horizontal spring
    const k = 120;   // stiffness
    const c = 20;    // damping
    const ax = -k * (sim.x - sim.targetX) - c * sim.v;
    sim.v += ax * dt;
    sim.x += sim.v * dt;

    // Width spring coupled to distance AND velocity so the blend starts earlier
    const kW = 220;
    const cW = 24;
    const dist = Math.abs(sim.targetX - sim.x);
    const vel = Math.abs(sim.v);
    const extra = Math.min(40, 0.35 * dist + 0.12 * vel); // cap extra stretch
    const dynamicTargetW = sim.targetW + extra;
    const aw = -kW * (sim.w - dynamicTargetW) - cW * sim.vw;
    sim.vw += aw * dt;
    sim.w += sim.vw * dt;

    // Apply
    blob.style.left = `${sim.x}px`;
    blob.style.width = `${Math.max(28, sim.w)}px`;

    // Velocity-based squish; faster move = more stretch, but keep it subtle
    const speed = Math.min(900, Math.abs(sim.v) * 60);
    const sx = 1 + (speed / 900) * 0.18;       // up to ~1.18x
    const sy = 1 - (speed / 900) * 0.12;       // down to ~0.88x
    const syClamped = Math.max(0.86, sy);
    blob.style.transformOrigin = (dir >= 0 ? '0% 50%' : '100% 50%');
    blob.style.transform = `translateY(-50%) scaleX(${sx.toFixed(3)}) scaleY(${syClamped.toFixed(3)})`;

    const atRestX = Math.abs(sim.x - sim.targetX) < 0.5 && Math.abs(sim.v) < 5;
    const atRestW = Math.abs(sim.w - sim.targetW) < 0.5 && Math.abs(sim.vw) < 5;
    if (atRestX && atRestW) {
      blob.style.transform = 'translateY(-50%) scaleX(1) scaleY(1)';
      sim.raf = 0;
      return;
    }
    sim.raf = requestAnimationFrame(step);
  }

  if (!sim.raf) sim.raf = requestAnimationFrame(step);
};

export const initTabPillAnimation = (tabsSelector = '.input-tabs') => {
  // Find all tab containers
  const tabContainers = document.querySelectorAll(tabsSelector);

  if (!tabContainers.length) return;

  // Prepare SVG goo filter for gooey effect
  ensureGooFilter();

  // For each tab container, set up the animation
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
    const tabButtons = tabContainer.querySelectorAll('.tab-btn');
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

      // Press overlay geometry for non-active tabs so the hold state matches the tab size
      const setPressVars = (btn) => {
        // If pressing the active tab, let CSS fall back to --pill-*; no overrides needed
        if (btn.classList.contains('active')) {
          tabContainer.style.removeProperty('--press-pill-left');
          tabContainer.style.removeProperty('--press-pill-width');
          return;
        }
        const tabRect = btn.getBoundingClientRect();
        const containerRect = tabContainer.getBoundingClientRect();
        const left = tabRect.left - containerRect.left + tabContainer.scrollLeft;
        const pillPadding = 8; // keep in sync with positionPillForActiveTab
        const naturalWidth = tabRect.width; // non-active tabs are not scaled
        const pressWidth = naturalWidth + pillPadding;
        tabContainer.style.setProperty('--press-pill-width', `${pressWidth}px`);
        tabContainer.style.setProperty('--press-pill-left', `${left - (pillPadding / 2)}px`);
      };
      const clearPressVars = () => {
        tabContainer.style.removeProperty('--press-pill-left');
        tabContainer.style.removeProperty('--press-pill-width');
      };

      // Attach press/hold listeners
      ['pointerdown','mousedown','touchstart'].forEach(evt => {
        button.addEventListener(evt, () => setPressVars(button), { passive: true });
      });
      ['pointerup','mouseup','touchend','touchcancel','pointercancel','mouseleave','pointerout','blur'].forEach(evt => {
        button.addEventListener(evt, clearPressVars, { passive: true });
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
  const activeTab = tabContainer.querySelector('.tab-btn.active');

  // If no active tab, hide the pill
  if (!activeTab) {
    tabContainer.style.setProperty('--pill-width', '0px');
    tabContainer.style.setProperty('--pill-left', '0px');
    return;
  }

  // Check if pill width is already set and this is just a re-click on the same tab
  // Only skip recalculation if it's the same tab being clicked again
  const currentPillWidth = tabContainer.style.getPropertyValue('--pill-width');
  const isReclick = activeTab.dataset.wasActive === 'true' &&
                    activeTab.dataset.lastActive === 'true';

  if (currentPillWidth && currentPillWidth !== '0px' && isReclick) {
    // This is a re-click on the same tab, no need to recalculate
    return;
  }

  // Mark all tabs as not being the last active tab
  const allTabs = tabContainer.querySelectorAll('.tab-btn');
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
  const pillPadding = 8; // 4px on each side

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

  // Determine direction and travel for liquid motion
  const computed = getComputedStyle(tabContainer);
  const prevLeftVal = parseFloat(computed.getPropertyValue('--pill-left')) || parseFloat(tabContainer.style.getPropertyValue('--pill-left')) || 0;
  const newLeftVal = left - (pillPadding / 2);
  const travel = Math.abs(newLeftVal - prevLeftVal);
  const dir = (newLeftVal >= prevLeftVal) ? 1 : -1;
  const delayMs = Math.round(Math.min(140, Math.max(70, travel * 0.25)));

  // Motion tuning variables for CSS
  tabContainer.style.setProperty('--pill-origin-x', dir >= 0 ? '0%' : '100%');
  tabContainer.style.setProperty('--pill-left-delay', dir > 0 ? `${delayMs}ms` : '0ms');
  tabContainer.style.setProperty('--pill-width-delay', dir > 0 ? '0ms' : `${delayMs}ms`);
  tabContainer.style.setProperty('--pill-travel', `${travel}px`);

  // Set the geometry variables
  tabContainer.style.setProperty('--pill-width', `${pillWidth}px`);
  tabContainer.style.setProperty('--pill-left', `${newLeftVal}px`);


  // Start physics-based goo animation (spring)
  startGooSim(tabContainer, newLeftVal - 20, pillWidth + 40, dir);

};

export default initTabPillAnimation;
