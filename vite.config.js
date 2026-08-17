import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [],
  root: '.',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
  server: {
    port: 3000,
    open: true,
    // src/api/ophim.js calls same-origin /api/* (the Worker handles that in
    // production). Vite's dev server doesn't run the Worker, so proxy /api/*
    // straight to the live production Worker to keep "npm run dev hits the
    // live backend" true.
    proxy: {
      '/api': { target: 'https://film.bluesia.net', changeOrigin: true },
    },
  },
  preview: {
    // Same reason as server.proxy above. (Was pointed at img.bluesia.net --
    // the VPS-era catalog host; that name is the R2 image bucket now and has
    // no /api/* route, so preview served no catalog data at all.)
    proxy: {
      '/api': { target: 'https://film.bluesia.net', changeOrigin: true },
    },
  },
});
