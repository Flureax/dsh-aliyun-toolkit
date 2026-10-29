/**
 * Alibaba Cloud RPC transport: endpoint resolution, common parameters,
 * signature, timeout/abort handling and error normalisation.
 */
import { randomUUID } from 'node:crypto'
import { canonicalQuery, ossSignature, rpcSignature } from './sign.js'

/** Known products: API version, endpoint builder and whether RegionId applies. */
export const PRODUCTS = {
  ecs: { version: '2014-05-26', endpoint: (region) => `ecs.${region}.aliyuncs.com`, region: true },
  cms: {
    version: '2019-01-01',
    endpoint: () => 'metrics.cn-hangzhou.aliyuncs.com',
    region: true,
  },
  bss: { version: '2017-12-14', endpoint: () => 'business.aliyuncs.com', region: false },
  vpc: { version: '2016-04-28', endpoint: (region) => `vpc.${region}.aliyuncs.com`, region: true },
  rds: { version: '2014-05-28', endpoint: (region) => `rds.${region}.aliyuncs.com`, region: true },
  slb: { version: '2014-05-15', endpoint: (region) => `slb.${region}.aliyuncs.com`, region: true },
  ram: { version: '2015-05-01', endpoint: () => 'ram.aliyuncs.com', region: false },
  dns: { version: '2015-01-09', endpoint: () => 'alidns.aliyuncs.com', region: true },
  cdn: { version: '2018-05-10', endpoint: () => 'cdn.aliyuncs.com', region: false },
  cs: { version: '2015-12-15', endpoint: (region) => `cs.${region}.aliyuncs.com`, region: true },
  oss: { version: '2013-10-15', endpoint: (region) => `oss-${region}.aliyuncs.com`, region: true },
}

/** Error codes that mean "this instance cannot stop in economy mode". */
const STOP_CHARGING_HINTS = /stopcharging|stopped\s*mode|economy|节省|停机模式/i

export class AliyunError extends Error {
  constructor({ code, message, requestId, status, advice, cause }) {
    super(message || code || 'aliyun request failed', cause ? { cause } : undefined)
    this.name = 'AliyunError'
    this.code = code || 'AliyunError'
    this.requestId = requestId
    this.status = status
    this.advice = advice
  }
}

function adviceFor(code, message) {
  const text = `${code || ''} ${message || ''}`
  if (/InvalidAccessKeyId/i.test(text)) return 'AccessKeyId 无效或已被禁用：检查凭据，或到 RAM 控制台确认状态。'
  if (/SignatureDoesNotMatch/i.test(text)) return '签名不匹配：多为系统时间偏差或 Secret 错误，校准本机时间后重试。'
  if (/Forbidden|NoPermission|UnauthorizedOperation/i.test(text)) return 'RAM 权限不足：按 README 的最小权限策略为这个 AccessKey 授权。'
  if (/Throttling|Throttling\.User/i.test(text)) return '请求被限流：稍后重试，或降低并发/扫描页数。'
  if (/InvalidRegionId|InvalidRegion/i.test(text)) return '地域无效：换成合法 RegionId（例如 cn-hangzhou、cn-shanghai）。'
  if (/IncorrectInstanceStatus|InvalidInstanceId|InvalidInstance\.NotFound/i.test(text)) return '实例状态或 ID 不合法：先用 aliyun_ecs action=list 核对实例。'
  if (/OperationDenied/i.test(text)) return '该操作被拒绝：常见原因是不支持节省停机、实例受保护或账号欠费。'
  if (/ServiceUnavailable|InternalError/i.test(text)) return '阿里云服务端暂时不可用：稍后重试。'
  return undefined
}

function asIsoUtc(date) {
  return date.toISOString().replace(/\.\d{3}Z$/, 'Z')
}

function abortReason(signal) {
  if (!signal) return undefined
  if (typeof signal.reason !== 'undefined') return signal.reason
  const error = new Error('aborted')
  error.name = 'AbortError'
  return error
}

export function isAbortError(error) {
  return error?.name === 'AbortError' || /aborted|abort/i.test(String(error?.message || ''))
}

/**
 * Sign and send one RPC request.
 *
 * @param {object} options
 * @param {string} options.product    key of PRODUCTS (or any product name)
 * @param {string} options.action     OpenAPI Action
 * @param {string} [options.version]  API version, defaults to the catalog value
 * @param {string} [options.region]   RegionId (omitted for global products)
 * @param {object} [options.params]   action parameters; arrays expand to Key.N
 * @param {string} [options.endpoint] explicit endpoint override
 * @param {object} options.credentials { accessKeyId, accessKeySecret, securityToken? }
 * @param {object} options.settings   requestTimeoutMs and endpointOverrides
 * @param {AbortSignal} [options.signal]
 * @param {boolean} [options.includeRegion]
 */
export async function callRpc(options) {
  const {
    product,
    action,
    version,
    region,
    params = {},
    endpoint,
    credentials,
    settings,
    signal,
  } = options
  if (!credentials?.accessKeyId || !credentials?.accessKeySecret) {
    throw new AliyunError({
      code: 'NoCredentials',
      message: '未配置阿里云 AccessKey（ALIYUN_ACCESS_KEY_ID / ALIYUN_ACCESS_KEY_SECRET）。',
      advice: '在 Settings →「阿里云」保存 AccessKey，或设置同名环境变量。',
    })
  }
  const catalog = PRODUCTS[product]
  const includeRegion =
    typeof options.includeRegion === 'boolean'
      ? options.includeRegion
      : Boolean(catalog ? catalog.region : true)
  const apiVersion = version || catalog?.version
  if (!apiVersion) {
    throw new AliyunError({
      code: 'MissingVersion',
      message: `产品 ${product} 没有内置 API 版本，请在调用中显式提供 version。`,
    })
  }
  const host =
    endpoint ||
    settings?.endpointOverrides?.[product] ||
    (catalog ? catalog.endpoint(region) : `${product}.${region}.aliyuncs.com`)

  const now = new Date()
  const raw = {
    ...params,
    Action: action,
    Format: 'JSON',
    Version: apiVersion,
    AccessKeyId: credentials.accessKeyId,
    SignatureMethod: 'HMAC-SHA1',
    SignatureNonce: randomUUID(),
    SignatureVersion: '1.0',
    Timestamp: asIsoUtc(now),
    RegionId: region,
  }
  if (!includeRegion) delete raw.RegionId
  if (credentials.securityToken) raw.SecurityToken = credentials.securityToken

  const clean = {}
  for (const [key, value] of Object.entries(raw)) {
    if (value === undefined || value === null || value === '') continue
    if (Array.isArray(value)) {
      value.forEach((item, index) => {
        const itemValue = typeof item === 'object' ? JSON.stringify(item) : String(item)
        clean[`${key}.${index + 1}`] = itemValue
      })
      continue
    }
    if (typeof value === 'object') {
      clean[key] = JSON.stringify(value)
      continue
    }
    clean[key] = String(value)
  }

  const signature = rpcSignature('POST', clean, credentials.accessKeySecret)
  const body = canonicalQuery({ ...clean, Signature: signature })
  const url = `https://${host}/`

  const timeoutMs = Math.max(1000, Number(settings?.requestTimeoutMs) || 20000)
  const controller = new AbortController()
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort(new Error('timeout'))
  }, timeoutMs)
  const relay = () => controller.abort(abortReason(signal))
  if (signal) {
    if (signal.aborted) relay()
    else signal.addEventListener('abort', relay, { once: true })
  }

  let response
  let text
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body,
      signal: controller.signal,
    })
    text = await response.text()
  } catch (error) {
    if (timedOut) {
      throw new AliyunError({
        code: 'Timeout',
        message: `请求 ${host} 超时（${timeoutMs}ms）。`,
        advice: '网络到阿里云不通，或请求参数导致服务端处理过慢；先运行 aliyun_doctor。',
        cause: error,
      })
    }
    if (signal?.aborted || isAbortError(error)) {
      const aborted = new Error('请求已取消')
      aborted.name = 'AbortError'
      throw aborted
    }
    throw new AliyunError({
      code: 'NetworkError',
      message: `无法连接 ${host}：${error?.message || error}`,
      advice: '检查出网/DNS，或运行 aliyun_doctor 做连通性自检。',
      cause: error,
    })
  } finally {
    clearTimeout(timer)
    if (signal) signal.removeEventListener('abort', relay)
  }

  let data
  try {
    data = JSON.parse(text)
  } catch {
    throw new AliyunError({
      code: 'InvalidResponse',
      message: `HTTP ${response.status} 返回了非 JSON 内容：${String(text).slice(0, 300)}`,
      status: response.status,
    })
  }
  if (!response.ok || data?.Code) {
    const code = data?.Code || `HTTP${response.status}`
    const message = data?.Message || String(text).slice(0, 300)
    throw new AliyunError({
      code,
      message,
      requestId: data?.RequestId,
      status: response.status,
      advice: adviceFor(code, message),
    })
  }
  return data
}

/** Build and send one OSS request (signature V1). */
export async function callOss(options) {
  const {
    method = 'GET',
    region,
    bucket,
    key,
    query,
    subresources,
    headers = {},
    credentials,
    settings,
    signal,
  } = options
  if (!credentials?.accessKeyId || !credentials?.accessKeySecret) {
    throw new AliyunError({
      code: 'NoCredentials',
      message: '未配置阿里云 AccessKey（ALIYUN_ACCESS_KEY_ID / ALIYUN_ACCESS_KEY_SECRET）。',
    })
  }
  const catalog = PRODUCTS.oss
  const endpoint =
    options.endpoint ||
    settings?.endpointOverrides?.oss ||
    catalog.endpoint(region || settings?.defaultRegion || 'cn-hangzhou')
  const host = bucket ? `${bucket}.${endpoint}` : endpoint
  const date = new Date().toUTCString()
  const ossHeaders = {
    ...(credentials.securityToken ? { 'x-oss-security-token': credentials.securityToken } : {}),
    ...headers,
  }
  const signature = ossSignature(
    { method, date, headers: ossHeaders, bucket, key, subresources },
    credentials.accessKeySecret,
  )
  const qs = new URLSearchParams(query || {}).toString()
  const url =
    `https://${host}/` +
    (key ? key.split('/').map(encodeURIComponent).join('/') : '') +
    (qs ? '?' + qs : '')

  const timeoutMs = Math.max(1000, Number(settings?.requestTimeoutMs) || 20000)
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new Error('timeout')), timeoutMs)
  const relay = () => controller.abort(abortReason(signal))
  if (signal) {
    if (signal.aborted) relay()
    else signal.addEventListener('abort', relay, { once: true })
  }
  let response
  let text
  try {
    response = await fetch(url, {
      method,
      headers: {
        Date: date,
        Authorization: `OSS ${credentials.accessKeyId}:${signature}`,
        ...ossHeaders,
      },
      signal: controller.signal,
    })
    text = await response.text()
  } catch (error) {
    if (signal?.aborted || isAbortError(error)) {
      const aborted = new Error('请求已取消')
      aborted.name = 'AbortError'
      throw aborted
    }
    throw new AliyunError({
      code: 'NetworkError',
      message: `无法连接 ${host}：${error?.message || error}`,
    })
  } finally {
    clearTimeout(timer)
    if (signal) signal.removeEventListener('abort', relay)
  }
  if (!response.ok) {
    const match = /<Code>([^<]+)<\/Code>\s*<Message>([^<]*)<\/Message>/i.exec(text || '')
    throw new AliyunError({
      code: match?.[1] || `HTTP${response.status}`,
      message: (match?.[2] || String(text).slice(0, 300)) + ` (${host})`,
      status: response.status,
    })
  }
  return { status: response.status, headers: response.headers, text }
}

export { STOP_CHARGING_HINTS }
