/**
 * Shared helpers for tool definitions: output rendering, error shaping,
 * approval gating and input validation.
 */
import { readCredentials } from './credentials.js'
import { isAbortError } from './rpc.js'
import { loadSettings } from './settings.js'
import { setPreferencesText } from './state.js'

export const OUTPUT_SCHEMA = { type: 'object', additionalProperties: true }

export function renderValue(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2)
  const capped = text.length > 60000 ? text.slice(0, 60000) + '\n…（输出已截断）' : text
  return [{ type: 'text', text: capped }]
}

export function presentCall(title, kind) {
  return (args) => ({ card: 'generic', title, kind, rawInput: args })
}

export function toolFailure(code, message, extra) {
  return { ok: false, code, message, ...(extra || {}) }
}

export function inputError(message) {
  const error = new Error(message)
  error.code = 'InvalidInput'
  return error
}

/** Execute a tool body, converting expected failures into a JSON result. */
export async function guarded(fn) {
  try {
    return await fn()
  } catch (error) {
    if (isAbortError(error)) throw error
    return toolFailure(error?.code || 'Error', error?.message || String(error), {
      ...(error?.requestId ? { requestId: error.requestId } : {}),
      ...(error?.advice ? { advice: error.advice } : {}),
    })
  }
}

export function stringList(value, field) {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value)) throw inputError(`${field} 必须是字符串数组。`)
  const out = []
  for (const item of value) {
    if (typeof item !== 'string' || !item.trim()) throw inputError(`${field} 只能包含非空字符串。`)
    out.push(item.trim())
  }
  return out
}

export function requiredString(value, field) {
  if (typeof value !== 'string' || !value.trim()) throw inputError(`${field} 必填。`)
  return value.trim()
}

export function optionalString(value, field) {
  if (value === undefined || value === null || value === '') return undefined
  if (typeof value !== 'string') throw inputError(`${field} 必须是字符串。`)
  return value.trim()
}

export function intInRange(value, fallback, min, max, field) {
  if (value === undefined || value === null) return fallback
  const number = Number(value)
  if (!Number.isFinite(number) || number < min || number > max) {
    throw inputError(`${field} 必须是 ${min} 到 ${max} 之间的数字。`)
  }
  return Math.round(number)
}

export function chunk(items, size) {
  const out = []
  for (let index = 0; index < items.length; index += size) out.push(items.slice(index, index + size))
  return out
}

export function toIsoUtc(date) {
  return date.toISOString().replace(/\.\d{3}Z$/, 'Z')
}

/** Load settings plus credentials for one tool call. */
export async function prepare(ctx) {
  const loaded = await loadSettings()
  setPreferencesText(loaded.value.preferences)
  const credentials = await readCredentials(ctx)
  return { settings: loaded.value, settingsError: loaded.error, credentials }
}

export function requireCredentials(credentials) {
  if (credentials?.complete) return
  const error = new Error(
    '未配置阿里云 AccessKey：请打开 Settings →「阿里云」保存，或设置 ALIYUN_ACCESS_KEY_ID / ALIYUN_ACCESS_KEY_SECRET。',
  )
  error.code = 'NoCredentials'
  error.advice = '可用 aliyun_doctor 查看当前凭据来源。'
  throw error
}

/**
 * Ask for the user's approval for one write. Returns `undefined` when allowed,
 * otherwise a failure object. `writeMode=allow` skips the prompt and
 * `writeMode=deny` refuses outright.
 */
export async function approveWrite(ctx, exec, settings, detail) {
  if (settings.writeMode === 'deny') {
    return toolFailure('WritesDisabled', '写操作已被插件设置禁用（writeMode=deny），仅允许只读调用。')
  }
  if (settings.writeMode === 'allow') return undefined
  if (!exec?.agent) {
    return toolFailure('ApprovalUnavailable', '当前调用没有 agent 上下文，无法发起写操作审批。')
  }
  const approval = (() => {
    try {
      return ctx?.get?.('approval')
    } catch {
      return undefined
    }
  })()
  if (!approval || typeof approval.request !== 'function') {
    return toolFailure('ApprovalUnavailable', '宿主没有审批服务，写操作已按只读模式拒绝。')
  }
  let outcome
  try {
    outcome = await approval.request({
      agent: exec.agent,
      toolName: exec.name,
      callId: exec.callId,
      reason: detail.zh,
      displayReason: { en: detail.en, zh: detail.zh },
      signal: exec.signal,
    })
  } catch (error) {
    return toolFailure('ApprovalFailed', `审批请求失败：${error?.message || error}`)
  }
  if (outcome !== 'allowed-once') {
    return toolFailure('ApprovalDenied', `写操作未获批准（${outcome}），未执行任何变更。`)
  }
  return undefined
}

export function protectionOf(settings) {
  const ids = new Set(settings.protectIds || [])
  const patterns = (settings.protectPatterns || []).map((item) => item.toLowerCase()).filter(Boolean)
  return (instance) => {
    if (!instance) return true
    if (ids.has(instance.id)) return true
    const haystack = `${instance.name || ''} ${instance.id || ''}`.toLowerCase()
    return patterns.some((pattern) => haystack.includes(pattern))
  }
}
