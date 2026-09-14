# BOBOCLOUD server deployment

`Deploy-BoboCloudServer.ps1` is the reviewed Windows PowerShell release path
for the `production-81.70.51.43` profile. It deploys the Go server binary and
the reviewed `bobocloud.service` unit. On apply it provisions the dedicated
`bobocloud` account, validates Docker-socket access, installs the host TLS
certificate/key into `/etc/bobocloud/tls`, and repairs ownership of the
existing data/workspace trees while the service is stopped. It does not alter
Docker images or optional toolkits.

The script has no passwords, tokens, private key paths, or host-key bypasses.
It uses the current user's OpenSSH configuration and requires a verified host
key. By default it performs local preflight only. A real deployment requires
both `-Apply` and a typed `-ConfirmTarget 81.70.51.43`.

## Provision the host once

The apply path performs the one-time identity/TLS preparation below. To prepare
a host manually, run the equivalent commands as root:

```bash
groupadd --system bobocloud || true
useradd --system --gid bobocloud --home-dir /root/cloudeEditor/data --shell /usr/sbin/nologin bobocloud || true
usermod --groups docker bobocloud
install -d -o root -g bobocloud -m 0750 /etc/bobocloud/tls
install -d -o root -g bobocloud -m 0750 /etc/bobocloud
install -m 0640 -o root -g bobocloud deploy/bobocloud.env.example /etc/bobocloud/bobocloud.env
install -m 0644 deploy/bobocloud.service /etc/systemd/system/bobocloud.service
systemctl daemon-reload
systemctl enable bobocloud.service
```

Install the certificate and private key as root-owned files readable by the
`bobocloud` group (`0640` for the key, `0644` or `0640` for the certificate),
then set real per-host values in `/etc/bobocloud/bobocloud.env`. The unit pins
TLS and the data root again through `/usr/bin/env` at the final exec boundary,
because systemd gives `EnvironmentFile=` precedence over `Environment=`. Never add secrets
to the example file or unit. `Type=simple` is intentional because the Go
process does not implement `sd_notify`. Release readiness is checked by the
deployment script, not inferred from process creation.

The service retains `CAP_SYS_ADMIN` for the current LSP/DAP bind-anchor
implementation and keeps `PrivateMounts=false`; otherwise Docker cannot see
the validated projection mounts. The Docker group is also a root-equivalent
control-plane permission. A path-allowlisted root-owned mount helper and a
Docker socket proxy are the follow-up hardening items. When LSP or DAP is
enabled, `lsp_servers.json` and `dap_adapters.json` are required deployment
inputs; startup fails closed if either catalog is missing or invalid. The
release transaction also rechecks staged hashes after stopping the previous
process, closing the privileged-process time-of-check/time-of-use window.

## Build and preflight

From `server/deploy` in Windows PowerShell:

```powershell
.\Deploy-BoboCloudServer.ps1 -Target production-81.70.51.43 -Build
```

`-Build` performs a local `GOOS=linux GOARCH=amd64 CGO_ENABLED=0` build into
`server/release/bobocloud-server-linux-amd64`, verifies the ELF target, and
prints its SHA-256. Before compiling, it removes every prior
`bobocloud-server*` artifact from `server/release`; the directory is not a
binary snapshot store. To deploy a separately built artifact, replace `-Build`
with `-BinaryPath <absolute-path>`.

## Apply a release

```powershell
.\Deploy-BoboCloudServer.ps1 `
  -Target production-81.70.51.43 `
  -Build `
  -Apply `
  -ConfirmTarget 81.70.51.43 `
  -RemoteCAFile /etc/bobocloud/tls/bobocloud.crt
```

The order is fixed and observable:

1. Verify the local SHA-256 and Linux/amd64 ELF header.
2. Provision the non-root identity, Docker group check, protected TLS paths,
   and remote staging directory; upload one temporary new server binary and one
   temporary systemd unit.
3. Verify both remote SHA-256 values, install the unit to
   `/etc/systemd/system/bobocloud.service`, and run `systemctl daemon-reload`.
4. Stop `bobocloud.service`, delete all top-level `bobocloud-server*` deployed
   binary artifacts and any interrupted replacement file, then install exactly one official
   `/root/cloudeEditor/bobocloud-server` binary.
5. Start the service and wait for `GET /healthz`, `GET /readyz`, then
   `POST /` with `{"action":"serverInfo"}`.

The stop-through-verification portion is protected by a non-blocking remote
`flock`. A second release fails before it can stop or replace the service;
content-addressed uploads can still occur in parallel and are checked again
under the release lock.

The unit is bound to Docker availability and rejects symlinked executables,
configuration, catalogs, and TLS files at startup. This keeps an operator or a
stale release from redirecting the service through a replacement path.

There is deliberately no binary rollback snapshot. A failed deployment leaves
the newly uploaded staging artifact in `/root/cloudeEditor/.deploy` for an
operator to inspect; it is not an old version and is removed after a successful
start. The script does not silently restore or retain an older binary.

## TLS verification

When the server listener uses TLS, production verification must validate the
certificate chain. Supply the certificate authority file already present on the
server and the hostname covered by the certificate:

```powershell
.\Deploy-BoboCloudServer.ps1 `
  -Target production-81.70.51.43 `
  -Build `
  -Transport https `
  -ProbeHost cloud.example.com `
  -RemoteCAFile /etc/bobocloud/tls/ca.pem `
  -Apply `
  -ConfirmTarget 81.70.51.43
```

The HTTPS probe resolves that hostname to `127.0.0.1` on the server, so the
certificate name and chain are checked without exposing a separate probe port.
The script refuses HTTPS verification without `-RemoteCAFile` and never uses
`curl -k`.

## BOBOCLOUD server deployment (Chinese)

`Deploy-BoboCloudServer.ps1` 是 `production-81.70.51.43` 配置的受审查
Windows PowerShell 发布路径。它会替换 Go 服务端二进制和受审查的
`bobocloud.service` unit，并在停止服务期间把现有 `data/` 与工作区安全地
修复为 `bobocloud` 所有；不会修改 Docker 镜像或可选工具链。

脚本不包含密码、token、私钥路径，也不会绕过 SSH 主机密钥校验。默认只做本地预检；
真实发布必须同时提供 `-Apply` 与手工确认的
`-ConfirmTarget 81.70.51.43`。

首次配置服务器时，发布脚本会创建非 root 的 `bobocloud` 用户、加入 `docker` 组、
把证书/私钥安装到 `/etc/bobocloud/tls`，并将 `bobocloud.env.example` 复制为
`root:bobocloud`、权限 `0640` 的 `/etc/bobocloud/bobocloud.env`。真实密钥只可写入
该服务器上的受保护文件，不能写入示例、unit 或 Git。服务使用 `Type=simple` 是有意设计：Go 进程没有实现
`sd_notify`，发布脚本会在启动后验证 `/healthz`、`/readyz` 和 `serverInfo`。

在 Windows PowerShell 的 `server/deploy` 目录先执行预检：

```powershell
.\Deploy-BoboCloudServer.ps1 -Target production-81.70.51.43 -Build
```

`-Build` 会先删除 `server/release` 中全部旧 `bobocloud-server*` 产物，再本地交叉编译
Linux/amd64 二进制、检查 ELF 头和 SHA-256；该目录不保留二进制快照。确认无误后再加
`-Apply -ConfirmTarget 81.70.51.43`。发布时脚本先上传并校验临时的新二进制和 unit，
安装 `/etc/systemd/system/bobocloud.service` 并执行 `systemctl daemon-reload`，随后
停止服务，使用不跟随符号链接且跳过挂载锚点的方式修复状态目录，删除
`/root/cloudeEditor` 顶层所有旧的 `bobocloud-server*` 二进制产物和中断替换文件，
只安装一个正式二进制，最后启动并完成三项健康验证。

不会保留旧二进制或回滚快照。生产 TLS 发布必须指定服务器上的 CA 文件和证书覆盖的主机名，
例如 `-Transport https -ProbeHost cloud.example.com -RemoteCAFile
/etc/bobocloud/tls/ca.pem`；脚本不会使用 `curl -k`。
