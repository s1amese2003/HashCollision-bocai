import vue from '@vitejs/plugin-vue'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [vue()],
  server: {
    proxy: {
      '/api': 'http://127.0.0.1:8090',
      '/ws': { target: 'ws://127.0.0.1:8090', ws: true },
    },
  },
})
