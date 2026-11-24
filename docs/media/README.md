# Documentation media / 文档素材

## Provenance / 来源

Captured on **2026-11-24** in the actual Electron application, using the owner's authorized **root** application account and a newly created personal project named `BOBOCLOUD-Showcase-20261124`. The source is reproduced in [examples/cloud-tour](../../examples/cloud-tour/). The selected runtime was **Python 3.12**, backed by the configured Linux service. Every final live capture uses **Cloud Forge**. No model calls were needed.

于 **2026-11-24** 在真实 Electron 应用采集，使用所有者授权的 **root** 应用账号，新建个人项目 `BOBOCLOUD-Showcase-20261124`。源码见 [examples/cloud-tour](../../examples/cloud-tour/)，选用真实 Linux 服务的 **Python 3.12**。最终实录全部使用 **Cloud Forge**，不需要调用模型。

## Published assets / 已发布素材

| Asset / 素材 | Meaning / 内容 |
| --- | --- |
| `live-workbench-en.png`, `live-workbench-zh-CN.png` | A real completed run and its output / 真实成功运行及输出。 |
| `live-completion-en.png`, `live-completion-zh-CN.png` | Actual module-member completion / 实际模块成员补全。 |
| `live-lsp-settings-en.png`, `live-lsp-settings-zh-CN.png` | Three cache strategies, persistence, learning, and budget / 三策略、持久化、学习与预算。 |
| `live-history-en.png`, `live-history-zh-CN.png` | Actual run metadata and retained output / 真实运行元数据及保留输出。 |
| `live-dependencies-en.png`, `live-dependencies-zh-CN.png` | NumPy installed through a real project transaction / 通过真实项目事务安装的 NumPy。 |
| `live-environment-en.png`, `live-environment-zh-CN.png` | Exact inventory and environment health / 精确安装清单与环境健康状态。 |
| `live-numpy-completion-en.png`, `live-numpy-completion-zh-CN.png` | Actual `np.a` candidates after analyzer warmup / 分析器预热后真实 `np.a` 候选。 |
| `cloud-tour-en.gif`, `cloud-tour-zh-CN.gif` | Captioned, edited screenshot sequence of the live workflow / 加字幕的真实工作流截图节选。 |

The GIFs use standard GIF animation and the stills use PNG, with repository-relative Markdown embeds that GitHub can display directly. Each GIF is approximately 11.4 seconds and under 1 MB. Mermaid diagrams in the Markdown are source diagrams rendered by GitHub; no unsupported HTML video player is required.

GIF 为标准动画格式，静态图为 PNG，通过仓库相对 Markdown 链接直接展示。每段 GIF 约 11.4 秒、小于 1 MB。Markdown 内的 Mermaid 由 GitHub 原生渲染，不依赖不兼容的 HTML 视频播放器。

## What was edited / 做过哪些编辑

- The actual workbench language was switched for the paired captures; output values were not translated or fabricated.
- 中英截图切换真实工作台语言，程序输出数值未翻译或伪造。
- The GIF is a sequence of actual screenshots, resized with an external caption strip. Pauses are shortened; it is **not** a continuous real-time latency measurement. Captions describe the observed workflow, not a measured speedup.
- GIF 由真实截图组成，缩放后添加外部字幕条，等待被缩短，**不是**连续实时延迟测量；字幕描述工作流，不代表测出的加速比。
- Unrelated rows in the root account's run-history dialog were excluded from the capture. The displayed demonstration record, run ID, metadata, and output are genuine.
- 运行历史对话框排除了 root 账号其它项目的行，展示的演示记录、run ID、元数据及输出都是真实数据。
- The service's warning `Artifact safety limits omitted 1 known files` is retained. The program exited with code 0; the recording does not claim all artifact handling was warning-free. The standard-library example creates no report file.
- 保留服务返回的 `Artifact safety limits omitted 1 known files` 警告；程序退出码为 0，但不声称产物处理毫无警告。标准库示例不生成报告文件。

## Reproduce responsibly / 如何重新采集

1. Build the current renderer and launch a dedicated Electron profile. Use an explicitly authorized account and a new demo project; never overwrite someone's working project.
2. 构建当前 Renderer，使用独立 Electron profile、明确授权的账号及新演示项目，不覆盖现有工作项目。
3. Select Cloud Forge, choose English/Chinese, and capture the actual UI through the repository's Electron Playwright tooling. Wait for real ready/result states; do not inject fake success, output, package inventory, or latency.
4. 选择 Cloud Forge 和中/英文，通过仓库的 Electron Playwright 工具采集，等待真实就绪/结果，不注入假成功、输出、安装清单或延迟。
5. Keep raw frames and any authenticated profile under ignored `output/playwright/`, never in this directory. Remove credentials, unrelated history/source, local private paths, and account/server settings from published content.
6. 原始帧和认证 profile 放在被忽略的 `output/playwright/`，不要放在本文目录。发布内容不能含凭据、无关历史/源码、私有路径及账号/服务器设置。
7. Create a JSON frame list with `file`, `duration` (milliseconds), `en`, and `zh`. Use a local CJK-capable font and Pillow:
8. 建立含 `file`、`duration`（毫秒）、`en`、`zh` 的帧列表，使用本地支持中文的字体及 Pillow：

```powershell
python -m pip install Pillow
python scripts/docs/build-tour-gif.py output/playwright/frames.json docs/media/cloud-tour-en.gif --locale en --font C:/Windows/Fonts/msyh.ttc
python scripts/docs/build-tour-gif.py output/playwright/frames.json docs/media/cloud-tour-zh-CN.gif --locale zh --font C:/Windows/Fonts/msyh.ttc
```

The renderer reads screenshots and captions only. Review every frame at readable size, verify filenames/links, and inspect Git staging before publishing. The font is used locally for rasterization and is not copied into the repository.

渲染脚本只读取截图和字幕。发布前以可读大小查看每帧，核对链接与文件名，并审查 Git 暂存内容。字体只在本机栅格化时使用，不复制进仓库。

## Legacy fixtures / 旧版夹具图

`docs/screenshots/` is maintained by `npm run docs:screenshots`. Those images intentionally use local UI fixtures, including illustrative output, package inventory, and AI settings. They show interface layout, not live cloud results, published package availability, or benchmark evidence. Their nature must remain explicit wherever they are reused.

`docs/screenshots/` 由 `npm run docs:screenshots` 维护，使用本地 UI fixture，包括示例输出、依赖清单与 AI 配置。它们展示布局，不是真实云结果、已发布包可用性或性能证据，再使用时必须注明性质。
