/**
 * Client half: the "阿里云" settings section.
 *
 * Plain-JS module (no JSX, no imports besides React). It talks to the Host
 * through the same-origin JSON route registered by index.js, so no generated
 * Remote namespace is required.
 */
window.__ModuleLoader__.load({
  id: '@local/dsh-aliyun-toolkit',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const useState = React.useState
    const useEffect = React.useEffect
    const useCallback = React.useCallback
    const useRef = React.useRef

    const API_BASE = '/aliyun-toolkit/'
    const REGIONS = [
      'cn-hangzhou',
      'cn-shanghai',
      'cn-beijing',
      'cn-shenzhen',
      'cn-guangzhou',
      'cn-qingdao',
      'cn-zhangjiakou',
      'cn-chengdu',
      'cn-huhehaote',
      'cn-wulanchabu',
      'cn-hongkong',
      'ap-southeast-1',
      'ap-northeast-1',
      'us-east-1',
      'eu-central-1',
    ]

    const CSS = `
.ay-root{display:flex;flex-direction:column;gap:14px;font-size:13px;line-height:1.6;color:var(--dsw-alias-label-primary)}
.ay-intro{color:var(--dsw-alias-label-secondary);margin:0}
.ay-card{border:1px solid var(--dsw-alias-border-l1);border-radius:12px;padding:16px;background:var(--dsw-alias-bg-layer-1)}
.ay-card h3{margin:0 0 4px;font-size:14px;font-weight:600}
.ay-card p{margin:0 0 12px;color:var(--dsw-alias-label-secondary)}
.ay-row{display:flex;flex-wrap:wrap;gap:10px;align-items:flex-end}
.ay-field{display:flex;flex-direction:column;gap:4px;min-width:180px;flex:1 1 200px}
.ay-field span{font-size:12px;color:var(--dsw-alias-label-secondary)}
.ay-input{width:100%;box-sizing:border-box;padding:7px 10px;border-radius:8px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font:inherit}
.ay-input:focus{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}
.ay-textarea{min-height:120px;resize:vertical;font:inherit;line-height:1.6}
.ay-btn{border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);border-radius:8px;padding:7px 14px;font:inherit;cursor:pointer}
.ay-btn:disabled{opacity:.5;cursor:default}
.ay-btn.primary{background:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary);color:#fff}
.ay-btn.danger{color:var(--dsw-alias-state-error-primary)}
.ay-status{display:flex;flex-wrap:wrap;gap:8px 18px;margin-bottom:12px}
.ay-mono{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
.ay-ok{color:var(--dsw-alias-state-success-primary)}
.ay-bad{color:var(--dsw-alias-state-error-primary)}
.ay-warn{color:var(--dsw-alias-state-warn-primary)}
.ay-muted{color:var(--dsw-alias-label-secondary)}
.ay-banner{border-radius:8px;padding:8px 12px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-2)}
.ay-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:10px}
.ay-check{display:flex;align-items:center;gap:8px;margin-top:6px}
.ay-foot{color:var(--dsw-alias-label-secondary);font-size:12px;word-break:break-all}
`

    async function request(path, body) {
      const init = body
        ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }
        : { method: 'GET' }
      let response
      try {
        response = await fetch(API_BASE + path, init)
      } catch (error) {
        throw new Error(`无法访问本机接口：${error && error.message ? error.message : error}`)
      }
      let data
      try {
        data = await response.json()
      } catch {
        throw new Error(`接口返回了非 JSON 响应（HTTP ${response.status}）`)
      }
      if (!response.ok) throw new Error(data.message || `HTTP ${response.status}`)
      return data
    }

    function ensure(result) {
      if (result && result.ok === false) throw new Error(result.message || '操作失败')
      return result
    }

    function Card(props) {
      return h(
        'section',
        { className: 'ay-card' },
        h('h3', null, props.title),
        props.description ? h('p', null, props.description) : null,
        props.children,
      )
    }

    function TextField(props) {
      return h(
        'label',
        { className: 'ay-field' },
        h('span', null, props.label),
        h('input', {
          className: 'ay-input' + (props.mono ? ' ay-mono' : ''),
          type: props.type || 'text',
          value: props.value,
          placeholder: props.placeholder,
          autoComplete: props.autoComplete || 'off',
          list: props.list,
          onChange: (event) => props.onChange(event.target.value),
          disabled: props.disabled,
        }),
      )
    }

    function CredentialCard(props) {
      const { status, busy, onSave, onClear } = props
      const [form, setForm] = useState({ accessKeyId: '', accessKeySecret: '', securityToken: '' })
      const credentials = status && status.credentials ? status.credentials : null
      const update = (key) => (value) => setForm((current) => ({ ...current, [key]: value }))
      const idInfo = credentials && credentials.accessKeyId ? credentials.accessKeyId : {}
      const secretInfo = credentials && credentials.accessKeySecret ? credentials.accessKeySecret : {}
      return h(
        Card,
        {
          title: '凭据',
          description: 'AccessKey 存入 DSH 凭据库（优先）或 ALIYUN_* 环境变量；本页不会回显 Secret。',
        },
        h(
          'div',
          { className: 'ay-status' },
          h(
            'div',
            null,
            'AccessKey ID：',
            idInfo.configured
              ? h('span', { className: 'ay-ok ay-mono' }, idInfo.masked || '已配置')
              : h('span', { className: 'ay-bad' }, '未配置'),
            idInfo.source ? h('span', { className: 'ay-muted' }, `（${idInfo.source}）`) : null,
          ),
          h(
            'div',
            null,
            'AccessKey Secret：',
            secretInfo.configured ? h('span', { className: 'ay-ok' }, '已配置') : h('span', { className: 'ay-bad' }, '未配置'),
          ),
          h(
            'div',
            null,
            'STS Token：',
            credentials && credentials.securityToken && credentials.securityToken.configured
              ? h('span', { className: 'ay-ok' }, '已配置')
              : h('span', { className: 'ay-muted' }, '未配置'),
          ),
        ),
        h(
          'div',
          { className: 'ay-row' },
          h(TextField, {
            label: 'AccessKey ID',
            mono: true,
            value: form.accessKeyId,
            placeholder: idInfo.configured ? '输入新的 ID 以替换' : 'LTAI...',
            onChange: update('accessKeyId'),
            disabled: busy === 'save' || busy === 'clear',
          }),
          h(TextField, {
            label: 'AccessKey Secret',
            type: 'password',
            mono: true,
            value: form.accessKeySecret,
            placeholder: '仅写入，不会显示',
            onChange: update('accessKeySecret'),
            disabled: busy === 'save' || busy === 'clear',
          }),
          h(TextField, {
            label: 'STS Token（可选）',
            type: 'password',
            mono: true,
            value: form.securityToken,
            placeholder: '使用临时凭证时填写',
            onChange: update('securityToken'),
            disabled: busy === 'save' || busy === 'clear',
          }),
        ),
        h(
          'div',
          { className: 'ay-row', style: { marginTop: 12 } },
          h(
            'button',
            {
              className: 'ay-btn primary',
              type: 'button',
              disabled: busy === 'save' || !form.accessKeyId || !form.accessKeySecret,
              onClick: () => onSave(form, () => setForm({ accessKeyId: '', accessKeySecret: '', securityToken: '' })),
            },
            busy === 'save' ? '保存中…' : '保存凭据',
          ),
          h(
            'button',
            {
              className: 'ay-btn danger',
              type: 'button',
              disabled: busy === 'clear',
              onClick: onClear,
            },
            busy === 'clear' ? '清除中…' : '清除凭据',
          ),
        ),
      )
    }

    function ConnectionCard(props) {
      const { status, busy, result, onTest } = props
      const region = status && status.settings ? status.settings.defaultRegion : 'cn-hangzhou'
      return h(
        Card,
        { title: '连接', description: '用一次只读的 DescribeRegions 验证凭据、签名与出网。' },
        h(
          'div',
          { className: 'ay-status' },
          h('div', null, '默认地域：', h('span', { className: 'ay-mono' }, region)),
          h('div', null, 'Endpoint：', h('span', { className: 'ay-mono' }, `ecs.${region}.aliyuncs.com`)),
        ),
        h(
          'div',
          { className: 'ay-row' },
          h(
            'button',
            { className: 'ay-btn', type: 'button', disabled: busy === 'test', onClick: onTest },
            busy === 'test' ? '测试中…' : '测试连接',
          ),
        ),
        result
          ? h(
              'div',
              { className: 'ay-banner', style: { marginTop: 12 } },
              result.ok
                ? h(
                    'span',
                    { className: 'ay-ok' },
                    `连接成功：${result.region} · 延迟 ${result.latencyMs}ms · 可选地域 ${result.regionCount} 个`,
                  )
                : h(
                    'span',
                    { className: 'ay-bad' },
                    `连接失败：${result.code || 'Error'} — ${result.message || ''}`,
                    result.advice ? h('div', { className: 'ay-muted' }, result.advice) : null,
                  ),
            )
          : null,
      )
    }

    function SettingsCard(props) {
      const { status, busy, onSave } = props
      const [form, setForm] = useState(null)
      useEffect(() => {
        if (status && status.settings && form === null) setForm({ ...status.settings })
      }, [status, form])
      if (!form) return null
      const update = (key) => (value) => setForm((current) => ({ ...current, [key]: value }))
      const number = (key) => (value) => {
        const parsed = Number(value)
        setForm((current) => ({ ...current, [key]: Number.isFinite(parsed) ? parsed : current[key] }))
      }
      return h(
        Card,
        {
          title: '插件设置',
          description: '默认地域、写策略与省钱阈值；保存后立即对下一次工具调用生效。',
        },
        h(
          'div',
          { className: 'ay-grid' },
          h(TextField, {
            label: '默认地域',
            mono: true,
            list: 'ay-regions',
            value: form.defaultRegion,
            onChange: update('defaultRegion'),
          }),
          h(
            'label',
            { className: 'ay-field' },
            h('span', null, '写操作策略'),
            h(
              'select',
              {
                className: 'ay-input',
                value: form.writeMode,
                onChange: (event) => update('writeMode')(event.target.value),
              },
              h('option', { value: 'ask' }, 'ask：写操作经 DSH 审批'),
              h('option', { value: 'deny' }, 'deny：全部只读'),
              h('option', { value: 'allow' }, 'allow：写操作不询问（谨慎）'),
            ),
          ),
          h(TextField, {
            label: '请求超时（毫秒）',
            type: 'number',
            value: String(form.requestTimeoutMs),
            onChange: number('requestTimeoutMs'),
          }),
          h(TextField, {
            label: '单次返回条数',
            type: 'number',
            value: String(form.maxResults),
            onChange: number('maxResults'),
          }),
          h(TextField, {
            label: '单批最多处理实例数',
            type: 'number',
            value: String(form.maxBatch),
            onChange: number('maxBatch'),
          }),
          h(TextField, {
            label: '空闲 CPU 阈值（%）',
            type: 'number',
            value: String(form.idleCpuPercent),
            onChange: number('idleCpuPercent'),
          }),
          h(TextField, {
            label: '空闲判定窗口（分钟）',
            type: 'number',
            value: String(form.idleWindowMinutes),
            onChange: number('idleWindowMinutes'),
          }),
          h(TextField, {
            label: '最小实例年龄（分钟）',
            type: 'number',
            value: String(form.minInstanceAgeMinutes),
            onChange: number('minInstanceAgeMinutes'),
          }),
          h(TextField, {
            label: '默认自动释放（小时）',
            type: 'number',
            value: String(form.autoReleaseHours),
            onChange: number('autoReleaseHours'),
          }),
        ),
        h('datalist', { id: 'ay-regions' }, REGIONS.map((region) => h('option', { key: region, value: region }))),
        h(
          'div',
          { className: 'ay-grid', style: { marginTop: 10 } },
          h(TextField, {
            label: '保护实例 ID（逗号或换行分隔）',
            value: (form.protectIds || []).join(', '),
            onChange: (value) =>
              update('protectIds')(
                value
                  .split(/[,\n]/)
                  .map((item) => item.trim())
                  .filter(Boolean),
              ),
          }),
          h(TextField, {
            label: '保护实例名关键字（逗号分隔）',
            value: (form.protectPatterns || []).join(', '),
            onChange: (value) =>
              update('protectPatterns')(
                value
                  .split(/[,\n]/)
                  .map((item) => item.trim())
                  .filter(Boolean),
              ),
          }),
        ),
        h(
          'label',
          { className: 'ay-check' },
          h('input', {
            type: 'checkbox',
            checked: form.allowGenericApi !== false,
            onChange: (event) => update('allowGenericApi')(event.target.checked),
          }),
          h('span', null, '允许 aliyun_api 通用 OpenAPI 透传'),
        ),
        h(
          'div',
          { className: 'ay-row', style: { marginTop: 12 } },
          h(
            'button',
            {
              className: 'ay-btn primary',
              type: 'button',
              disabled: busy === 'settings',
              onClick: () => onSave(form),
            },
            busy === 'settings' ? '保存中…' : '保存设置',
          ),
        ),
      )
    }

    function ComputeCard(props) {
      const { status, busy, onSave } = props
      const [form, setForm] = useState(null)
      useEffect(() => {
        if (status && status.settings && form === null) setForm({ ...status.settings })
      }, [status, form])
      if (!form) return null
      const update = (key) => (value) => setForm((current) => ({ ...current, [key]: value }))
      const number = (key) => (value) => {
        const parsed = Number(value)
        setForm((current) => ({ ...current, [key]: Number.isFinite(parsed) ? parsed : current[key] }))
      }
      const missing = ['computeInstanceType', 'computeImageId', 'computeSecurityGroupId', 'computeVSwitchId']
        .filter((key) => !String(form[key] || '').trim())
        .length
      const auto = form.computeAuto !== false
      return h(
        Card,
        {
          title: '计算偏好',
          description:
            '视频渲染、转码、推理等重计算任务会优先放到阿里云上跑。这里用自然语言写下你的偏好，agent 每次规划任务时都会读到它。',
        },
        h('textarea', {
          className: 'ay-input ay-textarea',
          rows: 6,
          value: form.preferences || '',
          placeholder:
            '例如：视频渲染优先用 GPU 抢占式实例，单任务不超过 2 小时；预算每小时 8 元以内；只装 ffmpeg 6；输出统一 1080p H.264；深夜可以跑长任务。',
          onChange: (event) => update('preferences')(event.target.value),
        }),
        h(
          'p',
          { className: 'ay-muted', style: { marginTop: 6 } },
          '可以写：常用规格/GPU 型号、预算与时长上限、地域、软件栈、画质/编码要求、允许的时间段、必须避免的规格。',
        ),
        h(
          'div',
          { className: 'ay-grid', style: { marginTop: 12 } },
          h(
            'label',
            { className: 'ay-field' },
            h('span', null, '资源来源'),
            h(
              'select',
              {
                className: 'ay-input',
                value: auto ? 'auto' : 'manual',
                onChange: (event) => update('computeAuto')(event.target.value === 'auto'),
              },
              h('option', { value: 'auto' }, '自动选择（推荐）：留空项由 AI 补全'),
              h('option', { value: 'manual' }, '手动填写：缺项时报错'),
            ),
          ),
          h(
            'label',
            { className: 'ay-field' },
            h('span', null, '自动选规格偏好'),
            h(
              'select',
              {
                className: 'ay-input',
                value: form.computeAccelerator || 'auto',
                onChange: (event) => update('computeAccelerator')(event.target.value),
              },
              h('option', { value: 'auto' }, '自动判断（按偏好/脚本关键词）'),
              h('option', { value: 'gpu' }, '优先 GPU（渲染/转码/推理）'),
              h('option', { value: 'cpu' }, '只用 CPU（更便宜）'),
            ),
          ),
        ),
        h(
          'div',
          { className: 'ay-grid', style: { marginTop: 10 } },
          h(TextField, {
            label: '计算地域（留空自动）',
            mono: true,
            list: 'ay-regions',
            value: form.computeRegion || '',
            placeholder: '自动：默认地域优先，可回退',
            onChange: update('computeRegion'),
          }),
          h(TextField, {
            label: '实例规格（留空自动）',
            mono: true,
            value: form.computeInstanceType || '',
            placeholder: '自动：GPU/CPU 候选依次尝试',
            onChange: update('computeInstanceType'),
          }),
          h(TextField, {
            label: '镜像 ID（留空自动）',
            mono: true,
            value: form.computeImageId || '',
            placeholder: '自动：最新 Ubuntu 22.04',
            onChange: update('computeImageId'),
          }),
          h(TextField, {
            label: '安全组 ID（留空自动）',
            mono: true,
            value: form.computeSecurityGroupId || '',
            placeholder: '自动：账号在该地域的第一个安全组',
            onChange: update('computeSecurityGroupId'),
          }),
          h(TextField, {
            label: '交换机 ID（留空自动）',
            mono: true,
            value: form.computeVSwitchId || '',
            placeholder: '自动：账号在该地域的第一个交换机',
            onChange: update('computeVSwitchId'),
          }),
          h(TextField, {
            label: '最长运行（小时）',
            type: 'number',
            value: String(form.computeMaxHours),
            onChange: number('computeMaxHours'),
          }),
        ),
        h(
          'label',
          { className: 'ay-check' },
          h('input', {
            type: 'checkbox',
            checked: form.computeSpot !== false,
            onChange: (event) => update('computeSpot')(event.target.checked),
          }),
          h('span', null, '优先抢占式实例（更便宜，可能被回收；默认开启）'),
        ),
        auto
          ? h(
              'div',
              { className: 'ay-banner', style: { marginTop: 10 } },
              '自动选择已开启：留空的镜像/规格/交换机/安全组/地域会在提交任务时由 AI 补全；想固定某一项，直接填值即可。',
            )
          : missing > 0
            ? h(
                'div',
                { className: 'ay-banner ay-warn', style: { marginTop: 10 } },
                `还缺 ${missing} 项计算默认值（规格/镜像/安全组/交换机）；手动模式下 agent 会报错。`,
              )
            : null,
        h(
          'div',
          { className: 'ay-row', style: { marginTop: 12 } },
          h(
            'button',
            {
              className: 'ay-btn primary',
              type: 'button',
              disabled: busy === 'compute',
              onClick: () =>
                onSave({
                  preferences: form.preferences || '',
                  computeRegion: form.computeRegion || '',
                  computeInstanceType: form.computeInstanceType || '',
                  computeImageId: form.computeImageId || '',
                  computeSecurityGroupId: form.computeSecurityGroupId || '',
                  computeVSwitchId: form.computeVSwitchId || '',
                  computeMaxHours: form.computeMaxHours,
                  computeSpot: form.computeSpot !== false,
                  computeAuto: form.computeAuto !== false,
                  computeAccelerator: form.computeAccelerator || 'auto',
                }),
            },
            busy === 'compute' ? '保存中…' : '保存计算偏好',
          ),
        ),
      )
    }

    function AliyunSection() {
      const [status, setStatus] = useState(null)
      const [busy, setBusy] = useState('')
      const [error, setError] = useState('')
      const [notice, setNotice] = useState('')
      const [testResult, setTestResult] = useState(null)
      const alive = useRef(true)

      useEffect(() => {
        alive.current = true
        return () => {
          alive.current = false
        }
      }, [])

      const refresh = useCallback(async () => {
        const data = await request('status')
        if (alive.current) setStatus(data)
        return data
      }, [])

      useEffect(() => {
        refresh().catch((cause) => {
          if (alive.current) setError(cause.message)
        })
      }, [refresh])

      const run = useCallback(async (kind, action) => {
        setBusy(kind)
        setError('')
        setNotice('')
        try {
          return await action()
        } catch (cause) {
          setError(cause.message)
          return null
        } finally {
          if (alive.current) setBusy('')
        }
      }, [])

      const onSave = (form, reset) =>
        run('save', async () => {
          ensure(await request('credentials', form))
          await refresh()
          if (reset) reset()
          setNotice('凭据已保存。')
        })

      const onClear = () =>
        run('clear', async () => {
          ensure(await request('credentials/clear', {}))
          await refresh()
          setTestResult(null)
          setNotice('凭据已清除。')
        })

      const onTest = () =>
        run('test', async () => {
          const result = await request('test', {})
          setTestResult(result)
        })

      const onSaveCompute = (form) =>
        run('compute', async () => {
          ensure(await request('settings', form))
          const data = await refresh()
          setNotice(
            data.settings.computeInstanceType
              ? `计算偏好已保存（规格 ${data.settings.computeInstanceType}）。`
              : '计算偏好已保存；还缺实例规格/镜像/安全组/交换机。',
          )
        })

      const onSaveSettings = (form) =>
        run('settings', async () => {
          ensure(
            await request('settings', {
              defaultRegion: form.defaultRegion,
              writeMode: form.writeMode,
              requestTimeoutMs: form.requestTimeoutMs,
              maxResults: form.maxResults,
              maxBatch: form.maxBatch,
              allowGenericApi: form.allowGenericApi,
              idleCpuPercent: form.idleCpuPercent,
              idleWindowMinutes: form.idleWindowMinutes,
              minInstanceAgeMinutes: form.minInstanceAgeMinutes,
              autoReleaseHours: form.autoReleaseHours,
              protectIds: form.protectIds,
              protectPatterns: form.protectPatterns,
            }),
          )
          const data = await refresh()
          setNotice(`设置已保存（${data.settings.defaultRegion}）。`)
        })

      return h(
        'div',
        { className: 'ay-root' },
        h('style', null, CSS),
        h('p', { className: 'ay-intro' }, '让 agent 把视频渲染、转码、推理等重计算任务放到阿里云算力上，并按你的偏好选择规格；同时提供省钱止损与资源管理。'),
        error ? h('div', { className: 'ay-banner ay-bad' }, error) : null,
        notice ? h('div', { className: 'ay-banner ay-ok' }, notice) : null,
        h(CredentialCard, { status, busy, onSave, onClear }),
        h(ConnectionCard, { status, busy, result: testResult, onTest }),
        h(ComputeCard, { status, busy, onSave: onSaveCompute }),
        h(SettingsCard, { status, busy, onSave: onSaveSettings }),
        h(
          'div',
          { className: 'ay-foot' },
          status
            ? `设置文件：${status.settingsFile}` +
              (status.settingsError ? ` · 警告：${status.settingsError}` : '') +
              ` · v${status.version}`
            : '',
        ),
      )
    }

    return {
      name: '@local/dsh-aliyun-toolkit/client',
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('settings.section', () =>
          ctx.slots.register(
            { name: 'settings.section', id: 'aliyun-toolkit', order: 20, label: '阿里云' },
            AliyunSection,
          ),
        )
      },
    }
  },
})
