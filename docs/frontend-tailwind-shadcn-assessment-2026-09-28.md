# Tailwind + shadcn/ui 前端覆盖率评估

日期：2026-09-28。范围：当前工作区 `apps/desktop/src`，包含未提交改动；排除测试、预览、构建产物。评估对象是 Electron 的 React 渲染层，不包含 daemon、协议、持久化或 Agent 引擎。

## 结论

推荐渐进统一。Tailwind 已有基础，最值得改进的是主题变量与 CSS 层级，以及重复实现的表单和交互控件。

按界面职责评估，Tailwind 适合承接约 80–90% 的通用布局与视觉样式，shadcn/ui 适合承接约 70–85% 的通用控件职责。这是阅读代码后的迁移规划估计，不是实测完成率，不表示能替换相同比例的前端代码或业务逻辑。两项分母不同，不能相加。

## 实测现状与口径

使用 TypeScript AST 遍历生产 TSX 的 JSX 标签和属性；抽取 `className` 中可静态读取的字符串与模板片段，再由已安装 Tailwind 的 design system 校验候选工具类。动态传入类名、间接组件样式、`@apply` 不计入直接工具类命中。

| 指标 | 结果 |
| --- | ---: |
| 生产 TSX 文件 | 28 |
| TSX 总行数，含空行 | 4,433 |
| 含至少一个有效 Tailwind 工具类的 TSX 文件 | 15/28，53.6% |
| 直接使用工具类或使用 Bui 组件的文件 | 16/28，57.1% |
| JSX `className` 属性 | 559 |
| 含至少一个有效工具类的 `className` 属性 | 278/559，49.7% |
| 自定义 CSS 文件 | 13，共 2,851 行 |
| `BuiButton` 使用点 | 78 |
| 原生 `button` 声明 | 45，包含基础组件内部 |
| 原生 input / select / textarea | 34 / 12 / 10 |
| 原生 details / dialog / table | 13 / 2 / 4 |
| 明确可识别的 shadcn/ui 接入 | 0：未发现 components.json、相关原语依赖或生成组件 |

这些是源码出现次数；列表中一个 JSX 元素在运行时可能生成多项。一个 `sr-only` 就能让文件计入“使用 Tailwind”，因此 49.7% / 53.6% 不能解释为视觉像素覆盖率。直接工具类比例也不反映它是否被全局 CSS 覆盖。

现有依赖为 React 19.1.1、Vite 配置、Tailwind 4.3.3 和 `@tailwindcss/vite`，已有 Lucide 图标。官方提供 [Vite 接入流程](https://ui.shadcn.com/docs/installation/vite) 和 [Tailwind v4 / React 19 说明](https://ui.shadcn.com/docs/tailwind-v4)，无需为接入组件库更换应用框架。

## 按界面职责估算

以下比例是每个模块中可由标准组件和工具类承担的展示/交互职责范围，包含必要的样式与事件适配；不是直接复制组件后就能完成的比例。

| 区域 | 可优化范围估计 | 推荐组件 | 仍需由项目维护 |
| --- | --- | --- | --- |
| 设置、Profile、验证配置、MCP 表单 | 85–95% | Field、Input、Textarea、Native Select/Select、Checkbox、Switch、Card、Tabs | 校验、凭据保存、异步操作、RPC |
| 技能、插件、记忆、回收站管理 | 75–90% | Card、Badge、Button、Dialog、Alert Dialog、Empty | 信任流程、权限、安装、恢复与删除语义 |
| 弹窗、菜单、帮助提示 | 80–90% | Dialog、Alert Dialog、Menubar、Dropdown Menu、Tooltip、Popover | 全局快捷键、异步锁、失败重试、关闭时机 |
| 项目导航和侧栏 | 65–80% | Sidebar 结构、Collapsible、Button、Tooltip | 分组、历史分页、当前会话、拖拽宽度、持久化 |
| 消息输入区 | 50–65% | Textarea、Input Group、Dropdown Menu、Popover | 中文输入法、回车发送、图片粘贴、附件、发送/暂停/继续 |
| 对话过程和结果展示 | 35–55% | Collapsible、Badge、Alert、Progress；评估 Message 外壳 | 流式事件、过程/结果划分、Markdown、安全链接、自动滚动 |
| 差异审查和内置浏览器 | 15–35% | Toolbar、Tabs/Toggle Group、Select、Button、Resizable | diff 算法、行号对应、撤销、Electron 浏览器宿主 |
| 小灰嘎动画和桌面原生能力 | 很低 | 仅外围布局可用工具类 | 帧动画、系统拖拽区、IPC、窗口与截屏行为 |

组件名称参考 [shadcn 官方目录](https://ui.shadcn.com/docs/components)。当前目录也提供 [Message](https://ui.shadcn.com/docs/components/base/message) 和 [Message Scroller](https://ui.shadcn.com/docs/components/base/message-scroller)，可以评估其外壳；项目自身的流式事件与滚动策略仍需要逐项适配。

## 优先解决的具体问题

### 1. 主题变量含义冲突

项目同时使用 `--bg/--panel/--muted` 和 `--color-bg/--color-surface/--color-text-muted` 两组变量。
`themes.css:43` 为 Kelo 定义深色主题，`:135` 再以同一个选择器定义浅色主题，后面的规则覆盖前面。`theme.ts` 中 Kelo 的描述也仍是“墨黑光晕”。

尤其要注意：项目的 `--muted` 当前表示文字颜色；shadcn 的 `--muted` 表示柔和背景，文字对应 `--muted-foreground`。不能直接覆盖默认变量。`--accent` 也应按用途审核，而非仅按同名替换。官方变量语义见 [Theming](https://ui.shadcn.com/docs/theming)。

建议先统一 `background / foreground / card / border / primary / muted / muted-foreground / destructive` 等语义变量；将现有使用点逐步迁移，必要时保留兼容别名。保留 `data-theme=classic|kelo`，让组件暗色变体与这个属性对应，避免引入一套脱节的 `.dark` 状态。

### 2. 手写 CSS 层级会覆盖组件工具类

`renderer.tsx:90` 开始连续加载 styles、tailwind、workbench、themes。`styles.css` 对 button、nav button、input、select、textarea 有全局规则，`workbench.css` 和 `themes.css` 再追加覆盖。

仅接入 `cn()` 或 `tailwind-merge` 无法解决未分层 CSS 对工具类的覆盖。先限制旧规则作用域，再按模块整理进合适的 base/components 层；每迁移一个组件，同时退役其旧规则，避免一次移动全部 CSS 后改变整个应用。Tailwind 官方建议将需要被工具类覆盖的自定义组件样式放入 [components 层](https://tailwindcss.com/docs/adding-custom-styles)。

### 3. 利用现有 Bui 入口降低修改范围

`ui/button.tsx` 的 BuiButton 已有 78 个使用点。可先让它适配所选的 shadcn Button，保留 primary/secondary/ghost/danger 与 sm/md 的现有语义，再逐步统一调用方。danger 不应因替换而失去危险操作的视觉提示。

输入类控件仍有 56 个原生声明，是下一批标准化的主要入口。简单枚举优先保留 Native Select 的行为；长列表和搜索场景再引入 Select/Combobox。

### 4. 弹窗与桌面快捷键必须一起迁移

`DecisionDialog.tsx` 已实现焦点恢复、异步锁和错误展示；`McpView.tsx` 另外实现了原生 dialog 包装。迁移组件时应保持这些语义。

`DesktopChrome.tsx:74` 只通过 `document.querySelector("dialog[open]")` 判断是否有模态框。改成基于 Portal 的组件后，不能继续仅依赖此条件，否则模态框打开时全局快捷键可能仍执行。建议使用共享模态状态或统一的弹窗封装，并验证 Escape、Tab、焦点返回及忙碌状态。

### 5. 对话区域保留已经确认的行为

项目名点击收起/展开、隐藏箭头、单行任务、右侧状态标识、稳定滚动条、小灰嘎循环动画，均应写入迁移验收清单。Collapsible 不要求显示箭头，可以保留现有外观。

侧栏与对话的字号和字重应引用同一语义样式，避免迁移后被默认 `font-medium` 改变。Markdown、diff、精灵帧动画和 `-webkit-app-region` 等专用样式可以继续保留 CSS。

## 建议执行顺序

1. **基础统一**：清理主题覆盖；完成变量映射；补 components.json、组件路径与 Vite/TypeScript 别名；按需引入组件，确定一种原语实现。
2. **低风险试点**：升级 BuiButton / Badge / Card；迁移设置页和 MCP 表单的输入、选择与提示。同步移除迁移部分的旧 CSS。
3. **交互统一**：迁移 Dialog / Alert Dialog、输入区菜单和桌面菜单；同步处理全局快捷键及焦点行为。
4. **导航统一**：将项目组适配为无箭头的 Collapsible；评估 Sidebar 外壳，保留宽度和滚动布局。
5. **专用界面整理**：对话、diff、浏览器只迁移通用控件。随迁移拆出 `renderer.tsx` 中的设置/Profile 等视图，降低集中修改风险。

第一阶段目标应是“一个主题变量来源、统一的常规控件、选定页面通过视觉和交互回归”，而非把所有 CSS 改成 className。

验收建议覆盖：经典深色/Kelo 浅色、900×620/最大化、键盘焦点、中文输入法、异步失败、模态快捷键隔离、侧栏收起、滚动位置保持、生成状态动画。性能和包体积收益需迁移后实测；接入组件库本身不能保证更快或更小。
