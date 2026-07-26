/// <reference types="vitest/config" />
import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

// Test config for the APP (root workspace). App/integration tests live under
// src/**/*.test.ts(x) and run in a jsdom environment so browser globals (window,
// document) and future React component tests work. The engine keeps its own
// DOM-free vitest config under packages/engine — the two are independent.
export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    include: ['src/**/*.test.{ts,tsx}'],
    globals: false,
  },
})
