import { isPhysicalPointInsideElement } from './nativeMediaDropTarget';

const viewport = (overrides = {}) => ({
  devicePixelRatio: 2,
  innerHeight: 600,
  innerWidth: 800,
  ...overrides,
});

it('converts physical pixels to CSS client coordinates before hit testing', () => {
  const child = {};
  const element = { contains: vi.fn((target) => target === child) };
  const viewportDocument = { elementFromPoint: vi.fn(() => child) };

  expect(isPhysicalPointInsideElement(
    { x: 500, y: 250 },
    element,
    viewport(),
    viewportDocument
  )).toBe(true);
  expect(viewportDocument.elementFromPoint).toHaveBeenCalledWith(250, 125);
  expect(element.contains).toHaveBeenCalledWith(child);
});

it('accepts the drop-zone element itself and rejects obscured or outside points', () => {
  const element = { contains: vi.fn(() => false) };
  const overlay = {};
  const viewportDocument = { elementFromPoint: vi.fn(() => element) };

  expect(isPhysicalPointInsideElement(
    { x: 10, y: 20 }, element, viewport({ devicePixelRatio: 1 }), viewportDocument
  )).toBe(true);
  viewportDocument.elementFromPoint.mockReturnValue(overlay);
  expect(isPhysicalPointInsideElement(
    { x: 10, y: 20 }, element, viewport({ devicePixelRatio: 1 }), viewportDocument
  )).toBe(false);
  expect(isPhysicalPointInsideElement(
    { x: 1600, y: 20 }, element, viewport(), viewportDocument
  )).toBe(false);
});

it.each([
  [{ x: Number.NaN, y: 1 }, viewport()],
  [{ x: 1, y: Number.POSITIVE_INFINITY }, viewport()],
  [{ x: 1, y: 1 }, viewport({ devicePixelRatio: 0 })],
  [{ x: -1, y: 1 }, viewport()],
])('fails closed for invalid coordinate inputs %#', (position, viewportWindow) => {
  const viewportDocument = { elementFromPoint: vi.fn() };
  expect(isPhysicalPointInsideElement(
    position,
    { contains: vi.fn() },
    viewportWindow,
    viewportDocument
  )).toBe(false);
  expect(viewportDocument.elementFromPoint).not.toHaveBeenCalled();
});
