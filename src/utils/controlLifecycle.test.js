const settleMutations = () => new Promise(resolve => setTimeout(resolve, 0));

afterEach(() => { document.body.replaceChildren(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it('disconnects a removed custom scrollbar but preserves one moved inside the document', async () => {
  const observers = [];
  vi.stubGlobal('ResizeObserver', class {
    constructor() { this.disconnected = false; observers.push(this); }
    observe() {}
    disconnect() { this.disconnected = true; }
  });
  const { initializeFunctionalScrollbars } = await import('./functionalScrollbar');
  const host = document.createElement('div');
  host.className = 'reference-text-container';
  const text = document.createElement('textarea'); text.className = 'reference-text';
  host.append(text); document.body.append(host);
  initializeFunctionalScrollbars();
  const instance = host._functionalScrollbar;
  const parent = document.createElement('section'); document.body.append(parent); parent.append(host);
  await settleMutations();
  expect(host._functionalScrollbar).toBe(instance);
  expect(observers[0].disconnected).toBe(false);
  host.remove(); await settleMutations();
  expect(host._functionalScrollbar).toBeUndefined();
  expect(observers[0].disconnected).toBe(true);
  document.body.append(host); initializeFunctionalScrollbars();
  expect(host._functionalScrollbar).not.toBe(instance);
});

it('removing a modal releases its sliders global listeners and allows remounting', async () => {
  const added = vi.spyOn(document, 'addEventListener');
  const removed = vi.spyOn(document, 'removeEventListener');
  await import('./sliderDragHandler');
  const modal = document.createElement('div');
  const slider = document.createElement('div'); slider.className = 'standard-slider-container';
  const input = document.createElement('input'); input.className = 'standard-slider-input';
  input.type = 'range'; slider.append(input); modal.append(slider); document.body.append(modal);
  await settleMutations();
  expect(input.hasAttribute('data-drag-handler-added')).toBe(true);
  modal.remove(); await settleMutations();
  const residual = added.mock.calls.filter(([type, handler]) => ['mouseup', 'touchend'].includes(type)
    && !removed.mock.calls.some(([removedType, removedHandler]) => type === removedType && handler === removedHandler));
  expect(residual).toHaveLength(0);
  expect(input.hasAttribute('data-drag-handler-added')).toBe(false);
  document.body.append(modal); await settleMutations();
  expect(input.hasAttribute('data-drag-handler-added')).toBe(true);
});
