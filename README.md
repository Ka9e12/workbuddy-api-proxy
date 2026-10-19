# WorkBuddy API Proxy

把 **腾讯 CodeBuddy / WorkBuddy 反代**接进 Claude Code、Codex、DSH 和任何 OpenAI / Anthropic 客户端。

CodeBuddy 官方只给 OpenAI 形态的接口，而这些编码助手多数只认 Anthropic Messages。这个自托管网关补上中间那一段——**双协议互转、多账号轮换、失败自动换号、积分与签到托管**。

`CodeBuddy` `WorkBuddy` `Claude Code` `Codex` `Anthropic API 反向代理` `OpenAI 转 Anthropic` `协议转换网关` `多账号轮换` `claude-code-router`

---

## 它能给你什么

**一个订阅，所有客户端都能用。** 接上之后，Claude Code 里改个 `ANTHROPIC_BASE_URL` 就能跑，工具调用、流式输出、图片输入、thinking 全部照常。Codex 和 DSH 走同一条链路。

**多账号不互相拖累。** 加几个号，网关自动轮转。某个号限流了自动切走；会话粘性保证同一轮对话不会跳到别的号上，上下文不串。上游 prefix cache 也因此更容易命中，积分更省。

**账号出问题能自愈。** 402、429、404、5xx 分开处理，冷却时长和错误类型匹配。几天前的一次偶发 502 不会一直挂着把好号熔断。

**日常琐事自动做。** 启动时自动签到、跑成长中心（猫猫旅行、连登兑换、抽奖）。也可以让它在后台定时跑。

**翻车也能查。** 面板上能看到每个号的余额、冷却来源、锁住的模型、还要等多久。

---

## 三个后端

| 后端 | 你能做什么 | 面板 |
| ---- | ---------- | ---- |
| **CodeBuddy** | 把订阅号接给 Claude Code / Codex / DSH；加多个号自动轮换；托管签到、积分、成长中心 | `/codebuddyFE` |
| **GitHub Copilot** | 用 Copilot 订阅驱动 Claude Code；可指定 GPT 模型，不消耗 Claude 高级请求 | `/copilotFE` |
| **Relay** | 接任意 OpenAI / Responses / Anthropic 上游，可做模型名映射 | `/relayFE` |

---

## 快速开始

### 0. 让你的 AI 帮你部署

如果你在用 Claude Code、Codex、Cursor 这类编码助手，把下面这句丢给它就行：

```
帮我部署 https://github.com/Ka9e12/workbuddy-api-proxy 并且告诉我如何使用
```

它会自己 clone、装依赖、起服务，再把面板地址和接入方式告诉你。你唯一需要亲自做的是最后一件事——在面板里完成 CodeBuddy 的 OAuth 登录，因为那一步必须点浏览器。

> 想让它一次做对，可以在提示里补一句现在的状态，比如「我 Windows，没装 Node」「我 macOS，已经有 Node 20」。

下面的手动步骤留着，用于 AI 跑不通或者你想自己看清每一步的时候。

### 1. 确认 Node.js

```bash
node -v
```

能打印出版本号且不低于 `v18` 就跳过安装。没有的话去 [nodejs.org](https://nodejs.org/) 装 LTS 版（推荐 20 / 22）。

### 2. 拿到代码

已经有这个目录的可以直接跳过。

```bash
git clone https://github.com/Ka9e12/workbuddy-api-proxy.git
cd workbuddy-api-proxy
```

### 3. 启动

**Windows：双击 `启动代理.bat`。** 第一次运行会自动装依赖，之后直接起服务。窗口要一直开着，关掉就停了。

**macOS / Linux 或想用命令行：**

```bash
npm install    # 只需第一次
npm start
```

启动后终端会打出面板地址和两个接入地址：

```
  ▸ 管理面板   http://127.0.0.1:3088
  ▸ 接入地址   http://127.0.0.1:3088/codebuddy/anthropic   (Claude Code / DSH)
              http://127.0.0.1:3088/codebuddy/v1            (Codex / OpenAI 兼容)
  ▸ 鉴权       面板需登录 · 网关需 Key
  ▸ 监听       127.0.0.1:3088（仅本机）
```

打开面板地址进主页。输入 `h` 可以查看全部端点和控制台指令。

> 默认只监听 `127.0.0.1`，同一局域网的其他设备访问不到。想用手机或另一台电脑接的话，把 `.env` 里的 `HOST` 改成 `0.0.0.0`，并确保 `ADMIN_PASSWORD` 已经设置。

> 双击 `.bat` 的好处是不用手动开终端、不用记命令，出错了窗口也不会一闪而过。`npm start` 适合放进脚本或 PM2 托管。

### 添加 CodeBuddy 账号

1. 进 `/codebuddyFE`
2. 选上游（国内站 `copilot.tencent.com` / 国际站 / 企业站）
3. 点「开始认证」，在跳出的页面完成 OAuth 登录
4. 完成后账号自动入列，并**自动设为当前活跃账号**（只有第一个号才是活跃号，之后加的会替换它；想固定用某个号再手动点「设为活跃」）
5. 复制面板上生成的 API Key（`sk-xxx`）

---

## 接进客户端

所有客户端都填**同一套** Base URL 和 Key，只是协议不同。

### Claude Code

编辑 `~/.claude/settings.json`（Windows 是 `C:\Users\<你>\.claude\settings.json`）：

```json
{
    "env": {
        "ANTHROPIC_AUTH_TOKEN": "sk-xxx",
        "ANTHROPIC_BASE_URL": "http://127.0.0.1:3088/codebuddy/anthropic",
        "NO_PROXY": "localhost,127.0.0.1,::1"
    }
}
```

重启 Claude Code，随便说句话验证。

> Base URL 结尾**不带** `/v1`，客户端会自己拼成 `/codebuddy/anthropic/v1/messages`。写成 `.../codebuddy/anthropic/v1` 会被拼成 `/v1/v1/messages`，直接 404。
>
> `NO_PROXY` 一定要加，很多代理软件会劫持 localhost。

### Codex

编辑 `~/.codex/config.toml`，加一个自定义 provider：

```toml
model_provider = "codebuddy"
model = "deepseek-v4.1-flash"

[model_providers.codebuddy]
name = "CodeBuddy via WorkBuddy API Proxy"
base_url = "http://127.0.0.1:3088/codebuddy/v1"
env_key = "CODEBUDDY_API_KEY"
```

然后设置环境变量：

```bash
# Windows PowerShell
$env:CODEBUDDY_API_KEY="sk-xxx"

# macOS / Linux
export CODEBUDDY_API_KEY="sk-xxx"
```

> Codex 走的是 **OpenAI Responses** 或 **Chat Completions** 协议，所以 Base URL 用 `/codebuddy/v1`，不是 `/codebuddy/anthropic`。
>
> `env_key` 里填的是**变量名**，不是 Key 本身。

### DSH（DeepSeek Harness）

启动 `npx @deepseek-ai/dsh web`，进 **Settings → Models** → **Add model provider** → 切到 **Custom model API**，填：

| 字段 | 值 |
| ---- | -- |
| Provider ID | `codebuddy`（小写，创建后不可改） |
| Base URL | `http://127.0.0.1:3088/codebuddy/anthropic` |
| API protocol | **Anthropic Messages** |
| API Key | `sk-xxx` |
| Model | 至少填一个，比如 `glm-5.3` |

保存后模型会出现在选择器里，选中即生效，不用重启。

> 「Fetch available models」会尝试自动拉模型列表，但 DSH 不保证能解析每个网关的返回格式。拉不到就手动填模型 id，效果一样。

### 其他客户端

| 客户端 | Base URL | 协议 |
| ------ | -------- | ---- |
| Cursor / Cline / Continue | `http://127.0.0.1:3088/codebuddy/v1` | OpenAI Chat |
| Cherry Studio | `http://127.0.0.1:3088/codebuddy/v1` | 选 Responses 模式 |
| Anthropic SDK | `http://127.0.0.1:3088/codebuddy/anthropic` | Anthropic Messages |

把 `codebuddy` 换成 `copilot` 或 `relay` 就切到别的后端。Key 用面板里那个 `sk-xxx`，`Authorization: Bearer` 和 `x-api-key` 两种头都支持。

---

## 用 CC Switch 一键切换

[CC Switch](https://github.com/farion1231/cc-switch) 是个桌面工具，帮你管理多个供应商配置，一键切换，不用手改 JSON。支持 Windows / macOS / Linux，从 [Releases](https://github.com/farion1231/cc-switch/releases) 下载安装包。

好处是你可以同时存着国内站、国际站、Copilot、Relay 好几套，点一下就切，不用反复改配置文件。

### 接 Claude Code

1. 左侧选 **Claude Code**，点右上角 **+**
2. 选 **自定义配置**
3. 填三项基本信息：

   | 字段 | 填什么 |
   | ---- | ------ |
   | 名称 | 随便起，比如「CodeBuddy 国内站」 |
   | API Key | 面板里的 `sk-xxx` |
   | 请求地址 | `http://127.0.0.1:3088/codebuddy/anthropic` |

4. 点模型输入框旁的**获取模型列表**，选你要用的模型
5. 需要长上下文就勾那一行的 **1M**——它写进 `ANTHROPIC_MODEL`，由 Claude Code 自己用来判断上下文窗口，不会发给上游
6. 底部**默认兜底模型**填一个，比如 `deepseek-v4.1-flash`——落到 Sonnet / Opus / Haiku 任何一档之外的请求会用它
7. 保存，回到主界面选中它点「启用」

Claude Code 无需重启，下次请求就生效。

> 请求地址不带 `/v1`。CC Switch 会自己拼成 `/codebuddy/anthropic/v1/messages`。

### 接 Codex

同样左上加供应商，只是表单不同：

1. 左侧选 **Codex**，点 **+** → **自定义配置**
2. 请求地址填 `http://127.0.0.1:3088/codebuddy/v1`（Codex 走 OpenAI 协议）
3. API Key 同上
4. 在**模型映射**表里加行：菜单显示名随你，实际请求模型填 `deepseek-v4.1-flash`、`glm-5.3` 这类真实模型名
5. 需要长上下文勾 **1M 上下文窗口**，会写进 `model_context_window = 1000000`
6. 表的第一行就是默认模型

Codex 改完要**重开终端**才会加载新的模型列表。

> 「上游格式」保持默认的 **Responses（原生）** 即可，本项目 `/codebuddy/v1` 原生支持。选成 Chat Completions 或 Anthropic Messages 会让 CC Switch 要求额外开本地路由，多一层转发。

### 接其他工具

同一个套路，只换请求地址：

| 工具 | 请求地址 |
| ---- | -------- |
| Claude Code / DSH（Anthropic 协议） | `http://127.0.0.1:3088/codebuddy/anthropic` |
| Codex（OpenAI 协议） | `http://127.0.0.1:3088/codebuddy/v1` |

---

## CodeBuddy 模型

模型列表在面板「模型列表」里实时从上游拉（`/v3/config`），下面的静态表只在上游拉取失败时兜底。**以面板为准。**

**国内站**（`copilot.tencent.com`）

`deepseek-v4-pro` `deepseek-v4-flash` `deepseek-v4.1-flash` `deepseek-v3-2-volc`
`glm-5.3` `glm-5.3-flash` `glm-5.2` `glm-5.1` `glm-5.0` `glm-5.0-turbo` `glm-5v-turbo` `glm-4.7` `glm-4.6` `glm-4.6v`
`kimi-k3-1` `kimi-k2.8-preview` `kimi-k2.7` `kimi-k2.6` `kimi-k2.5` `kimi-k2-thinking`
`minimax-m3` `minimax-m2.7` `minimax-m2.5`
`hy3` `hy3-x` `hy4-preview` `hy4-preview-x` `hunyuan-chat`
`step-5-preview` `space-bunny`

**国际站**（`www.codebuddy.ai`）

`default-model` `fast-model` `balanced-model` `primary-model` `deep-model`（这几个是档位别名）
`gpt-5.6-terra` `gpt-5.6-luna` `gpt-5.5` `gpt-5.4`
`gemini-3.5-flash`
`glm-5.3` `glm-5.3-flash` `glm-5.2`
`kimi-k3` `kimi-k2.8-preview` `kimi-k2.6`
`deepseek-v4.1-flash` `deepseek-v4.1-flash-sg`
`hy4-preview` `hy3`

**企业站**

企业站域名因企业而异，用环境变量配置后会出现在下拉框：

```env
CODEBUDDY_ENTERPRISE_HOSTS=https://abc.copilot.qq.com,xyz.copilot.qq.com
```

企业站模型与国内站接近，以面板实际拉取为准。

> 推理强度从 `output_config.effort` 读（low / medium / high / max），没有就看 `thinking` 配置，默认 `high`。

---

## 多账号怎么调度

**选号优先级：手动指定 > 会话粘性 > 按阈值轮转。**

同一会话的多轮请求尽量落在同一个号上，30 分钟滚动续期，请求失败自动解绑换号——上下文不串，上游 prefix cache 也更容易命中。

**冷却按错误类型分开处理：**

| 上游返回 | 冷却多久 | 面板显示 |
| -------- | -------- | -------- |
| `402` 余额不足 | 到次日 04:00 | 余额不足 |
| `429` 限流 | 10 分钟起，翻倍退避，封顶 2 小时 | 限流 |
| `429` + `code 6004` | 只锁这个模型 5 分钟，账号还能用别的模型 | 模型锁 |
| `404` | 60 秒 | 上游404 |
| 连续 3 次 5xx | 30 分钟起，封顶 6 小时 | 熔断 |
| 其它 4xx | 不罚账号（问题在请求本身） | — |

三个细节：

- **"连续"看时间窗口。** 熔断只统计 10 分钟内的失败，几天前的孤立错误不会累积。
- **取更长的不叠加。** 同一个号同时有软冷却和熔断时，按到期晚的那个算。
- **兜底探测不计数。** 所有号都冷却时，网关仍会试探性发请求，但这些失败不推进任何计数，避免越试越冷。

> 冷却状态保存在内存里，每个 worker 独立，重启后清空。集群模式下面板显示的是当前实例的视角。

### 错误返回

网关会把上游错误翻译成"客户端该干什么"，原始信息放在 `error.gateway_hint` 里不覆盖。

| 上游情况 | 返回给客户端 | 意思是 |
| -------- | ------------ | ------ |
| 模型限流 / 模型不存在 | **400** | 换模型，重试没用 |
| `429` | 429 | 已经自动换号了 |
| `402` | 502 | 已经自动换号了 |
| 5xx | 502 | 稍等再试 |
| 请求体不合法 | 502 | 换号没用，检查请求内容 |
| 连不上上游 | 502 | 检查网络或代理 |

---

## 签到与成长中心

`/codebuddyFE` 面板里，只对**国内个人站**生效（企业站和国际站没有个人成长体系，自动跳过）。

**积分与签到** — 看余额、看容量、每日签到。签到做了幂等，本地记一笔、上游再查一次，重复执行不会多签。

**成长中心** — 猫猫旅行（领养、派出、领到站奖励）、连登档位兑换（7d / 14d / 28d）、抽奖。

每个写操作都先查状态再动手，上游接口变了也只会失败并记日志，不会误操作。写操作不做重试，避免超时后重复提交。

### 自动化

**默认行为：每次启动时跑一遍。** 签到 + 成长日常，面板上可以关掉。

**默认不会在你的系统里注册任何计划任务。**

要是不想每次启动才跑，可以手动执行：

```bash
npm run task:checkin    # 只签到
npm run task:growth     # 只跑成长中心
```

想让它在后台定时跑（关掉项目也生效），再装计划任务：

```bash
npm run schedule:enable
```

需要管理员权限，会创建两个 Windows 计划任务：签到每天 08:05，成长每天 09:05 / 13:05 / 19:05 / 21:00。

```bash
npm run schedule:status   # 看状态
npm run schedule:disable  # 删掉
```

---

## GitHub Copilot

进 `/copilotFE`，点登录，完成 GitHub 设备码授权。Token 会自动保存。

**国内网络需要配代理**，在面板的「代理配置」里填 `http://127.0.0.1:7890` 之类。

**模型能不能用取决于出口地区**：国内节点一般只有 GPT 和 Gemini，要 Claude 系列得用日本 / 美国 / 新加坡等节点。

**省额度的用法**：Copilot 的 Claude 模型按"高级请求"计费。把 Claude Code 指到 Copilot 的 GPT 模型上，一次需要 5 轮模型调用的 agent 任务就不会吃掉 5 次 Claude 高级请求，工具调用照样能用。

```json
{
    "env": {
        "ANTHROPIC_AUTH_TOKEN": "sk-xxx",
        "ANTHROPIC_BASE_URL": "http://127.0.0.1:3088/copilot",
        "ANTHROPIC_DEFAULT_HAIKU_MODEL": "gpt-4.1",
        "ANTHROPIC_DEFAULT_SONNET_MODEL": "gpt-4.1",
        "ANTHROPIC_DEFAULT_OPUS_MODEL": "gpt-4.1",
        "NO_PROXY": "localhost,127.0.0.1,::1"
    }
}
```

---

## Relay

接任意上游。进 `/relayFE`，填 URL + API Key，选协议类型（`openai` / `responses` / `anthropic`），设为活跃。

| 上游 | Base URL | 协议 |
| ---- | -------- | ---- |
| DeepSeek | `https://api.deepseek.com` | `openai` |
| OpenAI | `https://api.openai.com` | `openai` |
| 本代理的 CodeBuddy | `http://127.0.0.1:3088/codebuddy` | `openai` |

需要代理的上游在「代理」字段填 `http://` / `https://` / `socks5://`。

不同上游的模型名不一样，可以在上游配置里设**模型映射表**，把 Claude Code 请求的模型名转成上游认识的名字。也可以开「模型自动」，没匹配上的全转到默认模型。

```json
{
    "env": {
        "ANTHROPIC_AUTH_TOKEN": "sk-xxx",
        "ANTHROPIC_BASE_URL": "http://127.0.0.1:3088/relay/anthropic",
        "NO_PROXY": "localhost,127.0.0.1,::1"
    }
}
```

---

## 端点一览

三个后端前缀通用：`/codebuddy` · `/copilot` · `/relay`。

| 路径 | 说明 |
| ---- | ---- |
| `/v1/chat/completions` | OpenAI Chat 格式 |
| `/v1/responses` | OpenAI Responses 格式，支持流式 reasoning |
| `/v1/responses/compact` | Responses 精简模式 |
| `/anthropic/v1/messages` | Anthropic Messages，Claude Code / DSH 走这条 |
| `/v1/models` · `/anthropic/v1/models` | 模型列表 |
| `/anthropic/v1/messages/count_tokens` | 本地估算，不打上游 |

---

## 环境变量

复制 `.env.example` 为 `.env`，全部可选。

| 变量 | 默认 | 说明 |
| ---- | ---- | ---- |
| `PORT` | `3088` | 监听端口 |
| `HOST` | `0.0.0.0` | 绑定地址。改 `127.0.0.1` 只允许本机访问 |
| `LOG_LEVEL` | `INFO` | `DEBUG` / `INFO` / `WARN` / `ERROR` |
| `MAX_PAYLOAD_BYTES` | `16777216` | 请求体上限，超了在解析前返回 413；`0` 不限制 |
| `ADMIN_USERNAME` | `admin` | 管理后台用户名 |
| `ADMIN_PASSWORD` | 空 | **留空就不需要密码**，公网部署务必设置 |
| `SESSION_MAX_AGE` | `86400000` | 登录有效期（毫秒） |
| `SESSION_SECRET` | 自动生成 | 多实例部署必须设成同一个值 |
| `RATE_LIMIT_MAX_ATTEMPTS` | `5` | 窗口内最多允许几次鉴权失败 |
| `RATE_LIMIT_WINDOW_MS` | `60000` | 限流统计窗口 |
| `RATE_LIMIT_BLOCK_MS` | `300000` | 触发后封多久 |
| `CLUSTER_PORTS` | 同 `PORT` | 各 worker 端口，集群模式由 PM2 注入 |
| `CODEBUDDY_CREDS_DIR` | `.codebuddy` | 凭证存放目录 |
| `CODEBUDDY_ENTERPRISE_HOSTS` | 空 | 企业站域名，逗号分隔 |
| `CODEBUDDY_IDLE_TIMEOUT_MS` | `300000` | 流空闲多久算卡死，`0` 关闭 |
| `CODEBUDDY_BREAKER_WINDOW_MS` | `600000` | 熔断的"连续"判定窗口 |
| `CODEBUDDY_SOFT_WINDOW_MS` | `1800000` | 软冷却的"连续"判定窗口 |
| `RELAY_CREDS_DIR` | `.relay` | 凭证存放目录 |
| `NODE_TLS_REJECT_UNAUTHORIZED` | 未设置 | 设 `0` 跳过 TLS 校验，**仅调试用** |

---

## 部署

```bash
npm start        # 跑起来
npm run dev      # 开发，改代码自动重启
npm run debug    # 输出 DEBUG 日志
npm test         # 跑测试
```

**PM2**

```bash
pm2 start ecosystem.config.cjs && pm2 save && pm2 startup
```

集群（4 个 worker + Nginx）：

```bash
pm2 start ecosystem.cluster.config.cjs && pm2 save && pm2 startup
```

Nginx 配置见 [docs/nginx-cluster.md](docs/nginx-cluster.md)。

> 纯轮询的 Nginx 下，同一会话会被分到不同 worker，会话粘性命中率大约只有 `1/worker数`。需要完整粘性的话，在 Nginx 层按 `$http_x_conversation_id` 做一致性哈希，或者直接用单实例。

**健康检查**

```bash
curl http://127.0.0.1:3088/health
```

不需要鉴权，返回是否就绪、各后端状态。不包含任何凭证信息。状态码永远是 200，就绪情况看 `ready` 字段。

**开机自启（Windows）**

```bash
npm run startup:enable
npm run startup:status
npm run startup:disable
```

---

## 常见问题

**连不上 3088** — 服务还在跑吗？客户端的 `NO_PROXY` 加了吗？

**401 认证失败** — Key 填的是面板里生成的 `sk-xxx`，不是 CodeBuddy 账号密码。

**404 / 路径对不上** — Claude Code 和 DSH 的 Base URL 结尾**不要**带 `/v1`；Codex 要走 `/codebuddy/v1`。搞反了就会 404。

**Copilot 说模型不可用** — 出口地区问题，Claude 系列需要非国内节点。

**一直返回 402** — 账号余额不足，已自动冷却到次日 04:00。去面板看余额，或者换一个号。

**某个模型一直 400** — `6004` 或 `11102` 表示这个模型现在用不了。换模型，别重试。

**响应很久但没断** — 推理模型在慢慢吐 thinking token。只要 300 秒内有数据就不会被中断，嫌不够可以调大 `CODEBUDDY_IDLE_TIMEOUT_MS`。

**集群下会话粘性不生效** — 轮询型 Nginx 会把同一会话分到不同 worker。做会话亲和，或者改用单实例。

**成长中心连登天数一直是 0** — 连登看的是成长中心的活跃热力，和签到（发积分）是两套体系。活跃只能由官方客户端上报点亮，代理不做这件事，所以连登不会涨。签到和积分照常工作。想在成长中心攒连登，用官方客户端正常聊。

---

## 安全

- 凭证存在被 `.gitignore` 排除的目录里（`.codebuddy/` `.copilot/` `.relay/` `.gateway/`），不会进仓库
- 密码和网关 Token 用常量时间比较，防时序攻击
- `/health` 不含任何凭证
- 管理后台默认不需要密码，公网部署前务必设置 `ADMIN_PASSWORD`

## 免责声明

通过逆向客户端接口实现协议转换，上游接口都不是官方公开的，随时可能变。请自行评估风险、遵守各服务的使用条款，仅用于个人学习与自用。

## License

[MIT](LICENSE)
