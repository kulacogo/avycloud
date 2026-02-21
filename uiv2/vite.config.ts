import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      // Proxy only actual API calls (not source files like api/client.ts)
      '/api/admin': { target: 'https://product-hub-backend-79205549235.europe-west3.run.app', changeOrigin: true, secure: true },
      '/api/auth': { target: 'https://product-hub-backend-79205549235.europe-west3.run.app', changeOrigin: true, secure: true },
      '/api/baselinker': { target: 'https://product-hub-backend-79205549235.europe-west3.run.app', changeOrigin: true, secure: true },
      '/api/categories': { target: 'https://product-hub-backend-79205549235.europe-west3.run.app', changeOrigin: true, secure: true },
      '/api/chat': { target: 'https://product-hub-backend-79205549235.europe-west3.run.app', changeOrigin: true, secure: true },
      '/api/dashboard': { target: 'https://product-hub-backend-79205549235.europe-west3.run.app', changeOrigin: true, secure: true },
      '/api/ebay': { target: 'https://product-hub-backend-79205549235.europe-west3.run.app', changeOrigin: true, secure: true },
      '/api/identify': { target: 'https://product-hub-backend-79205549235.europe-west3.run.app', changeOrigin: true, secure: true },
      '/api/operations': { target: 'https://product-hub-backend-79205549235.europe-west3.run.app', changeOrigin: true, secure: true },
      '/api/products': { target: 'https://product-hub-backend-79205549235.europe-west3.run.app', changeOrigin: true, secure: true },
      '/api/queue': { target: 'https://product-hub-backend-79205549235.europe-west3.run.app', changeOrigin: true, secure: true },
      '/api/warehouse': { target: 'https://product-hub-backend-79205549235.europe-west3.run.app', changeOrigin: true, secure: true },
    },
  },
})
