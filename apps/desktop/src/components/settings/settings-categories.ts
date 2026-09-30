export const SETTINGS_CATEGORIES = [
  {
    id: "general",
    group: "个人",
    title: "常规",
    description: "管理工作台的日常设置与运行时数据。",
    keywords: "运行时 刷新 数据 Profile 任务 记忆 技能 审批",
  },
  {
    id: "appearance",
    group: "个人",
    title: "外观",
    description: "选择适合你的界面外观。",
    keywords: "主题 深色 浅色 跟随系统 Kelo",
  },
  {
    id: "credentials",
    group: "模型与服务",
    title: "模型凭据",
    description: "管理本机保存的服务密钥。",
    keywords: "Windows API Key 密钥 OpenAI Anthropic Gemini BYOK",
  },
  {
    id: "provider",
    group: "模型与服务",
    title: "兼容 API",
    description: "连接 OpenAI-compatible 模型服务。",
    keywords: "地址 URL 模型 协议 Responses Chat Completions 上下文 tokens",
  },
  {
    id: "gateway",
    group: "模型与服务",
    title: "自托管网关",
    description: "通过团队网关访问模型服务。",
    keywords: "Gateway Docker 团队 设备令牌",
  },
  {
    id: "search",
    group: "集成",
    title: "网页搜索",
    description: "配置网页检索与 GitHub 认证。",
    keywords: "Parallel Search GitHub Token 密钥",
  },
  {
    id: "messaging",
    group: "集成",
    title: "远程入口",
    description: "将消息渠道与本地工作台配对。",
    keywords: "Telegram 飞书 配对码 消息",
  },
  {
    id: "recycle",
    group: "数据",
    title: "回收站",
    description: "查看和恢复已删除的会话与项目。",
    keywords: "删除 会话 项目 恢复 清理",
  },
] as const;

export type SettingsCategoryId = (typeof SETTINGS_CATEGORIES)[number]["id"];

export function filterSettingsCategories(query: string) {
  const terms = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  return SETTINGS_CATEGORIES.filter((category) => {
    const text =
      `${category.group} ${category.title} ${category.description} ${category.keywords}`.toLocaleLowerCase();
    return terms.every((term) => text.includes(term));
  });
}
