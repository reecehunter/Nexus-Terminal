import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  build: {
    rollupOptions: {
      output: {
        manualChunks: {
          terminal: ['@xterm/xterm', '@xterm/addon-fit'],
          react: ['react', 'react-dom'],
          markdown: ['react-markdown'],
        },
      },
    },
  },
  server: { host: '127.0.0.1', port: 1420, strictPort: true },
  test: { environment: 'jsdom', restoreMocks: true },
});
