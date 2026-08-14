package model

// ============================================================
// result.go — 运行结果与文件签名
// ============================================================

// RunResult 是一次编译/运行操作的结果
type RunResult struct {
	Success    bool
	ReturnCode int
	Stdout     string
	Stderr     string
	TimedOut   bool
	Cancelled  bool
}

// FileSig 是文件快照签名（大小 + 修改时间纳秒）
type FileSig struct {
	Size    int64
	ModTime int64
}
