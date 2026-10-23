# 模型配置与提示词系统

模型设置中的“提示词系统”与 API 地址、模型 ID 一起保存。“保存并重载”重建后台运行时，Provider 在创建时绑定提示词后端，后续请求不再检测地址或全局启停插件。

| 设置 | 生效方式 |
| --- | --- |
| 自动选择 | 官方 HTTPS `api.deepseek.com` 根地址或 `/v1` 使用 `dsh`；其他地址使用原有 `harness` |
| 原有 Harness | 强制使用原有提示词实现 |
| DeepSeek Harness | 强制使用 dsh，适用于第三方 DeepSeek 代理或网关 |

只凭模型名称不自动切换。保存文件包含选择值 `promptBackend` 和解析值 `resolvedPromptBackend`；载入或再次保存时重新计算解析值，不信任输入中已有的解析结果。旧配置默认使用自动选择。

每个 Provider 独立绑定后端。启用多个服务时，实际路由到哪个 Provider，就使用其已绑定的实现。每个任务拥有独立的组装器与生命周期，并发任务不会互相修改注册表。

## dsh 集成

采用原版 `@deepseek-ai/dsh-system-prompt@0.2.1-rc.2` 与 `@deepseek-ai/cordis@4.0.5`。适配依据 DeepSeek Harness 源码 `687f282e8625c6b8d11ff58211a90524be2e4317` 的 `packages/core/system-prompt`，无需在部署机器上保留参考仓库。

dsh 是注册和组装框架。现有安全规则、Profile、工具与工作流指导注册为本应用的贡献，不会因为安装组装器而变成另一套工具协议。系统和开发者段经过其 section 注册表，上下文经过 context 注册表，可用工具经过 tools 注册表。适配后保留原有消息角色、信任标签、附件以及工具的验证、风险、幂等性和超时契约。用户、项目、技能和工具文本不执行模板插值，包含 `{{...}}` 的原文保持不变。

现代任务从首轮固定一份系统指导前缀，同一轮的计量、发送和重试共同使用该策略快照。自动／修改模式预加载带适用条件的实施与任务图参考，不因加载参考而给咨询、只读调查或小改动增加任务图、编辑与无关验证义务；显式分析模式不加载实施／任务图段。建立任务图、首次编辑和恢复都不会按阶段增删系统段。当前 intent、任务图、验证和授权状态通过末尾运行时上下文更新，不通过改写头部系统指导传递。legacy v1 检查点保留原提示词版本约定。

动态运行时状态通过 dsh 的 required context 刷新，再交给原有 `base_snapshot` / `dirty_diff` 历史机制。缓存身份包含 dsh 适配版本；恢复或切换配置时不保留旧 system/developer 消息。部署新提示词本身仍可能有一次冷缓存；这里避免的是同一任务中仅因阶段变化而反复破坏前缀，不保证服务端实际缓存命中率。

主对话、压缩摘要、记忆提取和 MCP sampling 都使用所选组装后端。后三者保留各自的任务说明、输出约定与工具隔离；不会注入主对话的编码指导。压缩、记忆和 sampling 在实际输入预算检查之前完成组装。

## 环境配置

CLI、daemon 和 gateway 可使用对应 Provider 的变量：

- `OPENAI_PROMPT_BACKEND`
- `ANTHROPIC_PROMPT_BACKEND`
- `GEMINI_PROMPT_BACKEND`
- `OPENAI_COMPATIBLE_PROMPT_BACKEND`
- `HARNESS_GATEWAY_PROMPT_BACKEND`

值为 `auto`、`harness` 或 `dsh`，未配置时默认 `auto`。桌面应用把保存后的解析值传给 `OPENAI_COMPATIBLE_PROMPT_BACKEND`。此选择独立于 API 协议和服务端思考参数，不会因为代理使用 dsh 而自动发送仅官方支持的请求字段。

现有“保存并重载”会停止旧后台，正在运行的任务也会受到重启影响。切换不会修改已存储的历史内容或全局 Profile 文本。
