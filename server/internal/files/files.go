package files

import (
	"context"
	"encoding/base64"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"log/slog"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"unicode/utf8"

	"bobocloud-server/internal/model"
	"bobocloud-server/internal/safefile"
	"bobocloud-server/internal/session"
)

var projectCopyBuffers = sync.Pool{New: func() any {
	buffer := make([]byte, 128*1024)
	return &buffer
}}

// ============================================================
// files.go — 文件快照、拷贝、产物同步、产物发送
// ============================================================

const (
	defaultArtifactMaxFiles        = 128
	defaultArtifactMaxTotalBytes   = int64(64 << 20)
	maximumArtifactMaxFiles        = 4096
	maximumArtifactMaxTotalBytes   = int64(4 << 30)
	MaxArtifactFileBytes           = int64(32 << 20)
	MaxArtifactPathBytes           = 4096
	defaultArtifactScanEntries     = 4096
	maximumArtifactScanEntries     = 400000
	defaultArtifactScanDepth       = 128
	artifactDirectoryReadBatch     = 128
	DefaultProjectCopyMaxFiles     = 20000
	DefaultProjectCopyMaxBytes     = int64(1 << 30)
	DefaultProjectCopyMaxPathBytes = 4096
	maximumProjectCopyMaxFiles     = 100000
	maximumProjectCopyMaxBytes     = int64(8 << 30)
	maximumProjectScanEntries      = 400000
	defaultProjectCopyDepth        = 128
)

var (
	errArtifactScanStopped = errors.New("artifact scan budget reached")
	ErrProjectCopyLimit    = errors.New("project workspace exceeds the configured copy limit")
)

type ArtifactLimits struct {
	MaxFiles       int
	MaxTotalBytes  int64
	MaxFileBytes   int64
	MaxPathBytes   int
	MaxScanEntries int
	MaxDepth       int
}

type ArtifactSnapshot struct {
	Files          map[string]model.FileSig
	OmittedFiles   int
	TotalBytes     int64
	ScannedEntries int
	Truncated      bool
	LimitReached   bool
}

type ProjectCopyLimits struct {
	MaxFiles      int
	MaxTotalBytes int64
	MaxPathBytes  int
}

type treeWalkStats struct {
	OmittedFiles   int
	ScannedEntries int
	Truncated      bool
}

type regularTreeLimits struct {
	MaxFileBytes   int64
	MaxPathBytes   int
	MaxScanEntries int
	MaxDepth       int
}

// SnapshotProjectFiles uses a planning budget independent from the smaller
// artifact-return budget. This avoids limiting a normal multi-file build to
// the default number of files that may be sent back to the client.
func SnapshotProjectFiles(ctx context.Context, dir string, limits ProjectCopyLimits) (ArtifactSnapshot, error) {
	limits = normalizeProjectCopyLimits(limits)
	result := ArtifactSnapshot{Files: make(map[string]model.FileSig, min(limits.MaxFiles, 256))}
	walkLimits := projectTreeWalkLimits(limits)
	walkStats, err := walkRegularTree(ctx, dir, walkLimits, ArtifactIgnored, nil, func(relPath string, info fs.FileInfo) error {
		if len(result.Files) >= limits.MaxFiles || info.Size() > limits.MaxTotalBytes-result.TotalBytes {
			result.OmittedFiles++
			result.LimitReached = true
			return nil
		}
		result.Files[relPath] = model.FileSig{Size: info.Size(), ModTime: info.ModTime().UnixNano()}
		result.TotalBytes += info.Size()
		return nil
	})
	result.OmittedFiles += walkStats.OmittedFiles
	result.ScannedEntries = walkStats.ScannedEntries
	result.Truncated = walkStats.Truncated
	return result, err
}

func SnapshotFilesWithLimits(ctx context.Context, dir string, limits ArtifactLimits) (ArtifactSnapshot, error) {
	limits = normalizeArtifactLimits(limits)
	result := ArtifactSnapshot{Files: make(map[string]model.FileSig, min(limits.MaxFiles, 256))}
	walkStats, err := walkArtifactFiles(ctx, dir, limits, func(relPath string, info fs.FileInfo) error {
		if len(result.Files) >= limits.MaxFiles || info.Size() > limits.MaxTotalBytes-result.TotalBytes {
			result.OmittedFiles++
			result.LimitReached = true
			return nil
		}
		result.Files[relPath] = model.FileSig{Size: info.Size(), ModTime: info.ModTime().UnixNano()}
		result.TotalBytes += info.Size()
		return nil
	})
	result.OmittedFiles += walkStats.OmittedFiles
	result.ScannedEntries = walkStats.ScannedEntries
	result.Truncated = walkStats.Truncated
	return result, err
}

func normalizeArtifactLimits(limits ArtifactLimits) ArtifactLimits {
	if limits.MaxFiles <= 0 {
		limits.MaxFiles = defaultArtifactMaxFiles
	} else if limits.MaxFiles > maximumArtifactMaxFiles {
		limits.MaxFiles = maximumArtifactMaxFiles
	}
	if limits.MaxTotalBytes <= 0 {
		limits.MaxTotalBytes = defaultArtifactMaxTotalBytes
	} else if limits.MaxTotalBytes > maximumArtifactMaxTotalBytes {
		limits.MaxTotalBytes = maximumArtifactMaxTotalBytes
	}
	if limits.MaxFileBytes <= 0 || limits.MaxFileBytes > MaxArtifactFileBytes {
		limits.MaxFileBytes = MaxArtifactFileBytes
	}
	if limits.MaxPathBytes <= 0 || limits.MaxPathBytes > MaxArtifactPathBytes {
		limits.MaxPathBytes = MaxArtifactPathBytes
	}
	if limits.MaxScanEntries <= 0 {
		limits.MaxScanEntries = limits.MaxFiles * 16
		if limits.MaxScanEntries < defaultArtifactScanEntries {
			limits.MaxScanEntries = defaultArtifactScanEntries
		}
	}
	if limits.MaxScanEntries > maximumArtifactScanEntries {
		limits.MaxScanEntries = maximumArtifactScanEntries
	}
	if limits.MaxDepth <= 0 || limits.MaxDepth > defaultArtifactScanDepth {
		limits.MaxDepth = defaultArtifactScanDepth
	}
	return limits
}

func normalizeProjectCopyLimits(limits ProjectCopyLimits) ProjectCopyLimits {
	if limits.MaxFiles <= 0 {
		limits.MaxFiles = DefaultProjectCopyMaxFiles
	} else if limits.MaxFiles > maximumProjectCopyMaxFiles {
		limits.MaxFiles = maximumProjectCopyMaxFiles
	}
	if limits.MaxTotalBytes <= 0 {
		limits.MaxTotalBytes = DefaultProjectCopyMaxBytes
	} else if limits.MaxTotalBytes > maximumProjectCopyMaxBytes {
		limits.MaxTotalBytes = maximumProjectCopyMaxBytes
	}
	if limits.MaxPathBytes <= 0 || limits.MaxPathBytes > DefaultProjectCopyMaxPathBytes {
		limits.MaxPathBytes = DefaultProjectCopyMaxPathBytes
	}
	return limits
}

func projectTreeWalkLimits(limits ProjectCopyLimits) regularTreeLimits {
	maxEntries := limits.MaxFiles*4 + 1024
	if maxEntries > maximumProjectScanEntries {
		maxEntries = maximumProjectScanEntries
	}
	return regularTreeLimits{
		MaxPathBytes:   limits.MaxPathBytes,
		MaxScanEntries: maxEntries, MaxDepth: defaultProjectCopyDepth,
	}
}

// ProjectCopyScanEntries returns the derived directory-entry budget shared by
// copy, planning inventory, and post-run artifact discovery.
func ProjectCopyScanEntries(limits ProjectCopyLimits) int {
	return projectTreeWalkLimits(normalizeProjectCopyLimits(limits)).MaxScanEntries
}

func walkArtifactFiles(ctx context.Context, dir string, limits ArtifactLimits, visit func(string, fs.FileInfo) error) (treeWalkStats, error) {
	return walkRegularTree(ctx, dir, regularTreeLimits{
		MaxFileBytes: limits.MaxFileBytes, MaxPathBytes: limits.MaxPathBytes,
		MaxScanEntries: limits.MaxScanEntries, MaxDepth: limits.MaxDepth,
	}, ArtifactIgnored, nil, visit)
}

func walkRegularTree(ctx context.Context, dir string, limits regularTreeLimits, ignore func(string) bool, visitDirectory, visitFile func(string, fs.FileInfo) error) (treeWalkStats, error) {
	if ctx == nil {
		ctx = context.Background()
	}
	if err := ctx.Err(); err != nil {
		return treeWalkStats{}, err
	}
	root, err := safefile.RealDirectory(dir)
	if err != nil {
		return treeWalkStats{}, err
	}
	stats := treeWalkStats{}
	var walkDirectory func(string, string, int, bool) error
	walkDirectory = func(absolute, relative string, depth int, rootDirectory bool) error {
		if err := ctx.Err(); err != nil {
			return err
		}
		before, err := os.Lstat(absolute)
		if err != nil || !before.IsDir() || before.Mode()&os.ModeSymlink != 0 {
			if rootDirectory {
				if err != nil {
					return err
				}
				return fmt.Errorf("artifact scan root is not a real directory")
			}
			stats.OmittedFiles++
			stats.Truncated = true
			return nil
		}
		directory, err := os.Open(absolute)
		if err != nil {
			if rootDirectory {
				return err
			}
			stats.OmittedFiles++
			stats.Truncated = true
			return nil
		}
		defer directory.Close()
		opened, err := directory.Stat()
		if err != nil || !opened.IsDir() || !os.SameFile(before, opened) {
			if rootDirectory {
				return fmt.Errorf("artifact scan root changed while opening")
			}
			stats.OmittedFiles++
			stats.Truncated = true
			return nil
		}
		for {
			entries, readErr := directory.ReadDir(artifactDirectoryReadBatch)
			sort.Slice(entries, func(left, right int) bool { return entries[left].Name() < entries[right].Name() })
			for _, entry := range entries {
				if err := ctx.Err(); err != nil {
					return err
				}
				if stats.ScannedEntries >= limits.MaxScanEntries {
					stats.Truncated = true
					return errArtifactScanStopped
				}
				stats.ScannedEntries++
				childRelative := entry.Name()
				if relative != "" {
					childRelative = filepath.Join(relative, entry.Name())
				}
				slashRelative := filepath.ToSlash(childRelative)
				if len(slashRelative) > limits.MaxPathBytes {
					stats.OmittedFiles++
					stats.Truncated = true
					continue
				}
				if entry.Type()&os.ModeSymlink != 0 {
					stats.OmittedFiles++
					continue
				}
				info, infoErr := entry.Info()
				if infoErr != nil {
					stats.OmittedFiles++
					stats.Truncated = true
					continue
				}
				if info.IsDir() {
					if ignore != nil && ignore(slashRelative) {
						continue
					}
					if depth >= limits.MaxDepth {
						stats.OmittedFiles++
						stats.Truncated = true
						continue
					}
					if visitDirectory != nil {
						if err := visitDirectory(slashRelative, info); err != nil {
							return err
						}
					}
					if err := walkDirectory(filepath.Join(absolute, entry.Name()), childRelative, depth+1, false); err != nil {
						return err
					}
					continue
				}
				if ignore != nil && ignore(slashRelative) {
					continue
				}
				if !info.Mode().IsRegular() || info.Size() < 0 || (limits.MaxFileBytes > 0 && info.Size() > limits.MaxFileBytes) {
					stats.OmittedFiles++
					continue
				}
				if visitFile != nil {
					if err := visitFile(slashRelative, info); err != nil {
						return err
					}
				}
			}
			if errors.Is(readErr, io.EOF) {
				return nil
			}
			if readErr != nil {
				if rootDirectory {
					return readErr
				}
				stats.OmittedFiles++
				stats.Truncated = true
				return nil
			}
		}
	}
	err = walkDirectory(root, "", 0, true)
	if errors.Is(err, errArtifactScanStopped) {
		err = nil
	}
	return stats, err
}

// CopyProjectToTemp copies only regular project files into an isolated tree.
// Links and special files are intentionally omitted: following them would let
// a workspace snapshot escape its source or block on a FIFO.
func CopyProjectToTemp(ctx context.Context, srcDir, dstDir string, limits ProjectCopyLimits) error {
	if ctx == nil {
		ctx = context.Background()
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	if _, err := os.Stat(srcDir); os.IsNotExist(err) {
		return nil
	}
	limits = normalizeProjectCopyLimits(limits)
	sourceRoot, err := safefile.RealDirectory(srcDir)
	if err != nil {
		return fmt.Errorf("validate project workspace: %w", err)
	}
	destinationPath, err := filepath.Abs(dstDir)
	if err != nil {
		return err
	}
	if within, pathErr := safefile.PathWithin(sourceRoot, destinationPath); pathErr != nil {
		return pathErr
	} else if within {
		return fmt.Errorf("isolated workspace must be outside the source workspace")
	}
	if err := os.MkdirAll(destinationPath, 0755); err != nil {
		return err
	}
	destinationRoot, err := safefile.RealDirectory(destinationPath)
	if err != nil {
		return fmt.Errorf("validate isolated workspace: %w", err)
	}
	if within, pathErr := safefile.PathWithin(sourceRoot, destinationRoot); pathErr != nil {
		return pathErr
	} else if within {
		return fmt.Errorf("isolated workspace must be outside the source workspace")
	}
	copiedFiles := 0
	copiedBytes := int64(0)
	walkStats, err := walkRegularTree(ctx, sourceRoot, projectTreeWalkLimits(limits), ArtifactIgnored,
		func(relative string, info fs.FileInfo) error {
			if err := ctx.Err(); err != nil {
				return err
			}
			return os.MkdirAll(filepath.Join(destinationRoot, filepath.FromSlash(relative)), info.Mode().Perm())
		}, func(relative string, discovered fs.FileInfo) error {
			if err := ctx.Err(); err != nil {
				return err
			}
			if copiedFiles >= limits.MaxFiles || discovered.Size() > limits.MaxTotalBytes-copiedBytes {
				return ErrProjectCopyLimit
			}
			source, info, err := safefile.OpenRegularBeneath(sourceRoot, filepath.FromSlash(relative), limits.MaxTotalBytes)
			if err != nil {
				if errors.Is(err, safefile.ErrTooLarge) {
					return ErrProjectCopyLimit
				}
				return fmt.Errorf("open project file %s: %w", relative, err)
			}
			if info.Size() > limits.MaxTotalBytes-copiedBytes {
				_ = source.Close()
				return ErrProjectCopyLimit
			}
			target := filepath.Join(destinationRoot, filepath.FromSlash(relative))
			if err := os.MkdirAll(filepath.Dir(target), 0755); err != nil {
				_ = source.Close()
				return err
			}
			written, copyErr := copyOpenedFileContext(ctx, source, target, info.Mode(), limits.MaxTotalBytes-copiedBytes)
			closeErr := source.Close()
			if copyErr != nil {
				return copyErr
			}
			if closeErr != nil {
				return closeErr
			}
			copiedFiles++
			copiedBytes += written
			return nil
		})
	if err != nil {
		return err
	}
	if walkStats.Truncated {
		return ErrProjectCopyLimit
	}
	return nil
}

func copyOpenedFileContext(ctx context.Context, source *os.File, destination string, mode os.FileMode, maxBytes int64) (int64, error) {
	destinationFile, err := os.OpenFile(destination, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, mode.Perm())
	if err != nil {
		return 0, err
	}
	complete := false
	defer func() {
		_ = destinationFile.Close()
		if !complete {
			_ = os.Remove(destination)
		}
	}()
	buffer := projectCopyBuffers.Get().(*[]byte)
	defer projectCopyBuffers.Put(buffer)
	written, err := io.CopyBuffer(destinationFile, io.LimitReader(&contextBoundReader{ctx: ctx, reader: source}, maxBytes+1), *buffer)
	if err != nil {
		return written, err
	}
	if written > maxBytes {
		return written, ErrProjectCopyLimit
	}
	if err := destinationFile.Close(); err != nil {
		return written, err
	}
	if err := ctx.Err(); err != nil {
		return written, err
	}
	complete = true
	return written, nil
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
	".venv":        true,
	"venv":         true,
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

type ArtifactSyncResult struct {
	Paths          []string
	OmittedFiles   int
	TotalBytes     int64
	ScannedEntries int
	ScanTruncated  bool
}

// SyncGeneratedArtifactsWithLimits compares the bounded planning snapshot to
// the post-run tree and atomically publishes changed regular files.
func SyncGeneratedArtifactsWithLimits(ctx context.Context, tempDir, projectDir string, beforeSnapshot map[string]model.FileSig, sourceRelPath string, limits ArtifactLimits) (ArtifactSyncResult, error) {
	limits = normalizeArtifactLimits(limits)
	result := ArtifactSyncResult{Paths: make([]string, 0, min(limits.MaxFiles, 128))}
	if sourceRelPath != "" {
		sourceRelPath = filepath.ToSlash(filepath.Clean(sourceRelPath))
	}
	walkStats, err := walkArtifactFiles(ctx, tempDir, limits, func(relPath string, discovered fs.FileInfo) error {
		if err := ctx.Err(); err != nil {
			return err
		}
		if relPath == sourceRelPath {
			return nil
		}
		afterSig := model.FileSig{Size: discovered.Size(), ModTime: discovered.ModTime().UnixNano()}
		beforeSig, existed := beforeSnapshot[relPath]
		if existed && beforeSig == afterSig {
			return nil
		}
		if len(result.Paths) >= limits.MaxFiles || discovered.Size() > limits.MaxTotalBytes-result.TotalBytes {
			result.OmittedFiles++
			return nil
		}
		source, info, err := safefile.OpenRegularBeneath(tempDir, filepath.FromSlash(relPath), limits.MaxFileBytes)
		if err != nil {
			slog.Warn("Unsafe artifact skipped", "path", relPath, "error", err)
			result.OmittedFiles++
			return nil
		}
		openedSig := model.FileSig{Size: info.Size(), ModTime: info.ModTime().UnixNano()}
		if existed && beforeSig == openedSig {
			_ = source.Close()
			return nil
		}
		if len(result.Paths) >= limits.MaxFiles || info.Size() > limits.MaxTotalBytes-result.TotalBytes {
			_ = source.Close()
			result.OmittedFiles++
			return nil
		}
		copyErr := safefile.ReplaceRegularBeneathContext(ctx, projectDir, filepath.FromSlash(relPath), source, info.Mode(), limits.MaxFileBytes)
		closeErr := source.Close()
		if copyErr != nil {
			if ctxErr := ctx.Err(); ctxErr != nil {
				return ctxErr
			}
			slog.Error("Failed to sync artifact", "relPath", relPath, "error", copyErr)
			result.OmittedFiles++
			return nil
		}
		if closeErr != nil {
			slog.Warn("Failed to close artifact source", "relPath", relPath, "error", closeErr)
		}
		if err := ctx.Err(); err != nil {
			return err
		}
		result.Paths = append(result.Paths, relPath)
		result.TotalBytes += info.Size()
		slog.Info("Saved generated artifact to server workspace", "path", filepath.Join(projectDir, filepath.FromSlash(relPath)))
		return nil
	})
	result.OmittedFiles += walkStats.OmittedFiles
	result.ScannedEntries = walkStats.ScannedEntries
	result.ScanTruncated = walkStats.Truncated
	return result, err
}

// SendArtifacts 将变更的文件通过 WebSocket Channel 分块发送给客户端
func SendArtifacts(ctx context.Context, channel *session.RunChannel, tempDir string, relPaths []string, chunkSize int) error {
	if ctx == nil {
		ctx = context.Background()
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	if channel == nil {
		return fmt.Errorf("artifact channel is unavailable")
	}
	if chunkSize <= 0 {
		chunkSize = 200000
	}
	for _, relPath := range relPaths {
		if err := ctx.Err(); err != nil {
			return err
		}
		data, err := readArtifactContext(ctx, tempDir, relPath)
		if err != nil {
			if ctxErr := ctx.Err(); ctxErr != nil {
				return ctxErr
			}
			if !channel.SendJSON(session.MakeStreamLine("stderr", fmt.Sprintf("Failed to read artifact %s: %v", relPath, err), "")) {
				return io.ErrClosedPipe
			}
			continue
		}

		fileType := "binary"
		content := base64.StdEncoding.EncodeToString(data)
		if isTextFile(data) {
			fileType = "text"
			content = string(data)
		}
		if err := ctx.Err(); err != nil {
			return err
		}

		chunkCount := (len(content) + chunkSize - 1) / chunkSize
		if chunkCount < 1 {
			chunkCount = 1
		}
		for i := 0; i < chunkCount; i++ {
			if err := ctx.Err(); err != nil {
				return err
			}
			end := (i + 1) * chunkSize
			if end > len(content) {
				end = len(content)
			}
			part := content[i*chunkSize : end]
			if !channel.SendJSON(session.MakeArtifact(relPath, fileType, i, chunkCount, part)) {
				return io.ErrClosedPipe
			}
		}
	}
	return nil
}

type contextBoundReader struct {
	ctx    context.Context
	reader io.Reader
}

func (reader *contextBoundReader) Read(buffer []byte) (int, error) {
	if err := reader.ctx.Err(); err != nil {
		return 0, err
	}
	read, err := reader.reader.Read(buffer)
	if contextErr := reader.ctx.Err(); contextErr != nil {
		return read, contextErr
	}
	return read, err
}

func readArtifactContext(ctx context.Context, root, relPath string) ([]byte, error) {
	file, _, err := safefile.OpenRegularBeneath(root, filepath.FromSlash(relPath), MaxArtifactFileBytes)
	if err != nil {
		return nil, err
	}
	defer file.Close()
	data, err := io.ReadAll(io.LimitReader(&contextBoundReader{ctx: ctx, reader: file}, MaxArtifactFileBytes+1))
	if err != nil {
		return nil, err
	}
	if int64(len(data)) > MaxArtifactFileBytes {
		return nil, safefile.ErrTooLarge
	}
	return data, nil
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
