/**
 * Host half of the Aliyun toolkit bundle.
 *
 * Optional services are resolved with `ctx.inject`, so a profile without the
 * web server or the system prompt registry still gets the tools.
 */
import { registerHttp } from './src/http.js'
import { installPrompt } from './src/prompt.js'
import { loadSettings } from './src/settings.js'
import { setPreferencesText } from './src/state.js'
import { registerCompute } from './src/tools-compute.js'
import { registerCostGuard } from './src/tools-cost.js'
import { registerEcs } from './src/tools-ecs.js'
import { registerMiscTools } from './src/tools-misc.js'
import { registerOss } from './src/tools-oss.js'

export const name = '@local/dsh-aliyun-toolkit'
export const inject = []

export function apply(ctx) {
  loadSettings()
    .then((loaded) => setPreferencesText(loaded.value.preferences))
    .catch(() => {})

  ctx.inject(['tools'], (toolsCtx) => {
    const steps = [registerEcs, registerCostGuard, registerCompute, registerOss, registerMiscTools]
    for (const step of steps) {
      try {
        step(toolsCtx)
      } catch (error) {
        toolsCtx.logger?.error?.(`[aliyun-toolkit] 工具注册失败：${error?.stack || error}`)
      }
    }
  })

  ctx.inject(['systemPrompt'], (promptCtx) => {
    try {
      installPrompt(promptCtx)
    } catch (error) {
      promptCtx.logger?.warn?.(`[aliyun-toolkit] 系统提示未安装：${error?.message || error}`)
    }
  })

  ctx.inject(['webServer'], (webCtx) => {
    try {
      registerHttp(webCtx)
    } catch (error) {
      webCtx.logger?.warn?.(`[aliyun-toolkit] 设置页接口未注册：${error?.message || error}`)
    }
  })
}
