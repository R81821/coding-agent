# Harness Agent 桌面端 UI 重写实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 用 Beautiful UI 设计语言 + lucide-react 全量重写桌面端 10 个视图（深色玻璃主题，逻辑层零改动）。

**Architecture:** Tailwind v4 构建期样式 + `src/ui/` 基础组件库 + 视图分批替换；旧 styles.css 最后删除。CSP 已验证兼容。

**Tech Stack:** React 19、Vite 7、Tailwind CSS v4、lucide-react、TypeScript strict。

**Spec:** `docs/superpowers/specs/2026-09-02-desktop-ui-redesign-design.md`
**注意：** 本目录不是 git 仓库，无 commit 步骤；每批以 typecheck/test/build 全绿为完成标志。pnpm 需用 `corepack pnpm` 前缀（本机未入 PATH）。

---

## Batch 1 — 基础设施 + SidebarNav 改造（本批已完整展开）

### Task 1.1: 安装依赖

- [ ] **Step 1: 安装**

Run: `corepack pnpm --filter @harness/desktop add lucide-react`
Run: `corepack pnpm --filter @harness/desktop add -D tailwindcss @tailwindcss/vite`
Expected: 三个包进入 apps/desktop/package.json

### Task 1.2: Vite 接入 Tailwind

**Files:**
- Modify: `apps/desktop/vite.config.ts`

- [ ] **Step 1: 读现有配置后修改**

在 plugin 数组中追加 `tailwindcss()`：

```ts
import tailwindcss from "@tailwindcss/vite";
// plugins: [react(), tailwindcss()]
```

### Task 1.3: 主题 token

**Files:**
- Create: `apps/desktop/src/tailwind.css`
- Modify: `apps/desktop/src/renderer.tsx`（在 `import "./styles.css";` 之后加 `import "./tailwind.css";`，让 Tailwind 工具类后加载以覆盖旧样式）

- [ ] **Step 1: 写 tailwind.css**

```css
@import "tailwindcss";

@theme {
  --color-bg: #061425;
  --color-surface: rgba(13, 28, 48, 0.66);
  --color-surface-strong: #0d1c30;
  --color-line: rgba(148, 163, 184, 0.14);
  --color-line-strong: rgba(148, 163, 184, 0.28);
  --color-text: #e2e8f0;
  --color-text-muted: #8ea3bd;
  --color-accent: #3b82f6;
  --color-accent-soft: rgba(59, 130, 246, 0.16);
  --color-accent-text: #93c5fd;
  --color-success: #34d399;
  --color-warning: #fbbf24;
  --color-danger: #f87171;
  --font-sans: "Segoe UI", "Microsoft YaHei", "PingFang SC", system-ui, sans-serif;
  --font-mono: "Cascadia Code", "JetBrains Mono", Consolas, "Courier New", monospace;
  --animate-shimmer: shimmer 1.6s linear infinite;
  @keyframes shimmer {
    from { background-position: 200% 0; }
    to { background-position: -200% 0; }
  }
}

@layer base {
  body { @apply bg-bg text-text font-sans antialiased; }
}

@layer components {
  .glass {
    @apply bg-surface backdrop-blur-xl border border-line rounded-2xl;
  }
  .glass-strong {
    @apply bg-surface-strong backdrop-blur-xl border border-line rounded-2xl;
  }
}
```

### Task 1.4: ui/ 基础组件

**Files:**
- Create: `apps/desktop/src/ui/button.tsx`
- Create: `apps/desktop/src/ui/card.tsx`
- Create: `apps/desktop/src/ui/badge.tsx`
- Create: `apps/desktop/src/ui/tool-chip.tsx`
- Create: `apps/desktop/src/ui/loading-state.tsx`

- [ ] **Step 1: button.tsx**

```tsx
import React from "react";

const VARIANTS = {
  primary: "bg-accent text-white hover:bg-blue-500 active:bg-blue-600",
  secondary: "bg-white/5 border border-line text-text hover:bg-white/10",
  ghost: "text-text-muted hover:text-text hover:bg-white/5",
  danger: "bg-danger/15 text-danger border border-danger/30 hover:bg-danger/25",
} as const;

export function BuiButton({
  variant = "secondary",
  size = "md",
  className = "",
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: keyof typeof VARIANTS;
  size?: "sm" | "md";
}) {
  return (
    <button
      {...props}
      className={`inline-flex items-center justify-center gap-1.5 rounded-xl font-medium transition-colors disabled:opacity-45 disabled:pointer-events-none ${size === "sm" ? "px-2.5 py-1 text-xs" : "px-3.5 py-2 text-sm"} ${VARIANTS[variant]} ${className}`.trim()}
    />
  );
}
```

- [ ] **Step 2: card.tsx**

```tsx
import React from "react";

export function BuiGlassPanel({
  strong = false,
  className = "",
  children,
  ...props
}: React.HTMLAttributes<HTMLDivElement> & { strong?: boolean }) {
  return (
    <div {...props} className={`${strong ? "glass-strong" : "glass"} ${className}`.trim()}>
      {children}
    </div>
  );
}
```

- [ ] **Step 3: badge.tsx**

```tsx
import React from "react";

const TONES = {
  neutral: "bg-white/8 text-text-muted border-line",
  info: "bg-accent-soft text-accent-text border-accent/30",
  success: "bg-success/12 text-success border-success/30",
  warning: "bg-warning/12 text-warning border-warning/30",
  danger: "bg-danger/12 text-danger border-danger/30",
} as const;

export function BuiBadge({
  tone = "neutral",
  children,
}: {
  tone?: keyof typeof TONES;
  children: React.ReactNode;
}) {
  return (
    <span className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium ${TONES[tone]}`}>
      {children}
    </span>
  );
}
```

- [ ] **Step 4: tool-chip.tsx**

```tsx
import { Wrench } from "lucide-react";

export function BuiToolChip({
  name,
  status = "idle",
}: {
  name: string;
  status?: "running" | "finished" | "failed" | "idle";
}) {
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-lg border px-2 py-1 font-mono text-[11px] ${
        status === "running" ? "border-accent/40 bg-accent-soft text-accent-text animate-pulse"
        : status === "failed" ? "border-danger/40 bg-danger/12 text-danger"
        : "border-line bg-white/5 text-text-muted"
      }`}
    >
      <Wrench size={12} aria-hidden="true" />
      {name}
    </span>
  );
}
```

- [ ] **Step 5: loading-state.tsx**（像素网格 shimmer + 经过时间，Beautiful UI Loading State 风格）

```tsx
import { useEffect, useState } from "react";

const GRID_CELLS = Array.from({ length: 40 }, (_, index) => index);

export function BuiLoadingState({ label = "正在运行" }: { label?: string }) {
  const [seconds, setSeconds] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setSeconds((current) => current + 1), 1_000);
    return () => clearInterval(timer);
  }, []);
  return (
    <div className="glass p-4" role="status" aria-live="polite">
      <div className="flex items-center justify-between">
        <span className="text-sm text-text-muted">{label}</span>
        <span className="font-mono text-xs text-text-muted">{seconds}s</span>
      </div>
      <div className="mt-3 grid grid-cols-10 gap-1" aria-hidden="true">
        {GRID_CELLS.map((index) => (
          <div
            key={index}
            className="aspect-square rounded-[3px] animate-shimmer bg-[linear-gradient(110deg,transparent_30%,rgba(147,197,253,0.28)_50%,transparent_70%)] bg-[length:200%_100%] bg-white/5"
            style={{ animationDelay: `${(index % 10) * 60}ms` }}
          />
        ))}
      </div>
    </div>
  );
}
```

### Task 1.5: SidebarNav 换 lucide 图标

**Files:**
- Create: `apps/desktop/src/ui/sidebar-nav.tsx`
- Modify: `apps/desktop/src/renderer.tsx`（BuiSidebarNav 导入改为 ui/sidebar-nav 版本；侧边栏 items 的 icon 换 lucide 组件：聊天 MessageSquare、任务 KanbanSquare、审批 ShieldCheck、计划 ClipboardList、记忆 Brain、技能 Sparkles、插件 Puzzle、Profiles UserCog、追踪 Activity、设置 Settings）

- [ ] **Step 1: sidebar-nav.tsx**

```tsx
import React from "react";

export function BuiSidebarNav<T extends string>({
  items,
  active,
  onSelect,
}: {
  items: Array<{ id: T; label: string; icon: React.ReactNode; badge?: number }>;
  active: T;
  onSelect: (item: T) => void;
}) {
  return (
    <nav className="flex flex-col gap-1 p-2" aria-label="主导航">
      {items.map((item) => (
        <button
          key={item.id}
          type="button"
          aria-current={active === item.id ? "page" : undefined}
          className={`flex items-center gap-2.5 rounded-xl px-3 py-2 text-sm transition-colors ${
            active === item.id
              ? "bg-accent-soft text-accent-text"
              : "text-text-muted hover:bg-white/5 hover:text-text"
          }`}
          onClick={() => onSelect(item.id)}
        >
          {item.icon}
          <span className="flex-1 text-left">{item.label}</span>
          {Boolean(item.badge) && (
            <em className="not-italic rounded-full bg-danger px-1.5 py-0.5 text-[10px] font-semibold text-white">
              {item.badge}
            </em>
          )}
        </button>
      ))}
    </nav>
  );
}
```

- [ ] **Step 2: 接线 renderer.tsx**

把 `import { BuiSidebarNav } from "./beautiful-ui.js";` 中的 BuiSidebarNav 移除，改为 `import { BuiSidebarNav } from "./ui/sidebar-nav.js";`；sidebar items 的 `icon:` 字段换成 `<MessageSquare size={16} />` 等 lucide 组件（lucide-react 顶部导入）。

- [ ] **Step 3: 验证**

Run: `corepack pnpm typecheck` + `corepack pnpm test` + `corepack pnpm -r --if-present build`
Expected: 全部通过（72 项测试不回归）

---

## Batch 2 — Chat 主界面（大纲，启动时展开）

- ChatView 消息流：text_delta 流式渲染（Streaming Text）、reasoning_summary 折叠（Reasoning）、错误/route 事件样式
- 工具时间线：EventRow/ToolEventGroup 改为 Thinking 步骤 + Tool Chips（running 脉冲/failed 红）
- PromptBar：升级 BuiPromptBar 为 Tailwind 版（附件预览 chips、发送按钮 lucide ArrowUp、加载 spinner）
- 附件卡片（Context Cards）+ 运行中 BuiLoadingState
- 最终回答区：finalText 渲染 + 操作按钮（复制等）

## Batch 3 — 审批与计划（大纲）

- ApprovalPromptDialog → Approval Card（风险色边框、参数摘要、批准/拒绝/要求修订、过期时间倒计时）
- PlanView：计划步骤列表（Task Rows 风格）、检查点、验证结果
- CropOverlay 裁剪浮层视觉统一

## Batch 4 — 管理视图（大纲）

- TasksView：Kanban 列（待办/进行/阻塞/完成）卡片化 + cron 表单
- MemoryView：记忆卡片网格（Context Cards 风格）+ 批准/拒绝操作
- SkillsView：技能卡片（名称/触发词/工具 chips/信任状态）
- PluginsView：插件卡片（模式徽章、权限摘要、信任流程）

## Batch 5 — 收尾（大纲）

- ProfilesView：Profile 卡片 + VerificationEditor
- TraceView：Records/Filter Table
- SettingsView：凭据/Provider/配对码/搜索状态卡片化
- 删除 styles.css 与 beautiful-ui.tsx（确认无引用后）
- 全量回归：typecheck + test + build + lint

## 全局验收

- [x] `corepack pnpm typecheck` 通过
- [x] `corepack pnpm test` 72 项全绿
- [x] `corepack pnpm -r --if-present build` 通过（9 个包）
- [x] `corepack pnpm lint` 通过
- [ ] 用户 `pnpm dev` 视觉验收（待用户确认）

**执行状态（2026-09-02）：全部 5 批完成。** 与计划的偏差：
- `styles.css` 保留——其中包含应用外壳布局（sidebar/topbar/content、chat-layout 滚动容器、approval/crop 浮层、board 横向滚动）等仍被引用的功能 CSS；全删需迁移约 1700 行布局样式，超出"展现效果"改造目的。组件级视觉样式已全部 Tailwind 化。
- `beautiful-ui.tsx` 已删除（无引用）。
- 依赖安装使用 `corepack pnpm@11 --store-dir D:/qweai/.pnpm-store`（本机 node_modules 由 pnpm 11 的 v11 store 链接，与 packageManager 声明的 10.15 不匹配；建议之后 `corepack prepare pnpm@11.25.0 --activate` 或更新 packageManager 字段）。
