package files

import "testing"

// TestArtifactIgnored 构建目录与依赖目录不应回传为产物
func TestArtifactIgnored(t *testing.T) {
	ignored := []string{
		".bobocloud/output",
		".bobocloud/classes/Main.class",
		"target/debug/myapp",
		"crate/target/release/myapp",
		".git/index",
		"node_modules/x/index.js",
		"__pycache__/main.cpython-311.pyc",
	}
	for _, p := range ignored {
		if !ArtifactIgnored(p) {
			t.Errorf("should be ignored: %s", p)
		}
	}

	kept := []string{
		"result.txt",
		"plot.png",
		"out/data.csv", // 注意：out 在源码扫描中忽略，但产物不忽略（用户程序可能输出到这里）
		"target.txt",   // 文件名含 target 但不是目录
	}
	for _, p := range kept {
		if ArtifactIgnored(p) {
			t.Errorf("should NOT be ignored: %s", p)
		}
	}
}
