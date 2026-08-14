package runner

import (
	"os"
	"path"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
)

// ============================================================
// collect.go — 规划期源码收集与项目探测辅助
//
// 全部基于"相对路径列表 + 宿主机目录只读扫描"，不触碰执行环境，
// 因此同一份逻辑对 Docker 与本地模式都成立。
// ============================================================

// sourceScanIgnoredDirs 收集源文件 / 探测清单时跳过的目录名。
// 与 files.ArtifactIgnored 保持一致：这些目录要么是 VCS/依赖目录，
// 要么是构建产物目录（target/.bobocloud 等），不属于"用户源码"。
var sourceScanIgnoredDirs = map[string]bool{
	".git":         true,
	".bobocloud":   true,
	"node_modules": true,
	"target":       true, // Rust cargo 构建目录
	"build":        true,
	"dist":         true,
	"out":          true,
	"__pycache__":  true,
	".venv":        true,
	"venv":         true,
	"classes":      true,
}

// pathIgnored 判断 slash 相对路径是否落在被忽略的目录中
func pathIgnored(relPath string) bool {
	for _, seg := range strings.Split(relPath, "/") {
		if sourceScanIgnoredDirs[seg] {
			return true
		}
	}
	return false
}

// CollectSources 从项目文件列表中按扩展名收集源文件（忽略依赖/构建目录），
// 返回排序后的 slash 相对路径。exts 形如 [".c", ".h"]（小写带点）。
func CollectSources(projectFiles []string, exts []string) []string {
	extSet := make(map[string]bool, len(exts))
	for _, e := range exts {
		extSet[e] = true
	}
	var out []string
	for _, f := range projectFiles {
		if pathIgnored(f) {
			continue
		}
		if extSet[strings.ToLower(path.Ext(f))] {
			out = append(out, f)
		}
	}
	sort.Strings(out)
	return out
}

var cFamilyMainDefinition = regexp.MustCompile(`(?m)^[\t ]*(?:(?:static|extern|inline|constexpr|signed|unsigned|long|short|int|void|auto)[\t \r\n*]+)+main[\t \r\n]*\(`)

// SelectCFamilyProgram keeps the requested entry and helper translation units,
// while excluding sibling exercises/applications that define their own main.
// Without this distinction, running one root-level C file compiles every C
// example in the workspace and usually fails with duplicate main symbols.
func SelectCFamilyProgram(hostWorkDir, entryRel string, sources []string) []string {
	selected := make([]string, 0, len(sources))
	for _, source := range sources {
		if source == entryRel {
			selected = append(selected, source)
			continue
		}
		content, err := readHostFile(hostWorkDir, source, 256*1024)
		if err == nil && cFamilyMainDefinition.MatchString(content) {
			continue
		}
		selected = append(selected, source)
	}
	sort.Strings(selected)
	return selected
}

// FilterUnderDir 过滤出位于 dir 子树内的文件（dir 为 slash 相对目录，"" 表示项目根）。
func FilterUnderDir(files []string, dir string) []string {
	dir = strings.Trim(dir, "/")
	if dir == "" {
		return files
	}
	prefix := dir + "/"
	var out []string
	for _, f := range files {
		if strings.HasPrefix(f, prefix) {
			out = append(out, f)
		}
	}
	return out
}

// DirOf 返回 slash 相对路径的目录部分（"" 表示项目根，替代 path.Dir 的 "."）。
func DirOf(relPath string) string {
	d := path.Dir(relPath)
	if d == "." || d == "/" {
		return ""
	}
	return strings.Trim(d, "/")
}

// BaseOf 返回 slash 相对路径的文件名部分
func BaseOf(relPath string) string {
	return path.Base(relPath)
}

// FindUpward 从 startDir 开始逐级向上（直到项目根）查找名为 name 的文件，
// 返回其所在目录（"" = 项目根）；未找到返回 ok=false。
// 用于探测 go.mod / Cargo.toml / package.json 等项目清单。
func FindUpward(projectFiles []string, startDir, name string) (dir string, ok bool) {
	fileSet := make(map[string]bool, len(projectFiles))
	for _, f := range projectFiles {
		fileSet[f] = true
	}
	d := strings.Trim(startDir, "/")
	for {
		candidate := name
		if d != "" {
			candidate = d + "/" + name
		}
		if fileSet[candidate] {
			return d, true
		}
		if d == "" {
			return "", false
		}
		d = DirOf(d)
	}
}

// readHostFile 读取宿主机项目目录下的文件（规划期使用，限制大小防超大文件）
func readHostFile(hostWorkDir, relPath string, maxBytes int64) (string, error) {
	full := filepath.Join(hostWorkDir, filepath.FromSlash(relPath))
	f, err := os.Open(full)
	if err != nil {
		return "", err
	}
	defer f.Close()
	buf := make([]byte, maxBytes)
	n, _ := f.Read(buf)
	return string(buf[:n]), nil
}

var javaPackageRe = regexp.MustCompile(`(?m)^\s*package\s+([a-zA-Z_][a-zA-Z0-9_.]*)\s*;`)

// ParseJavaPackage 解析 Java 文件的 package 声明（找不到返回 ""）
func ParseJavaPackage(hostWorkDir, entryRel string) string {
	content, err := readHostFile(hostWorkDir, entryRel, 8192)
	if err != nil {
		return ""
	}
	m := javaPackageRe.FindStringSubmatch(content)
	if m == nil {
		return ""
	}
	return m[1]
}

// ParseCargoBinaryName 从 Cargo.toml 解析二进制名：
// 优先第一个 [[bin]] 的 name，否则 [package] 的 name。
func ParseCargoBinaryName(hostWorkDir, cargoDir string) string {
	rel := "Cargo.toml"
	if cargoDir != "" {
		rel = cargoDir + "/Cargo.toml"
	}
	content, err := readHostFile(hostWorkDir, rel, 65536)
	if err != nil {
		return ""
	}
	section := ""
	pkgName := ""
	binName := ""
	for _, line := range strings.Split(content, "\n") {
		trimmed := strings.TrimSpace(line)
		if strings.HasPrefix(trimmed, "#") {
			continue
		}
		if strings.HasPrefix(trimmed, "[") {
			section = trimmed
			continue
		}
		if strings.HasPrefix(trimmed, "name") {
			kv := strings.SplitN(trimmed, "=", 2)
			if len(kv) != 2 {
				continue
			}
			val := strings.Trim(strings.TrimSpace(kv[1]), "\"'")
			switch section {
			case "[[bin]]":
				if binName == "" {
					binName = val
				}
			case "[package]":
				if pkgName == "" {
					pkgName = val
				}
			}
		}
	}
	if binName != "" {
		return binName
	}
	return pkgName
}

// ContainsFlag 判断参数列表中是否含有某标志（精确匹配，或前缀匹配形如 --release）
func ContainsFlag(args []string, flag string) bool {
	for _, a := range args {
		if a == flag {
			return true
		}
	}
	return false
}
