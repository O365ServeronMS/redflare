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
      '/api': { target: 'https://phim.bluesia.net', changeOrigin: true },
    },
  },
  preview: {
    proxy: {
      '/api': { target: 'https://img.bluesia.net', changeOrigin: true },
    },
  },
});
