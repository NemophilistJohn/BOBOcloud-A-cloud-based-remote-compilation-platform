# 参与 BOBOCLOUD 开发

[English](CONTRIBUTING.md) · [README](README.zh-CN.md)

欢迎改进用户体验、语言适配、无障碍/本地化、文档、测试、部署或插件。先找到可复现问题及最小所属边界。可选产品行为通常适合插件；可复用、受校验的能力适合宿主。

## 本地开始

使用 Node.js 22，以及 [server/go.mod](server/go.mod) 声明的 Go 版本（当前为 1.25）。`npm ci --prefix client` 安装客户端依赖，`npm start` 启动桌面端。编辑与多数测试不需要生产账号；真实实验使用测试 profile 和自己的服务。

修改前阅读适用 `AGENTS.md`，检查 `git status`，保留无关改动。普通测试不要顺带部署管理员服务器、修改真实账号、给别人的项目安装依赖或发布插件。

## 找到功能所有者

| 修改内容 | 从这里开始 |
| --- | --- |
| 编辑器交互与补全 | `client/src/`、`client/editor-rules/`、`client/completion-rules.ts`。 |
| Renderer 服务、启动、销毁、扩展边界 | `client/renderer/`、`client/types/`。 |
| 桌面文件、凭据、进程、传输、审批 | `client/main/`，再看显式 `client/preload.js` 契约。 |
| 云 API 与生命周期 | `server/internal/handler/`，`server/cmd/bobocloud/main.go` 保持组合入口职责。 |
| 依赖事务与缓存所有权 | `server/internal/packageops/`、`personalcache/`、`cachev2/` 及对应客户端主进程控制器。 |
| 公平准入与资源记账 | `resourcecontrol/`、`resourcegovernor/`、`hostresource/`。 |
| 语言智能或调试 | 分离的 `server/internal/lsp/` 和 `dap/` 所有者。 |
| 可安装扩展 | [插件入门](docs/plugin-quickstart.zh-CN.md)、[SDK](client/plugin-sdk/bobocloud-plugin.d.ts)和独立插件仓库。 |

`client/renderer-dist/` 是构建产物，修改源码后重新构建。`window.BOBO` 是宿主兼容投影，不是插件 API。新增 Renderer 特权调用应通过 native adapter 提供窄私有 host port，不增加直接读取 preload 全局对象的调用者。

## 在异步工作中保护正确性

任务绑定服务器、账号、工作区身份、revision 和操作/会话代次；边界改变后拒绝迟到结果。长工作流明确取消、关闭、退出账号、更换服务器和切换工作区时的处理。Promise 被取消，不等于真实进程、容器、挂载或租约已经回收。

已发布依赖代不可变，不能往挂载包目录写文件，也不能只删数据库或只删目录来“修复”。运行、LSP、DAP 可以独立租用同一依赖代，可变状态必须分离。复用编译产物后，程序仍应真正执行。

不要把输入拼接成 shell 文本。路径、参数、URL、JSON 消息和权限在对应权威层按结构校验；不要为了让测试通过就增加容器权限或关闭 TLS 校验。

## 按改动选择验证

| 范围 | 有用的本地检查 |
| --- | --- |
| 纯客户端逻辑 | `node --test client/tests/<affected>.test.js`。 |
| Renderer 契约 | `npm run typecheck`、`npm run build:renderer`。 |
| 编辑器/LSP 交互 | `npm --prefix client run test:ui:lsp`。 |
| 更广工作台交互 | `npm run test:ui`，迭代期间运行对应 spec。 |
| 依赖中心事务 | `npm --prefix client run test:ui:packages`。 |
| 云端逻辑 | `go -C server test ./...`、`go -C server vet ./...`。 |
| 共享生命周期/缓存/资源状态 | 对应 `go -C server test -race ./internal/<package>`，并运行普通套件。 |
| 测试归属 | `node scripts/ci/verify-test-routing.mjs`。 |
| 文档 | 相对链接、代码示例、Mermaid 语法、双语一致性及截图实际渲染。 |

根目录 `npm test` 运行客户端 Node 测试，不包含 Go。Windows 上串行构建 Renderer。真实 Electron 测试使用隔离 profile；mock 传输不能替代 TLS 或线上部署检查。普通 hermetic UI spec 自动进入 core，依赖特殊产物、平台、特权或嵌套模块的测试需要明确归属。

GitHub workflow 对服务器和账号保持只读。稳定 **CI Gate** 汇总客户端契约、UI 分片、依赖中心、插件兼容、打包应用、Go/race、特权挂载、toolkit 和 Windows 发布预检。新失败需要解释或修复，不应隐藏成 skip。

## 本地化与文档

本体可见与无障碍文字同步扩展英文、简体中文、日文语言包；插件文字留在插件自己的语言包。检查占位符一致性及窄窗口实际布局。

[README.md](README.md) 与 [README.zh-CN.md](README.zh-CN.md)，以及 `.en.md`/`.zh-CN.md` 配对教程应保持语义一致。依据当前代码/测试描述已实现行为，区分示例与测量，为 fixture 图注明性质。不要公开 profile、无关项目源码、服务密钥、Token、私有本机路径或与演示无关的账号历史，详见[素材说明](docs/media/README.md)。

## 有用的 Issue 与 PR

Issue 提供版本、操作系统、语言/运行时、最小项目、预期/实际行为、精确步骤及适用的脱敏输出/run ID。区分本地逻辑、受控 UI、真实服务与部署观察。

PR 先说明用户可见的触发条件和最终行为，再列有意义的边界改动、实际运行的验证和剩余限制。聚焦问题，避免混入无关清理。公开契约变更时，同步 validator、broker、preload/transport、renderer、SDK、文档和对应测试。

仓库 [LICENSE](LICENSE) 为 Apache-2.0。保留第三方声明，重新分发依赖、镜像、字体和录制素材前核对许可证。
