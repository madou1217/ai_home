import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'

export default defineConfig({
  plugins: [react()],
  base: '/ui/',
  server: {
    port: 3000,
    proxy: {
      '/v0': {
        target: 'http://127.0.0.1:8317',
        changeOrigin: true
      }
    }
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src')
    }
  },
  build: {
    outDir: 'dist',
    assetsDir: 'assets',
    emptyOutDir: true,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes('node_modules')) return;
          if (id.includes('/react-dom/') || id.includes('/react-router-dom/') || id.includes('/react/')) {
            return 'react-vendor';
          }
          if (
            id.includes('/antd/')
            || id.includes('/@ant-design/')
            || id.includes('/rc-')
          ) {
            return 'antd-core';
          }
          if (
            id.includes('/@xterm/')
            || id.includes('/react-markdown/')
            || id.includes('/remark-gfm/')
            || id.includes('/rehype-highlight/')
          ) {
            return 'chat-vendor';
          }
          if (id.includes('/dayjs/') || id.includes('/axios/')) {
            return 'app-vendor';
          }
        }
      }
    },
    chunkSizeWarningLimit: 1100
  }
})
