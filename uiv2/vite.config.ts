import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'https://product-hub-backend-79205549235.europe-west3.run.app',
        changeOrigin: true,
        secure: true,
      },
    },
  },
})
