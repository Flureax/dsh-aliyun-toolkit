/**
 * Plugin-owned settings, persisted as JSON outside the profile's managed files.
 * Nothing secret is stored here: AccessKeys live in the DSH credential store.
 */
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const DEFAULT_SETTINGS = Object.freeze({
  defaultRegion: 'cn-hangzhou',
  writeMode: 'ask',
  requestTimeoutMs: 20000,
  maxResults: 50,
  allowGenericApi: true,
  idleCpuPercent: 5,
  idleWindowMinutes: 30,
  minInstanceAgeMinutes: 10,
  maxBatch: 20,
  protectIds: [],
  protectPatterns: [],
  endpointOverrides: {},
  autoReleaseHours: 8,
  // Free-form, natural-language user preferences (video rendering, budget, stack...).
  preferences: '',
  // Defaults for `aliyun_compute`; empty strings mean "not configured yet".
  computeRegion: '',
  computeInstanceType: '',
  computeImageId: '',
  computeSecurityGroupId: '',
  computeVSwitchId: '',
  computeMaxHours: 4,
  computeSpot: true,
  // When a compute field is empty, resolve it automatically (region/image/
  // instance type/vSwitch/security group) instead of failing.
  computeAuto: true,
  computeAccelerator: 'auto',
})

const REGION_RE = /^[a-z0-9][a-z0-9-]{1,31}$/
const PREFERENCES_MAX = 2000
const IDENTIFIER_MAX = 128

export function dshHome() {
  return process.env.DSH_HOME || join(homedir(), '.dsh')
}

export function settingsDir() {
  return join(dshHome(), 'plugin-data', 'aliyun-toolkit')
}

export function settingsFile() {
  return join(settingsDir(), 'settings.json')
}

function clampInt(value, min, max, fallback) {
  const number = Number(value)
  if (!Number.isFinite(number)) return fallback
  return Math.min(max, Math.max(min, Math.round(number)))
}

function clampNumber(value, min, max, fallback) {
  const number = Number(value)
  if (!Number.isFinite(number)) return fallback
  return Math.min(max, Math.max(min, number))
}

function text(value, max = IDENTIFIER_MAX) {
  return typeof value === 'string' ? value.trim().slice(0, max) : ''
}

/** Coerce any stored shape into a complete, valid settings object. */
export function normalizeSettings(raw) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  const writeMode = ['ask', 'allow', 'deny'].includes(source.writeMode)
    ? source.writeMode
    : DEFAULT_SETTINGS.writeMode
  const overrides = {}
  if (source.endpointOverrides && typeof source.endpointOverrides === 'object') {
    for (const [key, value] of Object.entries(source.endpointOverrides)) {
      if (typeof key !== 'string' || !key) continue
      if (typeof value !== 'string' || !value) continue
      if (!/^[a-z0-9.-]+$/i.test(value)) continue
      overrides[key] = value
    }
  }
  const strings = (value, max) =>
    Array.isArray(value)
      ? value.filter((item) => typeof item === 'string' && item.trim()).map((item) => item.trim()).slice(0, max)
      : []
  return {
    defaultRegion:
      typeof source.defaultRegion === 'string' && REGION_RE.test(source.defaultRegion)
        ? source.defaultRegion
        : DEFAULT_SETTINGS.defaultRegion,
    writeMode,
    requestTimeoutMs: clampInt(source.requestTimeoutMs, 2000, 120000, DEFAULT_SETTINGS.requestTimeoutMs),
    maxResults: clampInt(source.maxResults, 1, 200, DEFAULT_SETTINGS.maxResults),
    allowGenericApi:
      typeof source.allowGenericApi === 'boolean' ? source.allowGenericApi : DEFAULT_SETTINGS.allowGenericApi,
    idleCpuPercent: clampNumber(source.idleCpuPercent, 0, 100, DEFAULT_SETTINGS.idleCpuPercent),
    idleWindowMinutes: clampInt(source.idleWindowMinutes, 5, 1440, DEFAULT_SETTINGS.idleWindowMinutes),
    minInstanceAgeMinutes: clampInt(source.minInstanceAgeMinutes, 0, 1440, DEFAULT_SETTINGS.minInstanceAgeMinutes),
    maxBatch: clampInt(source.maxBatch, 1, 100, DEFAULT_SETTINGS.maxBatch),
    protectIds: strings(source.protectIds, 200),
    protectPatterns: strings(source.protectPatterns, 50),
    endpointOverrides: overrides,
    autoReleaseHours: clampInt(source.autoReleaseHours, 1, 720, DEFAULT_SETTINGS.autoReleaseHours),
    preferences: text(source.preferences, PREFERENCES_MAX),
    computeRegion:
      typeof source.computeRegion === 'string' && REGION_RE.test(source.computeRegion)
        ? source.computeRegion
        : '',
    computeInstanceType: text(source.computeInstanceType),
    computeImageId: text(source.computeImageId),
    computeSecurityGroupId: text(source.computeSecurityGroupId),
    computeVSwitchId: text(source.computeVSwitchId),
    computeMaxHours: clampInt(source.computeMaxHours, 1, 72, DEFAULT_SETTINGS.computeMaxHours),
    computeSpot: typeof source.computeSpot === 'boolean' ? source.computeSpot : DEFAULT_SETTINGS.computeSpot,
    computeAuto: typeof source.computeAuto === 'boolean' ? source.computeAuto : DEFAULT_SETTINGS.computeAuto,
    computeAccelerator: ['auto', 'gpu', 'cpu'].includes(source.computeAccelerator)
      ? source.computeAccelerator
      : DEFAULT_SETTINGS.computeAccelerator,
  }
}

/** Read settings; a missing file yields defaults, a corrupt one yields defaults plus a diagnostic. */
export async function loadSettings() {
  let raw
  try {
    raw = await readFile(settingsFile(), 'utf8')
  } catch (error) {
    if (error?.code === 'ENOENT') return { value: normalizeSettings(DEFAULT_SETTINGS), error: undefined }
    return {
      value: normalizeSettings(DEFAULT_SETTINGS),
      error: `无法读取设置文件（${settingsFile()}）：${error?.message || error}`,
    }
  }
  try {
    return { value: normalizeSettings(JSON.parse(raw)), error: undefined }
  } catch (error) {
    return {
      value: normalizeSettings(DEFAULT_SETTINGS),
      error: `设置文件不是合法 JSON，已回落默认值：${error?.message || error}`,
    }
  }
}

/** Validate a user-supplied patch; returns `{ value }` with only known keys. */
export function validateSettingsPatch(patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
    return { error: '请求体必须是 JSON 对象。' }
  }
  const value = {}
  if ('defaultRegion' in patch) {
    if (typeof patch.defaultRegion !== 'string' || !REGION_RE.test(patch.defaultRegion)) {
      return { error: 'defaultRegion 必须是合法地域 ID，例如 cn-hangzhou。' }
    }
    value.defaultRegion = patch.defaultRegion
  }
  if ('writeMode' in patch) {
    if (!['ask', 'allow', 'deny'].includes(patch.writeMode)) {
      return { error: 'writeMode 只能是 ask / allow / deny。' }
    }
    value.writeMode = patch.writeMode
  }
  const ranges = {
    requestTimeoutMs: [2000, 120000],
    maxResults: [1, 200],
    idleCpuPercent: [0, 100],
    idleWindowMinutes: [5, 1440],
    minInstanceAgeMinutes: [0, 1440],
    maxBatch: [1, 100],
    autoReleaseHours: [1, 720],
    computeMaxHours: [1, 72],
  }
  for (const [key, [min, max]] of Object.entries(ranges)) {
    if (!(key in patch)) continue
    const number = Number(patch[key])
    if (!Number.isFinite(number) || number < min || number > max) {
      return { error: `${key} 必须是 ${min} 到 ${max} 之间的数字。` }
    }
    value[key] = number
  }
  if ('allowGenericApi' in patch) {
    if (typeof patch.allowGenericApi !== 'boolean') return { error: 'allowGenericApi 必须是布尔值。' }
    value.allowGenericApi = patch.allowGenericApi
  }
  if ('computeSpot' in patch) {
    if (typeof patch.computeSpot !== 'boolean') return { error: 'computeSpot 必须是布尔值。' }
    value.computeSpot = patch.computeSpot
  }
  if ('computeAuto' in patch) {
    if (typeof patch.computeAuto !== 'boolean') return { error: 'computeAuto 必须是布尔值。' }
    value.computeAuto = patch.computeAuto
  }
  if ('computeAccelerator' in patch) {
    if (!['auto', 'gpu', 'cpu'].includes(patch.computeAccelerator)) {
      return { error: 'computeAccelerator 只能是 auto / gpu / cpu。' }
    }
    value.computeAccelerator = patch.computeAccelerator
  }
  if ('preferences' in patch) {
    if (typeof patch.preferences !== 'string') return { error: 'preferences 必须是字符串。' }
    if (patch.preferences.length > PREFERENCES_MAX) {
      return { error: `preferences 最多 ${PREFERENCES_MAX} 个字符。` }
    }
    value.preferences = patch.preferences
  }
  if ('computeRegion' in patch) {
    const region = patch.computeRegion
    if (typeof region !== 'string' || (region !== '' && !REGION_RE.test(region))) {
      return { error: 'computeRegion 必须是合法地域 ID 或留空。' }
    }
    value.computeRegion = region
  }
  for (const key of ['computeInstanceType', 'computeImageId', 'computeSecurityGroupId', 'computeVSwitchId']) {
    if (!(key in patch)) continue
    const item = patch[key]
    if (typeof item !== 'string' || item.length > IDENTIFIER_MAX) {
      return { error: `${key} 必须是字符串（最多 ${IDENTIFIER_MAX} 字符）。` }
    }
    value[key] = item.trim()
  }
  for (const key of ['protectIds', 'protectPatterns']) {
    if (!(key in patch)) continue
    if (!Array.isArray(patch[key]) || patch[key].some((item) => typeof item !== 'string')) {
      return { error: `${key} 必须是字符串数组。` }
    }
    value[key] = patch[key]
  }
  if ('endpointOverrides' in patch) {
    const overrides = patch.endpointOverrides
    if (!overrides || typeof overrides !== 'object' || Array.isArray(overrides)) {
      return { error: 'endpointOverrides 必须是 { 产品: 域名 } 对象。' }
    }
    for (const [key, item] of Object.entries(overrides)) {
      if (typeof item !== 'string' || !/^[a-z0-9.-]+$/i.test(item)) {
        return { error: `endpointOverrides.${key} 必须是纯域名，例如 ecs-vpc.cn-hangzhou.aliyuncs.com。` }
      }
    }
    value.endpointOverrides = overrides
  }
  return { value }
}

/** Merge a validated patch, write atomically, and return the effective settings. */
export async function saveSettings(patch) {
  const checked = validateSettingsPatch(patch)
  if (checked.error) {
    const error = new Error(checked.error)
    error.code = 'InvalidSettings'
    throw error
  }
  const current = await loadSettings()
  const next = normalizeSettings({ ...current.value, ...checked.value })
  await mkdir(settingsDir(), { recursive: true })
  const file = settingsFile()
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`
  await writeFile(temp, JSON.stringify(next, null, 2) + '\n', 'utf8')
  try {
    await rename(temp, file)
  } catch (error) {
    try {
      await unlink(file)
      await rename(temp, file)
    } catch {
      await unlink(temp).catch(() => {})
      throw error
    }
  }
  return { value: next, error: current.error }
}
