import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: { index: resolve('src/main/index.ts') },
        output: {
          // The English pack gets a chunk of its own (the others already do: they
          // are loaded on demand). electron-vite injects its CommonJS shim after
          // the last `import … from '…'` it finds by regex, and inlined into
          // index.js the pack is 6,000 strings of prose — "Unlock vault and
          // import" followed by a quote matched, and the shim landed inside the
          // JSON. A chunk with no `require(` is never shimmed.
          manualChunks: (id) => (/[\\/]shared[\\/]locales[\\/]en\.json$/.test(id) ? 'locale-en' : undefined)
        }
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: { input: { index: resolve('src/preload/index.ts') } }
    }
  },
  renderer: {
    root: resolve('src/renderer'),
    resolve: {
      alias: { '@': resolve('src/renderer/src') },
      // Ensure a single React instance so hooks resolve (avoids the
      // "Cannot read properties of null (reading 'useRef')" dedupe error).
      dedupe: ['react', 'react-dom']
    },
    optimizeDeps: {
      include: ['react', 'react-dom', 'react-dom/client', 'zustand', 'lucide-react', '@xterm/xterm']
    },
    build: {
      chunkSizeWarningLimit: 1500,
      rollupOptions: { input: { index: resolve('src/renderer/index.html') } }
    },
    plugins: [react()]
  }
})
