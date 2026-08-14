package security

import "strings"

// ============================================================
// policy.go — 安全策略接口 + 实现
// ============================================================

// Policy 定义容器安全策略
type Policy interface {
	AllowCommand(cmd string) bool
	AllowNetwork(runtimeID string) bool
	FilterCommand(cmd string) string
}

// ---------- PermissivePolicy（宽松策略：全部放行）----------
//
// 仅用于本地调试或受信任环境。生产环境请使用 RestrictivePolicy。
type PermissivePolicy struct{}

func NewPermissivePolicy() *PermissivePolicy {
	return &PermissivePolicy{}
}

func (p *PermissivePolicy) AllowCommand(cmd string) bool {
	return true
}

func (p *PermissivePolicy) AllowNetwork(runtimeID string) bool {
	return true
}

func (p *PermissivePolicy) FilterCommand(cmd string) string {
	return cmd
}

// ---------- RestrictivePolicy（限制策略：生产默认）----------
//
// 不再无条件放行：
//   - AllowCommand：拒绝一组明显的容器逃逸原语（nsenter/unshare/docker/...）。
//     注意：容器层的 --cap-drop=ALL 已经从内核能力上封锁了这些操作，
//     这里的命令黑名单只是第二道防线，给出清晰错误而非 EPERM。
//     黑名单刻意保守，避免误伤用户合法的 setup 命令（pip/apt/cargo 等）。
//   - AllowNetwork：尊重配置项 docker_default_network（默认 true，因为
//     pip/cargo 等包管理器需要联网）。可通过 NetworkAllowlist 按运行时精细化放行。
//   - FilterCommand：暂不做改写（隔离已下沉到容器层）。

// RestrictivePolicy 限制性安全策略。
type RestrictivePolicy struct {
	DefaultNetwork   bool            // 未在 allowlist 中指定的运行时是否允许联网
	NetworkAllowlist map[string]bool // runtimeID → 是否允许联网（覆盖 DefaultNetwork）
}

// NewRestrictivePolicy 创建限制性策略。defaultNetwork 通常来自 cfg.DockerDefaultNetwork。
func NewRestrictivePolicy(defaultNetwork bool) *RestrictivePolicy {
	return &RestrictivePolicy{
		DefaultNetwork:   defaultNetwork,
		NetworkAllowlist: make(map[string]bool),
	}
}

// SetNetworkAllowlist 设置按运行时的网络放行表（runtimeID → 是否放行）。
func (p *RestrictivePolicy) SetNetworkAllowlist(m map[string]bool) {
	p.NetworkAllowlist = m
}

// deniedCommands 列出在代码运行器中没有合法用途、仅用于容器逃逸/提权的命令。
// 仅匹配命令起始（后接空白或结尾），避免误伤形如 "mountain" 之类的合法命令。
var deniedCommands = []string{
	"nsenter", // 命名空间逃逸
	"unshare", // 创建新命名空间
	"docker",  // 宿主 docker socket 逃逸（即便未挂载 socket，也禁止）
	"ctr",     // containerd CLI
	"runc",    // 直接调用 runc
	"mount",   // 挂载文件系统（cap-drop 已封锁，这里给清晰错误）
	"umount",  // 卸载文件系统
}

func (p *RestrictivePolicy) AllowCommand(cmd string) bool {
	c := strings.TrimSpace(cmd)
	if c == "" {
		return true
	}
	lower := strings.ToLower(c)
	for _, d := range deniedCommands {
		if lower == d || strings.HasPrefix(lower, d+" ") || strings.HasPrefix(lower, d+"\t") {
			return false
		}
	}
	return true
}

func (p *RestrictivePolicy) AllowNetwork(runtimeID string) bool {
	if v, ok := p.NetworkAllowlist[runtimeID]; ok {
		return v
	}
	return p.DefaultNetwork
}

func (p *RestrictivePolicy) FilterCommand(cmd string) string {
	return cmd
}
