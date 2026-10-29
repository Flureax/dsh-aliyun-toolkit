/**
 * Agent-facing routing rules for the Aliyun tools, plus the user's own
 * natural-language compute preferences.
 */
import { preferencesText } from './state.js'

const BASE = [
  '阿里云工具包（aliyun_*）已启用。',
  '- 重计算任务（视频渲染/转码、批量素材处理、渲染农场、模型推理、大规模编译、压测、批量转码）默认放到阿里云算力上跑，不要在本机硬扛：',
  '  1) 用 `aliyun_compute action=recommend` 看 GPU 规格与可用区；',
  '  2) 用 `aliyun_compute action=launch` 提交 bootstrap 脚本（脚本内安装 ffmpeg 等依赖、用 OSS 预签名 GET 取输入、结果用预签名 PUT 传回 OSS），默认抢占式 + 自动释放；',
  '  3) 用 `action=status` / `action=logs` 跟进，任务结束后确认实例已释放或到期。',
  '- OSS 预签名：下载用 `aliyun_oss action=presign method=GET`；上传用 `method=PUT` 且必须给 `content_type`，脚本发送的 Content-Type 必须与之一致。',
  '- 镜像/规格/交换机/安全组/地域留空时由 aliyun_compute 自动选择（可在设置里关闭）；用户偏好可覆盖。只有自动选择失败（例如账号没有 VPC/交换机）时才请用户补齐。',
  '- 想先确认自动选了什么：`aliyun_compute action=launch dry_run=true` 返回完整计划（地域/可用区/镜像/规格候选/到期时间），确认后再执行。',
  '- 用户说"省钱 / 止损 / 别计费了 / 闲置资源"时：先 `aliyun_cost_guard action=scan`，再 `action=stop`（可逆，节省停机不收费）。',
  '- `release` 不可逆：只能在用户明确同意后执行，且必须 `dry_run=false` + `confirm=true`。',
  '- 写操作会触发 DSH 审批；用户拒绝后不得换接口或换参数绕过。',
  '- 工具返回 `ok=false` 时按 `code` / `advice` 处理，不要盲目重试同一个调用。',
]

const NO_PREFERENCES =
  '用户暂未填写计算偏好。涉及规格、预算、地域、软件栈的选择时先问用户，或提示他到 Settings →「阿里云」→「计算偏好」填写。'

export function installPrompt(ctx) {
  ctx.effect(() =>
    ctx.systemPrompt.section({
      name: 'aliyun-toolkit',
      order: 620,
      text: () => {
        const preferences = preferencesText()
        return `${BASE.join('\n')}\n\n${
          preferences ? `用户的计算偏好（自然语言，优先级高于默认值）：\n${preferences}` : NO_PREFERENCES
        }`
      },
    }),
  )
}
