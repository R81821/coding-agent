# 记忆管理

桌面端在「工作台工具 → 记忆」中管理记忆。可以搜索内容、来源和作用域，筛选当前项目/全部作用域及审批状态，编辑正文、设置过期时间、固定/取消固定、删除，或导出当前筛选结果。

- 修改正文会撤销旧的批准状态，保存为候选；再次点击「记住」后才能参与召回。来源和作用域不能通过正文编辑更改。
- 固定不是授权：只有已批准、未过期且属于当前 Profile 允许范围的固定记忆会优先召回；仍受每次召回条数上限约束。普通记忆按关键词匹配度排序。
- 过期时间按本地时间输入，存为 UTC；留空表示永不过期。过期候选须先更新过期时间再批准。
- 删除会同时移除加密记录和搜索索引，不能撤销；桌面端删除前会确认。
- 导出通过本地保存对话框生成明文 JSON，包含版本、导出时间、记录、来源与审批信息。单次最多 1,000 条；没有记录的筛选结果不可导出。
- 当前 Profile 的会话/项目/全局读取范围可分别开关；全部关闭时不会召回记忆。设置从下一次运行生效，不会删除现有记录。会话仅匹配当前 sessionId，项目仅匹配当前工作区，全局仅匹配 global 作用域。

CLI 也使用同一套 daemon 接口：

```text
harness-agent memory list [scopeId]
harness-agent memory edit <id> <新正文>
harness-agent memory pin <id>
harness-agent memory unpin <id>
harness-agent memory expire <id> <ISO-8601时间或never>
harness-agent memory approve <id>
harness-agent memory reject <id>
harness-agent memory delete <id>
harness-agent memory export <id> [id ...]
```

CLI 导出写至标准输出，不自动创建文件；删除命令直接执行所指定记录的删除。
