# 阿里云工具包（@local/dsh-aliyun-toolkit）

让 DeepSeek Harness 的 agent **把视频渲染、转码、推理等重计算任务优先放到阿里云算力上跑**，同时处理按量计费算力的省钱与止损：一条命令扫描出正在计费但空闲的 ECS，用「节省停机模式」停止计费；新建算力用抢占式实例并自动设置释放时间。

- 纯 Node 内置模块实现，**零 npm 依赖**，安装时不联网拉包。
- 凭据只进 DSH 凭据库（回退 `ALIYUN_*` 环境变量），**不写入插件配置、不出现在工具结果里**。
- 写操作默认经 DSH 审批；释放实例默认只预演，执行需要 `dry_run=false` + `confirm=true`。

> GitHub: https://github.com/Flureax/dsh-aliyun-toolkit

## 安装

```powershell
git clone https://github.com/Flureax/dsh-aliyun-toolkit.git
# 在 DSH 会话里让 agent 执行，或通过插件管理器安装本地包
plugin_manager action=install_bundle target=<仓库目录的绝对路径>
```

装好后 Settings →「阿里云」出现一个配置页，`aliyun_*` 工具对 agent 可用。安装通常立即生效（设置页与工具会热加载）。若工具或设置页没有出现，重启 DSH：Host 代码在启动时装载。

## 首次配置

1. 打开 **Settings →「阿里云」**；
2. 填入 AccessKey ID / Secret（可选 STS Token），点「保存凭据」；
3. 点「测试连接」：返回 `连接成功` 即链路正常（这一步只调用只读的 `DescribeRegions`）；
4. 在「计算偏好」写自然语言要求，并填好「计算默认值」（镜像/规格/安全组/交换机）；
5. 在同一页设置默认地域、写策略与省钱阈值。

不想用凭据库时，可设置环境变量：`ALIYUN_ACCESS_KEY_ID`、`ALIYUN_ACCESS_KEY_SECRET`、`ALIYUN_SECURITY_TOKEN`（可选）。

## 工具

| 工具 | 用途 | 写操作 |
| --- | --- | --- |
| `aliyun_compute` | **重计算任务**：`recommend` 选 GPU 规格、`launch` 用云初始化脚本提交任务、`status`/`logs` 跟进、`terminate` 释放 | 创建/释放 |
| `aliyun_cost_guard` | 省钱模式：`scan` 体检、`stop` 节省停机、`auto_release` 设自动释放、`release` 释放 | 除 `scan` 外 |
| `aliyun_ecs` | 列举/详情/启动/停机/重启/释放/创建抢占式实例/设自动释放 | 是 |
| `aliyun_oss` | 列 bucket、列对象、对象元数据、预签名 URL、删除对象 | 删除 |
| `aliyun_monitor` | 云监控指标（默认 CPU）与告警 | 否 |
| `aliyun_billing` | 账户余额、账期账单（按产品汇总） | 否 |
| `aliyun_api` | 任意产品/任意 Action 的 OpenAPI 透传 | 按 Action 判定 |
| `aliyun_doctor` | 凭据来源、endpoint、连通性与签名自检 | 否 |

## 把视频渲染等计算任务放到阿里云

agent 的默认策略是：重计算任务（视频渲染/转码、批量素材处理、模型推理、大规模编译、压测）不走本机，改用 `aliyun_compute`。你只需要在 **Settings →「阿里云」→「计算偏好」** 用自然语言写下要求，例如：

> 视频渲染优先用 GPU 抢占式实例，单任务不超过 2 小时；预算每小时 8 元以内；只装 ffmpeg 6；输出统一 1080p H.264。

同时填好「计算默认值」——**这些都可以留空**：默认开启「自动选择」，agent 会自己挑地域/镜像/规格/交换机/安全组；想固定某一项再填值即可。想先看自动选了什么，用 `aliyun_compute action=launch dry_run=true`。

工作流：

```text
aliyun_compute action=recommend                      # 列出可用区与 GPU 规格，挑 instance_type
aliyun_oss    action=presign method=GET ...           # 生成输入文件的限时下载链接
aliyun_oss    action=presign method=PUT content_type=video/mp4 ...   # 生成结果上传链接
aliyun_compute action=launch script="..." dry_run=true   # 预演：看自动选中的地域/镜像/规格/交换机
aliyun_compute action=launch script="<bootstrap>"     # 创建抢占式实例并执行脚本（自动释放）
aliyun_compute action=status                          # 跟进实例状态
aliyun_oss    action=list_objects bucket=... prefix=out/   # 取回结果
aliyun_compute action=terminate                       # 提前释放（默认只预演）
```

自动选择规则（按顺序回退）：

- **地域**：显式/设置值 → 默认地域 → `cn-hangzhou / cn-shanghai / cn-beijing / cn-shenzhen / cn-zhangjiakou / cn-chengdu` 中第一个能拿到交换机+安全组+镜像的地域。
- **规格**：显式/设置值 → GPU（按 GPU 数、CPU 数从小到大，最多 6 个候选）或 CPU（内置廉价规格列表）；创建时依次尝试，遇到无库存自动换下一个。
- **镜像**：显式/设置值 → 最新 Ubuntu 22.04 系统镜像 → 最新 Ubuntu → 最新 Alinux/CentOS/Debian。
- **交换机/安全组**：显式/设置值 → 账号在该地域的第一个 VPC 交换机（优先默认交换机），安全组取其同 VPC。
- 自动判断 GPU 还是 CPU：`computeAccelerator` 设为 `auto` 时，看偏好文字和脚本里是否出现 GPU/渲染/推理/转码 等关键词；也可以在调用时传 `accelerator=gpu|cpu`。
- 关掉自动：设置里把「资源来源」改成「手动填写」，或调用时传 `auto=false`；此时缺项会直接报错而不是替你选。

脚本以 root 通过 cloud-init 执行，不需要 SSH、不需要入方向安全组规则。示例：

```bash
#!/bin/bash
set -euo pipefail
apt-get update && apt-get install -y ffmpeg curl
curl -fsSL "<输入文件的预签名 GET URL>" -o /tmp/in.mov
ffmpeg -y -i /tmp/in.mov -vf scale=1920:-2 -c:v libx264 -crf 20 -c:a aac /tmp/out.mp4
curl -fsSL -X PUT -H "Content-Type: video/mp4" --data-binary @/tmp/out.mp4 "<预签名 PUT URL>"
poweroff
```

注意事项：

- 预签名 PUT 的 `content_type` 必须与脚本发送的 `Content-Type` 完全一致，否则 OSS 拒绝。
- 脚本上限 10KB；大依赖请让脚本在实例上下载。
- 实例默认挂 40GB 系统盘、100Mbps 公网带宽上限（按流量计费），大素材建议放 OSS 而不是实例盘。
- 默认开启抢占式并设置自动释放时间，任务结束或超时都不会长期计费。

## 省钱模式（最常用）

```text
# 1. 体检：找出运行中的按量付费 ECS、CPU 空闲情况、闲置 EIP/云盘
aliyun_cost_guard action=scan

# 2. 止损：对空闲实例执行节省停机（可逆，计算资源不再计费）
aliyun_cost_guard action=stop

# 紧急情况：连"看起来不空闲"的实例也停掉
aliyun_cost_guard action=stop scope=all

# 3. 上保险：给存量实例设置自动释放时间，避免长期扣费
aliyun_cost_guard action=auto_release hours=8
```

判定为空闲的条件：状态 Running、付费方式 PostPaid、不在保护名单、创建时间超过 `minInstanceAgeMinutes`、最近 `idleWindowMinutes` 内 CPU 均值低于 `idleCpuPercent`。**取不到监控数据时不会被判为空闲**，宁可不停。

停止时优先 `StoppedMode=StopCharging`（节省停机，不收取计算费用）。若实例不支持（本地盘、经典网络等），会自动降级为普通停机并在结果里明确标注「仍会继续计费」。

`release` 不可逆：

```text
aliyun_cost_guard action=release                 # 默认只预演，列出目标
aliyun_cost_guard action=release dry_run=false confirm=true
```

临时算力用抢占式实例（创建时即设好自动释放）：

```text
aliyun_ecs action=run_spot image_id=ubuntu_22_04_x64_20G_alibase_20240124.vhd \
  instance_type=ecs.t6-c1m2.large security_group_id=sg-xxx vswitch_id=vsw-xxx \
  hours=4 internet_max_bandwidth_out=1
```

## 设置

设置保存在 `<DSH_HOME>/plugin-data/aliyun-toolkit/settings.json`（默认 `~/.dsh/...`），页面保存后对下一次工具调用立即生效：

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `defaultRegion` | `cn-hangzhou` | 默认地域 |
| `writeMode` | `ask` | `ask` 审批 / `deny` 全只读 / `allow` 不询问 |
| `requestTimeoutMs` | `20000` | 单次 OpenAPI 超时 |
| `maxResults` | `50` | 单次返回条数上限 |
| `allowGenericApi` | `true` | 是否允许 `aliyun_api` 透传 |
| `idleCpuPercent` | `5` | 空闲 CPU 阈值 |
| `idleWindowMinutes` | `30` | 空闲判定窗口 |
| `minInstanceAgeMinutes` | `10` | 新实例保护期，避免误停刚创建的机器 |
| `maxBatch` | `20` | 单次最多处理的实例数 |
| `protectIds` | `[]` | 永不自动操作的实例 ID |
| `protectPatterns` | `[]` | 实例名关键字（命中即保护） |
| `endpointOverrides` | `{}` | 产品 → 自定义域名（VPC 私有接入点/专有云） |
| `autoReleaseHours` | `8` | 默认自动释放小时数 |
| `preferences` | `''` | 自然语言计算偏好，注入 agent 的系统提示 |
| `computeRegion` | `''` | 计算任务地域，留空跟随 `defaultRegion` |
| `computeInstanceType` | `''` | 计算实例规格；留空自动选择（视频渲染建议 GPU 规格） |
| `computeImageId` | `''` | 计算实例镜像；留空自动选择最新 Ubuntu 22.04 |
| `computeSecurityGroupId` | `''` | 安全组；留空自动取同地域第一个 |
| `computeVSwitchId` | `''` | 交换机；留空自动取同地域第一个 |
| `computeMaxHours` | `4` | 计算任务最长运行小时数（到点自动释放） |
| `computeSpot` | `true` | 是否优先抢占式实例 |
| `computeAuto` | `true` | 留空项是否自动选择（关掉后缺项直接报错） |
| `computeAccelerator` | `auto` | 自动选规格偏好：`auto` / `gpu` / `cpu` |

## RAM 最小权限

只为这个 AccessKey 授予需要的动作：

```json
{
  "Version": "1",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "ecs:DescribeRegions", "ecs:DescribeInstances", "ecs:DescribeDisks",
        "ecs:DescribeEipAddresses", "ecs:StartInstance", "ecs:StopInstance",
        "ecs:RebootInstance", "ecs:DeleteInstance", "ecs:RunInstances",
        "ecs:ModifyInstanceAutoReleaseTime", "ecs:DescribeZones",
        "ecs:DescribeInstanceTypes", "ecs:DescribeImages",
        "ecs:DescribeVSwitches", "ecs:DescribeSecurityGroups",
        "ecs:GetInstanceConsoleOutput"
      ],
      "Resource": "*"
    },
    {
      "Effect": "Allow",
      "Action": ["cms:DescribeMetricList", "cms:DescribeMetricLast", "cms:DescribeAlarms"],
      "Resource": "*"
    },
    {
      "Effect": "Allow",
      "Action": ["bss:QueryAccountBalance", "bss:QueryAccountBill"],
      "Resource": "*"
    },
    {
      "Effect": "Allow",
      "Action": ["oss:ListBuckets", "oss:ListObjects", "oss:GetObject", "oss:DeleteObject"],
      "Resource": "*"
    }
  ]
}
```

## 安全边界

- AccessKey 只存在 DSH 凭据库（或环境变量）；页面回显只有 ID 掩码，Secret 永不回传。
- 写操作走 `ctx.approval`；审批被拒时直接返回失败，不存在绕过路径。
- `release` / `delete_object` 不可逆：前者双重确认，默认预演。
- 保护名单与最小实例年龄默认生效；取不到 CPU 数据不判空闲。
- 插件自身只额外写一个设置文件（不含任何密钥）。

## 已知限制

- 仅支持公网 endpoint（可用 `endpointOverrides` 指向私有域名，未实现 HTTP 代理）。
- 单账号；多账号需要装多份并在不同 profile 配置。
- 不提供后台上定时停机守护进程——用云侧自动释放时间代替，避免无人值守的写操作。
- OSS 只做列举/元数据/预签名/删除，不做上传下载。
- 本机没有浏览器控制能力时，设置页的渲染需要人工确认一次。

## 卸载

```powershell
plugin_manager action=remove_bundle target=@local/dsh-aliyun-toolkit
```
