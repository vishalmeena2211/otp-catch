import { defineConfig } from 'tsup';

export default defineConfig([
  {
    entry: ['src/index.ts', 'src/react.ts'],
    format: ['esm', 'cjs'],
    dts: true,
    clean: true,
    sourcemap: true,
    target: 'es2020',
    external: ['react'],
  },
  {
    entry: { index: 'src/index.ts' },
    format: ['iife'],
    globalName: 'OtpCatch',
    outExtension: () => ({ js: '.global.js' }),
    minify: true,
    target: 'es2020',
    dts: false,
    clean: false,
  },
]);
