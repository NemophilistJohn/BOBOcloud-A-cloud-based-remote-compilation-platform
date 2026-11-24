# 开发第一个 BOBOCLOUD 插件

[English](plugin-quickstart.en.md) · [README](../README.zh-CN.md) · [完整 API](plugin-api.md)

当前宿主为桌面端 **2.8.1**、Plugin API **1.11.0**。公开契约以 [SDK 声明](../client/plugin-sdk/bobocloud-plugin.d.ts) 为准，不是 `window.BOBO`、Electron IPC、内部 Renderer 服务或 VS Code 扩展 API。

## 1. 选择合适入口

| 想实现什么 | 使用入口 | 边界 |
| --- | --- | --- |
| 命令或编排模块 | Schema 1，单个打包 ESM 激活入口。 | 隔离 Worker，没有任意 DOM、Node、文件系统、shell 或网络。 |
| 文件查看器/编辑器 | Schema 2 文档视图入口与声明资源。 | 独立不透明 iframe，只取得当前文档句柄。 |
| 本地 Git 工作流 | 专用源码管理/Git 接口与 SCM 装饰通道。 | 结构化宿主操作，不是任意 `git` shell。 |
| Agent | `agents`、`models`、`tools`、`skills`、`storage`。 | 模型密钥、工具审批、工作区解析和进程执行由宿主拥有。 |
| Notebook 工作流 | 受支持的范围受限文档读写/分析/执行接口。 | 根据运行时通过宿主执行，不能直接拿远程 shell。 |

声明通用 `menus`、`tasks`、`settings`、`languages`、`ai.tools`、`mcp.providers`、`skills.providers` 不会自动创建可见/可执行集成。依赖名称前先核对[已实现与保留接口](plugin-development.md#contributions)。

## 2. 从真实包开始

将 [hello-plugin](../client/examples/plugins/hello-plugin/) 复制到独立插件仓库。它已有有效 integrity hash 和最小命令权限，目录结构为：

```text
hello-plugin/
  manifest.json
  dist/
    extension.js
```

激活模块导出 `activate(context)`：

```js
export async function activate(context) {
  await context.commands.register(
    'example.hello-plugin.hello',
    () => ({ message: 'Hello from an isolated BOBOCloud plugin.' }),
    { title: 'Hello Plugin: Say Hello', category: 'Extensions' }
  );
}
```

插件与命令使用独特的反向域名式命名空间。修改命令标题也会改变字节，安装前需要重算 integrity。这个简单示例用于展示契约，生产可见文字应通过英文、简体中文和日文资源解析。

## 3. 读懂 manifest

- `schemaVersion`：仅激活模块使用 1，声明文档视图/资源使用 2。
- `id`、`version`：稳定身份与语义版本。
- `engines.bobocloud` 与 `engines.pluginApi`：两者都必须匹配。声明所需能力的最早版本，不盲目要求最新版。
- `main`：一个自包含 ESM bundle，不是带运行时 imports 的 Node 项目。
- `activationEvents`：校验必填，不要假定任意惰性事件分发均已实现。
- `permissions`：仅声明具体已支持能力，声明名称不能创建新 API。
- `integrity.files`：每个非 manifest 文件的精确 SHA-256，包括语言包与视图资源。

允许字段见[完整 manifest 参考](plugin-development.md#3-manifest-reference)。不要加任意顶层元数据或本机可执行文件。未知字段、路径穿越、符号链接、不支持的压缩格式、缺失/多余 integrity 文件会被拒绝。

## 4. 打包与安装

对未修改的仓库示例，从编译器仓库根目录执行：

```powershell
Set-Location client/examples/plugins/hello-plugin
python -m zipfile -c hello-plugin.boboplugin manifest.json dist
```

压缩包根目录必须直接包含 `manifest.json` 与 `dist/extension.js`，外面多套一层 `hello-plugin/` 是错误的。Python 只是方便的 ZIP 工具，不是插件运行依赖。不要把生成的包提交到编译器仓库。

修改文件后，按 [integrity map 示例](plugin-development.md#4-integrity-map-and-packaging) 重算哈希，再重建压缩包，不要保留上一次构建的 hash。

打开**扩展 → 安装 .boboplugin 包**，选择文件，检查结果和详情页，并在命令面板找到注册的命令。当前行为是校验兼容的包安装后默认启用，并授予声明权限；可在详情逐项检查/撤销，替换版本会恢复声明的默认权限。“官方”不绕过验证，也不会获得未声明权限。

## 5. 让 Worker 保持简单

依赖打包进入口，跨边界只传有界普通 JSON 类数据。把 `Error`、`Map`、`Set`、类实例等转成普通记录，不传函数或 DOM 节点。

使用可释放订阅，停用保持有界和幂等。即使失败，宿主也清除其拥有的注册，但插件仍需停止自己的工作。显式处理权限撤销、工作区切换、模型取消、文档句柄过期、禁用和操作失效。

Agent Worker 不能给自己批准权限，只提交结构化工具请求；可信宿主确定规范动作与审批。`full` 只改变批准行为，不改变路径限制、权限、可执行文件校验、配额与取消。模型引用和 Skill ID 不透明，不是 Key 或绝对路径。

## 6. 测试真实安装包

1. 从全新压缩包安装，不使用开发目录捷径，检查完整性与 API 范围。
2. 调用命令后禁用/启用，确认注册消失并恢复。
3. 撤销必需权限，验证清晰失败，不回退更宽的内部接口。
4. 切换工作区、关闭/重开视图，旧句柄或结果不能作用于新项目。
5. 检查英文、简体中文、日文布局，以及失败/缓慢激活。
6. 文档插件分别验证隔离 DOM 和读写/执行权限，只读查看器不得顺带获得执行权。
7. 修改宿主 API 时，运行主进程/broker/协议/Renderer/SDK/真实 Electron 对应测试，不只测试插件单元逻辑。

## 7. 独立发布

先在插件仓库发布不可变版本和归档，再按顺序更新 Registry：版本描述 → package index → official 分片 → 根 registry。归档 hash 覆盖精确字节；Registry JSON hash 使用文档约定的文本规范。远端产物与完整链验证后，才能说发布已生效。

不要改写已发布 tag/descriptor 来改变兼容性，应发布新语义版本。编译器提交、插件发布、Registry 提交分开处理。完整打包、限制、权限和错误行为见[插件开发指南](plugin-development.md)与 [Plugin API](plugin-api.md)。
