/**
 * Alibaba Cloud request signing.
 *
 * Two independent schemes live here:
 * - RPC style (ECS / CMS / BSS / most products) with SignatureVersion 1.0,
 *   HMAC-SHA1 over `METHOD&%2F&percentEncode(canonicalQuery)`.
 * - OSS style (object storage), HMAC-SHA1 over
 *   `VERB\nContent-MD5\nContent-Type\nDate\nCanonicalizedOSSHeaders + CanonicalizedResource`.
 *
 * Only node:crypto is used, so the plugin installs without any npm dependency.
 */
import { createHmac } from 'node:crypto'

/** RFC 3986 percent encoding, as required by the RPC signature. */
export function percentEncode(value) {
  return encodeURIComponent(String(value)).replace(
    /[!'()*]/g,
    (ch) => '%' + ch.charCodeAt(0).toString(16).toUpperCase(),
  )
}

/** Sorted `k=v&...` string for the RPC signature and for the form body. */
export function canonicalQuery(params) {
  return Object.keys(params)
    .filter((key) => params[key] !== undefined && params[key] !== null)
    .sort()
    .map((key) => percentEncode(key) + '=' + percentEncode(params[key]))
    .join('&')
}

/** The RPC string to sign. */
export function rpcStringToSign(method, params) {
  return (
    String(method).toUpperCase() +
    '&' +
    percentEncode('/') +
    '&' +
    percentEncode(canonicalQuery(params))
  )
}

/** Base64 HMAC-SHA1 signature for one RPC request. */
export function rpcSignature(method, params, accessKeySecret) {
  return createHmac('sha1', String(accessKeySecret) + '&')
    .update(rpcStringToSign(method, params), 'utf8')
    .digest('base64')
}

/** `x-oss-*` headers, lowercased and sorted, each terminated by a newline. */
export function ossCanonicalizedHeaders(headers) {
  const entries = Object.entries(headers || {})
    .map(([key, value]) => [key.toLowerCase(), String(value).trim()])
    .filter(([key]) => key.startsWith('x-oss-'))
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
  if (entries.length === 0) return ''
  return entries.map(([key, value]) => key + ':' + value).join('\n') + '\n'
}

/** `/bucket/key` plus sorted sub-resources, used verbatim in the OSS signature. */
export function ossCanonicalizedResource(bucket, key, subresources) {
  let resource = '/'
  if (bucket) resource += bucket + '/'
  if (key) resource += key
  const names = Object.keys(subresources || {}).sort()
  if (names.length > 0) {
    resource +=
      '?' +
      names
        .map((name) => {
          const value = subresources[name]
          return value === '' || value === undefined || value === null ? name : name + '=' + value
        })
        .join('&')
  }
  return resource
}

/** The OSS string to sign. */
export function ossStringToSign(options) {
  const {
    method = 'GET',
    contentMd5 = '',
    contentType = '',
    date = '',
    headers = {},
    bucket,
    key,
    subresources,
  } = options
  return [
    String(method).toUpperCase(),
    contentMd5,
    contentType,
    date,
    ossCanonicalizedHeaders(headers) + ossCanonicalizedResource(bucket, key, subresources),
  ].join('\n')
}

/** Base64 HMAC-SHA1 signature for one OSS request (secret is used as-is). */
export function ossSignature(options, accessKeySecret) {
  return createHmac('sha1', String(accessKeySecret))
    .update(ossStringToSign(options), 'utf8')
    .digest('base64')
}

/**
 * A signed, time-limited OSS URL. No request is made; the URL is valid for
 * `expiresSeconds` from now.
 */
export function ossPresignUrl(options) {
  const {
    method = 'GET',
    endpoint,
    bucket,
    key,
    accessKeyId,
    accessKeySecret,
    securityToken,
    expiresSeconds = 3600,
    contentType = '',
  } = options
  const expires = Math.floor(Date.now() / 1000) + Math.max(1, Math.floor(expiresSeconds))
  const headers = securityToken ? { 'x-oss-security-token': securityToken } : {}
  const signature = ossSignature(
    { method, contentType, date: String(expires), headers, bucket, key },
    accessKeySecret,
  )
  const query =
    'OSSAccessKeyId=' +
    encodeURIComponent(accessKeyId) +
    '&Expires=' +
    expires +
    '&Signature=' +
    encodeURIComponent(signature) +
    (securityToken ? '&security-token=' + encodeURIComponent(securityToken) : '')
  const path = key ? '/' + String(key).split('/').map(encodeURIComponent).join('/') : '/'
  const host = bucket ? bucket + '.' + endpoint : endpoint
  return `https://${host}${path}?${query}`
}
