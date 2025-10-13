/**
 * Handles the pill sliding animation for tab components
 * This adds a Material Design 3 style pill background that slides between tabs
 */

/**
 * Initialize the pill sliding animation for the given tabs container
 * @param {string} tabsSelector - CSS selector for the tabs container
 */
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

    const k = 250;
    const c = 30;
    const ax = -k * (sim.x - sim.targetX) - c * sim.v;
    sim.v += ax * dt;
    sim.x += sim.v * dt;

    const kW = 300;
    const cW = 32;
    const dist = Math.abs(sim.targetX - sim.x);
    const vel = Math.abs(sim.v);
    const extra = Math.min(40, 0.2 * dist + 0.08 * vel);
    const dynamicTargetW = sim.targetW + extra;
    const aw = -kW * (sim.w - dynamicTargetW) - cW * sim.vw;
    sim.vw += aw * dt;
    sim.w += sim.vw * dt;

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
      
      sim.raf = 0;
      return;
    }
    sim.raf = requestAnimationFrame(step);
  }

  if (!sim.raf) sim.raf = requestAnimationFrame(step);
};

export const initTabPillAnimation = (tabsSelector = '.input-tabs') => {
  const tabContainers = document.querySelectorAll(tabsSelector);
  if (!tabContainers.length) return;
  ensureGooFilter();

  tabContainers.forEach(tabContainer => {
    if (!tabContainer.querySelector('.pill-overlay')) {
      const overlay = document.createElement('div');
      overlay.className = 'pill-overlay';
      overlay.innerHTML = '<div class="goo-blob"></div>';
      tabContainer.appendChild(overlay);
      tabContainer.classList.add('goo-ready');
    }

    positionPillForActiveTab(tabContainer);

    const tabButtons = tabContainer.querySelectorAll('.tab-btn');
    tabButtons.forEach(button => {
      button.addEventListener('click', () => {
        tabButtons.forEach(tab => {
          if (tab !== button) {
            tab.dataset.wasActive = 'false';
            tab.dataset.lastActive = 'false';
          }
        });
        setTimeout(() => positionPillForActiveTab(tabContainer), 10);
      });

      const setPressVars = (btn) => {
        if (btn.classList.contains('active')) {
          tabContainer.style.removeProperty('--press-pill-left');
          tabContainer.style.removeProperty('--press-pill-width');
          return;
        }
        const tabRect = btn.getBoundingClientRect();
        const containerRect = tabContainer.getBoundingClientRect();
        const left = tabRect.left - containerRect.left + tabContainer.scrollLeft;
        const pillPadding = 8;
        const naturalWidth = tabRect.width;
        const pressWidth = naturalWidth + pillPadding;
        tabContainer.style.setProperty('--press-pill-width', `${pressWidth}px`);
        tabContainer.style.setProperty('--press-pill-left', `${left - (pillPadding / 2)}px`);
      };
      const clearPressVars = () => {
        tabContainer.style.removeProperty('--press-pill-left');
        tabContainer.style.removeProperty('--press-pill-width');
      };

      ['pointerdown','mousedown','touchstart'].forEach(evt => {
        button.addEventListener(evt, () => setPressVars(button), { passive: true });
      });
      ['pointerup','mouseup','touchend','touchcancel','pointercancel','mouseleave','pointerout','blur'].forEach(evt => {
        button.addEventListener(evt, clearPressVars, { passive: true });
      });
    });

    window.addEventListener('resize', () => {
      tabButtons.forEach(tab => {
        tab.dataset.wasActive = 'false';
        tab.dataset.lastActive = 'false';
      });
      positionPillForActiveTab(tabContainer);
    });
  });
};

const positionPillForActiveTab = (tabContainer) => {
  const activeTab = tabContainer.querySelector('.tab-btn.active');

  if (!activeTab) {
    tabContainer.style.setProperty('--pill-width', '0px');
    tabContainer.style.setProperty('--pill-left', '0px');
    return;
  }

  const currentPillWidth = tabContainer.style.getPropertyValue('--pill-width');
  const isReclick = activeTab.dataset.wasActive === 'true' &&
                    activeTab.dataset.lastActive === 'true';

  if (currentPillWidth && currentPillWidth !== '0px' && isReclick) {
    return;
  }

  const allTabs = tabContainer.querySelectorAll('.tab-btn');
  allTabs.forEach(tab => {
    tab.dataset.lastActive = 'false';
  });

  activeTab.dataset.wasActive = 'true';
  activeTab.dataset.lastActive = 'true';

  const tabRect = activeTab.getBoundingClientRect();
  const containerRect = tabContainer.getBoundingClientRect();
  let left = tabRect.left - containerRect.left + tabContainer.scrollLeft;
  const pillPadding = 8;

  const tabClone = activeTab.cloneNode(true);
  tabClone.style.transform = 'none';
  tabClone.style.position = 'absolute';
  tabClone.style.visibility = 'hidden';
  tabClone.style.display = 'flex';
  tabClone.classList.remove('active');
  document.body.appendChild(tabClone);

  const naturalWidth = tabClone.getBoundingClientRect().width;
  document.body.removeChild(tabClone);

  const pillWidth = naturalWidth + pillPadding;
  const widthDifference = tabRect.width - (naturalWidth);
  left = left + (widthDifference / 2);

  const newLeftVal = left - (pillPadding / 2);
  const dir = (newLeftVal >= (parseFloat(tabContainer.style.getPropertyValue('--pill-left')) || 0)) ? 1 : -1;
  
  // These are for the CSS fallback and can be kept
  tabContainer.style.setProperty('--pill-width', `${pillWidth}px`);
  tabContainer.style.setProperty('--pill-left', `${newLeftVal}px`);
  
  // *** THE FIX IS HERE ***
  // We make the source blob 40px wider and shift it left by 20px.
  // This compensates for the blur shrinkage from the SVG goo filter,
  // ensuring the final VISIBLE pill has the correct, comfortable width.
  startGooSim(tabContainer, newLeftVal - 20, pillWidth + 40, dir);
};

export default initTabPillAnimation;