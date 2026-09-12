/**
 * A debug app restart must read today's sources, not an intermediate edit cached by a long-lived
 * Vite process. Filesystem notifications can be missed/coalesced; even a browser reload otherwise
 * reuses Vite's transformed modules. Invalidate the client graph on app-document navigation only.
 * Normal module requests and HMR retain Vite's cache, and production builds never run this plugin.
 */
export const createDevFreshnessPlugin = () => ({
  name: 'osg-dev-fresh-document',
  apply: 'serve',
  configureServer(server) {
    server.middlewares.use((request, _response, next) => {
      const pathname = request.url?.split('?')[0];
      if (request.method === 'GET' && (pathname === '/' || pathname === '/index.html')) {
        server.environments.client.moduleGraph.invalidateAll();
      }
      next();
    });
  },
});
