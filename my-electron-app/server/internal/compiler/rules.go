package compiler

import (
	"encoding/json"
	"log/slog"
	"os"
	"path/filepath"
	"regexp"
	"strings"

	"bobocloud-server/internal/model"
)

// ============================================================
// rules.go — 编译规则加载与自动检测
// ============================================================

var (
	rules            []model.CompileRule
	compiledPatterns []compiledRule
)

type compiledRule struct {
	rule     model.CompileRule
	patterns []*regexp.Regexp
}

// LoadCompileRules 从 JSON 文件加载编译规则
func LoadCompileRules(rulesPath string) error {
	data, err := os.ReadFile(rulesPath)
	if err != nil {
		slog.Warn("Failed to load compile rules", "path", rulesPath, "error", err)
		return err
	}

	var config model.CompileRulesConfig
	if err := json.Unmarshal(data, &config); err != nil {
		slog.Warn("Failed to parse compile rules", "path", rulesPath, "error", err)
		return err
	}

	rules = config.Rules
	compiledPatterns = make([]compiledRule, 0, len(rules))

	for _, rule := range rules {
		cr := compiledRule{rule: rule}
		for _, pattern := range rule.Detect.Patterns {
			re, err := regexp.Compile("(?m)" + pattern)
			if err != nil {
				slog.Warn("Invalid regex pattern in compile rule", "pattern", pattern, "rule", rule.Name, "error", err)
				continue
			}
			cr.patterns = append(cr.patterns, re)
		}
		if len(cr.patterns) > 0 {
			compiledPatterns = append(compiledPatterns, cr)
		}
	}

	slog.Info("Loaded compile rules", "count", len(rules), "path", rulesPath)
	return nil
}

// DetectFlagsInContent 在单个文件内容中检测匹配的编译标志
func DetectFlagsInContent(content string, compilerType string) []string {
	var flags []string
	seen := make(map[string]bool)

	for _, cr := range compiledPatterns {
		matched := false
		for _, re := range cr.patterns {
			if re.MatchString(content) {
				matched = true
				break
			}
		}
		if !matched {
			continue
		}

		rawFlags, ok := cr.rule.Flags[compilerType]
		if !ok {
			continue
		}
		for _, flag := range NormalizeFlags(rawFlags) {
			if flag != "" && !seen[flag] {
				seen[flag] = true
				flags = append(flags, flag)
			}
		}
	}

	return flags
}

// CollectCompileFlags 遍历工作目录中所有源码文件，收集编译器标志
func CollectCompileFlags(workDir string, compilerType string) []string {
	if len(compiledPatterns) == 0 {
		return nil
	}
	if _, err := os.Stat(workDir); os.IsNotExist(err) {
		return nil
	}

	seen := make(map[string]bool)
	var allFlags []string

	filepath.Walk(workDir, func(fullPath string, info os.FileInfo, err error) error {
		if err != nil || info.IsDir() {
			return nil
		}
		ext := strings.ToLower(filepath.Ext(fullPath))
		if !model.SourceExtensions[ext] {
			return nil
		}

		content, err := os.ReadFile(fullPath)
		if err != nil {
			return nil
		}

		for _, flag := range DetectFlagsInContent(string(content), compilerType) {
			if flag != "" && !seen[flag] {
				seen[flag] = true
				allFlags = append(allFlags, flag)
			}
		}
		return nil
	})

	if len(allFlags) > 0 {
		slog.Info("Auto-detected compile flags", "compiler", compilerType, "flags", allFlags)
	}
	return allFlags
}

// NormalizeFlags 将原始标志列展开为独立标志
func NormalizeFlags(rawFlags []string) []string {
	var normalized []string
	for _, item := range rawFlags {
		if item == "" {
			continue
		}
		if strings.Contains(item, "`") || strings.Contains(item, "$(") {
			normalized = append(normalized, item)
		} else {
			normalized = append(normalized, strings.Fields(item)...)
		}
	}
	return normalized
}

// EnsureExecutable 给文件添加可执行权限
func EnsureExecutable(filePath string) {
	info, err := os.Stat(filePath)
	if err != nil {
		slog.Warn("Failed to stat file for chmod", "path", filePath, "error", err)
		return
	}
	newMode := info.Mode() | 0111
	if err := os.Chmod(filePath, newMode); err != nil {
		slog.Warn("Failed to set executable bit", "path", filePath, "error", err)
	}
}
