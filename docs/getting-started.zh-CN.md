# 第一个 BOBOCLOUD 项目

[English](getting-started.en.md) · [README](../README.zh-CN.md)

本教程不要求有 BOBOCLOUD 使用经验。**客户端**是你电脑上的桌面编辑器，**服务端**是真正执行程序的 Linux 机器，**运行时**是选中的语言和工具链环境。名为 **Local** 的特殊运行时表示直接在服务器主机执行，不是在你的电脑执行。

## 1. 获取桌面客户端

如果管理员提供了安装包，安装并启动即可。已公开发布的包（如有）可在 [GitHub Releases](https://github.com/NemophilistJohn/BOBOcloud-A-cloud-based-remote-compilation-platform/releases) 查看；仓库存在不意味着每个平台都有当前版本的预构建包。

从源码启动时，先安装 Git 与 Node.js 22，然后运行：

```powershell
git clone https://github.com/NemophilistJohn/BOBOcloud-A-cloud-based-remote-compilation-platform.git
Set-Location BOBOcloud-A-cloud-based-remote-compilation-platform
npm ci --prefix client
npm start
```

开发期间保留终端。此命令启动真正的 Electron 应用，不是网站。运行云端示例不要求本机安装 Python、Java 或 Go 编译器，但需要兼容的云服务。

## 2. 连接服务，或先只编辑文件

首次向导会打开服务器设置。向管理员索取服务地址、HTTP/WS 端口、SSH/SFTP 连接和应用登录信息。应用账号与 SSH 账号用途不同：前者授权云功能，后者同步个人项目文件。

私有 HTTPS 证书应使用管理员提供且可信的 SHA-256 指纹，不要通过关闭证书校验来修复连接。默认 listener 分别为 HTTP(S) `3100`、WebSocket `3101`、Node 调试子会话 `3102`；代理后的公网端口可能不同。

只想编辑文件时可选**只使用本地编辑器**，以后再配置服务器。打开本地文件夹不会自动把它变成公开仓库或团队项目。

## 3. 打开示例文件夹

将 [examples/cloud-tour](../examples/cloud-tour/) 复制到编译器仓库外的可写位置，点击**打开文件夹**。打开 `main.py`，选择 **Python 3.12**，或服务器实际提供的其它 Python 3 版本。

示例只使用标准库，不需要安装第三方包。打开 `.py` 文件时可以根据记忆或可用目录选择运行时，但运行前仍请检查标题栏。`Local` 的隔离策略不同，本教程使用 Docker Python 运行时。

## 4. 运行并理解输出

点击**运行**。BOBOCLOUD 会保存未保存缓冲区、同步个人文件夹、请求运行并实时返回结果。程序预期输出为：

```text
BOBOCLOUD | Weather station report
Local source -> Linux runtime -> verifiable result
{
  "samples": 6,
  "mean": 20.75,
  "median": 20.75,
  "minimum": 18.5,
  "maximum": 23.0
}
```

运行摘要与程序输出分开阅读。摘要给出目标、运行时、退出码和耗时；基础设施详情解释同步、排队、容器、编译和产物。出现说明性警告不自动等于程序失败；本例**退出码为 0**表示成功完成。

长时间运行时可以点击**停止**，排队中的任务也能取消。服务器报告资源压力时，先查看状态并等待容量，不要连续点击运行。

## 5. 体验真实补全

在设置的代码智能页选择**标准**分析，等待状态栏显示远程服务就绪。在文件末尾临时新建一行，输入：

```python
stats.
```

文件导入了 `statistics as stats`，`mean`、`median` 等成员来自该环境。方向键选择、Tab 接受、Escape 取消。再次运行前撤销这条临时输入。

缓存先使用**智能**。**按需**减少空闲工作，**项目**在空闲时预热更多依赖摘要；磁盘持久化单独控制。“部分覆盖”表示已有数据可用且仍有边界，不表示所有 API 都能离线使用。

使用学习与 AI 行内生成不同：接受候选，或重复手写稳定的 API 使用，就能影响后续排序，不需要调用模型。同一设置区可清除或关闭学习。动态生成的 API 仍可能等待远程语言服务器。

## 6. 增加第三方依赖

符合条件的个人 Python 项目中，打开**环境 → 依赖**，按准确包名（例如 `numpy`）搜索，查看兼容版本，再确认清单变更。适合时，依赖中心可以创建根目录 `requirements.txt`。

操作会更新本地依赖文件、同步、安装到服务端暂存代、校验清单，最后发布。完成前不要切换工作区。开始应用后遇到连接不确定，会按原 operation ID 对账，不要盲目再安装一次。

Node 项目使用根目录 `package.json` 和受支持的 npm 或固定 pnpm 锁策略。Yarn、Bun、混合锁文件与 Node workspaces 不属于受管子集，详见[项目依赖中心](../README.zh-CN.md#项目依赖中心)。

在桌面电脑运行 `pip install` 不会把库装进所选云环境。缺少导入诊断可以帮助定位问题，但已发布环境清单才是安装事实。

## 7. 查看运行记录

从账户菜单打开**个人中心**，进入**历史记录**查看最近运行。选择自己的 `main.py` 记录，查看运行 ID、运行时、目标、工作区、时间、结果、可用参数及保留输出。可以复制输出用于反馈。长输出可能有明确省略标记；历史不是无限日志归档，也不是源码备份。

## 8. 调试同一项目

选择受支持的 Python 运行时，并确认服务端已部署 debugpy adapter。点击 `report = summarize(temperatures)` 所在行左侧栏添加断点，再点击**调试**。暂停后查看局部变量和调用栈、单步进入 `summarize`，最后继续或停止。以后可以保存 launch 配置，入门使用内置当前文件配置即可。

调试与语言智能是独立服务，LSP 绿色不代表调试器镜像已安装。目前 launch adapter 覆盖 Python、Go、Node.js；attach、复合启动和被调试程序 stdin 不属于文档承诺的子集。

## 9. 按自己的习惯使用工作台

- 本次演示统一使用 **Cloud Forge**，也可选择其它内置主题。
- Quick Open 在后台索引填充期间就能搜索文件名；展开一个文件夹不会提前展开所有目录。
- 同步徽标、Git 装饰与 Problems 分别描述不同状态。
- 从市场或 `.boboplugin` 安装可选扩展，在详情页查看权限与兼容性。
- 聊天、AI 行内补全与官方 Agent 均可选；标准库示例及普通 LSP 补全不需要模型密钥。

## 常见问题

| 现象 | 优先检查 |
| --- | --- |
| 能编辑，不能运行 | 服务连接、应用登录、公布能力、选中的运行时。 |
| TLS 或升级握手失败 | 真实公网 listener/端口和可信指纹，HTTPS/WSS 是否一致。 |
| 找不到导入 | 当前远程运行时与精确项目依赖清单，而非桌面电脑安装的包。 |
| 补全首次较慢 | 就绪状态、缓存模式/覆盖、首次模块访问、服务资源压力。 |
| 运行前后文件不同 | 本地同步状态和产物说明；普通终端编辑位于隔离副本。 |
| 无法调试 | 对应语言和运行时的 adapter，不能只看 LSP。 |
| 以前的输出不见了 | 历史/输出保留上限，记录 run ID 及省略标记。 |

反馈问题时提供应用/服务版本、操作系统、语言/运行时、复现步骤、脱敏输出和 run ID。不要附带密码、Key、Token、私有源码或 Electron user-data 目录。
