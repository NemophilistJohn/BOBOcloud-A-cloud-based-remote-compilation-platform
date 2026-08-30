package session

import "testing"

type legacyOutputCapture struct {
	stdout []string
	stderr []string
}

func (*legacyOutputCapture) WriteStatus(string, string) {}
func (capture *legacyOutputCapture) WriteStdout(value, _ string) {
	capture.stdout = append(capture.stdout, value)
}
func (capture *legacyOutputCapture) WriteStderr(value, _ string) {
	capture.stderr = append(capture.stderr, value)
}
func (*legacyOutputCapture) WriteArtifactBegin()                  {}
func (*legacyOutputCapture) WriteArtifact(string, []byte, string) {}
func (*legacyOutputCapture) WriteArtifactEnd()                    {}
func (*legacyOutputCapture) WriteResult(bool, int)                {}
func (*legacyOutputCapture) WriteError(string)                    {}

func TestMakeStreamFragmentCarriesExplicitLineState(t *testing.T) {
	message := MakeStreamFragment("stdout", OutputFragment{
		Text: "continued", Append: true, Newline: true,
	}, "run:go")
	if message["type"] != "stdout" || message["line"] != "continued" || message["stage"] != "run:go" {
		t.Fatalf("stream fragment identity = %#v", message)
	}
	if message["fragment"] != true || message["append"] != true || message["replace"] != false || message["newline"] != true {
		t.Fatalf("stream fragment controls = %#v", message)
	}
}

func TestFragmentHelpersFallBackToLegacyOutputWriter(t *testing.T) {
	capture := &legacyOutputCapture{}
	WriteStdoutFragment(capture, OutputFragment{Text: "prompt", Append: true}, "run")
	WriteStderrFragment(capture, OutputFragment{Text: "warning", Replace: true}, "run")
	if len(capture.stdout) != 1 || capture.stdout[0] != "prompt" {
		t.Fatalf("legacy stdout = %#v", capture.stdout)
	}
	if len(capture.stderr) != 1 || capture.stderr[0] != "warning" {
		t.Fatalf("legacy stderr = %#v", capture.stderr)
	}
}
