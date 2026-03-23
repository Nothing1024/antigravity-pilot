import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    proxy: {
      // Conversation step streaming WS (Phase 4/5): /api/conversations/:id/ws
      '/api/conversations': {
        target: 'http://localhost:3563',
        ws: true,
        changeOrigin: true
      },
      // API routes
      '/api': {
        target: 'http://localhost:3563',
        changeOrigin: true
      },
      '/cascades': {
        target: 'http://localhost:3563',
        changeOrigin: true
      },
      '/snapshot': {
        target: 'http://localhost:3563',
        changeOrigin: true
      },
      '/styles': {
        target: 'http://localhost:3563',
        changeOrigin: true
      },
      '/send': {
        target: 'http://localhost:3563',
        changeOrigin: true
      },
      '/click': {
        target: 'http://localhost:3563',
        changeOrigin: true
      },
      '/popup': {
        target: 'http://localhost:3563',
        changeOrigin: true
      },
      '/popup-click': {
        target: 'http://localhost:3563',
        changeOrigin: true
      },
      '/scroll': {
        target: 'http://localhost:3563',
        changeOrigin: true
      },
      '/dismiss': {
        target: 'http://localhost:3563',
        changeOrigin: true
      },
      '/new-conversation': {
        target: 'http://localhost:3563',
        changeOrigin: true
      },
      // WebSocket proxy
      '/ws': {
        target: 'ws://localhost:3563',
        ws: true,
        changeOrigin: true
      }
    }
  }
})
