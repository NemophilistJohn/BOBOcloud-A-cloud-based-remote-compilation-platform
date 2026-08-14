# Claude Code — project context









<!-- cloude-code-toolbox:mcp-skills-awareness-begin -->

### MCP & Skills awareness (Cloude Code ToolBox)

_Last synced: 2026-08-13T03:42:38.471Z._

- **Full report:** `.claude/cloude-code-toolbox-mcp-skills-awareness.md` in this workspace (auto-overwritten on each scan). Use it as ground truth for configured servers and skill folders.
- **MCP:** For **live tools** in Claude Code, enable the matching server via `/mcp`. Servers are configured in `~/.claude.json` (user) and `.mcp.json` (project).
- **When the user’s task matches a server** (e.g. Confluence work and a **Confluence** / **Atlassian** MCP is listed), **prefer that server id** and plan on tool use—not only file search.
- **Skills:** Folders below contain `SKILL.md`; attach or cite paths in chat when relevant.

#### Workspace MCP

- `e:\PROJECTS\my_webSet\.mcp.json` _(workspace: my_webSet)_ — _file missing_

_No active workspace servers in mcp.json._

#### User MCP

- `C:\Users\yours\.claude.json` — _servers defined_

| Server id | Kind | Detail |
|-----------|------|--------|
| ssh-mcp | stdio | cmd /c npx -y ssh-mcp --host=47.95.214.136 --user=root --port=22 --password=101800Czb |

#### Project skills

_None found (or no workspace open)._

#### User skills

- **arkcli-api-explorer** — `C:\Users\yours\.copilot\skills\arkcli-api-explorer` — arkcli Raw API Explorer：调用已注册的 Action 作为产品命令的兜底能力。当现有 `arkcli <domain> <verb>` 无法覆盖需求，或需要验证底层 Action 契约时使用。

- **arkcli-auth** — `C:\Users\yours\.copilot\skills\arkcli-auth` — arkcli 认证管理：交互式登录、Volc SSO 登录、查看状态、退出登录、生成 ARK API Key (apikey)、以及云开发机/CI 用 `arkcli init-volc` 从 VOLC_INIT_* 环境变量无交互引导 platform profile。0.1.16 起 SSO 登录走 Gate 1+2 自动绑定 Profile 切面 (type/region/project/owner_trn)；AK/SK logi

- **arkcli-billing** — `C:\Users\yours\.copilot\skills\arkcli-billing` — 查询火山引擎 ARK 拆分账单明细（结算金额、Token 用量计费），支持按账期月、月范围、Endpoint、API Key、产品编码等维度过滤。当用户问账单、花了多少钱、对账、账期、按 EP / API Key 拆账、按产品拆账、月度账单、出账明细时使用。注意 billing 跟 usage stats 不同：stats 出推理量（近实时），billing 出结算金额（T+1 出账，财务口径）。

- **arkcli-chat** — `C:\Users\yours\.copilot\skills\arkcli-chat` — arkcli +chat：通过数据面 Responses API 快速对话/推理，支持多模态（@file 本地图片、视频、音频、通用文件）、流式输出、system instructions、采样调节（temperature/top-p/max-output-tokens）、reasoning effort 调节、--store + previous-response-id 多轮接续。当用户需要与模型即时对话、问答、推理、做带图/视频/音

- **arkcli-code-example** — `C:\Users\yours\.copilot\skills\arkcli-code-example` — arkcli +code-example：为指定基础模型生成多语言（Python / Go / Java / Node / curl）调用示例代码并写入本地文件。数据源是火山方舟 OpenTOP OpenGetSampleCode。当用户需要拿某个基础模型的 SDK / curl 调用示例、保存为本地接入模板时使用。反触发：TTS/ASR/语音模型没有 arkcli 示例代码路径，不能靠补版本解决，只能转 models search 说

- **arkcli-config** — `C:\Users\yours\.copilot\skills\arkcli-config` — arkcli 本地配置管理。0.1.16 起 profile 类操作请优先使用 `arkcli profile <subcmd>`（init/list/show/switch/delete 已 deprecated）；本 skill 仍可处理 `arkcli config reset` 与历史 yaml 排障。

- **arkcli-connect** — `C:\Users\yours\.copilot\skills\arkcli-connect` — arkcli +connect：将 arkcli 内嵌的 AI skills 安装到本机检测到的所有 AI Agent 中，支持安装、列出已支持 agent、卸载。当用户需要将 arkcli 能力同步到 Claude Code 等本地 agent 时使用。

- **arkcli-custommodel** — `C:\Users\yours\.copilot\skills\arkcli-custommodel` — arkcli 自定义模型仓库管理：从 TOS 导入自定义模型、查询/筛选自定义模型、查看详情、改名、删除、查询可用量化模式、量化已就绪的模型。当用户需要管理账号下的自传/精调模型（`cm-xxx`），或为 +deploy 准备目标自定义模型时使用。注意：查询火山**公共基础模型**（doubao 等 foundation models）走 arkcli-models；本 skill 只管账号下的自定义模型仓库。

- **arkcli-deploy** — `C:\Users\yours\.copilot\skills\arkcli-deploy` — arkcli +deploy：创建推理接入点（Endpoint）的统一首选入口 —— **用户说『创建/新建/create 一个 endpoint/接入点』或『部署/上线/deploy 某模型』，只要意图是新建一个接入点，一律优先走这里，不要走 arkcli-infer-endpoint 的 create**。当用户需要把模型部署成在线推理接入点时使用。注意：要对**已有** Endpoint 做获取/列表/启停/更新等全生命周期管理，

- **arkcli-doctor** — `C:\Users\yours\.copilot\skills\arkcli-doctor` — arkcli doctor 诊断入口：用于火山方舟 Ark 报错、资源状态、用量配额、性能指标、错误码解释与修复建议；覆盖 doctor、doctor error、doctor infer-endpoint、doctor model、doctor metrics。用户给 Ark 错误码或错误 JSON、ep-xxx 接入点、模型名，问为什么报错、怎么修、状态/健康、用量/配额、限流、错误率、P99、Cache 命中率、接入点慢/挂、模型

- **arkcli-gen** — `C:\Users\yours\.copilot\skills\arkcli-gen` — 火山方舟 Ark 图片/视频生成入口：用户要生图、画图、生成图片/视频、图生图、图生视频、参考图/视频/音频生成，或明确使用 seedream/seedance 创作新内容时使用 arkcli +gen。+gen 按当前 profile 的可用资源与模型 supported_params 生成；图片同步返回，视频提交后返回 task_id/status，需用 --wait 或 arkcli gen get/list 轮询并下载结果。反触

- **arkcli-helper** — `C:\Users\yours\.copilot\skills\arkcli-helper` — arkcli helper:把 Claude Code / Codex / OpenCode / OpenClaw / Trae 配到火山方舟 Plan。用户说给当前或某个 Agent 配 MCP、豆包搜索、联网搜索、dataPro、OpenViking 时,用 `arkcli helper mcp`(只注入 MCP,不改 model);要连 model/provider 一起配用 `helper configure`;查状态用 `he

- **arkcli-infer-endpoint** — `C:\Users\yours\.copilot\skills\arkcli-infer-endpoint` — arkcli 推理接入点**管理**能力：对**已有** Endpoint 做获取、列表、启动、停止、删除、更新（生命周期管理 + 启停 + 销毁）。优先使用产品命令 `arkcli infer endpoint ...`，而不是直接调用 Raw API。**反触发（重要）：用户说『创建/新建/create/部署/deploy 一个 endpoint/接入点』这类新建接入点的意图，一律走 arkcli-deploy（`+deploy`）

- **arkcli-models** — `C:\Users\yours\.copilot\skills\arkcli-models` — arkcli 模型查询能力：列出、搜索、获取火山**公共基础模型**（foundation models）详情。优先使用产品命令 `arkcli models ...`，而不是直接调用 Raw API。注意：查询/管理账号下**自传或精调的自定义模型**（`cm-xxx`）走 arkcli-custommodel；本 skill 只覆盖公共基础模型目录。语音/TTS/ASR/播客/音色/实时语音交互模型只支持广场检索和选型说明，不要引导

- **arkcli-onboard** — `C:\Users\yours\.copilot\skills\arkcli-onboard` — arkcli 接入向导(workflow):把某个模型接入到自己的应用/服务的端到端引导 —— 从'我想用某模型'到拿到可调用的 Endpoint(+ 可选示例代码)。当用户说'我想在我的 app/服务里用豆包/某模型''怎么把方舟模型接进来''帮我接入 XX 模型''想正式用上某模型'这类**不含 deploy/部署关键词、但本质是正式接入**的意图时触发。已明确说'部署/创建 endpoint'的直接走 arkcli-deploy;

- **arkcli-plans** — `C:\Users\yours\.copilot\skills\arkcli-plans` — ARK 套餐管理(Agent Plan / Coding Plan,个人版 + 企业版):查询持有 / 购买 / 续费 / 模型清单 / 轮换 APIKey,**以及企业版席位的全部管理操作**:列出席位(`plans team seat-list`)、给员工分配席位(`plans team seat-assign`)、查谁绑了哪个 seat、轮换席位 APIKey(`plans team rotate-apikey`)。命中关键词:套

- **arkcli-pricing** — `C:\Users\yours\.copilot\skills\arkcli-pricing` — 查询火山引擎 ARK 基础模型结算单价（含当前账号折扣）以及 AgentPlan / CodingPlan 套餐订阅价格。Price 字段就是后端按账号合同 / 活动 / 套餐折后的最终单价，OriginalPrice 是公示原价。当用户问模型多少钱、定价、单价、价格、Agent Plan 多少钱、Coding Plan 多少钱、套餐价格、折扣价、按 token 收费、不同模态价格对比、模型免费额度时使用。反触发：TTS/ASR/语音模

- **arkcli-profile** — `C:\Users\yours\.copilot\skills\arkcli-profile` — arkcli profile 切面管理：列出、查看、新建、切换、删除、重命名 profile；管理 profile 内 API Key 列表；管理 plan 类 profile 的 default 模型（text/image/video）；设置某 modality 的默认资源 ID。0.1.16 把原 `arkcli config init/list/show/switch/delete` 全部迁过来，是 profile 类操作的唯一入

- **arkcli-resources** — `C:\Users\yours\.copilot\skills\arkcli-resources` — arkcli resources 实时控制面查询：按 profile.type 派发，列出当前/指定 profile 下可用的 endpoint / plan 模型 ID 列表。read-only，不写 profile.yaml。change default 走 `arkcli profile set-default` 或 `+deploy --set-default`。

- **arkcli-shared** — `C:\Users\yours\.copilot\skills\arkcli-shared` — arkcli 共享执行协议：首次配置入口、业务命令执行前的认证闸门、命令路由与选择顺序、输出/安全/二次确认规则。深度细节（身份解析、AK-SK 边界、API Key 恢复、实名闸门、profile 默认与漂移、全局 flags、故障分流）按需在 references/ 加载。当用户第一次使用 arkcli、遇到未登录/鉴权失败、需要判断该走产品命令还是 raw api、或任何 arkcli-* skill 需要公共上下文时触发。

- **arkcli-train-finetune** — `C:\Users\yours\.copilot\skills\arkcli-train-finetune` — 使用 ArkCLI 创建、查询和管理模型精调训练任务，并从训练指标选择最佳 step、导出训练产物为 custom model、衔接模型仓库与推理部署。适用于选择可训练模型与训练方法、查询价格和超参数、校验训练文件、预览并创建任务、列出任务、观察或操作指定任务，以及根据效果指标导出和部署精调产物。本 skill 不负责数据集管理。

- **arkcli-understand** — `C:\Users\yours\.copilot\skills\arkcli-understand` — arkcli +understand：多模态理解工作流，通过 12 个任务型 sub-skill（4 模态：image/video/audio/file）在数据面 Responses API 引擎上做专项理解。覆盖图片描述/OCR、视觉定位（bbox grounding）、GUI 操作识别、PDF/文档字段抽取、视频总结/视频问答、音视频联合理解、语音转写（ASR）、语音翻译（AST）、SRT 字幕打轴、多说话人转写、会议纪要。每个 s

- **arkcli-usage** — `C:\Users\yours\.copilot\skills\arkcli-usage` — ARK 用量查询:`usage stats`(Token / 请求数,5-30 分钟延迟)、`usage plan` / `usage balance --type plan`(套餐额度快照)、`usage plan-details`(按模型时间序列,套餐内/外拆分)、`usage balance`(余额:免费额度 / 媒资库 / 套餐)、`usage seats --with-usage`(团队席位用量 by seat)。命中关键词:

- **arkcli-api-explorer** — `C:\Users\yours\.claude\skills\arkcli-api-explorer` — arkcli Raw API Explorer：调用已注册的 Action 作为产品命令的兜底能力。当现有 `arkcli <domain> <verb>` 无法覆盖需求，或需要验证底层 Action 契约时使用。

- **arkcli-auth** — `C:\Users\yours\.claude\skills\arkcli-auth` — arkcli 认证管理：交互式登录、Volc SSO 登录、查看状态、退出登录、生成 ARK API Key (apikey)、以及云开发机/CI 用 `arkcli init-volc` 从 VOLC_INIT_* 环境变量无交互引导 platform profile。0.1.16 起 SSO 登录走 Gate 1+2 自动绑定 Profile 切面 (type/region/project/owner_trn)；AK/SK logi

- **arkcli-billing** — `C:\Users\yours\.claude\skills\arkcli-billing` — 查询火山引擎 ARK 拆分账单明细（结算金额、Token 用量计费），支持按账期月、月范围、Endpoint、API Key、产品编码等维度过滤。当用户问账单、花了多少钱、对账、账期、按 EP / API Key 拆账、按产品拆账、月度账单、出账明细时使用。注意 billing 跟 usage stats 不同：stats 出推理量（近实时），billing 出结算金额（T+1 出账，财务口径）。

- **arkcli-chat** — `C:\Users\yours\.claude\skills\arkcli-chat` — arkcli +chat：通过数据面 Responses API 快速对话/推理，支持多模态（@file 本地图片、视频、音频、通用文件）、流式输出、system instructions、采样调节（temperature/top-p/max-output-tokens）、reasoning effort 调节、--store + previous-response-id 多轮接续。当用户需要与模型即时对话、问答、推理、做带图/视频/音

- **arkcli-code-example** — `C:\Users\yours\.claude\skills\arkcli-code-example` — arkcli +code-example：为指定基础模型生成多语言（Python / Go / Java / Node / curl）调用示例代码并写入本地文件。数据源是火山方舟 OpenTOP OpenGetSampleCode。当用户需要拿某个基础模型的 SDK / curl 调用示例、保存为本地接入模板时使用。反触发：TTS/ASR/语音模型没有 arkcli 示例代码路径，不能靠补版本解决，只能转 models search 说

- **arkcli-config** — `C:\Users\yours\.claude\skills\arkcli-config` — arkcli 本地配置管理。0.1.16 起 profile 类操作请优先使用 `arkcli profile <subcmd>`（init/list/show/switch/delete 已 deprecated）；本 skill 仍可处理 `arkcli config reset` 与历史 yaml 排障。

- **arkcli-connect** — `C:\Users\yours\.claude\skills\arkcli-connect` — arkcli +connect：将 arkcli 内嵌的 AI skills 安装到本机检测到的所有 AI Agent 中，支持安装、列出已支持 agent、卸载。当用户需要将 arkcli 能力同步到 Claude Code 等本地 agent 时使用。

- **arkcli-custommodel** — `C:\Users\yours\.claude\skills\arkcli-custommodel` — arkcli 自定义模型仓库管理：从 TOS 导入自定义模型、查询/筛选自定义模型、查看详情、改名、删除、查询可用量化模式、量化已就绪的模型。当用户需要管理账号下的自传/精调模型（`cm-xxx`），或为 +deploy 准备目标自定义模型时使用。注意：查询火山**公共基础模型**（doubao 等 foundation models）走 arkcli-models；本 skill 只管账号下的自定义模型仓库。

- **arkcli-deploy** — `C:\Users\yours\.claude\skills\arkcli-deploy` — arkcli +deploy：创建推理接入点（Endpoint）的统一首选入口 —— **用户说『创建/新建/create 一个 endpoint/接入点』或『部署/上线/deploy 某模型』，只要意图是新建一个接入点，一律优先走这里，不要走 arkcli-infer-endpoint 的 create**。当用户需要把模型部署成在线推理接入点时使用。注意：要对**已有** Endpoint 做获取/列表/启停/更新等全生命周期管理，

- **arkcli-doctor** — `C:\Users\yours\.claude\skills\arkcli-doctor` — arkcli doctor 诊断入口：用于火山方舟 Ark 报错、资源状态、用量配额、性能指标、错误码解释与修复建议；覆盖 doctor、doctor error、doctor infer-endpoint、doctor model、doctor metrics。用户给 Ark 错误码或错误 JSON、ep-xxx 接入点、模型名，问为什么报错、怎么修、状态/健康、用量/配额、限流、错误率、P99、Cache 命中率、接入点慢/挂、模型

- **arkcli-gen** — `C:\Users\yours\.claude\skills\arkcli-gen` — 火山方舟 Ark 图片/视频生成入口：用户要生图、画图、生成图片/视频、图生图、图生视频、参考图/视频/音频生成，或明确使用 seedream/seedance 创作新内容时使用 arkcli +gen。+gen 按当前 profile 的可用资源与模型 supported_params 生成；图片同步返回，视频提交后返回 task_id/status，需用 --wait 或 arkcli gen get/list 轮询并下载结果。反触

- **arkcli-helper** — `C:\Users\yours\.claude\skills\arkcli-helper` — arkcli helper:把 Claude Code / Codex / OpenCode / OpenClaw / Trae 配到火山方舟 Plan。用户说给当前或某个 Agent 配 MCP、豆包搜索、联网搜索、dataPro、OpenViking 时,用 `arkcli helper mcp`(只注入 MCP,不改 model);要连 model/provider 一起配用 `helper configure`;查状态用 `he

- **arkcli-infer-endpoint** — `C:\Users\yours\.claude\skills\arkcli-infer-endpoint` — arkcli 推理接入点**管理**能力：对**已有** Endpoint 做获取、列表、启动、停止、删除、更新（生命周期管理 + 启停 + 销毁）。优先使用产品命令 `arkcli infer endpoint ...`，而不是直接调用 Raw API。**反触发（重要）：用户说『创建/新建/create/部署/deploy 一个 endpoint/接入点』这类新建接入点的意图，一律走 arkcli-deploy（`+deploy`）

- **arkcli-models** — `C:\Users\yours\.claude\skills\arkcli-models` — arkcli 模型查询能力：列出、搜索、获取火山**公共基础模型**（foundation models）详情。优先使用产品命令 `arkcli models ...`，而不是直接调用 Raw API。注意：查询/管理账号下**自传或精调的自定义模型**（`cm-xxx`）走 arkcli-custommodel；本 skill 只覆盖公共基础模型目录。语音/TTS/ASR/播客/音色/实时语音交互模型只支持广场检索和选型说明，不要引导

- **arkcli-onboard** — `C:\Users\yours\.claude\skills\arkcli-onboard` — arkcli 接入向导(workflow):把某个模型接入到自己的应用/服务的端到端引导 —— 从'我想用某模型'到拿到可调用的 Endpoint(+ 可选示例代码)。当用户说'我想在我的 app/服务里用豆包/某模型''怎么把方舟模型接进来''帮我接入 XX 模型''想正式用上某模型'这类**不含 deploy/部署关键词、但本质是正式接入**的意图时触发。已明确说'部署/创建 endpoint'的直接走 arkcli-deploy;

- **arkcli-plans** — `C:\Users\yours\.claude\skills\arkcli-plans` — ARK 套餐管理(Agent Plan / Coding Plan,个人版 + 企业版):查询持有 / 购买 / 续费 / 模型清单 / 轮换 APIKey,**以及企业版席位的全部管理操作**:列出席位(`plans team seat-list`)、给员工分配席位(`plans team seat-assign`)、查谁绑了哪个 seat、轮换席位 APIKey(`plans team rotate-apikey`)。命中关键词:套

- **arkcli-pricing** — `C:\Users\yours\.claude\skills\arkcli-pricing` — 查询火山引擎 ARK 基础模型结算单价（含当前账号折扣）以及 AgentPlan / CodingPlan 套餐订阅价格。Price 字段就是后端按账号合同 / 活动 / 套餐折后的最终单价，OriginalPrice 是公示原价。当用户问模型多少钱、定价、单价、价格、Agent Plan 多少钱、Coding Plan 多少钱、套餐价格、折扣价、按 token 收费、不同模态价格对比、模型免费额度时使用。反触发：TTS/ASR/语音模

- **arkcli-profile** — `C:\Users\yours\.claude\skills\arkcli-profile` — arkcli profile 切面管理：列出、查看、新建、切换、删除、重命名 profile；管理 profile 内 API Key 列表；管理 plan 类 profile 的 default 模型（text/image/video）；设置某 modality 的默认资源 ID。0.1.16 把原 `arkcli config init/list/show/switch/delete` 全部迁过来，是 profile 类操作的唯一入

- **arkcli-resources** — `C:\Users\yours\.claude\skills\arkcli-resources` — arkcli resources 实时控制面查询：按 profile.type 派发，列出当前/指定 profile 下可用的 endpoint / plan 模型 ID 列表。read-only，不写 profile.yaml。change default 走 `arkcli profile set-default` 或 `+deploy --set-default`。

- **arkcli-shared** — `C:\Users\yours\.claude\skills\arkcli-shared` — arkcli 共享执行协议：首次配置入口、业务命令执行前的认证闸门、命令路由与选择顺序、输出/安全/二次确认规则。深度细节（身份解析、AK-SK 边界、API Key 恢复、实名闸门、profile 默认与漂移、全局 flags、故障分流）按需在 references/ 加载。当用户第一次使用 arkcli、遇到未登录/鉴权失败、需要判断该走产品命令还是 raw api、或任何 arkcli-* skill 需要公共上下文时触发。

- **arkcli-train-finetune** — `C:\Users\yours\.claude\skills\arkcli-train-finetune` — 使用 ArkCLI 创建、查询和管理模型精调训练任务，并从训练指标选择最佳 step、导出训练产物为 custom model、衔接模型仓库与推理部署。适用于选择可训练模型与训练方法、查询价格和超参数、校验训练文件、预览并创建任务、列出任务、观察或操作指定任务，以及根据效果指标导出和部署精调产物。本 skill 不负责数据集管理。

- **arkcli-understand** — `C:\Users\yours\.claude\skills\arkcli-understand` — arkcli +understand：多模态理解工作流，通过 12 个任务型 sub-skill（4 模态：image/video/audio/file）在数据面 Responses API 引擎上做专项理解。覆盖图片描述/OCR、视觉定位（bbox grounding）、GUI 操作识别、PDF/文档字段抽取、视频总结/视频问答、音视频联合理解、语音转写（ASR）、语音翻译（AST）、SRT 字幕打轴、多说话人转写、会议纪要。每个 s

- **arkcli-usage** — `C:\Users\yours\.claude\skills\arkcli-usage` — ARK 用量查询:`usage stats`(Token / 请求数,5-30 分钟延迟)、`usage plan` / `usage balance --type plan`(套餐额度快照)、`usage plan-details`(按模型时间序列,套餐内/外拆分)、`usage balance`(余额:免费额度 / 媒资库 / 套餐)、`usage seats --with-usage`(团队席位用量 by seat)。命中关键词:

- **frontend-design** — `C:\Users\yours\.claude\skills\frontend-design` — Guidance for distinctive, intentional visual design when building new UI or reshaping an existing one. Helps with aesthetic direction, typography, and making choices that don't read as templated defaults.

- **web-artifacts-builder** — `C:\Users\yours\.claude\skills\web-artifacts-builder` — Suite of tools for creating elaborate, multi-component claude.ai HTML artifacts using modern frontend web technologies (React, Tailwind CSS, shadcn/ui). Use for complex artifacts requiring state management, routing, or s

- **arkcli-api-explorer** — `C:\Users\yours\.agents\skills\arkcli-api-explorer` — arkcli Raw API Explorer：调用已注册的 Action 作为产品命令的兜底能力。当现有 `arkcli <domain> <verb>` 无法覆盖需求，或需要验证底层 Action 契约时使用。

- **arkcli-auth** — `C:\Users\yours\.agents\skills\arkcli-auth` — arkcli 认证管理：交互式登录、Volc SSO 登录、查看状态、退出登录、生成 ARK API Key (apikey)、以及云开发机/CI 用 `arkcli init-volc` 从 VOLC_INIT_* 环境变量无交互引导 platform profile。0.1.16 起 SSO 登录走 Gate 1+2 自动绑定 Profile 切面 (type/region/project/owner_trn)；AK/SK logi

- **arkcli-billing** — `C:\Users\yours\.agents\skills\arkcli-billing` — 查询火山引擎 ARK 拆分账单明细（结算金额、Token 用量计费），支持按账期月、月范围、Endpoint、API Key、产品编码等维度过滤。当用户问账单、花了多少钱、对账、账期、按 EP / API Key 拆账、按产品拆账、月度账单、出账明细时使用。注意 billing 跟 usage stats 不同：stats 出推理量（近实时），billing 出结算金额（T+1 出账，财务口径）。

- **arkcli-chat** — `C:\Users\yours\.agents\skills\arkcli-chat` — arkcli +chat：通过数据面 Responses API 快速对话/推理，支持多模态（@file 本地图片、视频、音频、通用文件）、流式输出、system instructions、采样调节（temperature/top-p/max-output-tokens）、reasoning effort 调节、--store + previous-response-id 多轮接续。当用户需要与模型即时对话、问答、推理、做带图/视频/音

- **arkcli-code-example** — `C:\Users\yours\.agents\skills\arkcli-code-example` — arkcli +code-example：为指定基础模型生成多语言（Python / Go / Java / Node / curl）调用示例代码并写入本地文件。数据源是火山方舟 OpenTOP OpenGetSampleCode。当用户需要拿某个基础模型的 SDK / curl 调用示例、保存为本地接入模板时使用。反触发：TTS/ASR/语音模型没有 arkcli 示例代码路径，不能靠补版本解决，只能转 models search 说

- **arkcli-config** — `C:\Users\yours\.agents\skills\arkcli-config` — arkcli 本地配置管理。0.1.16 起 profile 类操作请优先使用 `arkcli profile <subcmd>`（init/list/show/switch/delete 已 deprecated）；本 skill 仍可处理 `arkcli config reset` 与历史 yaml 排障。

- **arkcli-connect** — `C:\Users\yours\.agents\skills\arkcli-connect` — arkcli +connect：将 arkcli 内嵌的 AI skills 安装到本机检测到的所有 AI Agent 中，支持安装、列出已支持 agent、卸载。当用户需要将 arkcli 能力同步到 Claude Code 等本地 agent 时使用。

- **arkcli-custommodel** — `C:\Users\yours\.agents\skills\arkcli-custommodel` — arkcli 自定义模型仓库管理：从 TOS 导入自定义模型、查询/筛选自定义模型、查看详情、改名、删除、查询可用量化模式、量化已就绪的模型。当用户需要管理账号下的自传/精调模型（`cm-xxx`），或为 +deploy 准备目标自定义模型时使用。注意：查询火山**公共基础模型**（doubao 等 foundation models）走 arkcli-models；本 skill 只管账号下的自定义模型仓库。

- **arkcli-deploy** — `C:\Users\yours\.agents\skills\arkcli-deploy` — arkcli +deploy：创建推理接入点（Endpoint）的统一首选入口 —— **用户说『创建/新建/create 一个 endpoint/接入点』或『部署/上线/deploy 某模型』，只要意图是新建一个接入点，一律优先走这里，不要走 arkcli-infer-endpoint 的 create**。当用户需要把模型部署成在线推理接入点时使用。注意：要对**已有** Endpoint 做获取/列表/启停/更新等全生命周期管理，

- **arkcli-doctor** — `C:\Users\yours\.agents\skills\arkcli-doctor` — arkcli doctor 诊断入口：用于火山方舟 Ark 报错、资源状态、用量配额、性能指标、错误码解释与修复建议；覆盖 doctor、doctor error、doctor infer-endpoint、doctor model、doctor metrics。用户给 Ark 错误码或错误 JSON、ep-xxx 接入点、模型名，问为什么报错、怎么修、状态/健康、用量/配额、限流、错误率、P99、Cache 命中率、接入点慢/挂、模型

- **arkcli-gen** — `C:\Users\yours\.agents\skills\arkcli-gen` — 火山方舟 Ark 图片/视频生成入口：用户要生图、画图、生成图片/视频、图生图、图生视频、参考图/视频/音频生成，或明确使用 seedream/seedance 创作新内容时使用 arkcli +gen。+gen 按当前 profile 的可用资源与模型 supported_params 生成；图片同步返回，视频提交后返回 task_id/status，需用 --wait 或 arkcli gen get/list 轮询并下载结果。反触

- **arkcli-helper** — `C:\Users\yours\.agents\skills\arkcli-helper` — arkcli helper:把 Claude Code / Codex / OpenCode / OpenClaw / Trae 配到火山方舟 Plan。用户说给当前或某个 Agent 配 MCP、豆包搜索、联网搜索、dataPro、OpenViking 时,用 `arkcli helper mcp`(只注入 MCP,不改 model);要连 model/provider 一起配用 `helper configure`;查状态用 `he

- **arkcli-infer-endpoint** — `C:\Users\yours\.agents\skills\arkcli-infer-endpoint` — arkcli 推理接入点**管理**能力：对**已有** Endpoint 做获取、列表、启动、停止、删除、更新（生命周期管理 + 启停 + 销毁）。优先使用产品命令 `arkcli infer endpoint ...`，而不是直接调用 Raw API。**反触发（重要）：用户说『创建/新建/create/部署/deploy 一个 endpoint/接入点』这类新建接入点的意图，一律走 arkcli-deploy（`+deploy`）

- **arkcli-models** — `C:\Users\yours\.agents\skills\arkcli-models` — arkcli 模型查询能力：列出、搜索、获取火山**公共基础模型**（foundation models）详情。优先使用产品命令 `arkcli models ...`，而不是直接调用 Raw API。注意：查询/管理账号下**自传或精调的自定义模型**（`cm-xxx`）走 arkcli-custommodel；本 skill 只覆盖公共基础模型目录。语音/TTS/ASR/播客/音色/实时语音交互模型只支持广场检索和选型说明，不要引导

- **arkcli-onboard** — `C:\Users\yours\.agents\skills\arkcli-onboard` — arkcli 接入向导(workflow):把某个模型接入到自己的应用/服务的端到端引导 —— 从'我想用某模型'到拿到可调用的 Endpoint(+ 可选示例代码)。当用户说'我想在我的 app/服务里用豆包/某模型''怎么把方舟模型接进来''帮我接入 XX 模型''想正式用上某模型'这类**不含 deploy/部署关键词、但本质是正式接入**的意图时触发。已明确说'部署/创建 endpoint'的直接走 arkcli-deploy;

- **arkcli-plans** — `C:\Users\yours\.agents\skills\arkcli-plans` — ARK 套餐管理(Agent Plan / Coding Plan,个人版 + 企业版):查询持有 / 购买 / 续费 / 模型清单 / 轮换 APIKey,**以及企业版席位的全部管理操作**:列出席位(`plans team seat-list`)、给员工分配席位(`plans team seat-assign`)、查谁绑了哪个 seat、轮换席位 APIKey(`plans team rotate-apikey`)。命中关键词:套

- **arkcli-pricing** — `C:\Users\yours\.agents\skills\arkcli-pricing` — 查询火山引擎 ARK 基础模型结算单价（含当前账号折扣）以及 AgentPlan / CodingPlan 套餐订阅价格。Price 字段就是后端按账号合同 / 活动 / 套餐折后的最终单价，OriginalPrice 是公示原价。当用户问模型多少钱、定价、单价、价格、Agent Plan 多少钱、Coding Plan 多少钱、套餐价格、折扣价、按 token 收费、不同模态价格对比、模型免费额度时使用。反触发：TTS/ASR/语音模

- **arkcli-profile** — `C:\Users\yours\.agents\skills\arkcli-profile` — arkcli profile 切面管理：列出、查看、新建、切换、删除、重命名 profile；管理 profile 内 API Key 列表；管理 plan 类 profile 的 default 模型（text/image/video）；设置某 modality 的默认资源 ID。0.1.16 把原 `arkcli config init/list/show/switch/delete` 全部迁过来，是 profile 类操作的唯一入

- **arkcli-resources** — `C:\Users\yours\.agents\skills\arkcli-resources` — arkcli resources 实时控制面查询：按 profile.type 派发，列出当前/指定 profile 下可用的 endpoint / plan 模型 ID 列表。read-only，不写 profile.yaml。change default 走 `arkcli profile set-default` 或 `+deploy --set-default`。

- **arkcli-shared** — `C:\Users\yours\.agents\skills\arkcli-shared` — arkcli 共享执行协议：首次配置入口、业务命令执行前的认证闸门、命令路由与选择顺序、输出/安全/二次确认规则。深度细节（身份解析、AK-SK 边界、API Key 恢复、实名闸门、profile 默认与漂移、全局 flags、故障分流）按需在 references/ 加载。当用户第一次使用 arkcli、遇到未登录/鉴权失败、需要判断该走产品命令还是 raw api、或任何 arkcli-* skill 需要公共上下文时触发。

- **arkcli-train-finetune** — `C:\Users\yours\.agents\skills\arkcli-train-finetune` — 使用 ArkCLI 创建、查询和管理模型精调训练任务，并从训练指标选择最佳 step、导出训练产物为 custom model、衔接模型仓库与推理部署。适用于选择可训练模型与训练方法、查询价格和超参数、校验训练文件、预览并创建任务、列出任务、观察或操作指定任务，以及根据效果指标导出和部署精调产物。本 skill 不负责数据集管理。

- **arkcli-understand** — `C:\Users\yours\.agents\skills\arkcli-understand` — arkcli +understand：多模态理解工作流，通过 12 个任务型 sub-skill（4 模态：image/video/audio/file）在数据面 Responses API 引擎上做专项理解。覆盖图片描述/OCR、视觉定位（bbox grounding）、GUI 操作识别、PDF/文档字段抽取、视频总结/视频问答、音视频联合理解、语音转写（ASR）、语音翻译（AST）、SRT 字幕打轴、多说话人转写、会议纪要。每个 s

- **arkcli-usage** — `C:\Users\yours\.agents\skills\arkcli-usage` — ARK 用量查询:`usage stats`(Token / 请求数,5-30 分钟延迟)、`usage plan` / `usage balance --type plan`(套餐额度快照)、`usage plan-details`(按模型时间序列,套餐内/外拆分)、`usage balance`(余额:免费额度 / 媒资库 / 套餐)、`usage seats --with-usage`(团队席位用量 by seat)。命中关键词:

<!-- cloude-code-toolbox:mcp-skills-awareness-end -->
