package runner

// ============================================================
// plugin_node.go — Node.js 语言插件
//
// 解释型语言无编译步骤；从项目根执行入口文件，require('./x') 相对入口
// 文件解析（Node 语义天然支持多文件）。编译参数无意义（忽略），
// 运行参数原样传给脚本（process.argv）。
// ============================================================

// NodePlugin Node.js 语言插件
type NodePlugin struct{}

func (NodePlugin) Language() string     { return "node" }
func (NodePlugin) Extensions() []string { return []string{".js", ".mjs", ".cjs"} }

func (NodePlugin) Plan(req *PlanRequest) (*Plan, error) {
	runCmd := []string{"node", req.EntryRelPath}
	runCmd = append(runCmd, req.RunArgs...)

	return &Plan{
		Steps: []Step{
			{Stage: "run:node", Cmd: runCmd, TimeoutSec: req.Timeouts.RunSec},
		},
	}, nil
}
