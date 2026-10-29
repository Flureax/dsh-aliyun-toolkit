/**
 * `aliyun_monitor`, `aliyun_billing`, `aliyun_api` and `aliyun_doctor`.
 */
import { PRODUCTS, callRpc } from './rpc.js'
import { settingsFile } from './settings.js'
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

const READ_ACTION_RE = /^(Describe|List|Get|Query|Search|Check|Head|Count)/i

function utcStamp(date) {
  const iso = date.toISOString()
  return iso.slice(0, 10) + ' ' + iso.slice(11, 19)
}

function parseDatapoints(response) {
  const raw = response?.Datapoints
  if (typeof raw === 'string') {
    try {
      return JSON.parse(raw)
    } catch {
      return []
    }
  }
  return Array.isArray(raw) ? raw : []
}

function registerMonitor(ctx) {
  ctx.tools.register({
    name: 'aliyun_monitor',
    description:
      '阿里云云监控 CMS：查询 ECS 等资源的时序指标（默认 CPU）与告警。用于判断实例是否空闲，也是 aliyun_cost_guard 之外的细粒度查询入口。',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['metric', 'last', 'alarms'],
          description: 'metric 查询一段时间的数据点；last 取最新值；alarms 查询告警规则。',
        },
        region: { type: 'string', description: '地域 ID，默认取插件设置。' },
        namespace: { type: 'string', description: '云监控命名空间，默认 acs_ecs_dashboard。' },
        metric_name: { type: 'string', description: '指标名，默认 cpu_total。' },
        dimensions: {
          type: 'array',
          items: { type: 'object', additionalProperties: true },
          description: '维度数组，例如 [{"instanceId":"i-xxx"}]；metric/last 需要。',
        },
        start_time: { type: 'string', description: '开始时间，格式 YYYY-MM-DD HH:mm:ss（UTC）；默认 1 小时前。' },
        end_time: { type: 'string', description: '结束时间，格式 YYYY-MM-DD HH:mm:ss（UTC）；默认现在。' },
        period: { type: 'number', description: '聚合周期秒（60-86400，默认 300）。' },
      },
      required: ['action'],
    },
    output: { schema: OUTPUT_SCHEMA, render: renderValue },
    timeoutMs: 60000,
    isConcurrencySafe: () => true,
    presentCall: (args) => ({
      card: 'generic',
      title: `阿里云云监控 · ${args?.action || 'metric'}`,
      kind: 'read',
      rawInput: args,
    }),
    execute: (args, exec) =>
      guarded(async () => {
        const action = String(args?.action || 'metric')
        const { settings, credentials } = await prepare(ctx)
        requireCredentials(credentials)
        const region = optionalString(args.region, 'region') || settings.defaultRegion
        const base = { product: 'cms', region, credentials, settings, signal: exec.signal }
        const namespace = optionalString(args.namespace, 'namespace') || 'acs_ecs_dashboard'
        const period = intInRange(args.period, 300, 60, 86400, 'period')

        if (action === 'alarms') {
          const response = await callRpc({
            ...base,
            action: 'DescribeAlarms',
            params: { PageSize: Math.min(settings.maxResults, 100), PageNumber: 1 },
          })
          const list = response?.AlarmList?.Alarm || response?.Datapoints || []
          return { ok: true, action, region, total: Number(response?.Total ?? list.length), alarms: list }
        }

        if (action !== 'metric' && action !== 'last') throw inputError('action 只能是 metric / last / alarms。')
        if (!Array.isArray(args?.dimensions) || args.dimensions.length === 0) {
          throw inputError('dimensions 必填，例如 [{"instanceId":"i-xxx"}]。')
        }
        const dimensions = JSON.stringify(args.dimensions)
        if (action === 'last') {
          const response = await callRpc({
            ...base,
            action: 'DescribeMetricLast',
            params: {
              Namespace: namespace,
              MetricName: optionalString(args.metric_name, 'metric_name') || 'cpu_total',
              Dimensions: dimensions,
              Period: period,
            },
          })
          return {
            ok: true,
            action,
            region,
            namespace,
            metricName: optionalString(args.metric_name, 'metric_name') || 'cpu_total',
            datapoints: parseDatapoints(response).slice(0, 200),
            requestId: response?.RequestId,
          }
        }
        const end = new Date()
        const start = new Date(end.getTime() - 60 * 60 * 1000)
        const response = await callRpc({
          ...base,
          action: 'DescribeMetricList',
          params: {
            Namespace: namespace,
            MetricName: optionalString(args.metric_name, 'metric_name') || 'cpu_total',
            Dimensions: dimensions,
            StartTime: optionalString(args.start_time, 'start_time') || utcStamp(start),
            EndTime: optionalString(args.end_time, 'end_time') || utcStamp(end),
            Period: period,
          },
        })
        const points = parseDatapoints(response)
        return {
          ok: true,
          action,
          region,
          namespace,
          metricName: optionalString(args.metric_name, 'metric_name') || 'cpu_total',
          period,
          total: points.length,
          datapoints: points.slice(0, 200),
          truncated: points.length > 200,
          requestId: response?.RequestId,
        }
      }),
  })
}

function registerBilling(ctx) {
  ctx.tools.register({
    name: 'aliyun_billing',
    description:
      '阿里云费用中心：查询账户余额与账期账单（按产品汇总）。余额只读，不涉及任何写操作。' +
      '配合 aliyun_cost_guard 使用：先看余额与账单趋势，再决定是否停机止损。',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['balance', 'bill'],
          description: 'balance 查询账户余额；bill 查询某账期账单。',
        },
        billing_cycle: {
          type: 'string',
          description: 'bill 的账期，格式 YYYY-MM，默认当前月（UTC）。',
        },
      },
      required: ['action'],
    },
    output: { schema: OUTPUT_SCHEMA, render: renderValue },
    timeoutMs: 60000,
    isConcurrencySafe: () => true,
    presentCall: (args) => ({
      card: 'generic',
      title: `阿里云费用 · ${args?.action || 'balance'}`,
      kind: 'read',
      rawInput: args,
    }),
    execute: (args, exec) =>
      guarded(async () => {
        const action = String(args?.action || 'balance')
        if (!['balance', 'bill'].includes(action)) throw inputError('action 只能是 balance / bill。')
        const { settings, credentials } = await prepare(ctx)
        requireCredentials(credentials)
        const base = { product: 'bss', credentials, settings, signal: exec.signal }
        if (action === 'balance') {
          const response = await callRpc({ ...base, action: 'QueryAccountBalance' })
          return { ok: true, action, data: response?.Data || response }
        }
        const cycle = optionalString(args.billing_cycle, 'billing_cycle') || new Date().toISOString().slice(0, 7)
        if (!/^\d{4}-\d{2}$/.test(cycle)) throw inputError('billing_cycle 必须是 YYYY-MM。')
        const response = await callRpc({
          ...base,
          action: 'QueryAccountBill',
          params: {
            BillingCycle: cycle,
            PageNum: 1,
            PageSize: Math.min(settings.maxResults, 100),
            IsGroupByProduct: true,
          },
        })
        return {
          ok: true,
          action,
          billingCycle: cycle,
          total: response?.Data?.TotalCount,
          items: response?.Data?.Items?.Item || [],
          requestId: response?.RequestId,
        }
      }),
  })
}

function registerGeneric(ctx) {
  ctx.tools.register({
    name: 'aliyun_api',
    description:
      '阿里云 OpenAPI 通用透传：已知产品（ecs/vpc/rds/slb/ram/dns/cdn/cs/cms/bss）可直接用产品名调用任意 Action；' +
      'Describe/List/Get/Query/Search/Check/Head/Count 开头的 Action 视为只读，其余写操作走 DSH 审批。' +
      '仅在专用工具不覆盖时使用；参数名与阿里云官方 API 完全一致。',
    parameters: {
      type: 'object',
      properties: {
        product: { type: 'string', description: '产品代号，例如 ecs、vpc、rds、cms、bss。' },
        action: { type: 'string', description: 'OpenAPI Action，例如 DescribeInstances、ReleaseEipAddress。' },
        version: { type: 'string', description: 'API 版本；已知产品可省略，例如 ECS 为 2014-05-26。' },
        region: { type: 'string', description: '地域 ID，默认取插件设置。' },
        endpoint: { type: 'string', description: '自定义 endpoint 域名（专有云 / VPC 私有接入点）。' },
        params: {
          type: 'object',
          additionalProperties: true,
          description: 'Action 参数对象，键名与阿里云文档一致；数组会展开为 Key.1/Key.2。',
        },
      },
      required: ['product', 'action'],
    },
    output: { schema: OUTPUT_SCHEMA, render: renderValue },
    timeoutMs: 120000,
    isConcurrencySafe: (args) => READ_ACTION_RE.test(String(args?.action || '')),
    presentCall: (args) => ({
      card: 'generic',
      title: `阿里云 OpenAPI · ${args?.action || ''}`,
      kind: READ_ACTION_RE.test(String(args?.action || '')) ? 'read' : 'execute',
      rawInput: args,
    }),
    execute: (args, exec) =>
      guarded(async () => {
        const { settings, credentials } = await prepare(ctx)
        if (!settings.allowGenericApi) {
          return toolFailure('GenericApiDisabled', '通用 OpenAPI 透传已被插件设置关闭（allowGenericApi=false）。')
        }
        requireCredentials(credentials)
        const product = requiredString(args?.product, 'product')
        const action = requiredString(args?.action, 'action')
        const region = optionalString(args.region, 'region') || settings.defaultRegion
        const version = optionalString(args.version, 'version') || PRODUCTS[product]?.version
        const params =
          args?.params && typeof args.params === 'object' && !Array.isArray(args.params) ? args.params : {}
        const write = !READ_ACTION_RE.test(action)
        if (write) {
          const denied = await approveWrite(ctx, exec, settings, {
            en: `Call Aliyun ${product}:${action} in ${region}`,
            zh: `调用阿里云写接口 ${product}:${action}（${region}）`,
          })
          if (denied) return denied
        }
        const response = await callRpc({
          product,
          action,
          version,
          region,
          endpoint: optionalString(args.endpoint, 'endpoint'),
          params,
          credentials,
          settings,
          signal: exec.signal,
        })
        return { ok: true, product, action, region, requestId: response?.RequestId, data: response }
      }),
  })
}

function registerDoctor(ctx) {
  ctx.tools.register({
    name: 'aliyun_doctor',
    description:
      '阿里云连通性与凭据自检：报告凭据来源、默认地域、endpoint 与一次只读 DescribeRegions 往返耗时；' +
      '失败时给出签名/权限/网络的处置建议。配置好 AccessKey 后先用它确认链路。',
    parameters: {
      type: 'object',
      properties: {
        region: { type: 'string', description: '用于测试的地域，默认取插件设置。' },
      },
    },
    output: { schema: OUTPUT_SCHEMA, render: renderValue },
    timeoutMs: 60000,
    isConcurrencySafe: () => true,
    presentCall: () => ({ card: 'generic', title: '阿里云连通性自检', kind: 'fetch' }),
    execute: (_args, exec) =>
      guarded(async () => {
        const { settings, settingsError, credentials } = await prepare(ctx)
        const region = settings.defaultRegion
        const store = (() => {
          try {
            return ctx?.get?.('credentials')
          } catch {
            return undefined
          }
        })()
        const report = {
          ok: false,
          credentialStoreAvailable: Boolean(store),
          credentials: {
            configured: credentials.complete,
            accessKeyId: credentials.accessKeyId ? credentials.accessKeyId.slice(0, 4) + '****' + credentials.accessKeyId.slice(-4) : '',
            sources: credentials.source,
            securityToken: Boolean(credentials.securityToken),
          },
          region,
          endpoints: {
            ecs: `https://ecs.${region}.aliyuncs.com`,
            cms: 'https://metrics.cn-hangzhou.aliyuncs.com',
            bss: 'https://business.aliyuncs.com',
            oss: `https://oss-${region}.aliyuncs.com`,
          },
          settingsFile: settingsFile(),
          settingsError,
        }
        if (!credentials.complete) {
          return {
            ...report,
            code: 'NoCredentials',
            message: '尚未配置 AccessKey：请在 Settings →「阿里云」保存，或设置 ALIYUN_ACCESS_KEY_ID / ALIYUN_ACCESS_KEY_SECRET。',
          }
        }
        const startedAt = Date.now()
        try {
          const response = await callRpc({
            product: 'ecs',
            region,
            action: 'DescribeRegions',
            params: {},
            credentials,
            settings,
            signal: exec.signal,
          })
          return {
            ...report,
            ok: true,
            latencyMs: Date.now() - startedAt,
            regionCount: response?.Regions?.Region?.length ?? 0,
            requestId: response?.RequestId,
          }
        } catch (error) {
          if (error?.name === 'AbortError') throw error
          return {
            ...report,
            ok: false,
            latencyMs: Date.now() - startedAt,
            code: error?.code || 'Error',
            message: error?.message || String(error),
            advice: error?.advice,
          }
        }
      }),
  })
}

export function registerMiscTools(ctx) {
  registerMonitor(ctx)
  registerBilling(ctx)
  registerGeneric(ctx)
  registerDoctor(ctx)
}
