/**
 * Credential access: the DSH credential store first, the process environment
 * second. Secrets never leave this module except as a signature input.
 */
export const CREDENTIAL_REFS = Object.freeze({
  accessKeyId: 'ALIYUN_ACCESS_KEY_ID',
  accessKeySecret: 'ALIYUN_ACCESS_KEY_SECRET',
  securityToken: 'ALIYUN_SECURITY_TOKEN',
})

function serviceOf(ctx) {
  try {
    return ctx?.get?.('credentials')
  } catch {
    return undefined
  }
}

async function resolveOne(ctx, ref) {
  const service = serviceOf(ctx)
  if (service && typeof service.resolve === 'function') {
    try {
      const resolved = await service.resolve(ref)
      if (resolved && typeof resolved.value === 'string' && resolved.value) {
        return { value: resolved.value, source: resolved.source || 'store' }
      }
    } catch {
      // fall through to the environment
    }
  }
  const ambient = process.env[ref]
  if (typeof ambient === 'string' && ambient) return { value: ambient, source: 'env' }
  return undefined
}

/** Resolve all three references. Missing AccessKey values stay empty strings. */
export async function readCredentials(ctx) {
  const [id, secret, token] = await Promise.all([
    resolveOne(ctx, CREDENTIAL_REFS.accessKeyId),
    resolveOne(ctx, CREDENTIAL_REFS.accessKeySecret),
    resolveOne(ctx, CREDENTIAL_REFS.securityToken),
  ])
  return {
    accessKeyId: id?.value || '',
    accessKeySecret: secret?.value || '',
    securityToken: token?.value || '',
    source: { accessKeyId: id?.source, accessKeySecret: secret?.source, securityToken: token?.source },
    complete: Boolean(id?.value && secret?.value),
  }
}

/** Mask an AccessKey ID for display: LTAI****ab12. */
export function maskAccessKeyId(value) {
  const text = String(value || '')
  if (!text) return ''
  if (text.length <= 8) return text.slice(0, 2) + '****'
  return text.slice(0, 4) + '****' + text.slice(-4)
}

async function describeOne(ctx, ref) {
  const service = serviceOf(ctx)
  if (service && typeof service.describe === 'function') {
    try {
      const described = await service.describe(ref)
      if (described && typeof described.configured === 'boolean') {
        return {
          configured: described.configured,
          source: described.source,
          writable: Boolean(described.writable),
        }
      }
    } catch {
      // fall through
    }
  }
  return { configured: Boolean(process.env[ref]), source: process.env[ref] ? 'env' : undefined, writable: false }
}

/** Status used by the settings page; never returns a secret. */
export async function describeCredentials(ctx) {
  const [id, secret, token] = await Promise.all([
    describeOne(ctx, CREDENTIAL_REFS.accessKeyId),
    describeOne(ctx, CREDENTIAL_REFS.accessKeySecret),
    describeOne(ctx, CREDENTIAL_REFS.securityToken),
  ])
  const value = await resolveOne(ctx, CREDENTIAL_REFS.accessKeyId)
  return {
    accessKeyId: { ...id, masked: maskAccessKeyId(value?.value) },
    accessKeySecret: secret,
    securityToken: token,
    configured: Boolean(id.configured && secret.configured),
    writable: Boolean(id.writable && secret.writable),
  }
}

function invalid(message) {
  const error = new Error(message)
  error.code = 'InvalidCredentials'
  return error
}

/** Store AccessKey pair (and an optional STS token) in the credential store. */
export async function saveCredentials(ctx, input) {
  const accessKeyId = typeof input?.accessKeyId === 'string' ? input.accessKeyId.trim() : ''
  const accessKeySecret = typeof input?.accessKeySecret === 'string' ? input.accessKeySecret.trim() : ''
  if (!/^[A-Za-z0-9._-]{8,64}$/.test(accessKeyId)) {
    throw invalid('AccessKey ID 格式不正确（8-64 位字母/数字）。')
  }
  if (accessKeySecret.length < 8 || accessKeySecret.length > 128) {
    throw invalid('AccessKey Secret 长度不正确（8-128 位）。')
  }
  const tokenValue = typeof input?.securityToken === 'string' ? input.securityToken.trim() : ''
  const service = serviceOf(ctx)
  if (!service || typeof service.set !== 'function') {
    throw invalid('当前宿主没有可写的凭据服务，请改用 ALIYUN_ACCESS_KEY_ID / ALIYUN_ACCESS_KEY_SECRET 环境变量。')
  }
  await service.set(CREDENTIAL_REFS.accessKeyId, accessKeyId)
  await service.set(CREDENTIAL_REFS.accessKeySecret, accessKeySecret)
  if (tokenValue) await service.set(CREDENTIAL_REFS.securityToken, tokenValue)
  else if (typeof service.unset === 'function') await service.unset(CREDENTIAL_REFS.securityToken)
  return { accessKeyId: maskAccessKeyId(accessKeyId) }
}

/** Remove all three references from the credential store. */
export async function clearCredentials(ctx) {
  const service = serviceOf(ctx)
  if (!service || typeof service.unset !== 'function') {
    throw invalid('当前宿主没有可写的凭据服务，无法清除。')
  }
  for (const ref of Object.values(CREDENTIAL_REFS)) await service.unset(ref)
}
