# 可切换界面主题

在顶部的主题下拉框，或「设置 → 外观」中选择「Kelo 玻璃」。选择立即生效，保存在当前设备；也可以随时切回「经典深色」。没有保存过选择时继续使用经典主题。

## 参考与适配

参考 [Jiro 的 AI Marketing Hero Kelo](https://jiro.build/components/header/ai-marketing-hero-kelo) 公开预览组件代码，保留大圆角、细边框与胶囊导航的结构，并按应用需求改成纯白底的浅色玻璃主题。桌面版采用原创 CSS 适配，不导入该站点的营销文案、Logo、仪表盘假数据或视频，也没有新增网络字体、视频请求或动画依赖。

主题覆盖侧栏、顶部导航、欢迎页、任务卡片、输入框、聊天消息、Markdown 代码块、设置卡片和解锁页。减少动态效果的系统设置仍然有效。

## 实现位置

- `apps/desktop/src/theme.ts`：主题目录、合法值校验、偏好读取与保存。读取失败或无效值回退为经典主题；保存失败时当前切换仍生效，并在设置中提示无法持久保存。
- `apps/desktop/src/components/ThemePicker.tsx`：带缩略预览的原生单选卡片，支持键盘操作。
- `apps/desktop/src/themes.css`：Kelo 的变量和外观覆盖。所有 Kelo 样式限定在 `html[data-theme="kelo"]`，切换回经典主题即可恢复原样式。
- `apps/desktop/src/renderer.tsx`：首次渲染前应用保存的主题，并同步设置页与顶部切换入口。

新增主题时，在 `THEMES` 中添加条目，补充对应的缩略预览和 `html[data-theme="新 ID"]` 样式；主题类型、选择列表和合法值校验会跟随目录更新。

## 本次验证（2026-09-13）

已在真实构建后的 Electron 渲染器中，使用隔离的测试资料验证：主题切换、纯白画布与输入框、历史聊天、新建会话、1200×800 紧凑窗口、可调整侧栏、居中输入区和模式标签。未启动真实 daemon，未读取实际应用口令和会话。

验证截图位于 `.cache/theme-kelo/`：`kelo-workbench.png`、`kelo-settings.png`、`kelo-conversation.png`、`kelo-compact.png`，其中内容均为测试资料。

主题已经接入源码和桌面构建。
