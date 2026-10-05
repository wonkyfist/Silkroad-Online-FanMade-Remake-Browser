import { defineConfig } from 'vite'

/** Game server for the /api proxy: $SRO_SERVER, default http://localhost:7000. */
const SERVER = process.env.SRO_SERVER ?? 'http://localhost:7000'
/** Dev server port: $SRO_ADMIN_PORT, default 5182 (an allowed dev origin of the game server, config.ts DEV_ORIGINS). */
const PORT = Number(process.env.SRO_ADMIN_PORT ?? 5182)

export default defineConfig({
  // The game server serves the build at /admin/ (docs/ADMIN.md §2).
  base: '/admin/',
  // /admin/out: the item and monster icons the game server serves for the panel (apps/server/src/admin/icons.ts).
  server: { port: PORT, strictPort: true, proxy: { '/api': { target: SERVER, changeOrigin: true }, '/admin/out': { target: SERVER, changeOrigin: true } } },
  preview: { port: PORT + 1, proxy: { '/api': { target: SERVER, changeOrigin: true } } },
  build: { target: 'es2022', outDir: 'dist', emptyOutDir: true },
})
