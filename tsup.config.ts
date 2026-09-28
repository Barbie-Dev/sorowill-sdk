import { defineConfig } from 'tsup';

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    'react/index': 'src/react/index.ts',
  },
  format: ['esm', 'cjs'],
  dts: true,
  clean: true,
  sourcemap: true,
  splitting: false,
  treeshake: true,
  external: ['react'],
  esbuildOptions(options) {
    options.platform = 'neutral';
    options.mainFields = ['module', 'main'];
    options.conditions = ['import', 'module', 'default'];
  },
});
