import { Miniflare } from 'miniflare';

// A throwaway Miniflare with one stub Worker and a fresh D1 bound as DB,
// in miniflare 5's native options shape (no convertV4MiniflareOptions shim).
export function newD1Miniflare() {
  return new Miniflare({
    workers: [{
      config: {
        name: '',
        compatibilityDate: '2026-10-12',
        manifest: {
          mainModule: 'index.mjs',
          modules: { 'index.mjs': { type: 'esm', contents: 'export default { fetch() { return new Response("ok"); } };' } },
        },
        env: { DB: { type: 'd1', id: crypto.randomUUID() } },
      },
    }],
  });
}
