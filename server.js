import express from 'express'
import { createApi } from './server/api.js'
import { appConfig } from './server/config.js'

const app = express()
app.disable('x-powered-by')

let api
function initialize() {
  return Promise.resolve()
    .then(() => createApi(appConfig()))
    .catch(error => {
      api = undefined
      throw error
    })
}

app.use(async (req, res, next) => {
  if (!req.path.startsWith('/api/')) return next()
  try {
    const service = await (api ??= initialize())
    await service.handle(req, res, next)
  } catch (error) {
    console.error('Workspace API unavailable:', error.code ?? error.name)
    res.status(503).set('Cache-Control', 'no-store').json({ error: 'The workspace API is unavailable.' })
  }
})

export default app
