import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    // Bind IPv4 explicitly — Vite's default binds ::1 only, so a browser or
    // curl pointed at 127.0.0.1 gets connection-refused.
    host: '127.0.0.1',
    port: 5290,
    strictPort: true,
    // The sidecar is loopback-only; proxy through it so the UI never needs CORS.
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:8791',
        changeOrigin: false,
      },
    },
  },
})
