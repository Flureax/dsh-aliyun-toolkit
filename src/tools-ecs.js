/**
 * `aliyun_ecs` — ECS query and lifecycle management.
 *
 * Read actions never ask for approval. Every write action goes through the
 * plugin's write policy, and irreversible ones require an explicit confirmation.
 */
import { callRpc } from './rpc.js'
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
  stringList,
  toIsoUtc,
  toolFailure,
} from './util.js'

const READ_ACTIONS = new Set(['list', 'get'])
const ALL_ACTIONS = [
  'list',
  'get',
  'start',
  'stop',
  'reboot',
  'release',
  'run_spot',
  'auto_release',
]

function compact(instance) {
  if (!instance || typeof instance !== 'object') return instance
  const privateIps = instance.VpcAttributes?.PrivateIpAddress?.IpAddress || []
  const publicIps = instance.PublicIpAddress?.IpAddress || []
  return {
    id: instance.InstanceId,
    name: instance.InstanceName,
    status: instance.Status,
    chargeType: instance.InstanceChargeType,
    spotStrategy: instance.SpotStrategy || null,
    instanceType: instance.InstanceType,
    region: instance.RegionId,
    zone: instance.ZoneId,
    cpu: instance.Cpu,
    memoryMb: instance.Memory,
    os: instance.OSName,
    privateIp: privateIps.join(','),
    publicIp: publicIps.join(','),
    created: instance.CreationTime,
    expired: instance.ExpiredTime || null,
    autoRelease: instance.AutoReleaseTime || null,
    stoppedMode: instance.StoppedMode || null,
  }
}

function describeFilters(args) {
  const params = { PageSize: 100, PageNumber: 1 }
  if (args.status) params.Status = String(args.status)
  if (args.name) params.InstanceName = String(args.name)
  if (args.instance_ids) params.InstanceIds = JSON.stringify(stringList(args.instance_ids, 'instance_ids'))
  return params
}

async function listInstances(base, args, settings) {
  const limit = intInRange(args.limit, settings.maxResults, 1, 100, 'limit')
  const params = { ...describeFilters(args), PageSize: limit }
  const response = await callRpc({ ...base, action: 'DescribeInstances', params })
  const list = response?.Instances?.Instance || []
  const total = Number(response?.TotalCount ?? list.length)
  return {
    ok: true,
    region: base.region,
    total,
    returned: list.length,
    truncated: list.length < total,
    instances: list.map(compact),
  }
}

async function oneInstance(base, id) {
  const response = await callRpc({
    ...base,
    action: 'DescribeInstances',
    params: { InstanceIds: JSON.stringify([id]) },
  })
  const list = response?.Instances?.Instance || []
  return list.map(compact)[0]
}

async function runOne(ids, operation) {
  const results = []
  for (const id of ids) {
    try {
      const response = await operation(id)
      results.push({ instanceId: id, ok: true, requestId: response?.RequestId })
    } catch (error) {
      if (error?.name === 'AbortError') throw error
      results.push({
        instanceId: id,
        ok: false,
        code: error?.code || 'Error',
        message: error?.message || String(error),
        ...(error?.requestId ? { requestId: error.requestId } : {}),
        ...(error?.advice ? { advice: error.advice } : {}),
      })
    }
  }
  return { ok: results.every((item) => item.ok), results }
}

async function run(ctx, args, exec) {
  const action = String(args?.action || 'list')
  if (!ALL_ACTIONS.includes(action)) throw inputError(`不支持的 action：${action}`)
  const { settings, credentials } = await prepare(ctx)
  requireCredentials(credentials)
  const region = optionalString(args.region, 'region') || settings.defaultRegion
  const base = { product: 'ecs', region, credentials, settings, signal: exec.signal }

  if (action === 'list') return listInstances(base, args, settings)
  if (action === 'get') {
    const id = stringList(args.instance_ids, 'instance_ids')[0]
    if (!id) throw inputError('get 需要 instance_ids[0]。')
    const instance = await oneInstance(base, id)
    return instance ? { ok: true, instance } : toolFailure('InstanceNotFound', `未找到实例 ${id}（${region}）。`)
  }

  if (action === 'run_spot') {
    const imageId = requiredField(args.image_id, 'image_id')
    const instanceType = requiredField(args.instance_type, 'instance_type')
    const securityGroupId = requiredField(args.security_group_id, 'security_group_id')
    const vswitchId = requiredField(args.vswitch_id, 'vswitch_id')
    const hours = intInRange(args.hours, settings.autoReleaseHours, 1, 720, 'hours')
    const amount = intInRange(args.amount, 1, 1, 20, 'amount')
    const spotDuration = intInRange(args.spot_duration_hours, 1, 1, 6, 'spot_duration_hours')
    const bandwidth = intInRange(args.internet_max_bandwidth_out, 1, 0, 200, 'internet_max_bandwidth_out')
    const spotStrategy = optionalString(args.spot_strategy, 'spot_strategy') || 'SpotAsPriceGo'
    if (!['SpotAsPriceGo', 'SpotWithPriceLimit'].includes(spotStrategy)) {
      throw inputError('spot_strategy 只能是 SpotAsPriceGo 或 SpotWithPriceLimit。')
    }
    const autoReleaseTime = toIsoUtc(new Date(Date.now() + hours * 3600 * 1000))
    const params = {
      ImageId: imageId,
      InstanceType: instanceType,
      SecurityGroupId: securityGroupId,
      VSwitchId: vswitchId,
      Amount: amount,
      InstanceChargeType: 'PostPaid',
      SpotStrategy: spotStrategy,
      SpotDuration: spotDuration,
      AutoReleaseTime: autoReleaseTime,
      InternetMaxBandwidthOut: bandwidth,
      'SystemDisk.Category': optionalString(args.system_disk_category, 'system_disk_category') || 'cloud_essd',
      'SystemDisk.Size': intInRange(args.system_disk_size_gb, 40, 20, 500, 'system_disk_size_gb'),
    }
    const instanceName = optionalString(args.instance_name, 'instance_name')
    if (instanceName) params.InstanceName = instanceName
    if (spotStrategy === 'SpotWithPriceLimit') {
      const limit = Number(args.spot_price_limit)
      if (!Number.isFinite(limit) || limit <= 0) throw inputError('SpotWithPriceLimit 需要 spot_price_limit（大于 0 的价格）。')
      params.SpotPriceLimit = limit
    }
    if (args.dry_run === true) {
      return { ok: true, dryRun: true, action, region, plan: { params, hoursBeforeRelease: hours } }
    }
    const denied = await approveWrite(ctx, exec, settings, {
      en: `Create ${amount} spot ECS instance(s) in ${region}, auto-release in ${hours}h`,
      zh: `创建 ${amount} 台抢占式 ECS（${region}），${hours} 小时后自动释放`,
    })
    if (denied) return denied
    const response = await callRpc({ ...base, action: 'RunInstances', params })
    return {
      ok: true,
      action,
      region,
      instanceIds: response?.InstanceIdSets?.InstanceIdSet || [],
      autoReleaseTime,
      requestId: response?.RequestId,
    }
  }

  const ids = stringList(args.instance_ids, 'instance_ids')
  if (ids.length === 0) throw inputError('该写操作需要 instance_ids（先用 action=list 查实例）。')
  const limited = ids.slice(0, settings.maxBatch)
  const skipped = ids.slice(settings.maxBatch)

  if (action === 'start') {
    const denied = await approveWrite(ctx, exec, settings, {
      en: `Start ${limited.length} ECS instance(s) in ${region}`,
      zh: `启动 ${limited.length} 台 ECS（${region}）`,
    })
    if (denied) return denied
    const response = await callRpc({
      ...base,
      action: 'StartInstances',
      params: { InstanceId: limited },
    })
    return { ok: true, action, region, started: limited, skipped, requestId: response?.RequestId }
  }

  if (action === 'reboot') {
    const denied = await approveWrite(ctx, exec, settings, {
      en: `Reboot ${limited.length} ECS instance(s) in ${region}`,
      zh: `重启 ${limited.length} 台 ECS（${region}）`,
    })
    if (denied) return denied
    const response = await callRpc({
      ...base,
      action: 'RebootInstances',
      params: { InstanceId: limited, ForceStop: args.force === true },
    })
    return { ok: true, action, region, rebooted: limited, skipped, requestId: response?.RequestId }
  }

  if (action === 'stop') {
    const stoppedMode = optionalString(args.stopped_mode, 'stopped_mode') || 'StopCharging'
    if (!['StopCharging', 'KeepCharging'].includes(stoppedMode)) {
      throw inputError('stopped_mode 只能是 StopCharging（节省停机）或 KeepCharging。')
    }
    if (args.dry_run === true) {
      return { ok: true, dryRun: true, action, region, stoppedMode, targets: limited, skipped }
    }
    const denied = await approveWrite(ctx, exec, settings, {
      en: `Stop ${limited.length} ECS instance(s) in ${region} (${stoppedMode})`,
      zh: `停机 ${limited.length} 台 ECS（${region}，${stoppedMode === 'StopCharging' ? '节省停机不收费' : '普通停机'}）`,
    })
    if (denied) return denied
    const result = await runOne(limited, async (id) => {
      try {
        return await callRpc({
          ...base,
          action: 'StopInstances',
          params: { InstanceId: [id], StoppedMode: stoppedMode },
        })
      } catch (error) {
        if (stoppedMode !== 'StopCharging' || error?.name === 'AbortError') throw error
        if (!/OperationDenied|StopCharging|economy|节省|stopped mode/i.test(`${error?.code} ${error?.message}`)) throw error
        const fallback = await callRpc({
          ...base,
          action: 'StopInstances',
          params: { InstanceId: [id], StoppedMode: 'KeepCharging' },
        })
        return { ...fallback, warning: '节省停机不受支持，已改为普通停机：仍会继续计费。' }
      }
    })
    return { ...result, action, region, stoppedMode, skipped }
  }

  if (action === 'release') {
    const dryRun = args.dry_run !== false
    if (dryRun) {
      const details = []
      for (const id of limited) {
        const instance = await oneInstance(base, id).catch(() => undefined)
        details.push({ instanceId: id, name: instance?.name, chargeType: instance?.chargeType })
      }
      return {
        ok: true,
        dryRun: true,
        action,
        region,
        targets: details,
        skipped,
        next: '释放不可逆：确认后传 dry_run=false 且 confirm=true。',
      }
    }
    if (args.confirm !== true) {
      return toolFailure('ConfirmRequired', '释放实例不可逆，必须显式传 confirm=true 且 dry_run=false。')
    }
    const denied = await approveWrite(ctx, exec, settings, {
      en: `Permanently release ${limited.length} ECS instance(s) in ${region}`,
      zh: `永久释放 ${limited.length} 台 ECS（${region}）— 不可恢复`,
    })
    if (denied) return denied
    const result = await runOne(limited, (id) =>
      callRpc({ ...base, action: 'DeleteInstance', params: { InstanceId: id, Force: false } }),
    )
    return { ...result, action, region, released: limited, skipped }
  }

  if (action === 'auto_release') {
    const hours = intInRange(args.hours, settings.autoReleaseHours, 1, 720, 'hours')
    const autoReleaseTime = toIsoUtc(new Date(Date.now() + hours * 3600 * 1000))
    if (args.dry_run === true) {
      return { ok: true, dryRun: true, action, region, autoReleaseTime, targets: limited, skipped }
    }
    const denied = await approveWrite(ctx, exec, settings, {
      en: `Set auto-release for ${limited.length} ECS instance(s) in ${region} at ${autoReleaseTime}`,
      zh: `为 ${limited.length} 台 ECS（${region}）设置 ${hours} 小时后自动释放`,
    })
    if (denied) return denied
    const result = await runOne(limited, (id) =>
      callRpc({
        ...base,
        action: 'ModifyInstanceAutoReleaseTime',
        params: { InstanceId: id, AutoReleaseTime: autoReleaseTime },
      }),
    )
    return { ...result, action, region, autoReleaseTime, skipped }
  }

  throw inputError(`未实现的 action：${action}`)
}

function requiredField(value, field) {
  if (typeof value !== 'string' || !value.trim()) throw inputError(`${field} 必填。`)
  return value.trim()
}

export function registerEcs(ctx) {
  ctx.tools.register({
    name: 'aliyun_ecs',
    description:
      '查询与管理阿里云 ECS。读操作（list/get）直接执行；写操作（start/stop/reboot/release/run_spot/auto_release）受插件写策略与 DSH 审批约束。' +
      '按量付费实例停止时默认使用节省停机模式（StopCharging，不收取计算费用）；release 不可逆，默认只预演。' +
      'run_spot 创建抢占式实例并默认设置自动释放时间，适合临时算力。',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ALL_ACTIONS,
          description: 'list 列举；get 单台详情；start/stop/reboot 启动/停机/重启；release 释放（不可逆）；run_spot 创建抢占式实例；auto_release 设置自动释放时间。',
        },
        region: {
          type: 'string',
          description: '地域 ID，默认取插件设置（cn-hangzhou）。',
        },
        instance_ids: {
          type: 'array',
          items: { type: 'string' },
          description: '实例 ID 列表；除 list/run_spot 外的操作必填。',
        },
        status: {
          type: 'string',
          enum: ['Running', 'Stopped', 'Starting', 'Stopping'],
          description: 'list 时按状态过滤。',
        },
        name: {
          type: 'string',
          description: 'list 时按实例名过滤（支持 * 通配）。',
        },
        limit: {
          type: 'number',
          description: 'list 返回条数（1-100，默认取插件设置）。',
        },
        stopped_mode: {
          type: 'string',
          enum: ['StopCharging', 'KeepCharging'],
          description: 'stop 的停机模式，默认 StopCharging（仅按量付费、且实例支持时免计算费）。',
        },
        dry_run: {
          type: 'boolean',
          description: 'true 时只返回将要执行的计划；release 默认 true，其他操作默认 false。',
        },
        confirm: {
          type: 'boolean',
          description: 'release 必须显式传 true 才会真正删除实例。',
        },
        hours: {
          type: 'number',
          description: 'run_spot / auto_release 的自动释放小时数（1-720，默认取插件设置 autoReleaseHours）。',
        },
        image_id: { type: 'string', description: 'run_spot 必填：镜像 ID（如 ubuntu_22_04_x64_20G_alibase_*）。' },
        instance_type: { type: 'string', description: 'run_spot 必填：实例规格（如 ecs.t6-c1m2.large）。' },
        security_group_id: { type: 'string', description: 'run_spot 必填：安全组 ID。' },
        vswitch_id: { type: 'string', description: 'run_spot 必填：交换机 ID。' },
        amount: { type: 'number', description: 'run_spot 创建数量（1-20，默认 1）。' },
        spot_strategy: {
          type: 'string',
          enum: ['SpotAsPriceGo', 'SpotWithPriceLimit'],
          description: '抢占式策略，默认 SpotAsPriceGo（随市场价）。',
        },
        spot_price_limit: { type: 'number', description: 'SpotWithPriceLimit 时的出价上限（元/小时）。' },
        spot_duration_hours: {
          type: 'number',
          description: '抢占式实例保护期（1-6 小时，默认 1）。',
        },
        internet_max_bandwidth_out: {
          type: 'number',
          description: '公网出口带宽 Mbps（0-200，默认 1；0 表示无公网 IP）。',
        },
        instance_name: { type: 'string', description: 'run_spot 的实例名。' },
        system_disk_category: { type: 'string', description: '系统盘类型，默认 cloud_essd。' },
        system_disk_size_gb: { type: 'number', description: '系统盘大小 GB（20-500，默认 40）。' },
        force: { type: 'boolean', description: 'reboot 时是否强制。' },
      },
      required: ['action'],
    },
    output: { schema: OUTPUT_SCHEMA, render: renderValue },
    timeoutMs: 180000,
    isConcurrencySafe: (args) => READ_ACTIONS.has(String(args?.action || 'list')),
    presentCall: (args) => ({
      card: 'generic',
      title: `阿里云 ECS · ${args?.action || 'list'}`,
      kind: READ_ACTIONS.has(String(args?.action || 'list')) ? 'read' : 'execute',
      rawInput: args,
    }),
    execute: (args, exec) => guarded(() => run(ctx, args, exec)),
  })
}
