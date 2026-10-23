// Settings modal chrome geometry: the title, close and footer stay inside the viewport on every tab.
/* global browser, document, getComputedStyle, window */

import { strict as assert } from 'node:assert';

const settingsChromeGeometry = () => browser.execute(() => {
  const selectorFor = (node) => {
    if (node === null || typeof node.tagName !== 'string') return null;
    const className = [...node.classList].slice(0, 3).join('.');
    return `${node.tagName.toLowerCase()}${node.id ? `#${node.id}` : ''}${className ? `.${className}` : ''}`;
  };
  const rectangle = (selector) => {
    const node = document.querySelector(selector);
    if (node === null) return null;
    const rect = node.getBoundingClientRect();
    return {
      left: rect.left,
      top: rect.top,
      right: rect.right,
      bottom: rect.bottom,
      width: rect.width,
      height: rect.height,
    };
  };
  const ownsPaintedPoint = (selector) => {
    const node = document.querySelector(selector);
    if (node === null) return null;
    const rect = node.getBoundingClientRect();
    // Rounded controls intentionally leave transparent corner pixels. The painted centre is the
    // point a real pointer action owns, so checking it detects an overlay without misclassifying
    // the button's own border radius as occlusion.
    const points = [[rect.left + rect.width / 2, rect.top + rect.height / 2]];
    return points.map(([x, y]) => {
      const painted = document.elementFromPoint(x, y);
      return {
        x,
        y,
        owns: painted !== null && (painted === node || node.contains(painted)),
        painted: selectorFor(painted),
      };
    });
  };
  const overlay = document.querySelector('.settings-modal-overlay');
  const modal = document.querySelector('.settings-modal');
  const header = document.querySelector('.settings-header');
  const content = document.querySelector('.settings-content');
  const footer = document.querySelector('.settings-footer');
  const historyContainer = document.querySelector('.toast-history-button-container');
  const historyButton = historyContainer?.querySelector('.toast-history-button') ?? null;
  const historyStyle = historyContainer === null ? null : getComputedStyle(historyContainer);
  return {
    viewport: { width: window.innerWidth, height: window.innerHeight },
    overlayPointerEvents: overlay === null ? null : getComputedStyle(overlay).pointerEvents,
    horizontalScroll: {
      window: window.scrollX,
      document: document.documentElement.scrollLeft,
      body: document.body.scrollLeft,
      overlay: document.querySelector('.settings-modal-overlay')?.scrollLeft ?? null,
      modal: document.querySelector('.settings-modal')?.scrollLeft ?? null,
      header: document.querySelector('.settings-header')?.scrollLeft ?? null,
      content: document.querySelector('.settings-content')?.scrollLeft ?? null,
    },
    verticalScroll: {
      window: window.scrollY,
      document: document.documentElement.scrollTop,
      body: document.body.scrollTop,
      overlay: overlay?.scrollTop ?? null,
      modal: modal?.scrollTop ?? null,
      header: header?.scrollTop ?? null,
      content: content?.scrollTop ?? null,
      footer: footer?.scrollTop ?? null,
    },
    paintedOwnership: {
      title: ownsPaintedPoint('.settings-header h2'),
      close: ownsPaintedPoint('.settings-header .close-button-settings'),
      footerLeft: ownsPaintedPoint('.settings-footer-left'),
      footerRight: ownsPaintedPoint('.settings-footer-right'),
    },
    overlay: rectangle('.settings-modal-overlay'),
    modal: rectangle('.settings-modal'),
    header: rectangle('.settings-header'),
    title: rectangle('.settings-header h2'),
    close: rectangle('.settings-header .close-button-settings'),
    footer: rectangle('.settings-footer'),
    ambientHistory: historyContainer === null ? null : {
      hidden: historyContainer.hidden,
      ariaHidden: historyContainer.getAttribute('aria-hidden'),
      display: historyStyle.display,
      visibility: historyStyle.visibility,
      pointerEvents: historyStyle.pointerEvents,
      buttonDisabled: historyButton?.disabled ?? null,
      buttonTabIndex: historyButton?.tabIndex ?? null,
    },
  };
});

export const assertSettingsChromeInViewport = async (tab, baseline = null) => {
  const geometry = await settingsChromeGeometry();
  const epsilon = 1;
  const insideViewport = (rect) => rect !== null
    && rect.width > 0
    && rect.height > 0
    && rect.left >= -epsilon
    && rect.top >= -epsilon
    && rect.right <= geometry.viewport.width + epsilon
    && rect.bottom <= geometry.viewport.height + epsilon;

  assert.ok(
    Object.values(geometry.horizontalScroll).every((value) => (
      Number.isFinite(value) && Math.abs(value) <= epsilon
    )),
    `${tab} scrolled a page ancestor horizontally: ${JSON.stringify(geometry)}`,
  );
  assert.equal(
    geometry.overlayPointerEvents,
    'auto',
    `${tab} allowed pointer input through the Settings backdrop: ${JSON.stringify(geometry)}`,
  );
  for (const [part, points] of Object.entries(geometry.paintedOwnership)) {
    assert.ok(
      Array.isArray(points) && points.every(({ owns }) => owns),
      `${tab} visually occluded the Settings ${part}: ${JSON.stringify(geometry)}`,
    );
  }
  for (const part of ['overlay', 'modal', 'header', 'title', 'close', 'footer']) {
    assert.equal(
      insideViewport(geometry[part]),
      true,
      `${tab} moved the Settings ${part} outside the viewport: ${JSON.stringify(geometry)}`,
    );
  }
  assert.deepEqual(
    geometry.ambientHistory,
    {
      hidden: true,
      ariaHidden: 'true',
      display: 'none',
      visibility: 'visible',
      pointerEvents: 'none',
      buttonDisabled: true,
      buttonTabIndex: -1,
    },
    `${tab} exposed ambient toast-history chrome over Settings: ${JSON.stringify(geometry)}`,
  );
  if (baseline !== null) {
    for (const edge of ['left', 'top', 'right', 'bottom']) {
      assert.ok(
        Math.abs(geometry.modal[edge] - baseline.modal[edge]) <= epsilon,
        `${tab} moved the Settings modal ${edge}: ${JSON.stringify({ baseline, geometry })}`,
      );
    }
  }
  return geometry;
};
