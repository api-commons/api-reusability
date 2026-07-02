import { defineConfig } from 'vite';
// @xenova/transformers is dynamically imported (semantic features are opt-in) so
// it lands in its own lazy chunk; exclude it from dep pre-bundling to avoid
// onnxruntime-web issues in dev.
export default defineConfig({
  build: { target: 'es2022' },
  optimizeDeps: { exclude: ['@xenova/transformers'] },
});
