// Vitest loads this file before each frontend test suite.

// Adds custom matchers like `toBeInTheDocument` / `toHaveClass`.
import '@testing-library/jest-dom';

// jsdom doesn't implement the Performance Timeline API. Some components probe the
// navigation type (e.g. VideoAnalysisModal checks whether the page was reloaded via
// `performance.getEntriesByType('navigation')`). Provide a no-op so rendering them in
// tests doesn't throw "getEntriesByType is not a function".
if (
  typeof window !== 'undefined' &&
  window.performance &&
  typeof window.performance.getEntriesByType !== 'function'
) {
  window.performance.getEntriesByType = () => [];
}

// jsdom doesn't expose the Encoding API globals; provide them from Node's `util` so code that
// uses TextEncoder/TextDecoder (e.g. the narration SSE reader) works under test.
import { TextDecoder, TextEncoder } from 'node:util';
if (typeof global.TextEncoder === 'undefined') global.TextEncoder = TextEncoder;
if (typeof global.TextDecoder === 'undefined') global.TextDecoder = TextDecoder;
