package model

// ============================================================
// runtime.go — 运行时定义与编译规则
// ============================================================

// RuntimeDef 定义一个可用的运行时环境
type RuntimeDef struct {
	Language    string   `json:"language"`
	Version     string   `json:"version"`
	RuntimeID   string   `json:"runtimeId"`
	DockerImage string   `json:"dockerImage"`
	DisplayName string   `json:"displayName"`
	Extensions  []string `json:"extensions"`
}

// CompileRule 是一条编译规则
type CompileRule struct {
	Name        string              `json:"name"`
	Description string              `json:"description"`
	Detect      CompileDetect       `json:"detect"`
	Flags       map[string][]string `json:"flags"`
}

// CompileDetect 定义规则的检测方式
type CompileDetect struct {
	Type     string   `json:"type"`
	Patterns []string `json:"patterns"`
}

// CompileRulesConfig 是 compile_rules.json 的顶层结构
type CompileRulesConfig struct {
	Rules []CompileRule `json:"rules"`
}
