import { resolve } from 'node:path';

import { defineConfig } from 'vitest/config';
import { transformWithOxc } from 'vite';

const sourceJavaScriptPattern = /[/\\]src[/\\].+\.js$/;

const reactJsxInJavaScript = () => ({
  name: 'osg-vitest-react-jsx-in-javascript',
  enforce: 'pre',
  async transform(source, id) {
    if (!sourceJavaScriptPattern.test(id)) return null;
    return transformWithOxc(source, id, {
      lang: 'jsx',
      jsx: { importSource: 'react', runtime: 'automatic' },
      sourcemap: true,
    });
  },
});

export default defineConfig({
  define: {
    'process.env': JSON.stringify({ NODE_ENV: 'test' }),
  },
  plugins: [reactJsxInJavaScript()],
  resolve: {
    alias: [{
      find: /^@material\/web\/.*$/,
      replacement: resolve('src/test-utils/materialWebMock.js'),
    }],
  },
  test: {
    environment: 'jsdom',
    globals: true,
    include: ['src/**/*.{test,spec}.{js,jsx,ts,tsx}'],
    setupFiles: ['./src/setupTests.js'],
    restoreMocks: false,
  },
});
