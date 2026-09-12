import { disableGeminiButtonEffects, initGeminiButtonEffects } from './index';

let frames, id;
beforeEach(() => {
  frames = new Map(); id = 0;
  vi.stubGlobal('requestAnimationFrame', callback => { frames.set(++id, callback); return id; });
  vi.stubGlobal('cancelAnimationFrame', key => frames.delete(key));
  localStorage.setItem('enable_gemini_effects', 'true');
});
afterEach(() => { disableGeminiButtonEffects(); document.body.replaceChildren(); vi.unstubAllGlobals(); });
const tick = () => { const pending = [...frames.values()]; frames.clear(); pending.forEach(fn => fn(performance.now())); };
const button = () => {
  const element = document.createElement('button'); element.className = 'generate-btn';
  element.getBoundingClientRect = () => ({ width: 200, height: 40, left: 0, top: 0 });
  document.body.append(element); return element;
};

it('repeated initialization preserves particles and does not multiply button handlers', () => {
  const control = button(); const listen = vi.spyOn(control, 'addEventListener');
  initGeminiButtonEffects();
  const first = control.querySelector('.gemini-mini-icon');
  const registrations = listen.mock.calls.length;
  for (let i = 0; i < 10; i++) initGeminiButtonEffects();
  expect(control.querySelector('.gemini-mini-icon')).toBe(first);
  expect(listen.mock.calls.length).toBe(registrations);
  listen.mockRestore();
});

it('sleeps while idle, wakes on hover, and releases removed active particles', () => {
  const control = button(); initGeminiButtonEffects();
  tick(); tick(); expect(frames.size).toBe(0);
  control.dispatchEvent(new MouseEvent('mouseenter'));
  tick(); expect(frames.size).toBe(1);
  expect(control.querySelector('.gemini-mini-icon').style.opacity).toBe('1');
  control.dispatchEvent(new MouseEvent('mouseleave'));
  for (let i = 0; i < 150; i++) tick();
  expect(frames.size).toBe(0);
  control.dispatchEvent(new MouseEvent('mouseenter')); tick();
  control.remove(); tick();
  expect(frames.size).toBe(0);
});
