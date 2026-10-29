/**
 * Local JSON API for the settings page.
 *
 * The page is a plain browser module, so it talks to the Host over one
 * same-origin route instead of a generated Remote namespace. The route never
 * returns a secret and only writes the plugin's own settings/credential refs.
 */
import { clearCredentials, describeCredentials, readCredentials, saveCredentials } from './credentials.js'
import { callRpc } from './rpc.js'
import { loadSettings, saveSettings, settingsFile } from './settings.js'
import { setPreferencesText } from './state.js'

// The web server matches a prefix only when the request is the prefix itself
// or starts with `${prefix}/`, so this must not carry a trailing slash.
const PREFIX = '/aliyun-toolkit'
const MAX_BODY = 16 * 1024
const VERSION = '1.0.0'

function sendJson(res, status, body) {
  const text = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(text),
  })
  res.end(text)
}

async function readJson(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_BODY) {
      const error = new Error('请求体超过 16KB。')
      error.code = 'PayloadTooLarge'
      throw error
    }
    chunks.push(chunk)
  }
  const text = Buffer.concat(chunks).toString('utf8')
  if (!text) return {}
  try {
    return JSON.parse(text)
  } catch {
    const error = new Error('请求体不是合法 JSON。')
    error.code = 'InvalidJson'
    throw error
  }
}

function originOf(ctx) {
  try {
    return ctx.webServer.getOrigin()
  } catch {
    return undefined
  }
}

async function statusPayload(ctx) {
  const loaded = await loadSettings()
  return {
    ok: true,
    version: VERSION,
    credentials: await describeCredentials(ctx),
    settings: loaded.value,
    settingsFile: settingsFile(),
    settingsError: loaded.error,
  }
}

async function handle(ctx, req, res) {
  const origin = originOf(ctx)
  const path = String(req.url || '').split('?')[0].replace(/^\/aliyun-toolkit\/?/, '')

  if (req.method === 'GET' && (path === '' || path === 'status')) {
    sendJson(res, 200, await statusPayload(ctx))
    return
  }

  if (req.method !== 'POST') {
    sendJson(res, 405, { ok: false, code: 'MethodNotAllowed', message: '只支持 GET status 与 POST 操作。' })
    return
  }

  const requestOrigin = req.headers.origin
  if (requestOrigin && origin && requestOrigin !== origin) {
    sendJson(res, 403, { ok: false, code: 'CrossOrigin', message: '拒绝跨源请求。' })
    return
  }

  let body
  try {
    body = await readJson(req)
  } catch (error) {
    sendJson(res, 400, { ok: false, code: error.code || 'InvalidJson', message: error.message })
    return
  }

  try {
    if (path === 'credentials') {
      const saved = await saveCredentials(ctx, body)
      sendJson(res, 200, { ok: true, ...saved, credentials: await describeCredentials(ctx) })
      return
    }
    if (path === 'credentials/clear') {
      await clearCredentials(ctx)
      sendJson(res, 200, { ok: true, credentials: await describeCredentials(ctx) })
      return
    }
    if (path === 'settings') {
      const saved = await saveSettings(body)
      setPreferencesText(saved.value.preferences)
      sendJson(res, 200, { ok: true, settings: saved.value, settingsError: saved.error })
      return
    }
    if (path === 'test') {
      const loaded = await loadSettings()
      const credentials = await readCredentials(ctx)
      const region =
        (typeof body?.region === 'string' && body.region.trim()) || loaded.value.defaultRegion
      if (!credentials.complete) {
        sendJson(res, 200, {
          ok: false,
          code: 'NoCredentials',
          message: '尚未配置 AccessKey。',
          region,
        })
        return
      }
      const startedAt = Date.now()
      try {
        const response = await callRpc({
          product: 'ecs',
          region,
          action: 'DescribeRegions',
          params: {},
          credentials,
          settings: loaded.value,
        })
        sendJson(res, 200, {
          ok: true,
          region,
          endpoint: `https://ecs.${region}.aliyuncs.com`,
          latencyMs: Date.now() - startedAt,
          regionCount: response?.Regions?.Region?.length ?? 0,
          requestId: response?.RequestId,
        })
      } catch (error) {
        sendJson(res, 200, {
          ok: false,
          region,
          latencyMs: Date.now() - startedAt,
          code: error?.code || 'Error',
          message: error?.message || String(error),
          advice: error?.advice,
        })
      }
      return
    }
    sendJson(res, 404, { ok: false, code: 'NotFound', message: `未知接口：${path}` })
  } catch (error) {
    sendJson(res, 200, {
      ok: false,
      code: error?.code || 'Error',
      message: error?.message || String(error),
    })
  }
}

/** Register the route; called with a context that has `webServer`. */
export function registerHttp(ctx) {
  ctx.effect(() =>
    ctx.webServer.register({
      kind: 'prefix',
      path: PREFIX,
      handler: (req, res) => handle(ctx, req, res),
    }),
  )
}
