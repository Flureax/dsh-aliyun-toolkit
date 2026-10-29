/**
 * `aliyun_compute` — run heavy jobs (video rendering/transcoding, batch
 * processing, inference) on Aliyun compute instead of the local machine.
 *
 * The job runs as a cloud-init script (`UserData`) on a pay-as-you-go spot
 * instance that is released automatically. Inputs and outputs travel through
 * OSS presigned URLs, so no SSH key or inbound rule is required.
 *
 * Everything the user leaves blank can be resolved automatically: region,
 * vSwitch, security group, system image and instance type. Explicit settings
 * always win; `auto: false` turns the fallback off.
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
  requiredString,
  stringList,
  toIsoUtc,
  toolFailure,
} from './util.js'

const ACTIONS = ['recommend', 'launch', 'status', 'logs', 'terminate']
const SCRIPT_LIMIT = 10 * 1024
const JOB_NAME_PREFIX = 'toolkit-job-'
const AUTO_REGIONS = ['cn-hangzhou', 'cn-shanghai', 'cn-beijing', 'cn-shenzhen', 'cn-zhangjiakou', 'cn-chengdu']
const CPU_TYPE_PREFERENCE = ['ecs.u1-c1m2.large', 'ecs.g6.large', 'ecs.c6.large', 'ecs.u1-c1m1.large', 'ecs.t6-c1m2.large']
const GPU_HINT = /gpu|cuda|nvenc|nvidia|渲染|推理|转码|机器学习|深度学习|模型|训练/i

function compact(instance) {
  const publicIps = instance.PublicIpAddress?.IpAddress || []
  const privateIps = instance.VpcAttributes?.PrivateIpAddress?.IpAddress || []
  return {
    id: instance.InstanceId,
    name: instance.InstanceName,
    status: instance.Status,
    chargeType: instance.InstanceChargeType,
    spotStrategy: instance.SpotStrategy || null,
    instanceType: instance.InstanceType,
    region: instance.RegionId,
    zone: instance.ZoneId,
    publicIp: publicIps.join(','),
    privateIp: privateIps.join(','),
    created: instance.CreationTime,
    autoRelease: instance.AutoReleaseTime || null,
  }
}

function dedupe(values) {
  return [...new Set(values.filter(Boolean))]
}

/** Errors that mean "this spec has no stock here", so the next candidate may work. */
function stockError(error) {
  return /InvalidInstanceType|Zone\.NotAvailable|NoStock|ResourcesSoldOut|InvalidResourceType|OperationDenied\.NoStock/i.test(
    `${error?.code || ''} ${error?.message || ''}`,
  )
}

function inferAccelerator(args, settings) {
  const configured = String(args.accelerator || settings.computeAccelerator || 'auto')
  if (configured === 'gpu' || configured === 'cpu') return configured
  const haystack = `${settings.preferences || ''} ${args.script || ''} ${args.instance_name || ''}`
  return GPU_HINT.test(haystack) ? 'gpu' : 'cpu'
}

async function recommend(base, settings) {
  const zonesResponse = await callRpc({ ...base, action: 'DescribeZones', params: {} })
  const zones = (zonesResponse?.Zones?.Zone || [])
    .map((zone) => ({ zoneId: zone.ZoneId, localName: zone.LocalName }))
    .slice(0, 20)
  const gpu = []
  const seen = new Set()
  for (let page = 1; page <= 3; page += 1) {
    const response = await callRpc({
      ...base,
      action: 'DescribeInstanceTypes',
      params: { PageSize: 100, PageNumber: page },
    })
    const list = response?.InstanceTypes?.InstanceType || []
    if (list.length === 0) break
    for (const type of list) {
      if (!(Number(type.GPUAmount) > 0) || seen.has(type.InstanceType)) continue
      seen.add(type.InstanceType)
      gpu.push({
        instanceType: type.InstanceType,
        cpu: type.CpuCoreCount,
        memoryGiB: type.MemorySize,
        gpuAmount: type.GPUAmount,
        gpuSpec: type.GPUSpec,
        eniQuantity: type.EniQuantity,
        status: type.Status,
      })
    }
    if (list.length < 100) break
  }
  return {
    ok: true,
    action: 'recommend',
    region: base.region,
    zones,
    gpuInstances: gpu.slice(0, Math.max(10, settings.maxResults)),
    auto: settings.computeAuto,
    accelerator: settings.computeAccelerator,
    configured: {
      computeRegion: settings.computeRegion || null,
      computeInstanceType: settings.computeInstanceType || null,
      computeImageId: settings.computeImageId || null,
      computeSecurityGroupId: settings.computeSecurityGroupId || null,
      computeVSwitchId: settings.computeVSwitchId || null,
      computeMaxHours: settings.computeMaxHours,
      computeSpot: settings.computeSpot,
    },
    notes: [
      '留空的项会在 launch 时自动选择：地域按默认地域优先并可回退，交换机/安全组取自账号已有 VPC，镜像取最新 Ubuntu 22.04 系统镜像，规格按 CPU/GPU 候选依次尝试。',
      '用 aliyun_compute action=launch dry_run=true 可以看到自动解析出来的完整计划，再决定是否执行。',
    ],
  }
}

async function findVSwitch(base) {
  const response = await callRpc({
    ...base,
    action: 'DescribeVSwitches',
    params: { PageSize: 50, PageNumber: 1 },
  })
  const list = response?.VSwitches?.VSwitch || []
  const usable = list.filter((item) => !item.Status || item.Status === 'Available')
  return usable.find((item) => item.IsDefault === true) || usable[0]
}

async function findSecurityGroup(base, vpcId) {
  const params = { PageSize: 50, PageNumber: 1 }
  if (vpcId) params.VpcId = vpcId
  const response = await callRpc({ ...base, action: 'DescribeSecurityGroups', params })
  const list = response?.SecurityGroups?.SecurityGroup || []
  return list.find((item) => !vpcId || item.VpcId === vpcId) || list[0]
}

function newest(list) {
  return [...list].sort((left, right) =>
    String(right.CreationTime || '').localeCompare(String(left.CreationTime || '')),
  )
}

async function findImage(base) {
  const response = await callRpc({
    ...base,
    action: 'DescribeImages',
    params: {
      ImageOwnerAlias: 'system',
      Status: 'Available',
      Architecture: 'x86_64',
      OSType: 'linux',
      PageSize: 100,
      PageNumber: 1,
    },
  })
  const images = response?.Images?.Image || []
  const text = (item) => `${item.ImageId || ''} ${item.ImageName || ''} ${item.OSName || ''}`
  const ubuntu22 = images.filter((item) => /ubuntu/i.test(text(item)) && /22[._]04|22\.04/.test(text(item)))
  const ubuntu = images.filter((item) => /ubuntu/i.test(text(item)))
  const other = images.filter((item) => /alinux|centos|debian/i.test(text(item)))
  return newest(ubuntu22)[0] || newest(ubuntu)[0] || newest(other)[0] || newest(images)[0]
}

async function typeCandidates(base, accelerator) {
  if (accelerator !== 'gpu') return [...CPU_TYPE_PREFERENCE]
  const gpu = []
  for (let page = 1; page <= 2; page += 1) {
    const response = await callRpc({
      ...base,
      action: 'DescribeInstanceTypes',
      params: { PageSize: 100, PageNumber: page },
    })
    const list = response?.InstanceTypes?.InstanceType || []
    if (list.length === 0) break
    for (const item of list) {
      const amount = Number(item.GPUAmount)
      if (!(amount > 0)) continue
      if (item.Status === 'Unavailable') continue
      gpu.push({ type: item.InstanceType, gpu: amount, cpu: Number(item.CpuCoreCount) || 0 })
    }
    if (list.length < 100) break
  }
  gpu.sort((left, right) => left.gpu - right.gpu || left.cpu - right.cpu)
  const seen = new Set()
  const result = []
  for (const item of gpu) {
    if (seen.has(item.type)) continue
    seen.add(item.type)
    result.push(item.type)
  }
  return result.slice(0, 6)
}

/**
 * Resolve the concrete launch plan. Explicit arguments and settings win; every
 * empty field falls back to an automatic choice when `auto` is on.
 */
async function resolvePlan({ baseProto, settings, args }) {
  const auto = typeof args.auto === 'boolean' ? args.auto : settings.computeAuto
  const explicitRegion = optionalString(args.region, 'region') || settings.computeRegion
  const explicitVSwitch = optionalString(args.vswitch_id, 'vswitch_id') || settings.computeVSwitchId
  const explicitSecurityGroup =
    optionalString(args.security_group_id, 'security_group_id') || settings.computeSecurityGroupId
  const explicitImage = optionalString(args.image_id, 'image_id') || settings.computeImageId
  const explicitType = optionalString(args.instance_type, 'instance_type') || settings.computeInstanceType
  const accelerator = inferAccelerator(args, settings)

  const missing = []
  if (!explicitVSwitch) missing.push('交换机')
  if (!explicitSecurityGroup) missing.push('安全组')
  if (!explicitImage) missing.push('镜像')
  if (!explicitType) missing.push('实例规格')
  if (!auto && missing.length > 0) {
    return {
      error: `缺少计算默认值：${missing.join('、')}。请在 Settings →「阿里云」→「计算默认值」填写，或在本次调用中显式传参；也可以打开「自动选择」。`,
      missing,
    }
  }

  const regions = explicitRegion
    ? [explicitRegion]
    : auto
      ? dedupe([settings.defaultRegion, ...AUTO_REGIONS])
      : [settings.defaultRegion]
  const attempts = []

  for (const region of regions) {
    const regionBase = { ...baseProto, region }
    let vSwitchId = explicitVSwitch
    let zoneId = optionalString(args.zone_id, 'zone_id')
    let zoneVpcId
    if (!vSwitchId) {
      const found = await findVSwitch(regionBase).catch(() => undefined)
      if (!found) {
        attempts.push({ region, reason: '账号在该地域没有可用的交换机（VPC）' })
        continue
      }
      vSwitchId = found.VSwitchId
      zoneId = zoneId || found.ZoneId
      zoneVpcId = found.VpcId
    }
    let securityGroupId = explicitSecurityGroup
    if (!securityGroupId) {
      const found = await findSecurityGroup(regionBase, zoneVpcId).catch(() => undefined)
      if (!found) {
        attempts.push({ region, reason: '没有可用的安全组' })
        continue
      }
      securityGroupId = found.SecurityGroupId
    }
    let imageId = explicitImage
    if (!imageId) {
      const found = await findImage(regionBase).catch(() => undefined)
      if (!found) {
        attempts.push({ region, reason: '没有可用的系统镜像' })
        continue
      }
      imageId = found.ImageId
    }
    const types = explicitType
      ? [explicitType]
      : await typeCandidates(regionBase, accelerator).catch(() => [])
    if (types.length === 0) {
      attempts.push({ region, reason: '没有找到可用实例规格' })
      continue
    }
    return {
      auto,
      region,
      vSwitchId,
      zoneId,
      securityGroupId,
      imageId,
      types,
      accelerator,
      autoResolved: {
        region: !explicitRegion,
        vSwitchId: !explicitVSwitch,
        securityGroupId: !explicitSecurityGroup,
        imageId: !explicitImage,
        instanceType: !explicitType,
      },
      attempts,
    }
  }

  return {
    error:
      '自动选择失败：' +
      (attempts.length > 0
        ? attempts.map((item) => `${item.region}（${item.reason}）`).join('；')
        : '没有可用地域'),
    attempts,
  }
}

async function status(base, args, settings) {
  const ids = stringList(args.instance_ids, 'instance_ids')
  const params = ids.length
    ? { InstanceIds: JSON.stringify(ids), PageSize: Math.min(settings.maxResults, 100) }
    : {
        InstanceName: optionalString(args.name_prefix, 'name_prefix') || `${JOB_NAME_PREFIX}*`,
        PageSize: Math.min(settings.maxResults, 100),
      }
  const response = await callRpc({ ...base, action: 'DescribeInstances', params })
  const list = response?.Instances?.Instance || []
  return {
    ok: true,
    action: 'status',
    region: base.region,
    total: Number(response?.TotalCount ?? list.length),
    instances: list.map(compact),
  }
}

async function logs(base, args) {
  const ids = stringList(args.instance_ids, 'instance_ids')
  const instanceId = ids[0] || optionalString(args.instance_id, 'instance_id')
  if (!instanceId) throw inputError('logs 需要 instance_id 或 instance_ids[0]。')
  try {
    const response = await callRpc({
      ...base,
      action: 'GetInstanceConsoleOutput',
      params: { InstanceId: instanceId },
    })
    const encoded = response?.ConsoleOutput || ''
    const text = encoded ? Buffer.from(encoded, 'base64').toString('utf8') : ''
    const limit = 8000
    return {
      ok: true,
      action: 'logs',
      instanceId,
      lastUpdateTime: response?.LastUpdateTime,
      truncated: text.length > limit,
      consoleOutput: text.length > limit ? text.slice(-limit) : text,
      note: '控制台输出只包含系统串口日志；任务日志建议在脚本里同时上传到 OSS。',
    }
  } catch (error) {
    if (error?.name === 'AbortError') throw error
    return toolFailure(error?.code || 'Error', error?.message || String(error), {
      advice: error?.advice || '读取控制台输出失败；可在脚本里把日志上传到 OSS，再用 aliyun_oss 查看。',
      instanceId,
    })
  }
}

async function terminate(ctx, exec, base, args, settings) {
  const ids = stringList(args.instance_ids, 'instance_ids')
  if (ids.length === 0) throw inputError('terminate 需要 instance_ids。')
  const dryRun = args.dry_run !== false
  if (dryRun) {
    return {
      ok: true,
      action: 'terminate',
      dryRun: true,
      region: base.region,
      targets: ids,
      next: '确认后传 dry_run=false 且 confirm=true。',
    }
  }
  if (args.confirm !== true) {
    return toolFailure('ConfirmRequired', '释放计算实例不可逆，必须显式传 confirm=true 且 dry_run=false。')
  }
  const denied = await approveWrite(ctx, exec, settings, {
    en: `Release ${ids.length} compute instance(s) in ${base.region}`,
    zh: `释放 ${ids.length} 台计算实例（${base.region}）— 不可恢复`,
  })
  if (denied) return denied
  const results = []
  for (const id of ids) {
    try {
      const response = await callRpc({
        ...base,
        action: 'DeleteInstance',
        params: { InstanceId: id, Force: args.force === true },
      })
      results.push({ instanceId: id, ok: true, requestId: response?.RequestId })
    } catch (error) {
      if (error?.name === 'AbortError') throw error
      results.push({
        instanceId: id,
        ok: false,
        code: error?.code || 'Error',
        message: error?.message || String(error),
        advice: error?.advice,
      })
    }
  }
  return { ok: results.every((item) => item.ok), action: 'terminate', region: base.region, results }
}

async function launch(ctx, exec, baseProto, args, settings) {
  const rawScript = requiredString(args.script, 'script')
  const script = /^#!/.test(rawScript) ? rawScript : `#!/bin/bash\n${rawScript}`
  const scriptBytes = Buffer.byteLength(script, 'utf8')
  if (scriptBytes > SCRIPT_LIMIT) {
    throw inputError(`bootstrap 脚本过大（${scriptBytes} 字节，上限 ${SCRIPT_LIMIT}）。请把重活留在脚本下载后执行。`)
  }

  const plan = await resolvePlan({ baseProto, settings, args })
  if (plan.error) {
    return toolFailure('ComputeNotConfigured', plan.error, { attempts: plan.attempts || [] })
  }

  const hours = intInRange(args.hours, settings.computeMaxHours, 1, 72, 'hours')
  const spot = typeof args.spot === 'boolean' ? args.spot : settings.computeSpot
  const autoReleaseTime = toIsoUtc(new Date(Date.now() + hours * 3600 * 1000))
  const instanceName = optionalString(args.instance_name, 'instance_name') || `${JOB_NAME_PREFIX}${Date.now()}`
  const baseParams = {
    ImageId: plan.imageId,
    SecurityGroupId: plan.securityGroupId,
    VSwitchId: plan.vSwitchId,
    Amount: 1,
    InstanceChargeType: 'PostPaid',
    AutoReleaseTime: autoReleaseTime,
    InternetMaxBandwidthOut: intInRange(args.internet_bandwidth, 100, 0, 200, 'internet_bandwidth'),
    InstanceName: instanceName,
    UserData: Buffer.from(script, 'utf8').toString('base64'),
    'SystemDisk.Category': optionalString(args.system_disk_category, 'system_disk_category') || 'cloud_essd',
    'SystemDisk.Size': intInRange(args.system_disk_size_gb, 40, 20, 500, 'system_disk_size_gb'),
  }
  if (plan.zoneId) baseParams.ZoneId = plan.zoneId
  if (spot) {
    baseParams.SpotStrategy = 'SpotAsPriceGo'
    baseParams.SpotDuration = intInRange(args.spot_duration_hours, 1, 1, 6, 'spot_duration_hours')
  }
  const planSummary = {
    region: plan.region,
    zoneId: plan.zoneId || null,
    vSwitchId: plan.vSwitchId,
    securityGroupId: plan.securityGroupId,
    imageId: plan.imageId,
    instanceType: plan.types[0],
    typeCandidates: plan.types,
    accelerator: plan.accelerator,
    spot,
    hours,
    autoReleaseTime,
    autoResolved: plan.autoResolved,
    attempts: plan.attempts,
  }

  if (args.dry_run === true) {
    return {
      ok: true,
      action: 'launch',
      dryRun: true,
      plan: { ...planSummary, instanceName, scriptBytes },
      next: '确认后传 dry_run=false。',
    }
  }

  const denied = await approveWrite(ctx, exec, settings, {
    en: `Launch 1 ${spot ? 'spot' : 'pay-as-you-go'} ECS (${plan.types[0]}${plan.types.length > 1 ? ' or fallback specs' : ''}) in ${plan.region} for a compute job, auto-release in ${hours}h`,
    zh: `在 ${plan.region} 创建 1 台${spot ? '抢占式' : '按量付费'} ECS（首选 ${plan.types[0]}${plan.types.length > 1 ? '，无库存时自动换同类规格' : ''}）跑计算任务，${hours} 小时后自动释放`,
  })
  if (denied) return denied

  const tried = []
  let created
  let response
  for (const type of plan.types) {
    try {
      response = await callRpc({
        ...baseProto,
        region: plan.region,
        action: 'RunInstances',
        params: { ...baseParams, InstanceType: type },
      })
      created = type
      break
    } catch (error) {
      if (error?.name === 'AbortError') throw error
      tried.push({ instanceType: type, code: error?.code, message: error?.message })
      if (!stockError(error)) throw error
    }
  }
  if (!created) {
    return toolFailure('NoStock', '候选实例规格在所有尝试中都没有库存，请换地域或手动指定 instance_type。', {
      tried,
      plan: planSummary,
    })
  }

  const instanceIds = response?.InstanceIdSets?.InstanceIdSet || []
  return {
    ok: true,
    action: 'launch',
    region: plan.region,
    instanceIds,
    instanceName,
    instanceType: created,
    spot,
    autoReleaseTime,
    scriptBytes,
    autoResolved: plan.autoResolved,
    tried: tried.length > 0 ? tried : undefined,
    requestId: response?.RequestId,
    next: [
      '实例约 1-2 分钟后进入 Running，cloud-init 随后执行脚本。',
      `用 aliyun_compute action=status instance_ids=${JSON.stringify(instanceIds)} 跟进状态。`,
      '任务结果按脚本约定写回 OSS，用 aliyun_oss action=list_objects 查看；如脚本失败，用 action=logs 读取控制台串口日志。',
    ],
  }
}

async function run(ctx, args, exec) {
  const action = String(args?.action || 'recommend')
  if (!ACTIONS.includes(action)) throw inputError(`不支持的 action：${action}`)
  const { settings, credentials } = await prepare(ctx)
  requireCredentials(credentials)
  const region =
    optionalString(args.region, 'region') || settings.computeRegion || settings.defaultRegion
  const baseProto = { product: 'ecs', credentials, settings, signal: exec.signal }
  const base = { ...baseProto, region }

  if (action === 'recommend') return recommend(base, settings)
  if (action === 'status') return status(base, args, settings)
  if (action === 'logs') return logs(base, args)
  if (action === 'terminate') return terminate(ctx, exec, base, args, settings)
  return launch(ctx, exec, baseProto, args, settings)
}

export function registerCompute(ctx) {
  ctx.tools.register({
    name: 'aliyun_compute',
    description:
      '把重计算任务（视频渲染/转码、批量素材处理、模型推理、大规模编译、压测）放到阿里云上跑。' +
      'recommend 列出 GPU 规格与可用区；launch 用云初始化脚本（UserData）在抢占式按量实例上执行并设置自动释放；status/logs 跟进；terminate 释放。' +
      '地域/镜像/规格/交换机/安全组留空时自动选择（可在设置里关闭），显式传参优先。' +
      '脚本以 root 运行，可用 OSS 预签名 GET 拉输入、预签名 PUT 传结果并用 poweroff 结束；无需 SSH。创建实例会经过 DSH 审批。',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ACTIONS,
          description: 'recommend 选规格；launch 提交任务；status 查实例；logs 读控制台输出；terminate 释放实例。',
        },
        region: {
          type: 'string',
          description: '地域，默认取「计算默认值」或插件默认地域；留空且自动选择开启时会在地域间回退。',
        },
        script: {
          type: 'string',
          description:
            'launch 必填：cloud-init 会以 root 执行的 bash 脚本（≤10KB）。例如安装 ffmpeg、curl 预签名 URL、ffmpeg 渲染、curl -T 上传结果、poweroff。',
        },
        accelerator: {
          type: 'string',
          enum: ['auto', 'gpu', 'cpu'],
          description: '自动选规格时的偏好；auto 会按偏好文字/脚本内容判断（含 GPU/渲染/推理等关键词则选 GPU）。',
        },
        auto: {
          type: 'boolean',
          description: '是否自动补齐留空的镜像/规格/交换机/安全组/地域；默认取设置 computeAuto。',
        },
        instance_type: { type: 'string', description: '实例规格；留空则自动选择（GPU 或 CPU 候选）。' },
        image_id: { type: 'string', description: '镜像 ID；留空则选最新 Ubuntu 22.04 系统镜像。' },
        security_group_id: { type: 'string', description: '安全组 ID；留空则取账号在该地域的第一个安全组。' },
        vswitch_id: { type: 'string', description: '交换机 ID；留空则取账号在该地域的第一个交换机。' },
        zone_id: { type: 'string', description: '可用区；留空则由交换机决定。' },
        hours: { type: 'number', description: '自动释放小时数（1-72，默认取设置 computeMaxHours=4）。' },
        spot: { type: 'boolean', description: '是否用抢占式实例（默认取设置 computeSpot=true）。' },
        instance_name: { type: 'string', description: '实例名，默认 toolkit-job-<时间戳>。' },
        internet_bandwidth: { type: 'number', description: '公网带宽上限 Mbps（0-200，默认 100；按流量计费）。' },
        spot_duration_hours: { type: 'number', description: '抢占式保护期小时数（1-6，默认 1）。' },
        system_disk_category: { type: 'string', description: '系统盘类型，默认 cloud_essd。' },
        system_disk_size_gb: { type: 'number', description: '系统盘 GB（20-500，默认 40）。' },
        instance_ids: {
          type: 'array',
          items: { type: 'string' },
          description: 'status/logs/terminate 的目标实例。',
        },
        instance_id: { type: 'string', description: 'logs 的单个实例（与 instance_ids 二选一）。' },
        name_prefix: {
          type: 'string',
          description: 'status 未给实例时按实例名前缀查找，默认 toolkit-job-*。',
        },
        dry_run: { type: 'boolean', description: 'launch/terminate 传 true 只返回计划（含自动解析结果）。' },
        confirm: { type: 'boolean', description: 'terminate 必须显式传 true。' },
        force: { type: 'boolean', description: 'terminate 时强制释放。' },
      },
      required: ['action'],
    },
    output: { schema: OUTPUT_SCHEMA, render: renderValue },
    timeoutMs: 300000,
    isConcurrencySafe: (args) => ['recommend', 'status', 'logs'].includes(String(args?.action || 'recommend')),
    presentCall: (args) => ({
      card: 'generic',
      title: `阿里云计算任务 · ${args?.action || 'recommend'}`,
      kind: ['recommend', 'status', 'logs'].includes(String(args?.action || 'recommend')) ? 'read' : 'execute',
      rawInput: args,
    }),
    execute: (args, exec) => guarded(() => run(ctx, args, exec)),
  })
}
