import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: { input: { index: resolve('src/main/index.ts') } }
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
      //
      // Vue is here for the same reason and a second one. The API client is a
      // Vue app mounted inside this React one, and two copies of Vue mean two
      // reactivity systems: a store created by one and read by the other
      // updates nothing, which renders as a client whose inputs do not respond.
      // It is also a direct dependency now rather than one reached through
      // npm's hoisting of Scalar's own — see package.json.
      dedupe: ['react', 'react-dom', 'vue']
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
