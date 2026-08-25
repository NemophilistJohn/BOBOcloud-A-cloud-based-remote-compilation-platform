# BOBOCLOUD AI Agent 云能力工具化设计与施工路线

状态：设计稿，不包含本轮 Go 服务端改动  
日期：2026-08-25  
适用范围：BOBOCLOUD 桌面客户端、插件平台、官方 AI Agent 插件

## 1. 结论

BOBOCLOUD 不应把现有云端 HTTP/WebSocket 接口直接暴露给插件，也不应让 Agent 插件读取账号令牌、服务器地址或证书配置。正确的目标结构是：

1. Electron 主进程新增受信任的 `AgentCloudBroker`，复用当前登录态、安全传输、工作区同步和运行协议。
2. 主进程建立统一的 `AgentToolRegistry`。本地文件工具、进程工具、云编译工具和未来 MCP 工具都经过同一套 schema 校验、风险分类、审批、取消、限额和审计。
3. 官方 Agent 插件只通过 `context.tools.invoke(name, input)` 调用能力；插件看不到凭据，也不能自行建立任意网络连接。
4. MCP 是统一工具注册表的兼容出口，不是新的权限中心，也不是云业务 API 的替代品。
5. 第一阶段可完全复用现有 Go API，只改本地客户端与 Plugin API。只有事件续传、结构化诊断等通用云能力确有产品价值时，才单独演进 Go 协议，服务端不得包含 Agent 提示词、规划或模型逻辑。

这保持了“AI Agent 是纯本地用户端组件”的产品边界，同时允许它安全使用用户账号已经拥有的云资源。

## 2. 当前代码基线

### 2.1 已有能力

- `server/internal/handler/http.go` 以统一 `action` 路由提供运行时、构建目标、代码运行、任务运行、取消、运行历史、环境中心、依赖中心、缓存、存储、LSP、DAP 等能力。
- `client/src/runner.js` 已完成保存脏文件、工作区版本判断、`checkFolder`、rclone 同步、`runCode`/`runTask`、一次性运行令牌、WebSocket 流、标准输出/错误输出、产物、stdin 和取消。
- `server/internal/handler/ws.go` 将运行绑定到用户和工作区，执行 Docker 任务，输出状态事件并保存最多 64 KiB 的历史摘要。
- `client/src/environment-center.js` 已采用“查询 -> 生成修复计划 -> 用户确认 -> 应用计划”的安全流程，并校验项目上下文。
- `client/src/package-center.js` 已有依赖搜索、详情、变更计划、应用、超时、计划占用和重对账语义。
- `client/main/terminal.js`、`client/terminal-transport.js`、DAP/LSP 主进程模块证明了账号凭据、安全 WebSocket 和长生命周期连接可以由主进程托管。
- `client/main/agent-platform.js` 已有 `ask`、`auto`、`full` 三档访问模式、风险级别、审批、工作区快照、插件 epoch、并发限制、取消和输出上限。

### 2.2 关键缺口

- 当前 Agent 工具只包含 `workspace_list/read/search/write` 与 `process_run`。
- 当前云运行的 HTTP 和 `/ws` 连接主要由 renderer 发起；Agent 云工具若照搬该路径，会把运行令牌和网络权力带入不受信任的插件链路。
- `contributes.ai.tools` 和 `contributes.mcp.providers` 目前只是声明元数据，没有形成统一的执行、授权和生命周期模型。
- 运行输出对人类终端友好，但对 Agent 的稳定诊断仍偏弱：缺少统一诊断对象、事件游标和可恢复操作状态。
- “无限制访问”当前表示 Agent 操作可自动获批，不应被解释为绕过账号权限、服务器限流、资源配额、工作区边界或危险操作硬禁令。
- 当前运行协议允许空 `runtime` 落到云主机本地执行；Agent 云运行必须只接受服务器 catalog 中明确标记为隔离可用的 Docker runtime，禁止该回退路径。
- rclone 同步的 operationId 主要隔离进度，尚未形成可靠的活动子进程取消；在提供自动同步前必须补齐真实取消与超时回收。
- LSP transport 的固定端口逻辑与服务器可配置端口存在不一致；接入 Agent 语义工具前应修复并做自定义端口回归。

## 3. 目标架构

```text
Official AI Agent plugin Worker
        |
        | context.tools.invoke(tool, input)
        v
Renderer Extension Host
  - manifest permission check
  - data-only request forwarding
        |
        v
Electron Main / AgentToolRegistry
  - JSON schema validation
  - session/workspace/account identity snapshot
  - risk classification and access-mode decision
  - approval, quota, cancellation, audit
        |
        +--> LocalWorkspaceToolProvider
        +--> LocalProcessToolProvider
        +--> AgentCloudBroker
        |      +--> CloudApiClient (HTTP actions)
        |      +--> CloudRunClient (WebSocket stream)
        |      +--> WorkspaceSyncCoordinator
        |      +--> DiagnosticNormalizer
        |
        +--> McpProviderManager (future)
               +--> allowlisted local stdio providers
               +--> optional BOBO tool-registry MCP facade
```

### 3.1 必须坚持的信任边界

| 层 | 可以拥有 | 不可以拥有 |
| --- | --- | --- |
| Agent 插件 Worker | 会话、提示词、工具选择、Goal/Skills 状态 | 账号令牌、任意网络、Node/Electron、原始文件句柄 |
| Renderer Extension Host | 插件注册、状态投影、权限声明校验 | 云凭据、真实执行权、审批结果伪造权 |
| Electron 主进程 | 凭据、安全传输、工具执行、审批权、审计、操作生命周期 | Agent 的业务规划和提示词状态 |
| Go 云服务 | 用户鉴权、资源隔离、Docker 执行、配额、持久化 | 模型调用、Agent 提示词、自动修复决策 |

## 4. 统一工具内核

不要继续在 `invokeTool()` 中堆叠 `if (tool === ...)`。应引入数据驱动注册表：

```ts
interface AgentToolDefinition {
  name: string;
  version: 1;
  permission: string;
  inputSchema: JsonSchema;
  outputSchema: JsonSchema;
  classifyRisk(input, context): 'low' | 'medium' | 'high' | 'blocked';
  summarize(input, context): string;
  execute(context, input, signal): Promise<JsonValue>;
  limits: { timeoutMs: number; maxOutputBytes: number; concurrencyKey: string };
}
```

`AgentToolRegistry.invoke()` 的固定顺序：解析工具 -> 校验输入 -> 捕获身份快照 -> 计算风险 -> 检查 manifest 权限 -> 检查服务器 capability -> 访问模式决策 -> 必要时审批 -> 再次核对身份/epoch -> 执行 -> 校验并裁剪输出 -> 审计 -> 返回规范结果。

所有工具返回同一外壳：

```json
{
  "schema": "agent-tool-result/v1",
  "ok": true,
  "operationId": "op_...",
  "data": {},
  "warnings": [],
  "truncated": false,
  "observedAt": "2026-08-25T00:00:00Z"
}
```

错误必须是稳定代码，例如 `AUTH_REQUIRED`、`CAPABILITY_UNAVAILABLE`、`WORKSPACE_CHANGED`、`APPROVAL_REQUIRED`、`PLAN_STALE`、`RATE_LIMITED`、`OUTPUT_TRUNCATED`、`OPERATION_CANCELLED`，不能要求模型从自然语言猜错误类型。

## 5. Plugin API 扩展建议

建议先发布 Plugin API 1.6，只增加通用工具注册与云工具权限，不让插件直接注册执行器：

```text
cloud.resources.read
cloud.runs.execute
cloud.runs.cancel
cloud.artifacts.read
cloud.environments.manage
cloud.packages.manage
cloud.debug.control       # 后续版本
```

`context.tools.invoke()` 本身可保持兼容；SDK 增加各官方工具的输入/输出类型联合。manifest 权限只表示“插件有资格请求”，最终执行仍由主进程的会话访问模式和实时风险判断决定。

长期可加入只读的 `context.tools.list()`，返回当前服务器、当前账号和当前工作区真正可用的工具描述。模型工具列表应由此动态生成，不能把不可用工具硬塞进提示词。

## 6. 分阶段工具目录

### 6.1 第一批：只读发现

| 工具 | 作用 | 风险 | 对应现有能力 |
| --- | --- | --- | --- |
| `cloud_capabilities` | 协议、功能、限制和兼容状态 | low | `serverInfo` |
| `cloud_runtimes_list` | 当前账号可用运行时 | low | `listRuntimes` |
| `cloud_build_targets_list` | 可编译目标/平台 | low | `listBuildTargets` |
| `cloud_environment_get` | 语言、运行时、manifest、依赖一致性 | low | `getProjectEnvironment` |
| `cloud_run_history_list` | 最近运行及摘要 | low | `listRunHistory` |
| `cloud_storage_get` | 项目存储概况 | low | `getStorageInfo` |
| `cloud_cache_inventory` | 缓存类型、大小、命中线索 | low | `getCacheInventory/getCacheEntry` |

所有只读工具必须绑定当前登录账号和当前工作区，禁止输入任意 `userId`、绝对服务器路径或容器 ID。

### 6.2 第二批：同步与运行

| 工具 | 作用 | 风险 |
| --- | --- | --- |
| `cloud_workspace_sync_plan` | 比较本地版本与云快照，返回将上传的范围和字节数 | low |
| `cloud_workspace_sync_apply` | 保存脏文件并同步已确认工作区 | medium/high |
| `cloud_run_start` | 运行文件或已经解析的任务 DAG | medium |
| `cloud_run_events` | 按游标读取有界状态/stdout/stderr/diagnostic/artifact 事件 | low |
| `cloud_run_result` | 读取最终状态、退出码、输出摘要和产物元数据 | low |
| `cloud_run_cancel` | 取消当前 Agent 创建的运行 | medium |

`cloud_run_start` 不接收 shell 字符串，只接收结构化目标：

```json
{
  "target": { "kind": "file", "path": "src/main.go" },
  "runtimeId": "go:1.24",
  "buildTargetId": "linux-amd64",
  "intent": "test",
  "stdinPolicy": "closed",
  "sync": { "mode": "if-needed", "expectedWorkspaceRevision": "..." },
  "limits": { "timeoutSeconds": 120, "maxOutputBytes": 262144 }
}
```

任务模式只能引用客户端已经解析和验证的 task ID；不允许模型提交任意 `command` 字段绕过 tasks 的安全边界。第一版 Agent 运行默认关闭 stdin，遇到交互程序应返回 `INTERACTIVE_INPUT_REQUIRED` 并停止，而不是把通用终端交给模型。

### 6.3 第三批：环境和依赖变更

| 工具 | 作用 | 风险 |
| --- | --- | --- |
| `cloud_environment_repair_plan` | 生成修复/重建计划 | low |
| `cloud_environment_repair_apply` | 按 planId 和 revision 应用 | high |
| `cloud_package_search` | 搜索兼容依赖 | low |
| `cloud_package_change_plan` | 生成安装/升级/删除计划 | low |
| `cloud_package_change_apply` | 应用依赖计划 | high |

Apply 工具必须携带计划 ID、工作区 revision、运行时 ID 和原始请求摘要；主进程应把计划步骤展示给用户。即使处于 `full`，删除依赖、重建环境、来源切换等不可逆或供应链相关操作也应受硬策略约束。

### 6.4 第四批：调试与分析

优先提供高层工具，而不是原样暴露 DAP JSON 消息：

- `cloud_debug_start(target, runtimeId, breakpoints)`
- `cloud_debug_continue(operationId)`
- `cloud_debug_stack(operationId, threadId)`
- `cloud_debug_variables(operationId, frameId, depth)`
- `cloud_debug_evaluate(operationId, frameId, expression)`
- `cloud_debug_stop(operationId)`

`evaluate` 必须单独分类为高风险，限制表达式长度、超时和输出；不得用它替代 shell。调试会话与 Agent 会话、用户、工作区 revision 和插件 epoch 绑定，切换账号/项目/访问模式时立即停止。

## 7. 长任务状态机

云编译不是普通 RPC。主进程需要一个本地 `CloudOperationStore`：

```text
created -> awaiting_approval -> syncing -> queued -> running
                                      |          |
                                      v          v
                                  cancelled   succeeded
                                                 failed
                                                 timed_out
                                                 disconnected
```

每个操作记录：`operationId`、创建它的插件/Agent 会话、账号 identity、工作区 identity/revision、访问模式快照、远端 runId、开始时间、deadline、事件 ring buffer、输出字节数、取消控制器和终态。

必须提供：

- 每个 Agent 会话最多 1 个活动云运行，整个客户端有明确上限。
- 事件具有单调递增 `sequence`；`cloud_run_events(afterSequence)` 支持模型分段读取，防止一次把全部日志塞入上下文。
- stdout/stderr 分开，保留 stage；超限后保留首部、尾部和结构化诊断，明确标记截断。
- renderer 刷新不终止主进程操作；插件停用、账号切换、工作区切换必须终止或隔离操作。
- 本地断线第一版直接取消远端运行。若未来需要恢复，再给通用云运行协议增加短期事件回放，而不是在 Agent 层猜测状态。

## 8. 自动编译与自动 Debug 闭环

自动修复应是可观测、有限次、可中止的状态机：

```text
获取环境/运行时
  -> 保存并同步工作区
  -> 编译或测试
  -> 归一化诊断
  -> 读取诊断涉及的少量本地文件
  -> 生成补丁
  -> workspace_write(expectedSha256)
  -> 仅同步变化
  -> 使用相同 target/runtime 复跑
```

停止条件：成功；达到默认 3 次修复上限；相同诊断指纹连续出现；错误置信度不足；需要改凭据/CI/发布配置；需要安装依赖或重建环境但未批准；工作区 hash 变化；用户取消；令牌、时间或输出预算耗尽。

诊断统一为：

```json
{
  "severity": "error",
  "source": "go-compiler",
  "code": "undefined-name",
  "message": "undefined: ParseConfig",
  "file": "internal/app/main.go",
  "range": { "startLine": 42, "startColumn": 9, "endLine": 42, "endColumn": 20 },
  "stage": "compile",
  "fingerprint": "sha256:..."
}
```

第一版在本地主进程复用 problem matcher 和常见编译器解析器生成该结构，无需改 Go。后续如服务端/运行器能稳定产生原生诊断，可作为通用 `diagnostic` WebSocket 事件加入协议，但不能耦合某个模型。

## 9. 三种访问模式如何作用于云工具

| 操作 | 请求批准 `ask` | 帮我批准 `auto` | 无限制 `full` |
| --- | --- | --- | --- |
| 查询 capabilities/runtime/environment | 自动 | 自动 | 自动 |
| 编译、测试、读取运行结果 | 每个意图首次批准 | 自动，受配额限制 | 自动，受配额限制 |
| 同步本地代码到云端 | 展示范围后批准 | 普通项目可自动，高敏路径仍批准 | 自动，但身份/hash 校验不省略 |
| 修改本地文件 | 按现有 workspace_write | 按现有中/高风险策略 | 自动，但禁止越界 |
| 安装依赖、修复/重建环境 | 必须批准 | 高风险仍批准 | 可按产品策略自动；删除和来源切换建议仍批准 |
| 原始终端、秘密、管理/团队变更 | 不开放 | 不开放 | 不开放或另设显式能力 |

这里的 `full` 只是本地批准策略，不会提升云账号角色，也不会绕过服务器 ACL、团队项目限制、并发数、时限、存储额和 Docker 沙箱。

## 10. 账号、工作区和凭据模型

`AgentCloudBroker` 每次操作都捕获不可变上下文：

```json
{
  "pluginId": "bobocloud.ai-agent",
  "agentSessionId": "...",
  "accountKey": "server-origin + authenticated-user-id",
  "workspaceKey": "personal/team + project-id + branch",
  "workspaceRevision": "...",
  "pluginEpoch": 7,
  "accessMode": "auto"
}
```

在审批之后和真正执行之前必须重新比对。账号注销、token 轮换、服务器配置变化、项目/分支切换、插件重载、访问级别降低都会使旧上下文失效。

凭据只由主进程现有安全存储读取；插件输入中出现 token、Authorization、服务器绝对路径、Docker 名称或用户 ID 字段应直接被 schema 拒绝。日志和工具结果必须统一脱敏 URL 查询参数、Bearer、API key、环境变量和值似凭据的长串。

## 11. MCP 的正确位置

### 11.1 内部 Agent

BOBO 官方 Agent 应直接调用内建 `AgentToolRegistry`。为内建云能力再启动一个本地 MCP 子进程，只会增加序列化、生命周期、安装和权限复杂度，没有收益。

### 11.2 第三方 MCP Provider

未来 `McpProviderManager` 由 Electron 主进程负责：

- 只启动已安装、已签名并经用户启用的 provider。
- 本地 provider 优先 stdio，使用绝对可执行文件路径和参数数组，禁止 shell。
- 环境变量采用空白名单，只注入短期 capability token，不注入完整 BOBO 账号凭据。
- 对 initialize/listTools/callTool 做协议版本、消息大小、超时、取消、并发和输出上限。
- provider 返回的工具仍注册进 `AgentToolRegistry`，继续经过同一审批与审计。
- provider 进程退出、插件禁用、账号/工作区变化时回收所有操作。

### 11.3 对外兼容

若未来希望 Claude Code、Codex 或 OpenCode 使用 BOBO 云编译，可由主进程提供一个显式启用的本地 MCP facade。它只映射允许的注册表工具，并要求桌面端在线、用户已登录和逐客户端授权。不要让外部 Agent 直接调用远端 Go API 或复用长期账号 token。

## 12. 前端交互设计

云工具状态应作为 Agent 时间线事件进入主编辑区，不在页面顶部增加常驻控制栏：

- 输入框上方/消息时间线显示“同步项目、排队、编译、测试、分析错误、应用补丁、复跑”等阶段。
- 每次云运行是一条可展开的工具记录，默认只显示目标、运行时、耗时、退出码和诊断数量。
- 展开后用 tabs 显示“诊断 / 输出 / 产物 / 环境”；日志使用虚拟列表和按需加载，不直接把全部日志渲染进对话。
- 审批卡显示将同步的文件数/字节数、目标运行时、预计操作、依赖计划步骤和风险原因。
- 输入框下方保留访问模式和思考强度；新增一个紧凑的云状态入口，只显示登录、项目和运行状态，不增加大卡片。
- `/cloud` 展示当前资源和能力，`/run` 选择文件/任务，`/debug` 启动有限自动修复，`/environment` 生成修复计划；Goal 模式仍通过斜杠菜单进入。
- 新增的所有可见字符串必须同时补齐 en、zh-CN、ja 语言包。

## 13. 模块施工图

### Phase 0：契约和测试骨架

- 新增 `client/main/agent-tools/registry.js`、`errors.js`、`schema.js`、`operation-store.js`。
- 将现有五个本地工具迁移为 provider，保持 Plugin API 1.5 行为和错误码兼容。
- 单测覆盖 schema、风险、访问模式、审批后身份变化、取消、epoch 和输出裁剪。
- 验收：现有 Agent 插件无需改动，全部现有测试通过。

### Phase 1：只读云能力（建议 Plugin API 1.6）

- 新增 `client/main/agent-cloud/cloud-api-client.js`、`cloud-context.js`、`cloud-tools-read.js`。
- 复用主进程 server transport、证书 pin、认证存储和 `serverInfo` capability negotiation。
- Agent 工具不可只依据客户端静态版本判断能力；连接生产服务器时以实时 `/healthz`、`/readyz` 和 `serverInfo` 为准。
- preload 只增加 `agent.tools.invoke` 已有通道所需的数据转发，不暴露通用 fetch。
- 官方插件按实际 capability 动态声明模型工具。
- 验收：离线、未登录、旧服务器、不兼容协议、切换账号/项目均返回稳定结果且不泄漏凭据。

### Phase 2：云运行

- 新增 `workspace-sync-coordinator.js`、`cloud-run-client.js`、`cloud-tools-run.js`。
- 把 runner 中与 UI 无关的同步、run request 和 WebSocket 协议抽为共享主进程服务；renderer 的 Run 按钮和 Agent 共用服务，而不是复制协议。
- 实现事件 ring buffer、游标读取、取消、超时、并发和输出上限。
- 只允许服务器 runtime catalog 中的隔离运行时；补齐 rclone 子进程的真实取消，并拒绝空 runtime/宿主机执行。
- 验收：编译成功、编译失败、运行超时、用户取消、网络断开、输出洪泛、工作区切换、插件停用均有集成测试。

### Phase 3：自动诊断与有限修复

- 新增 `diagnostic-normalizer.js` 与语言解析器；复用 tasks problem matcher。
- 官方插件实现固定上限的 diagnose/edit/resync/rerun loop，写文件继续使用 `expectedSha256`。
- UI 增加时间线工具记录、诊断/输出/产物详情和三语言文案。
- 验收：至少覆盖 Go、C/C++、Java、Python、Node 的典型编译/测试错误；同错循环和并发用户编辑必须安全停止。

### Phase 4：环境与依赖计划

- 映射现有环境/Package Center plan/apply 契约。
- 高风险审批展示服务端计划，不展示或执行模型伪造的命令文本。
- 验收：过期 plan、重复 apply、操作占用、重对账、团队项目限制、来源不可用均不会错误执行。

### Phase 5：高层 DAP 工具

- 在现有主进程 DAP manager 上增加 Agent facade 和会话限额。
- 先支持断点、继续、堆栈、变量和停止；最后评估 evaluate。
- 验收：断线、超时、巨大变量图、程序 fork/多线程、工作区切换均能回收会话。

### Phase 6：MCP 互操作

- 实现 provider manifest、签名/权限、stdio manager、工具映射和健康状态。
- 再实现可选的本地 BOBO MCP facade，默认关闭。
- 验收：恶意/卡死 provider、超大 JSON-RPC、重复工具名、进程崩溃、取消无响应和权限撤回都被隔离。

## 14. 测试矩阵

必须分四层：

1. 单元测试：schema、风险分类、身份快照、访问模式、错误归一化、诊断解析、输出裁剪。
2. 主进程集成：模拟 HTTP/WS，验证 token 不进入 renderer/plugin、TLS/身份变化、取消和断线。
3. Agent 合约测试：模型发出畸形参数、越权字段、重复调用、过期 approvalId、过期 planId。
4. E2E：真实插件在 ask/auto/full 下完成“读取环境 -> 编译 -> 发现错误 -> 改文件 -> 复跑”，并检查 UI、三语言和重启清理。

平台覆盖 Windows、macOS、Linux；路径和命令均使用 Node `path`、参数数组和主进程 transport，测试不得假设 PowerShell、bash、盘符或 `/tmp`。

## 15. 是否需要增加客户端语言

不需要。继续使用 JavaScript/Node/Electron 是当前最优解：

- 难点是权限、生命周期、协议、取消、并发和状态一致性，而不是 JS 表达能力。
- 客户端已有 Electron 主进程、preload、renderer、Worker 和测试基础，加入 Rust/Python 会额外制造打包、签名、更新、跨平台 ABI 和进程监管成本。
- Go 保持云服务实现语言；MCP provider 可以允许第三方使用自己的语言，但 BOBO 核心本地 Agent 工具主机应保持 JS 纯度。
- 只有未来出现经基准证明的 CPU 密集解析或强沙箱需求，才考虑 Rust/WASM 辅助模块；它也应是窄模块，不应成为第二套 Agent 内核。

## 16. 明确不做的事情

- 不给插件开放原始 `fetch`、任意 WebSocket、账号 token、Docker socket 或 SSH。
- 不把交互终端直接当 Agent 工具。
- 不允许模型提交 shell 字符串冒充 build/task/environment plan。
- 不让 MCP 绕过 Plugin API 权限、三种访问模式和主进程审批。
- 不把 Agent 思考、提示词、Skills、Goal 或自动修复循环放进 Go 服务。
- 不因 `full` 模式取消账号权限、配额、超时、路径、身份和审计边界。

## 17. 推荐的实际施工顺序

先完成 Phase 0，再做 Phase 1 和 Phase 2；这三期建立真正可复用的工具平台。随后用 Phase 3 交付最有用户价值的“云编译 + 自动诊断 + 有限修复”。环境/依赖和 DAP 分开发布，避免一次扩大过多危险面。MCP 放在最后，因为它应复用已经稳定的工具内核，而不是先搭协议再补权限。

第一项可交付验收场景应固定为：用户在已登录的个人项目中要求“编译当前文件并修复编译错误”，Agent 自动读取 capabilities 和 environment，展示同步/运行审批，流式执行云编译，生成结构化诊断，用带 hash 的本地写入修复代码，增量同步并复跑；全过程可取消、可审计、切换项目立即失效，且插件从未接触账号凭据。
