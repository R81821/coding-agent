# 本地安全测试与修复记录

日期：2026-10-04（Asia/Shanghai）。目标：当前 `D:\qweai` 工作区。

本轮采用源码审查、临时目录中的漏洞复现、本机 HTTP 服务、权限回归测试和依赖公告审计。测试没有读取真实用户凭据，没有对第三方站点执行攻击，也没有调用付费模型。原有未提交的功能改动已保留。

## 已确认并修复的问题

严重性为本项目威胁模型下的定性判断，未计算 CVSS。

| 编号 | 严重性 | 修复前证据和影响 | 修复 |
| --- | --- | --- | --- |
| SEC-01 | 高 | 授权 `npm test` 后，权限引擎放行 `npm test; echo unexpected`、管道、换行、命令替换和重定向，也把 `npm test-malicious` 当成匹配命令。可在已批准前缀后追加未审批的 shell 行为。 | 引擎与工具层共用命令匹配函数；要求参数边界；包含复杂 shell 语法时只能匹配明确批准的完整命令。普通参数仍可复用授权。 |
| SEC-02 | 高 | `node -` 已获授权时，改变 `stdin` 脚本仍被引擎自动放行。解释器授权因此覆盖了未经审阅的新程序。 | 非空 terminal stdin 始终要求对本次脚本内容的一次性批准。 |
| SEC-03 | 中 | `list_files` 和 `search_files(mode=name)` 接受绝对 glob，测试实际返回工作区同级 `private.txt` 的路径。影响为越界目录/文件名枚举，未将其误报为文件内容读取。 | 共享 glob 校验拒绝绝对路径、驱动器路径、父目录穿越和绝对模式分支。保留符号链接禁用选项，并测试目录链接、相对路径及扩展名模式。 |
| SEC-04 | 高 | 插件获准读取 `allowed` 后，通过其中指向未授权目录的 junction 成功读出测试文件 `fixture secret`。 | 同时校验词法路径和解析链接后的真实路径；只打开被授权的普通文件；在读取阶段限制为 1 MB。 |
| SEC-05 | 高 | 本地 HTTP 测试中，已授权 IP 的 302 响应跳转到未授权 `localhost` 后仍返回目标正文。私网 IPv4 映射 IPv6 等地址也被错误判定为公开地址。 | 禁止自动重定向；连接直接使用已验证的 DNS 结果，取消原先检查后再次解析的窗口；补充私网、链路本地、组播及保留地址判断；响应读取限 1 MB、请求限 30 秒。 |
| SEC-06 | 中 | `expiresAt: "invalid"` 被当成仍有效的授权，因为无效时间的比较返回 false。 | 只有能解析且晚于当前时间的到期值才可通过。 |

SEC-01 至 SEC-03、SEC-06 的首轮回归测试修复前有 14 项失败；插件测试修复前有 8 项失败，包括真实目录链接读取和真实跨域重定向。最终新增 40 项安全测试，包含允许场景与拒绝场景。DNS 重绑定修复通过受控解析结果和实际连接到回环地址的拒绝测试验证，未对公网实施重绑定攻击。

主要实现位于 `packages/core/src/security.ts`、`packages/tools/src/grants.ts`、`packages/tools/src/paths.ts`、`packages/extensions/src/plugins.ts` 和新增的 `packages/extensions/src/plugin-network.ts`。

## 依赖与交付链修复

- `sharp` 更新至 0.35.5，`fastify` 更新至 5.12.5，修复 `fast-uri` 的两个主版本分支。
- Electron 从 37.3.1 固定升级到 41.10.6，并同步更新 Windows 打包脚本的版本及官方 SHA-256；脚本新增包版本一致性检查。[Electron 41.10.6 官方发布说明](https://releases.electronjs.org/release/v41.10.6)包含沙箱继承和跨源协议处理等修复。
- 校验过的 Windows x64 压缩包 SHA-256：`5447c50d196c2227e396716ea969869c1e5baa12b6af7fb33f75ae897a6853aa`，来自[官方校验文件](https://github.com/electron/electron/releases/download/v41.10.6/SHASUMS256.txt)。
- Vitest 更新到 4.1.11；为新版本显式排除缓存和构建目录，避免把缓存副本当成项目测试执行。
- 使用版本限定的覆盖项修复 `ejs`、`semver`、`esbuild`、`undici`、`joi`、`brace-expansion`、`http-cache-semantics` 和 `ini` 的受影响分支。
- `braces` 当时没有修复版本，存在[深层模式栈耗尽公告](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm)。已用 `tinyglobby` 替换 `fast-glob`，从依赖树移除这条脆弱链；同时保留长度、分组数量、嵌套和展开数量限制。迁移显式关闭目录自动展开，保留原有文件匹配语义。

生产依赖初次审计发现 15 条公告；生产依赖升级后，扩大到全部依赖又发现 71 条公告。最终完整审计覆盖 972 项依赖，所有严重级别的已知公告均为 0。两个初始数字来自不同阶段和范围，不能相加作为漏洞数量。

## 验证方式

最终结果：110 个测试文件、700 项测试全部通过；`pnpm typecheck`、`pnpm build`、修改文件的 ESLint 和 `git diff --check` 通过。完整依赖审计为 0 条已知公告。构建仍有原有的大包体积和第三方纯函数注解提示，不影响构建成功。

```powershell
pnpm typecheck
pnpm test
pnpm build
pnpm audit --json --registry=https://registry.npmjs.org
pnpm exec vitest run tests/security-regression.test.ts tests/plugin-security-regression.test.ts tests/plugin-network.test.ts
```

已执行真实 Windows Electron 隐藏窗口测试：41.10.6 启动成功，WebContentsView 正常加载本地测试页面，隔离渲染器中的 `typeof process` 为 `undefined`。已对 PNG、JPEG、GIF、WebP 执行原生图片解码、旋转、编码和元数据检查。

全仓 lint 在本轮修改前已有的三个文件中仍有 8 项规则错误：`apps/desktop/src/components/McpView.test.tsx` 的未使用变量 6 项，`apps/web/src/lib/demo.ts` 的 prefer-const 1 项，`packages/extensions/src/mcp-service.ts` 的 no-this-alias 1 项。本轮修改的 TypeScript/JavaScript 文件单独 lint 通过。

为完成回归，同时同步了两处原有功能变更后的过期测试预期：只读工具列表中的 `workspace_diff`，以及会话条目的 `usage`/`chainUsage`。没有删除断言或修改这些功能的实现。

## 范围与兼容性说明

- 复杂 shell 命令和 stdin 脚本可能比以前更频繁要求审批；这是收紧授权边界的预期行为。命令前缀授权仍意味着用户信任该程序及其普通参数，不能代替操作系统沙箱。
- 插件网络代理不再跟随重定向。对显式 IP 的精确授权仍可允许该 IP；以域名授权时，非公开 DNS 地址被拒绝。
- 本轮未进行真实 PostgreSQL Gateway 部署的并发预算测试、生产反向代理配置测试或已发布安装包的安装/卸载测试；未重新发布应用。已有安装包不会因源码修复自动更新。
- 依赖审计零告警只表示所查询公告库未报告当前依赖版本的问题，不代表整个应用不存在其他漏洞。本次路径检查也不是针对恶意本机同权限进程的完整文件系统竞争防御。
