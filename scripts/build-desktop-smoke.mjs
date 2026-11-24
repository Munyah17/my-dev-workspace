import { mkdir, writeFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'

const build = spawnSync(process.execPath, ['node_modules/vite/bin/vite.js', 'build'], { stdio: 'inherit' })
if (build.status !== 0) process.exit(1)
const output = new URL('../src-tauri/smoke/', import.meta.url)
await mkdir(output, { recursive: true })
await writeFile(new URL('index.html', output), `<!doctype html>
<html lang="en"><meta charset="utf-8"><title>MyDev Workspace smoke test</title>
<body><main><h1>MyDev Workspace</h1><p>The desktop smoke shell opened. Run the Tauri development command to connect to the local Phase 1 backend.</p></main></body></html>`)
