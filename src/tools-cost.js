/**
 * `aliyun_cost_guard` — the cost-control tool for pay-as-you-go compute.
 *
 * scan     : read-only report of running postpaid ECS, idle detection via
 *            CloudMonitor CPU, plus billing-but-unused EIPs and disks.
 * stop     : stop instances in economy mode (StopCharging) — the fast brake.
 * release  : delete instances (irreversible, dry-run by default).
 * auto_release: set AutoReleaseTime so nothing bills forever by accident.
 */
import { callRpc } from './rpc.js'
import {
  OUTPUT_SCHEMA,
  approveWrite,
  chunk,
  guarded,
  inputError,
  intInRange,
  optionalString,
  prepare,
  protectionOf,
  renderValue,
  requireCredentials,
  stringList,
  toIsoUtc,
  toolFailure,
} from './util.js'

const ACTIONS = ['scan', 'stop', 'release', 'auto_release']
const SCOPES = ['idle', 'all']

function compactInstance(instance) {
  const publicIps = instance.PublicIpAddress?.IpAddress || []
  const privateIps = instance.VpcAttributes?.PrivateIpAddress?.IpAddress || []
  return {
    id: instance.InstanceId,
    name: instance.InstanceName,
    instanceType: instance.InstanceType,
    zone: instance.ZoneId,
    chargeType: instance.InstanceChargeType,
    spotStrategy: instance.SpotStrategy || null,
    publicIp: publicIps.join(','),
    privateIp: privateIps.join(','),
    created: instance.CreationTime,
    autoRelease: instance.AutoReleaseTime || null,
    stoppedMode: instance.StoppedMode || null,
  }
}

async function fetchInstances(base) {
  const all = []
  let total = 0
  for (let page = 1; page <= 3; page += 1) {
    const response = await callRpc({
      ...base,
      action: 'DescribeInstances',
      params: { PageSize: 100, PageNumber: page },
    })
    const list = response?.Instances?.Instance || []
    total = Number(response?.TotalCount ?? all.length + list.length)
    all.push(...list)
    if (list.length === 0 || all.length >= total) break
  }
  return { all, total }
}

function cmsTime(date) {
  const iso = date.toISOString()
  return iso.slice(0, 10) + ' ' + iso.slice(11, 19)
}

async function cpuAverages(base, ids, minutes) {
  const result = new Map()
  const end = new Date()
  const start = new Date(end.getTime() - minutes * 60 * 1000)
  for (const group of chunk(ids, 20)) {
    try {
      const response = await callRpc({
        ...base,
        action: 'DescribeMetricList',
        params: {
          Namespace: 'acs_ecs_dashboard',
          MetricName: 'cpu_total',
          Dimensions: JSON.stringify(group.map((instanceId) => ({ instanceId }))),
          StartTime: cmsTime(start),
          EndTime: cmsTime(end),
          Period: 300,
        },
      })
      const raw = response?.Datapoints
      const points = typeof raw === 'string' ? JSON.parse(raw) : raw || []
      for (const point of points) {
        const id = point.instanceId || point.dimensions?.instanceId
        const value = Number(point.Average ?? point.average ?? point.Value ?? point.value)
        if (!id || !Number.isFinite(value)) continue
        const bucket = result.get(id) || { sum: 0, count: 0 }
        bucket.sum += value
        bucket.count += 1
        result.set(id, bucket)
      }
    } catch (error) {
      if (error?.name === 'AbortError') throw error
      // CloudMonitor missing data must never be read as "idle".
    }
  }
  const averages = new Map()
  for (const [id, bucket] of result) {
    if (bucket.count > 0) averages.set(id, { average: bucket.sum / bucket.count, samples: bucket.count })
  }
  return averages
}

async function idleResources(base) {
  const eips = []
  const disks = []
  try {
    const response = await callRpc({
      ...base,
      action: 'DescribeEipAddresses',
      params: { Status: 'Available' },
    })
    for (const eip of response?.EipAddresses?.EipAddress || []) {
      eips.push({
        allocationId: eip.AllocationId,
        ip: eip.IpAddress,
        chargeType: eip.ChargeType,
        bandwidth: eip.Bandwidth,
        region: eip.RegionId,
      })
    }
  } catch {
    // scan stays useful without EIP data
  }
  try {
    const response = await callRpc({
      ...base,
      action: 'DescribeDisks',
      params: { Status: 'Available' },
    })
    for (const disk of response?.Disks?.Disk || []) {
      disks.push({
        id: disk.DiskId,
        name: disk.DiskName,
        sizeGb: disk.Size,
        category: disk.Category,
        type: disk.Type,
        chargeType: disk.DiskChargeType,
      })
    }
  } catch {
    // same for disks
  }
  return { eips, disks }
}

async function scanRegion({ base, settings }) {
  const { all, total } = await fetchInstances(base)
  const postpaid = all.filter((instance) => instance.InstanceChargeType === 'PostPaid')
  const running = postpaid.filter((instance) => instance.Status === 'Running')
  const isProtected = protectionOf(settings)
  const cpu = await cpuAverages(base, running.map((instance) => instance.InstanceId), settings.idleWindowMinutes)
  const now = Date.now()
  const minAgeMs = settings.minInstanceAgeMinutes * 60 * 1000

  const candidates = running.map((instance) => {
    const metrics = cpu.get(instance.InstanceId)
    const ageMinutes = instance.CreationTime
      ? Math.max(0, Math.round((now - Date.parse(instance.CreationTime)) / 60000))
      : undefined
    const tooYoung = ageMinutes !== undefined && ageMinutes * 60000 < minAgeMs
    const protectedByRule = isProtected({ id: instance.InstanceId, name: instance.InstanceName })
    const idle =
      metrics !== undefined && metrics.average < settings.idleCpuPercent && !tooYoung && !protectedByRule
    return {
      ...compactInstance(instance),
      ageMinutes,
      cpuAverage: metrics ? Number(metrics.average.toFixed(2)) : null,
      cpuSamples: metrics?.samples ?? 0,
      protected: protectedByRule,
      tooYoung,
      idle,
      recommendation: protectedByRule
        ? 'protect'
        : tooYoung
          ? 'keep-young'
          : metrics === undefined
            ? 'unknown-cpu'
            : idle
              ? 'stop-to-save'
              : 'keep-busy',
      action: idle ? 'aliyun_cost_guard action=stop' : null,
    }
  })

  const resources = await idleResources(base)
  const idleCount = candidates.filter((item) => item.idle).length
  return {
    scannedInstances: all.length,
    totalInstances: total,
    truncated: all.length < total,
    postpaidRunning: candidates.length,
    idleCount,
    stoppedMode: 'StopCharging',
    instances: candidates,
    idleResources: resources,
    notes: [
      '停机不收费（StopCharging）只适用于支持该模式的按量付费实例；本地盘或经典网络实例可能被拒绝。',
      '被保护的实例（protectIds / protectPatterns）与创建不足 minInstanceAgeMinutes 的实例不会被自动停机。',
      '未挂载云盘与未绑定 EIP 仍会产生费用，可用 aliyun_api 调用 ReleaseEipAddress / DeleteDisk 清理。',
    ],
  }
}

async function instancesById(base, ids) {
  const response = await callRpc({
    ...base,
    action: 'DescribeInstances',
    params: { InstanceIds: JSON.stringify(ids), PageSize: 100 },
  })
  return response?.Instances?.Instance || []
}

async function stopOne(base, id) {
  try {
    const response = await callRpc({
      ...base,
      action: 'StopInstances',
      params: { InstanceId: [id], StoppedMode: 'StopCharging' },
    })
    return { instanceId: id, ok: true, stoppedMode: 'StopCharging', requestId: response?.RequestId }
  } catch (error) {
    if (error?.name === 'AbortError') throw error
    if (!/OperationDenied|StopCharging|economy|节省|stopped mode/i.test(`${error?.code} ${error?.message}`)) {
      return {
        instanceId: id,
        ok: false,
        code: error?.code || 'Error',
        message: error?.message || String(error),
        advice: error?.advice,
      }
    }
    try {
      const response = await callRpc({
        ...base,
        action: 'StopInstances',
        params: { InstanceId: [id], StoppedMode: 'KeepCharging' },
      })
      return {
        instanceId: id,
        ok: true,
        stoppedMode: 'KeepCharging',
        warning: '该实例不支持节省停机，已按普通停机处理：计算资源仍会计费。',
        requestId: response?.RequestId,
      }
    } catch (fallbackError) {
      return {
        instanceId: id,
        ok: false,
        code: fallbackError?.code || 'Error',
        message: fallbackError?.message || String(fallbackError),
        advice: fallbackError?.advice,
      }
    }
  }
}

async function releaseOne(base, id) {
  try {
    const response = await callRpc({
      ...base,
      action: 'DeleteInstance',
      params: { InstanceId: id, Force: false },
    })
    return { instanceId: id, ok: true, requestId: response?.RequestId }
  } catch (error) {
    if (error?.name === 'AbortError') throw error
    return {
      instanceId: id,
      ok: false,
      code: error?.code || 'Error',
      message: error?.message || String(error),
      advice: error?.advice,
    }
  }
}

async function autoReleaseOne(base, id, time) {
  try {
    const response = await callRpc({
      ...base,
      action: 'ModifyInstanceAutoReleaseTime',
      params: { InstanceId: id, AutoReleaseTime: time },
    })
    return { instanceId: id, ok: true, autoReleaseTime: time, requestId: response?.RequestId }
  } catch (error) {
    if (error?.name === 'AbortError') throw error
    return {
      instanceId: id,
      ok: false,
      code: error?.code || 'Error',
      message: error?.message || String(error),
      advice: error?.advice,
    }
  }
}

async function run(ctx, args, exec) {
  const action = String(args?.action || 'scan')
  if (!ACTIONS.includes(action)) throw inputError(`不支持的 action：${action}`)
  const scope = String(args?.scope || 'idle')
  if (!SCOPES.includes(scope)) throw inputError('scope 只能是 idle 或 all。')
  const { settings, credentials } = await prepare(ctx)
  requireCredentials(credentials)
  const region = optionalString(args.region, 'region') || settings.defaultRegion
  const base = { product: 'ecs', region, credentials, settings, signal: exec.signal }
  const batch = intInRange(args.max_instances, settings.maxBatch, 1, 100, 'max_instances')
  const cpuThreshold = Number.isFinite(Number(args.idle_cpu_percent))
    ? Math.min(100, Math.max(0, Number(args.idle_cpu_percent)))
    : settings.idleCpuPercent
  const scanSettings = { ...settings, idleCpuPercent: cpuThreshold }

  if (action === 'scan') {
    const report = await scanRegion({ base, settings: scanSettings })
    return { ok: true, action, region, scope, settings: { idleCpuPercent: cpuThreshold, idleWindowMinutes: settings.idleWindowMinutes, minInstanceAgeMinutes: settings.minInstanceAgeMinutes }, ...report }
  }

  const explicitIds = stringList(args.instance_ids, 'instance_ids')
  let chosen = []
  let skipped = []
  if (explicitIds.length > 0) {
    const found = await instancesById(base, explicitIds)
    const isProtected = protectionOf(settings)
    for (const instance of found) {
      if (instance.InstanceChargeType !== 'PostPaid' || instance.Status !== 'Running') {
        skipped.push({ id: instance.InstanceId, reason: `状态 ${instance.Status}/${instance.InstanceChargeType}，不是运行中的按量付费实例` })
        continue
      }
      if (isProtected({ id: instance.InstanceId, name: instance.InstanceName })) {
        skipped.push({ id: instance.InstanceId, reason: '命中保护名单（protectIds / protectPatterns）' })
        continue
      }
      chosen.push(instance.InstanceId)
    }
    const missing = explicitIds.filter((id) => !found.some((instance) => instance.InstanceId === id))
    for (const id of missing) skipped.push({ id, reason: '未找到该实例' })
  } else {
    const report = await scanRegion({ base, settings: scanSettings })
    chosen = report.instances
      .filter((instance) => (scope === 'all' ? !instance.protected : instance.idle))
      .map((instance) => instance.id)
    skipped = report.instances
      .filter((instance) => (scope === 'all' ? instance.protected : !instance.idle))
      .map((instance) => ({
        id: instance.id,
        reason: instance.protected ? '受保护' : instance.idle ? '未命中' : `不满足空闲条件（CPU ${instance.cpuAverage ?? '未知'}%）`,
      }))
  }

  const targets = chosen.slice(0, batch)
  const overLimit = chosen.length - targets.length
  if (targets.length === 0) {
    return toolFailure('NoTargets', '没有符合条件的实例；先运行 action=scan 查看原因。', { skipped })
  }

  if (action === 'stop') {
    if (args.dry_run === true) {
      return { ok: true, dryRun: true, action, region, scope, targets, skipped, overLimit }
    }
    const denied = await approveWrite(ctx, exec, settings, {
      en: `Economy-stop ${targets.length} pay-as-you-go ECS instance(s) in ${region}`,
      zh: `节省停机 ${targets.length} 台按量付费 ECS（${region}）以停止计费`,
    })
    if (denied) return denied
    const results = []
    for (const id of targets) results.push(await stopOne(base, id))
    return {
      ok: results.every((item) => item.ok),
      action,
      region,
      scope,
      stoppedMode: 'StopCharging',
      results,
      skipped,
      overLimit,
      message: '已提交停机。节省停机模式下计算资源不再计费；再次运行 action=scan 可复核。',
    }
  }

  if (action === 'release') {
    const dryRun = args.dry_run !== false
    if (dryRun) {
      return {
        ok: true,
        dryRun: true,
        action,
        region,
        targets,
        skipped,
        overLimit,
        message: '释放不可逆：确认后传 dry_run=false 且 confirm=true。',
      }
    }
    if (args.confirm !== true) {
      return toolFailure('ConfirmRequired', '释放实例不可逆，必须显式传 confirm=true 且 dry_run=false。')
    }
    const denied = await approveWrite(ctx, exec, settings, {
      en: `Permanently release ${targets.length} ECS instance(s) in ${region}`,
      zh: `永久释放 ${targets.length} 台 ECS（${region}）— 不可恢复`,
    })
    if (denied) return denied
    const results = []
    for (const id of targets) results.push(await releaseOne(base, id))
    return { ok: results.every((item) => item.ok), action, region, results, skipped, overLimit }
  }

  // auto_release
  const hours = intInRange(args.hours, settings.autoReleaseHours, 1, 720, 'hours')
  const autoReleaseTime = toIsoUtc(new Date(Date.now() + hours * 3600 * 1000))
  if (args.dry_run === true) {
    return { ok: true, dryRun: true, action, region, autoReleaseTime, targets, skipped, overLimit }
  }
  const denied = await approveWrite(ctx, exec, settings, {
    en: `Set auto-release for ${targets.length} ECS instance(s) in ${region} at ${autoReleaseTime}`,
    zh: `为 ${targets.length} 台 ECS（${region}）设置 ${hours} 小时后自动释放`,
  })
  if (denied) return denied
  const results = []
  for (const id of targets) results.push(await autoReleaseOne(base, id, autoReleaseTime))
  return { ok: results.every((item) => item.ok), action, region, autoReleaseTime, results, skipped, overLimit }
}

export function registerCostGuard(ctx) {
  ctx.tools.register({
    name: 'aliyun_cost_guard',
    description:
      '阿里云按量付费省钱与止损。scan（只读）扫描运行中的按量付费 ECS，用云监控 CPU 判断空闲并列出闲置 EIP/云盘；' +
      'stop 用节省停机模式（StopCharging）快速停止计费；auto_release 设置自动释放时间防止长期扣费；release 永久释放（默认只预演，需 confirm=true）。' +
      '写操作受插件写策略与 DSH 审批约束；保护名单与最小实例年龄默认开启。用户说"省钱/止损/别计费了"时先 scan 再 stop。',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ACTIONS,
          description: 'scan 只读体检；stop 节省停机；auto_release 设置自动释放；release 永久释放（不可逆）。',
        },
        scope: {
          type: 'string',
          enum: SCOPES,
          description: 'stop/release/auto_release 的目标范围：idle 仅空闲实例（默认），all 为紧急止损（全部运行中的按量付费实例）。',
        },
        region: { type: 'string', description: '地域 ID，默认取插件设置。' },
        instance_ids: {
          type: 'array',
          items: { type: 'string' },
          description: '显式指定实例；省略时由 scan 结果按 scope 选取。',
        },
        max_instances: {
          type: 'number',
          description: '单次最多处理几台（1-100，默认取插件设置 maxBatch=20）。',
        },
        idle_cpu_percent: {
          type: 'number',
          description: 'CPU 均值低于该百分比视为空闲（默认取插件设置，通常 5）。',
        },
        hours: {
          type: 'number',
          description: 'auto_release 的小时数（1-720，默认取插件设置 autoReleaseHours=8）。',
        },
        dry_run: {
          type: 'boolean',
          description: 'true 只返回计划；stop/auto_release 默认 false，release 默认 true。',
        },
        confirm: {
          type: 'boolean',
          description: 'release 必须显式传 true 才执行。',
        },
      },
      required: ['action'],
    },
    output: { schema: OUTPUT_SCHEMA, render: renderValue },
    timeoutMs: 300000,
    isConcurrencySafe: (args) => String(args?.action || 'scan') === 'scan',
    presentCall: (args) => ({
      card: 'generic',
      title: `阿里云省钱模式 · ${args?.action || 'scan'}`,
      kind: String(args?.action || 'scan') === 'scan' ? 'read' : 'execute',
      rawInput: args,
    }),
    execute: (args, exec) => guarded(() => run(ctx, args, exec)),
  })
}
