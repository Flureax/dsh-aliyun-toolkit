/**
 * `aliyun_oss` — object storage listing, metadata, presigned URLs and delete.
 * Upload/download is intentionally out of scope: large bodies do not belong in
 * the model's context.
 */
import { callOss } from './rpc.js'
import { ossPresignUrl } from './sign.js'
import {
  OUTPUT_SCHEMA,
  approveWrite,
  guarded,
  inputError,
  intInRange,
  optionalString,
  prepare,
  renderValue,
  requireCredentials,
  requiredString,
  toolFailure,
} from './util.js'

const ACTIONS = ['list_buckets', 'list_objects', 'head_object', 'presign', 'delete_object']
const READ_ACTIONS = new Set(['list_buckets', 'list_objects', 'head_object', 'presign'])

function xmlBlocks(text, tag) {
  const blocks = []
  const pattern = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, 'gi')
  let match
  while ((match = pattern.exec(text))) blocks.push(match[1])
  return blocks
}

function xmlValue(block, tag) {
  const match = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, 'i').exec(block)
  return match ? match[1] : undefined
}

function decodeXml(value) {
  return String(value || '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
}

function listBuckets(response) {
  return xmlBlocks(response.text, 'Bucket').map((block) => ({
    name: decodeXml(xmlValue(block, 'Name')),
    created: xmlValue(block, 'CreationDate'),
    location: xmlValue(block, 'Location'),
    storageClass: xmlValue(block, 'StorageClass'),
  }))
}

function listObjects(response) {
  const objects = xmlBlocks(response.text, 'Contents').map((block) => ({
    key: decodeXml(xmlValue(block, 'Key')),
    size: Number(xmlValue(block, 'Size') || 0),
    lastModified: xmlValue(block, 'LastModified'),
    storageClass: xmlValue(block, 'StorageClass'),
    etag: (xmlValue(block, 'ETag') || '').replace(/"/g, ''),
  }))
  return {
    objects,
    truncated: /<IsTruncated>\s*true\s*<\/IsTruncated>/i.test(response.text),
    nextContinuationToken: decodeXml(xmlValue(response.text, 'NextContinuationToken')),
    keyCount: Number(xmlValue(response.text, 'KeyCount') || objects.length),
  }
}

async function run(ctx, args, exec) {
  const action = String(args?.action || 'list_buckets')
  if (!ACTIONS.includes(action)) throw inputError(`不支持的 action：${action}`)
  const { settings, credentials } = await prepare(ctx)
  requireCredentials(credentials)
  const region = optionalString(args.region, 'region') || settings.defaultRegion
  const base = { region, credentials, settings, signal: exec.signal }

  if (action === 'list_buckets') {
    const response = await callOss({ ...base, method: 'GET' })
    return { ok: true, action, region, buckets: listBuckets(response) }
  }

  if (action === 'presign') {
    const bucket = requiredString(args.bucket, 'bucket')
    const key = requiredString(args.key, 'key')
    const expires = intInRange(args.expires_seconds, 3600, 60, 604800, 'expires_seconds')
    const method = (optionalString(args.method, 'method') || 'GET').toUpperCase()
    if (!['GET', 'PUT'].includes(method)) throw inputError('method 只能是 GET 或 PUT。')
    const contentType = optionalString(args.content_type, 'content_type') || ''
    if (method === 'PUT' && !contentType) {
      throw inputError('PUT 预签名必须提供 content_type，上传时发送的 Content-Type 必须与之一致。')
    }
    const endpoint =
      settings.endpointOverrides?.oss || `oss-${region}.aliyuncs.com`
    return {
      ok: true,
      action,
      region,
      bucket,
      key,
      method,
      contentType,
      expiresIn: expires,
      url: ossPresignUrl({
        method,
        endpoint,
        bucket,
        key,
        contentType,
        accessKeyId: credentials.accessKeyId,
        accessKeySecret: credentials.accessKeySecret,
        securityToken: credentials.securityToken || undefined,
        expiresSeconds: expires,
      }),
    }
  }

  const bucket = requiredString(args.bucket, 'bucket')
  if (action === 'list_objects') {
    const maxKeys = intInRange(args.max_keys, Math.min(settings.maxResults, 100), 1, 1000, 'max_keys')
    const response = await callOss({
      ...base,
      method: 'GET',
      bucket,
      query: {
        'list-type': '2',
        'max-keys': maxKeys,
        ...(optionalString(args.prefix, 'prefix') ? { prefix: optionalString(args.prefix, 'prefix') } : {}),
        ...(optionalString(args.continuation_token, 'continuation_token')
          ? { 'continuation-token': optionalString(args.continuation_token, 'continuation_token') }
          : {}),
      },
    })
    return { ok: true, action, bucket, ...listObjects(response) }
  }

  const key = requiredString(args.key, 'key')

  if (action === 'head_object') {
    const response = await callOss({ ...base, method: 'HEAD', bucket, key })
    return {
      ok: true,
      action,
      bucket,
      key,
      size: Number(response.headers.get('content-length') || 0),
      contentType: response.headers.get('content-type'),
      etag: (response.headers.get('etag') || '').replace(/"/g, ''),
      lastModified: response.headers.get('last-modified'),
      storageClass: response.headers.get('x-oss-storage-class'),
      objectType: response.headers.get('x-oss-object-type'),
    }
  }

  if (action === 'delete_object') {
    if (args.dry_run === true) {
      return { ok: true, dryRun: true, action, bucket, key }
    }
    const denied = await approveWrite(ctx, exec, settings, {
      en: `Delete OSS object ${bucket}/${key}`,
      zh: `删除 OSS 对象 ${bucket}/${key}`,
    })
    if (denied) return denied
    const response = await callOss({ ...base, method: 'DELETE', bucket, key })
    return { ok: true, action, bucket, key, status: response.status }
  }

  return toolFailure('Unsupported', `未实现的 action：${action}`)
}

export function registerOss(ctx) {
  ctx.tools.register({
    name: 'aliyun_oss',
    description:
      '阿里云 OSS 对象存储：列举 bucket、列举/检索对象、读取对象元数据、生成限时预签名下载链接、删除对象。' +
      '不上传/下载对象内容（避免把大对象放进上下文）。删除走 DSH 审批；预签名只本地生成 URL，不发请求。',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ACTIONS,
          description: 'list_buckets 列举 bucket；list_objects 列举对象（V2）；head_object 对象元数据；presign 生成限时 URL；delete_object 删除对象。',
        },
        region: { type: 'string', description: '地域 ID，默认取插件设置（影响 oss-{region}.aliyuncs.com）。' },
        bucket: { type: 'string', description: 'bucket 名称（除 list_buckets 外必填）。' },
        key: { type: 'string', description: '对象 key（head_object / presign / delete_object 必填）。' },
        prefix: { type: 'string', description: 'list_objects 的前缀过滤。' },
        max_keys: { type: 'number', description: 'list_objects 返回条数（1-1000，默认取插件设置）。' },
        continuation_token: { type: 'string', description: 'list_objects 翻页令牌（上次返回的 nextContinuationToken）。' },
        expires_seconds: { type: 'number', description: 'presign 有效期秒数（60-604800，默认 3600）。' },
        method: {
          type: 'string',
          enum: ['GET', 'PUT'],
          description: 'presign 的用途：GET 下载（默认），PUT 上传。上传必须同时给 content_type。',
        },
        content_type: {
          type: 'string',
          description: 'PUT 预签名必填：上传时的 Content-Type（如 video/mp4），脚本必须发送同样的值。',
        },
        dry_run: { type: 'boolean', description: 'delete_object 传 true 时只返回将删除的目标。' },
      },
      required: ['action'],
    },
    output: { schema: OUTPUT_SCHEMA, render: renderValue },
    timeoutMs: 60000,
    isConcurrencySafe: (args) => READ_ACTIONS.has(String(args?.action || 'list_buckets')),
    presentCall: (args) => ({
      card: 'generic',
      title: `阿里云 OSS · ${args?.action || 'list_buckets'}`,
      kind: READ_ACTIONS.has(String(args?.action || 'list_buckets')) ? 'read' : 'delete',
      rawInput: args,
    }),
    execute: (args, exec) => guarded(() => run(ctx, args, exec)),
  })
}
