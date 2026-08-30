import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Tauri expects a fixed dev port; failure to bind aborts `tauri dev`.
// TAURI_DEV_HOST is set by `tauri android dev` so the emulator can reach
// the dev server over the LAN — bind to it when present.
export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: process.env.TAURI_DEV_HOST || false,
  },
  build: {
    target: 'es2022',
  },
})
