# Your first BOBOCLOUD project

[简体中文](getting-started.zh-CN.md) · [README](../README.md)

This walkthrough assumes no BOBOCLOUD experience. A **client** is the desktop editor on your computer; a **server** is the Linux machine that runs your program; a **runtime** is the chosen language/toolchain environment on that server. The special runtime named **Local** executes on the server host, not on your computer.

## 1. Get a desktop client

If your operator provides a packaged desktop client, install it and open BOBOCLOUD. Public packages, if available, are listed under [GitHub Releases](https://github.com/NemophilistJohn/BOBOcloud-A-cloud-based-remote-compilation-platform/releases); this repository does not imply every platform has a current prebuilt package.

To start from source, install Git and Node.js 22, then run:

```powershell
git clone https://github.com/NemophilistJohn/BOBOcloud-A-cloud-based-remote-compilation-platform.git
Set-Location BOBOcloud-A-cloud-based-remote-compilation-platform
npm ci --prefix client
npm start
```

Keep the terminal running while developing. This launches the actual Electron application, not a website. You do not need a local Python/Java/Go compiler to run the cloud example, but you do need a compatible server.

## 2. Connect, or start with local editing

The first-run guide opens Server settings. Ask your operator for the service host, HTTP and WebSocket ports, SSH/SFTP connection, and application login. The application account and the SSH account serve different purposes: the former authorizes cloud features; the latter synchronizes personal-project files.

For private HTTPS certificates, use the operator's trusted SHA-256 fingerprint. Do not fix a connection error by disabling certificate verification. Default listeners are HTTP(S) `3100`, WebSocket `3101`, and Node debug-child WebSocket `3102`; a proxy may use different public ports.

Choose **Use local editor only** if you only want to edit files. You can configure the server later. A local folder is not automatically a public or team repository.

## 3. Open the example folder

Copy [examples/cloud-tour](../examples/cloud-tour/) to a writable location outside the compiler repository and choose **Open Folder**. Open `main.py`, then select **Python 3.12**, or another available Python 3 runtime.

The example uses Python's standard library, so it needs no third-party install. Opening a `.py` file can select a compatible remembered/runtime choice, but check the title-bar runtime before running. `Local` has a different isolation policy; use a Docker Python runtime for this walkthrough.

## 4. Run and understand the output

Press **Run**. BOBOCLOUD saves dirty buffers, synchronizes the personal folder, requests a run, then streams the result. The expected program output is:

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

Read the summary separately from program output. It identifies the target, runtime, exit code, and elapsed time. Infrastructure details explain synchronization, queueing, container work, compilation, and artifacts; an informational warning is not automatically a failed program. **Exit code 0** means this example completed successfully.

Press **Stop** for a long run. A queued job can also be cancelled. Do not repeatedly press Run when the server reports resource pressure: inspect the state and wait for capacity.

## 5. Try real completion

Open Settings → code intelligence and select **Standard** analysis. Wait for the status bar to show the remote service is ready. On a temporary new line, type:

```python
stats.
```

The file imports `statistics as stats`; members such as `mean` and `median` come from that environment. Use arrow keys to navigate, Tab to accept, and Escape to dismiss. Undo the temporary line before running the program again.

Start with **Smart** cache strategy. **On demand** reduces idle work; **Project** prewarms more dependency summaries during idle periods. Disk persistence is separate. “Partial coverage” is useful cached data with limits, not a claim every API is available offline.

Learning is separate from AI inline generation: selecting a candidate or repeatedly writing a stable API use can affect later ranking without calling a model. Clear or disable learning in the same settings area. An API implemented dynamically may still need the remote language server.

## 6. Add a third-party dependency

For an eligible personal Python project, open **Environment → Dependencies**, search an exact package name such as `numpy`, inspect a compatible version, and confirm the proposed manifest change. Package Center can create a root `requirements.txt` when appropriate.

The change updates local dependency files, synchronizes them, installs into a staged server generation, verifies inventory, and publishes that generation. Let the operation finish before switching workspaces. A temporarily uncertain connection is reconciled with the original operation ID, so do not repeat an install blindly.

For Node projects, use a root `package.json` and the supported npm or pinned pnpm lock strategy. Yarn, Bun, mixed lockfiles, and Node workspaces are outside the managed subset. See [Project Dependency Center](../README.md#project-dependency-center).

Installing a library with desktop `pip` does not install it into a selected cloud runtime. Missing-import diagnostics are useful clues; the published environment inventory is the authoritative installed list.

## 7. Inspect a run record

Open **Personal center** from the account menu and choose **History** to inspect recent runs. Select your `main.py` record to see its run ID, runtime, target, workspace, timing, result, arguments when present, and retained output. Copy the output for a bug report. Long output may have an explicit omission marker; history is bounded, not an unlimited log archive or source-code backup.

## 8. Debug the same project

Use a supported Python runtime and deployed debugpy adapter. Click the editor gutter next to the `report = summarize(temperatures)` line, then press **Debug**. At the breakpoint inspect locals and the call stack, step into `summarize`, then continue or stop. You can save a launch configuration later; the built-in current-file configuration is enough to begin.

Debugging and language intelligence are independent services. A green LSP state does not prove a debugger image is installed. Supported launch adapters currently cover Python, Go, and Node.js; attach, compound launches, and debuggee stdin are not part of the documented subset.

## 9. Make the workbench yours

- Use **Cloud Forge** for the appearance shown in these demos; other built-in themes remain available.
- Use Quick Open to search filenames while the background index fills. Expanding one folder does not eagerly expand every directory.
- Separate sync badges, Git decorations, and Problems: they describe different states.
- Install optional extensions from Marketplace or a `.boboplugin` archive. Read permissions and compatibility in the extension detail page.
- Chat, AI inline completion, and the official Agent are optional. No model credential is required for the standard-library example or ordinary LSP completion.

## Troubleshooting

| Symptom | First check |
| --- | --- |
| Editing works, Run is unavailable | Server connection, application login, advertised capability, selected runtime. |
| TLS or upgrade failure | Correct public listener/port and trusted certificate pin; keep HTTPS/WSS consistent. |
| Import missing | Selected remote runtime and exact project dependency inventory, not desktop packages. |
| Completion feels cold | Ready state, cache mode/coverage, first module access, server resource pressure. |
| Files differ after a run | Local synchronization state and artifact messages; ordinary terminal edits are isolated. |
| Debug unavailable | Language/runtime-specific adapter availability, not just LSP availability. |
| Earlier output is absent | History/output retention limits; record the run ID and current omission marker. |

For a useful report, include application/server versions, OS, selected language/runtime, steps to reproduce, sanitized output, and run ID. Exclude passwords, keys, tokens, private source, and the Electron user-data directory.
