# Cloud tour / 云端开发演示

This is the small project used in the 2026-11-24 documentation recordings. Copy this folder to a writable location outside the compiler repository, open it in BOBOCLOUD, select an available Docker Python 3 runtime, and run `main.py`. No third-party packages or model keys are needed. The recording used Python 3.12 and **Cloud Forge**.

这是 2026-11-24 文档录制使用的小项目。将此目录复制到编译器仓库之外的可写位置，用 BOBOCLOUD 打开，选择实际可用的 Docker Python 3 运行时，再运行 `main.py`。无需第三方包或模型 Key，录制使用 Python 3.12 和 **Cloud Forge**。

Expected values / 预期结果：

```json
{
  "samples": 6,
  "mean": 20.75,
  "median": 20.75,
  "minimum": 18.5,
  "maximum": 23.0
}
```

- Completion: enable Standard analysis, wait for readiness, type `stats.` on a temporary final line, and inspect `statistics` members. Undo the temporary line before running again.
- 补全：启用标准分析并等待就绪，在文件末尾临时输入 `stats.` 查看 `statistics` 成员，再次运行前撤销该行。
- Debugging: set a breakpoint on `report = summarize(temperatures)`, start a supported Python debug adapter, inspect variables, step into the function, then continue/stop.
- 调试：在 `report = summarize(temperatures)` 设置断点，使用已部署的 Python adapter 启动调试，查看变量、进入函数，最后继续/停止。
- History: after a real run, select its record using the title-bar clock. Run IDs and timings vary; deterministic sample values do not.
- 历史：真实运行后通过标题栏时钟选择记录。run ID 与耗时会变化，示例统计值不变。

The unused `Path` import is retained to match the recorded source; it is not required by the report. The example does not generate an artifact file. Any runtime infrastructure warning belongs to the actual service response, not to these expected JSON values.

未使用的 `Path` 导入保留以对应录制源码，统计程序本身不需要它。示例不生成产物文件；运行基础设施警告属于服务实际返回，不属于上述 JSON 预期值。

## Optional NumPy example / 可选 NumPy 示例

After the standard-library tour, install `numpy` through Project Dependency Center in your copied project, then run `numpy_demo.py`. The documentation session installed NumPy **2.5.5** into its own Python 3.12 project generation and verified `mean=20.75`; this is a recorded version, not a universal recommendation or a promise that every catalog keeps it. Package Center creates/updates the project's requirements file. Member completion is shown after environment and analyzer warmup, separately from the cold install.

完成标准库流程后，可在复制的项目中通过依赖中心安装 `numpy`，再运行 `numpy_demo.py`。本次文档会话实际将 NumPy **2.5.5** 安装到自己的 Python 3.12 项目依赖代，核验得到 `mean=20.75`；这是记录版本，不是适用所有环境的版本建议，也不保证每个目录都永久保留它。依赖中心会创建或更新 requirements 文件。成员补全展示的是环境和分析器已预热的状态，与首次安装分开说明。

[English walkthrough](../../docs/getting-started.en.md) · [中文教程](../../docs/getting-started.zh-CN.md) · [Media / 素材说明](../../docs/media/README.md)
