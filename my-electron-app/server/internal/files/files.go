package files

import (
	"encoding/base64"
	"fmt"
	"io"
	"log/slog"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"unicode/utf8"

	"bobocloud-server/internal/model"
	"bobocloud-server/internal/session"
)

// ============================================================
// files.go — 文件快照、拷贝、产物同步、产物发送
// ============================================================

// SnapshotFiles 遍历目录，返回 map[相对路径]FileSig
func SnapshotFiles(dir string) map[string]model.FileSig {
	snapshot := make(map[string]model.FileSig)
	if _, err := os.Stat(dir); os.IsNotExist(err) {
		return snapshot
	}

	filepath.Walk(dir, func(fullPath string, info os.FileInfo, err error) error {
		if err != nil {
			return nil
		}
		if info.IsDir() {
			return nil
		}
		relPath, err := filepath.Rel(dir, fullPath)
		if err != nil {
			return nil
		}
		relPath = filepath.ToSlash(relPath)
		snapshot[relPath] = model.FileSig{
			Size:    info.Size(),
			ModTime: info.ModTime().UnixNano(),
		}
		return nil
	})
	return snapshot
}

// CopyProjectToTemp 将源目录递归拷贝到目标目录。
// Linux 下优先使用 cp -a，其他平台回退到 Go 原生实现。
func CopyProjectToTemp(srcDir, dstDir string) error {
	if _, err := os.Stat(srcDir); os.IsNotExist(err) {
		return nil
	}

	if cpCmd := fastCopyCmd(srcDir, dstDir); cpCmd != nil {
		if err := cpCmd.Run(); err == nil {
			return nil
		}
	}

	return walkCopy(srcDir, dstDir)
}

func fastCopyCmd(srcDir, dstDir string) *exec.Cmd {
	if _, err := exec.LookPath("cp"); err != nil {
		return nil
	}
	return exec.Command("cp", "-a", srcDir+"/.", dstDir)
}

func walkCopy(srcDir, dstDir string) error {
	if err := os.MkdirAll(dstDir, 0755); err != nil {
		return err
	}

	entries, err := os.ReadDir(srcDir)
	if err != nil {
		return err
	}

	for _, entry := range entries {
		srcPath := filepath.Join(srcDir, entry.Name())
		dstPath := filepath.Join(dstDir, entry.Name())

		if entry.IsDir() {
			if err := walkCopy(srcPath, dstPath); err != nil {
				return err
			}
		} else {
			info, _ := entry.Info()
			mode := os.FileMode(0644)
			if info != nil {
				mode = info.Mode()
			}
			if err := copyFile(srcPath, dstPath, mode); err != nil {
				return err
			}
		}
	}
	return nil
}

func copyFile(src, dst string, mode os.FileMode) error {
	srcFile, err := os.Open(src)
	if err != nil {
		return err
	}
	defer srcFile.Close()

	dstFile, err := os.OpenFile(dst, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, mode)
	if err != nil {
		return err
	}
	defer dstFile.Close()

	buf := make([]byte, 1024*1024)
	if _, err := io.CopyBuffer(dstFile, srcFile, buf); err != nil {
		return err
	}
	return nil
}

// artifactIgnoredDirs 不回传为产物的目录名：
// 构建产物目录（.bobocloud/target/classes）、VCS/依赖目录。
// 与 runner 包的源码扫描忽略目录保持一致。
var artifactIgnoredDirs = map[string]bool{
	".git":         true,
	".bobocloud":   true, // 编译产物（二进制/classes）所在目录
	"target":       true, // Rust cargo 构建目录（体积可达数百 MB）
	"node_modules": true,
	"__pycache__":  true,
}

// ArtifactIgnored 判断 slash 相对路径是否不应作为产物回传
func ArtifactIgnored(relPath string) bool {
	for _, seg := range strings.Split(relPath, "/") {
		if artifactIgnoredDirs[seg] {
			return true
		}
	}
	return false
}

// maxArtifactSize 单个产物文件的回传上限（超过则跳过并记日志，
// 防止 base64 分块传输把 WebSocket 与客户端内存打爆）
const maxArtifactSize = 32 * 1024 * 1024 // 32MB

// SyncGeneratedArtifacts 比较前后快照，将变更的文件从临时目录拷回项目目录。
// 返回变更文件的相对路径列表（已过滤构建目录与超大文件）。
func SyncGeneratedArtifacts(tempDir, projectDir string, beforeSnapshot map[string]model.FileSig, sourceRelPath string) []string {
	afterSnapshot := SnapshotFiles(tempDir)
	var changed []string

	for relPath, sig := range afterSnapshot {
		if relPath == sourceRelPath {
			continue
		}
		if ArtifactIgnored(relPath) {
			continue
		}
		if sig.Size > maxArtifactSize {
			slog.Warn("Artifact too large, skipped", "path", relPath, "size", sig.Size)
			continue
		}
		beforeSig, existed := beforeSnapshot[relPath]
		if !existed || beforeSig != sig {
			changed = append(changed, relPath)
		}
	}

	for _, relPath := range changed {
		srcPath := filepath.Join(tempDir, relPath)
		dstPath := filepath.Join(projectDir, relPath)
		os.MkdirAll(filepath.Dir(dstPath), 0755)

		srcInfo, _ := os.Stat(srcPath)
		srcMode := os.FileMode(0644)
		if srcInfo != nil {
			srcMode = srcInfo.Mode()
		}

		if err := copyFile(srcPath, dstPath, srcMode); err != nil {
			slog.Error("Failed to sync artifact", "relPath", relPath, "error", err)
		} else {
			slog.Info("Saved generated artifact to server workspace", "path", dstPath)
		}
	}

	return changed
}

// SendArtifacts 将变更的文件通过 WebSocket Channel 分块发送给客户端
func SendArtifacts(channel *session.RunChannel, tempDir string, relPaths []string, chunkSize int) {
	if chunkSize <= 0 {
		chunkSize = 200000
	}
	for _, relPath := range relPaths {
		fullPath := filepath.Join(tempDir, relPath)
		if _, err := os.Stat(fullPath); os.IsNotExist(err) {
			continue
		}

		data, err := os.ReadFile(fullPath)
		if err != nil {
			channel.SendJSON(session.MakeStreamLine("stderr",
				fmt.Sprintf("Failed to read artifact %s: %v", relPath, err), ""))
			continue
		}

		fileType := "binary"
		content := base64.StdEncoding.EncodeToString(data)
		if isTextFile(data) {
			fileType = "text"
			content = string(data)
		}

		chunkCount := (len(content) + chunkSize - 1) / chunkSize
		if chunkCount < 1 {
			chunkCount = 1
		}
		for i := 0; i < chunkCount; i++ {
			end := (i + 1) * chunkSize
			if end > len(content) {
				end = len(content)
			}
			part := content[i*chunkSize : end]
			channel.SendJSON(session.MakeArtifact(relPath, fileType, i, chunkCount, part))
		}
	}
}

func isTextFile(data []byte) bool {
	sampleSize := len(data)
	if sampleSize > 1024 {
		sampleSize = 1024
	}
	for _, b := range data[:sampleSize] {
		if b == 0 {
			return false
		}
	}
	return utf8.Valid(data)
}
