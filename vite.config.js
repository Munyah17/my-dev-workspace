import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

function workspaceApi() {
  async function configure(server) {
    const { createApi } = await import('./server/api.js')
    const { appConfig } = await import('./server/config.js')
    const api = await createApi(appConfig())
    server.middlewares.use(api.handle)
    server.httpServer?.once('close', () => { void api.close() })
  }
  return { name: 'workspace-api', configureServer: configure, configurePreviewServer: configure }
}

export default defineConfig({ plugins: [react(), workspaceApi()] })
