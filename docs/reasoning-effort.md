# 对话栏推理强度

模型由已有 Provider 设置和 Profile 路由决定。对话栏 Auto 左侧原样显示设置中的模型 ID、紫色推理强度和展开箭头；不使用显示名称或美化大小写、空格，这里不提供模型选择，也不覆盖模型设置。设置保存并重载运行时后，会刷新当前模型信息，无须重新加载界面。

点击按钮只展开紧凑的无外框倒三角，三个角均为圆角，四档从上到下为 Ultra、High、Medium、Low，文字纵向等距排列。没有默认档、底部空格或档位横线；整个三角始终使用从上到下的橙红紫渐变背景，选中档位字体为 `#1c33e3`，选择不改变背景。渐变背景内有错开循环的流星，装饰层不接收点击并裁切在圆角三角内；关闭弹层时卸载。弹出时采用 460ms 的史莱姆拉伸回弹动效，启用减少动态效果时停用动画和流星。弹层在欢迎页面不会越过四个入口卡片的下沿。

模型支持 `xhigh` 时，Ultra 发送 `xhigh`；只支持 `max` 时发送 `max`。不支持的档位禁用，不发送猜测的参数。尚未选择强度的历史会话显示“推理”，保留原有 Provider 参数。

选择以 `SessionRecord.reasoningEffort` 保存，启动运行时冻结为 `RunSpec.reasoningEffort`。`null` 明确表示默认，未填写时继承会话值；子任务、暂停恢复和继续运行继承原运行的强度。运行和暂停期间不能通过对话栏更改强度。

推理强度不参与模型评分或候选过滤。路由先按照原有设置选择模型，再校验模型是否支持指定强度；不支持时提供修正信息，不自动改用另一模型。摘要压缩请求不继承主请求的推理强度。

## 参数与兼容性

- OpenAI Responses：`reasoning.effort`。
- OpenAI Chat：`reasoning_effort`；已知 OpenAI 推理模型使用 `max_completion_tokens`，兼容模型保留原来的输出上限字段。
- Claude：`output_config.effort`，不额外开启需要新历史格式的 adaptive thinking。
- Gemini 3：`generationConfig.thinkingConfig.thinkingLevel`。现有 Gemini 2.5 GenerateContent 接口不提供等级映射。
- 未知模型别名保留 Provider 默认参数，不推测其支持等级。

依据：[OpenAI 推理参数](https://developers.openai.com/api/docs/guides/reasoning)、[Chat 输出上限](https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create)、[Claude effort](https://platform.claude.com/docs/en/build-with-claude/effort)、[Gemini thinking](https://ai.google.dev/gemini-api/docs/generate-content/thinking)、[DeepSeek thinking](https://api-docs.deepseek.com/guides/thinking_mode/)。

## 验证入口

`tests/reasoning-effort-*.test.ts` 验证持久化、默认值、路由保持原选择、主请求、摘要压缩和恢复继承；`tests/provider-reasoning.test.ts` 检查各 Provider 实际发送的请求体。

桌面交互测试保存在 `apps/desktop/scripts/model-reasoning-ui-test.cjs`。先构建桌面，再运行：

```powershell
pnpm --filter @harness/desktop build
pnpm --filter @harness/desktop exec cross-env NODE_OPTIONS= electron scripts/model-reasoning-ui-test.cjs
```

该文件运行真实桌面渲染器，`harness:request` 经过生产 `sanitizeRendererRequest` 白名单校验后进入隔离的 fixture daemon，覆盖模型读取、推理强度保存以及未授权方法拒绝。它同时检查无模型选择块、透明弹层、点击提交、键盘关闭、失败反馈、切换会话、重新加载、暂停锁定和运行参数。截图及检查结果写入 `.cache/model-reasoning-ui-*`；测试不连接真实 Provider。
