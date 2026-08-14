package model

import "strings"

// ============================================================
// lang.go — 语言扩展名映射与运行时查询
// ============================================================

// SourceExtensions 是需要扫描编译标志的源文件扩展名
var SourceExtensions = map[string]bool{
	".c":   true,
	".cpp": true,
	".cc":  true,
	".cxx": true,
	".h":   true,
	".hpp": true,
}

// LanguageExtensionMap 将文件扩展名映射到语言标识
var LanguageExtensionMap = map[string]string{
	".py":   "python",
	".java": "java",
	".c":    "c",
	".cpp":  "cpp",
	".cc":   "cpp",
	".cxx":  "cpp",
	".go":   "go",
	".rs":   "rust",
	".js":   "node",
	".mjs":  "node",
	".cjs":  "node",
}

// LanguageFromExtension 根据文件扩展名返回语言标识
func LanguageFromExtension(ext string) string {
	lang, ok := LanguageExtensionMap[strings.ToLower(ext)]
	if !ok {
		return ""
	}
	return lang
}

// SupportedRuntimes 是所有可用的 Docker 运行时环境
var SupportedRuntimes = []RuntimeDef{
	// Python
	{Language: "python", Version: "3.9", RuntimeID: "python:3.9", DockerImage: "python:3.9-slim", DisplayName: "Python 3.9", Extensions: []string{".py"}},
	{Language: "python", Version: "3.10", RuntimeID: "python:3.10", DockerImage: "python:3.10-slim", DisplayName: "Python 3.10", Extensions: []string{".py"}},
	{Language: "python", Version: "3.11", RuntimeID: "python:3.11", DockerImage: "python:3.11-slim", DisplayName: "Python 3.11", Extensions: []string{".py"}},
	{Language: "python", Version: "3.12", RuntimeID: "python:3.12", DockerImage: "python:3.12-slim", DisplayName: "Python 3.12", Extensions: []string{".py"}},
	{Language: "python", Version: "3.13", RuntimeID: "python:3.13", DockerImage: "python:3.13-slim", DisplayName: "Python 3.13", Extensions: []string{".py"}},

	// Java
	{Language: "java", Version: "11", RuntimeID: "java:11", DockerImage: "openjdk:11-slim", DisplayName: "Java 11", Extensions: []string{".java"}},
	{Language: "java", Version: "17", RuntimeID: "java:17", DockerImage: "openjdk:17-slim", DisplayName: "Java 17", Extensions: []string{".java"}},
	{Language: "java", Version: "21", RuntimeID: "java:21", DockerImage: "openjdk:21-slim", DisplayName: "Java 21", Extensions: []string{".java"}},

	// C (GCC)
	{Language: "c", Version: "11", RuntimeID: "c:11", DockerImage: "gcc:11", DisplayName: "C (GCC 11)", Extensions: []string{".c"}},
	{Language: "c", Version: "13", RuntimeID: "c:13", DockerImage: "gcc:13", DisplayName: "C (GCC 13)", Extensions: []string{".c"}},

	// C++ (G++)
	{Language: "cpp", Version: "11", RuntimeID: "cpp:11", DockerImage: "gcc:11", DisplayName: "C++ (GCC 11)", Extensions: []string{".cpp", ".cc", ".cxx"}},
	{Language: "cpp", Version: "13", RuntimeID: "cpp:13", DockerImage: "gcc:13", DisplayName: "C++ (GCC 13)", Extensions: []string{".cpp", ".cc", ".cxx"}},

	// Go
	{Language: "go", Version: "1.21", RuntimeID: "go:1.21", DockerImage: "golang:1.21", DisplayName: "Go 1.21", Extensions: []string{".go"}},
	{Language: "go", Version: "1.23", RuntimeID: "go:1.23", DockerImage: "golang:1.23", DisplayName: "Go 1.23", Extensions: []string{".go"}},

	// Rust
	{Language: "rust", Version: "1.75", RuntimeID: "rust:1.75", DockerImage: "rust:1.75-slim", DisplayName: "Rust 1.75", Extensions: []string{".rs"}},
	{Language: "rust", Version: "1.82", RuntimeID: "rust:1.82", DockerImage: "rust:1.82-slim", DisplayName: "Rust 1.82", Extensions: []string{".rs"}},

	// Node.js
	{Language: "node", Version: "20", RuntimeID: "node:20", DockerImage: "node:20-slim", DisplayName: "Node.js 20", Extensions: []string{".js", ".mjs", ".cjs"}},
	{Language: "node", Version: "22", RuntimeID: "node:22", DockerImage: "node:22-slim", DisplayName: "Node.js 22", Extensions: []string{".js", ".mjs", ".cjs"}},
}

// GetRuntimeDef 根据 runtimeID 查找 RuntimeDef
func GetRuntimeDef(runtimeID string) *RuntimeDef {
	for i := range SupportedRuntimes {
		if SupportedRuntimes[i].RuntimeID == runtimeID {
			return &SupportedRuntimes[i]
		}
	}
	return nil
}

// GetDefaultRuntimeForExtension 根据文件扩展名返回默认语言标识
func GetDefaultRuntimeForExtension(ext string) string {
	return LanguageFromExtension(ext)
}

// RuntimesGroupedByLanguage 按语言分组 RuntimeDef
func RuntimesGroupedByLanguage() map[string][]RuntimeDef {
	groups := make(map[string][]RuntimeDef)
	for _, rt := range SupportedRuntimes {
		groups[rt.Language] = append(groups[rt.Language], rt)
	}
	return groups
}
