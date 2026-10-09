import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';
const here = path.resolve(__dirname);
export default defineConfig({
  root: here,
  plugins: [{ name: 'local-fixtures-only', enforce: 'pre', resolveId(id) {
    if (/api\/client$/.test(id)) return path.join(here, 'fixtures.ts');
    if (/context\/AuthContext$/.test(id)) return path.join(here, 'auth.ts');
  } }, react()],
  server: { host: '127.0.0.1', port: 4180, strictPort: true, fs: { allow: [path.resolve(here, '../..')] } },
});
