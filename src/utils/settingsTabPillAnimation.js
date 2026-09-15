/**
 * Handles the pill sliding animation for settings tab components
 * This adds a Material Design 3 style pill background that slides between tabs
 */

import { scrollActiveSettingsTab } from './settingsTabVisibility';

// Standardize goo filter to match the high-quality one from other tabs
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
        <feGaussianBlur in="SourceGraphic" stdDeviation="10" result="blur" />
        <feColorMatrix in="blur" mode="matrix" values="
          1 0 0 0 0
          0 1 0 0 0
          0 0 1 0 0
          0 0 0 28 -11" result="goo" />
        <feBlend in="SourceGraphic" in2="goo" />
      </filter>
    </defs>`;
  document.body.appendChild(svg);
};

// Use the new snappy, precise physics simulation
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
    let x0 = parseFloat(computed.left);
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
    const k = 250, c = 30;
    const ax = -k * (sim.x - sim.targetX) - c * sim.v;
    sim.v += ax * dt; sim.x += sim.v * dt;

    const kW = 300, cW = 32;
    const dist = Math.abs(sim.targetX - sim.x);
    const vel = Math.abs(sim.v);
    const extra = Math.min(40, 0.2 * dist + 0.08 * vel);
    const dynamicTargetW = sim.targetW + extra;
    const aw = -kW * (sim.w - dynamicTargetW) - cW * sim.vw;
    sim.vw += aw * dt; sim.w += sim.vw * dt;

    blob.style.left = `${sim.x}px`;
    blob.style.width = `${Math.max(28, sim.w)}px`;

    const speed = Math.min(1000, Math.abs(sim.v) * 60);
    const sx = 1 + (speed / 1000) * 0.1;
    const sy = 1 - (speed / 1000) * 0.08;
    const skew = Math.min(4, Math.abs(sim.v) * 0.012) * (dir > 0 ? -1 : 1);
    
    const pillHeight = 45; 
    const maxRadius = pillHeight / 2;
    const dynamicRadius = (maxRadius / sy).toFixed(1);
    blob.style.borderRadius = `${dynamicRadius}px`;

    blob.style.transformOrigin = (dir >= 0 ? '0% 50%' : '100% 50%');
    blob.style.transform = `translateY(-50%) scaleX(${sx.toFixed(3)}) scaleY(${sy.toFixed(3)}) skewX(${skew.toFixed(2)}deg)`;

    const atRestX = Math.abs(sim.x - sim.targetX) < 0.1 && Math.abs(sim.v) < 0.1;
    const atRestW = Math.abs(sim.w - sim.targetW) < 0.1 && Math.abs(sim.vw) < 0.1;
    if (atRestX && atRestW) {
      blob.style.left = `${sim.targetX}px`;
      blob.style.width = `${sim.targetW}px`;
      blob.style.transform = 'translateY(-50%)';
      blob.style.borderRadius = '';
      sim.raf = 0; return;
    }
    sim.raf = requestAnimationFrame(step);
  }

  if (!sim.raf) sim.raf = requestAnimationFrame(step);
};

export const initSettingsTabPillAnimation = (tabsSelector = '.settings-tabs') => {
  const tabContainers = document.querySelectorAll(tabsSelector);
  if (!tabContainers.length) return;
  ensureGooFilter();

  const initializedContainers = [];
  tabContainers.forEach(tabContainer => {
    // A Settings modal can be opened repeatedly in one app session. Replace the
    // previous lifecycle instead of accumulating click/resize listeners.
    tabContainer._cleanupSettingsTabPill?.();

    if (!tabContainer.querySelector('.pill-overlay')) {
      const overlay = document.createElement('div');
      overlay.className = 'pill-overlay';
      overlay.innerHTML = '<div class="goo-blob"></div>';
      tabContainer.appendChild(overlay);
      tabContainer.classList.add('goo-ready');
    }

    positionPillForActiveTab(tabContainer);

    const tabButtons = tabContainer.querySelectorAll('.settings-tab');
    const buttonListeners = [];
    const positionTimers = new Set();
    tabButtons.forEach(button => {
      const handleClick = () => {
        tabButtons.forEach(tab => {
          if (tab !== button) {
            tab.dataset.wasActive = 'false';
            tab.dataset.lastActive = 'false';
          }
        });
        const timer = setTimeout(() => {
          positionTimers.delete(timer);
          positionPillForActiveTab(tabContainer);
        }, 10);
        positionTimers.add(timer);
      };
      button.addEventListener('click', handleClick);
      buttonListeners.push({ button, handleClick });
    });

    const handleResize = () => {
      tabButtons.forEach(tab => {
        tab.dataset.wasActive = 'false';
        tab.dataset.lastActive = 'false';
      });
      scrollActiveSettingsTab(tabContainer, tabContainer.querySelector('.settings-tab.active'));
      positionPillForActiveTab(tabContainer);
    };
    window.addEventListener('resize', handleResize);

    // A locale or application-font change can move and resize the existing tab
    // elements without changing the active tab key or resizing the window. The
    // active-pill reclick guard would otherwise keep the previous geometry and
    // leave a second, empty-looking pill behind. Observe every tab as well as the
    // strip: a preceding tab changing width can move the active tab even when the
    // active tab's own width is unchanged.
    const geometryObserver = typeof ResizeObserver === 'function'
      ? new ResizeObserver(handleResize)
      : null;
    geometryObserver?.observe(tabContainer);
    tabButtons.forEach(tab => geometryObserver?.observe(tab));

    const cleanupPill = () => {
      buttonListeners.forEach(({ button, handleClick }) => {
        button.removeEventListener('click', handleClick);
      });
      positionTimers.forEach(clearTimeout);
      positionTimers.clear();
      window.removeEventListener('resize', handleResize);
      geometryObserver?.disconnect();

      const simulation = settingsGooSims.get(tabContainer);
      if (simulation?.raf) cancelAnimationFrame(simulation.raf);
      settingsGooSims.delete(tabContainer);
    };
    tabContainer._cleanupSettingsTabPill = cleanupPill;
    initializedContainers.push({ tabContainer, cleanupPill });
  });

  return () => {
    initializedContainers.forEach(({ tabContainer, cleanupPill }) => {
      if (tabContainer._cleanupSettingsTabPill === cleanupPill) {
        cleanupPill();
        delete tabContainer._cleanupSettingsTabPill;
      }
    });
  };
};

export const positionPillForActiveTab = (tabContainer) => {
  const activeTab = tabContainer.querySelector('.settings-tab.active');

  if (!activeTab) {
    tabContainer.style.setProperty('--settings-pill-width', '0px');
    tabContainer.style.setProperty('--settings-pill-left', '0px');
    return;
  }

  const currentPillWidth = tabContainer.style.getPropertyValue('--settings-pill-width');
  const isReclick = activeTab.dataset.wasActive === 'true' &&
                    activeTab.dataset.lastActive === 'true';

  if (currentPillWidth && currentPillWidth !== '0px' && isReclick) {
    return;
  }

  const allTabs = tabContainer.querySelectorAll('.settings-tab');
  allTabs.forEach(tab => {
    tab.dataset.lastActive = 'false';
  });

  activeTab.dataset.wasActive = 'true';
  activeTab.dataset.lastActive = 'true';

  // CSS left/width use layout pixels, not the zoomed viewport pixels returned
  // by getBoundingClientRect. Mixing them scales the highlight twice.
  let left = activeTab.offsetLeft;
  
  // *** THE FIRST FIX IS HERE ***
  // Revert to your original "tight" padding for the settings pill.
  const pillPadding = 6; // total extra width (3px per side)

  const tabClone = activeTab.cloneNode(true);
  tabClone.style.transform = 'none';
  tabClone.style.position = 'absolute';
  tabClone.style.visibility = 'hidden';
  tabClone.style.display = 'flex';
  tabClone.classList.remove('active');
  document.body.appendChild(tabClone);
  const naturalWidth = tabClone.offsetWidth;
  document.body.removeChild(tabClone);

  const pillWidth = naturalWidth + pillPadding;
  const widthDifference = activeTab.offsetWidth - naturalWidth;
  left = left + (widthDifference / 2);

  const newLeftVal = left - (pillPadding / 2);
  const prevLeftVal = parseFloat(tabContainer.style.getPropertyValue('--settings-pill-left')) || 0;
  const dir = (newLeftVal >= prevLeftVal) ? 1 : -1;
  
  tabContainer.style.setProperty('--settings-pill-width', `${pillWidth}px`);
  tabContainer.style.setProperty('--settings-pill-left', `${newLeftVal}px`);

  // *** THE SECOND FIX IS HERE ***
  // Apply a subtle compensation for the goo filter, respecting the "tight" design.
  // We add just 12px total to the source blob, which the blur will shrink
  // back to a visual result very close to your original `pillPadding = 6`.
  startSettingsGooSim(tabContainer, newLeftVal - 6, pillWidth + 12, dir);
};

export default initSettingsTabPillAnimation;
