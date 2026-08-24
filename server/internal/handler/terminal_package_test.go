package handler

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"strings"
	"sync"
	"testing"
	"time"

	"bobocloud-server/internal/config"
)

func encodeTerminalPackageFrame(t *testing.T, frame terminalPackageShimFrame) []byte {
	t.Helper()
	raw, err := json.Marshal(frame)
	if err != nil {
		t.Fatal(err)
	}
	return []byte(base64.RawURLEncoding.EncodeToString(raw))
}

func TestTerminalPackagePolicyAcceptsDirectPythonPackageIntents(t *testing.T) {
	policy := newTerminalPackagePolicy(config.Default())
	for _, invocation := range []string{"pip", "pip3", "python-pip", "python3-pip"} {
		t.Run(invocation, func(t *testing.T) {
			intent, err := policy.parseArgs(invocation, []string{
				"install", "Num_Py==2.1.0", "requests[socks,security]", "--upgrade", "--no-cache-dir",
				"--index-url", "https://pypi.tuna.tsinghua.edu.cn/simple",
			})
			if err != nil {
				t.Fatal(err)
			}
			if intent.Type != "terminal.packageIntent" || intent.Operation != "install" || intent.SourceID != "pypi-tuna" || !intent.RequiresTerminalClose {
				t.Fatalf("install intent = %#v", intent)
			}
			if len(intent.Packages) != 2 || intent.Packages[0].Name != "num-py" || intent.Packages[0].Version != "2.1.0" {
				t.Fatalf("install packages = %#v", intent.Packages)
			}
			if got := strings.Join(intent.Packages[1].Features, ","); got != "security,socks" {
				t.Fatalf("normalized features = %q", got)
			}
		})
	}

	remove, err := policy.parseArgs("pip", []string{"uninstall", "-y", "Num.Py"})
	if err != nil {
		t.Fatal(err)
	}
	if remove.Operation != "remove" || remove.Packages[0].Name != "num-py" || remove.SourceID != config.Default().PackageDefaultSource {
		t.Fatalf("remove intent = %#v", remove)
	}
}

func TestTerminalPackageIntentStateRequiresDecisionAndExpires(t *testing.T) {
	started := time.Unix(100, 0)
	first := terminalPackageIntent{IntentID: "intent-first"}
	second := terminalPackageIntent{IntentID: "intent-second"}
	state := &terminalPackageIntentState{}

	if pending, offered := state.offer(first, started); !offered || pending != "" {
		t.Fatalf("first offer = pending %q, offered %v", pending, offered)
	}
	if state.acceptedIntentID() != "" {
		t.Fatal("an unacknowledged intent was eligible for publication")
	}
	if pending, offered := state.offer(second, started.Add(time.Second)); offered || pending != first.IntentID {
		t.Fatalf("concurrent offer = pending %q, offered %v", pending, offered)
	}
	if code, decided := state.decide(second.IntentID, true, started.Add(2*time.Second)); decided || code != "package_intent_stale" {
		t.Fatalf("mismatched decision = code %q, decided %v", code, decided)
	}
	if code, decided := state.decide(first.IntentID, true, started.Add(2*time.Second)); !decided || code != "" {
		t.Fatalf("accept decision = code %q, decided %v", code, decided)
	}
	if state.acceptedIntentID() != first.IntentID {
		t.Fatalf("accepted intent = %q", state.acceptedIntentID())
	}
	if expired := state.expire(started.Add(2*time.Second + terminalPackageIntentTimeout - time.Nanosecond)); expired != "" {
		t.Fatalf("intent expired early: %q", expired)
	}
	if expired := state.expire(started.Add(2*time.Second + terminalPackageIntentTimeout)); expired != first.IntentID {
		t.Fatalf("expired intent = %q", expired)
	}
	if pending, offered := state.offer(second, started.Add(time.Minute)); !offered || pending != "" {
		t.Fatalf("offer after expiration = pending %q, offered %v", pending, offered)
	}
	if code, decided := state.decide(second.IntentID, false, started.Add(time.Minute)); !decided || code != "" {
		t.Fatalf("decline decision = code %q, decided %v", code, decided)
	}
	if state.acceptedIntentID() != "" {
		t.Fatal("declined intent remained eligible for publication")
	}
}

func TestTerminalPackageIntentStateSerializesConcurrentOffers(t *testing.T) {
	state := &terminalPackageIntentState{}
	now := time.Now()
	var wait sync.WaitGroup
	accepted := make(chan string, 16)
	for index := 0; index < 16; index++ {
		wait.Add(1)
		go func(id string) {
			defer wait.Done()
			if _, offered := state.offer(terminalPackageIntent{IntentID: id}, now); offered {
				accepted <- id
			}
		}(fmt.Sprintf("intent-%d", index))
	}
	wait.Wait()
	close(accepted)
	if len(accepted) != 1 {
		t.Fatalf("accepted concurrent offers = %d, want 1", len(accepted))
	}
}

func TestTerminalPackageIntentEligibilityRequiresExplicitCompatibleHandshake(t *testing.T) {
	policy := newTerminalPackagePolicy(config.Default())
	if terminalPackageIntentEligible(false, "", "python", true, policy) {
		t.Fatal("an old client without packageIntents opt-in was intercepted")
	}
	if terminalPackageIntentEligible(true, "team-id", "python", true, policy) {
		t.Fatal("a team terminal was allowed to publish a personal package intent")
	}
	if terminalPackageIntentEligible(true, "", "node", true, policy) {
		t.Fatal("a non-Python terminal was allowed to publish a Python package intent")
	}
	if terminalPackageIntentEligible(true, "", "python", false, policy) {
		t.Fatal("a terminal without personal cache authority enabled package intents")
	}
	if !terminalPackageIntentEligible(true, "", "PYTHON", true, policy) {
		t.Fatal("an explicitly negotiated personal Python terminal was rejected")
	}
}

func TestTerminalPackagePolicyRejectsInputsThatBypassPackageCenter(t *testing.T) {
	policy := newTerminalPackagePolicy(config.Default())
	tests := []struct {
		name string
		args []string
		code string
	}{
		{name: "requirements file", args: []string{"install", "-r", "requirements.txt"}, code: "unsupported_option"},
		{name: "constraint file", args: []string{"install", "-c", "constraints.txt"}, code: "unsupported_option"},
		{name: "target", args: []string{"install", "--target", "/tmp/deps", "numpy"}, code: "unsupported_option"},
		{name: "user", args: []string{"install", "--user", "numpy"}, code: "unsupported_option"},
		{name: "prefix", args: []string{"install", "--prefix=/tmp/deps", "numpy"}, code: "unsupported_option"},
		{name: "no deps", args: []string{"install", "--no-deps", "numpy"}, code: "unsupported_option"},
		{name: "local directory", args: []string{"install", "../wheelhouse"}, code: "unsupported_requirement"},
		{name: "local wheel", args: []string{"install", "./demo.whl"}, code: "unsupported_requirement"},
		{name: "vcs", args: []string{"install", "git+https://example.invalid/demo.git"}, code: "unsupported_requirement"},
		{name: "direct URL", args: []string{"install", "https://example.invalid/demo.whl"}, code: "unsupported_requirement"},
		{name: "range", args: []string{"install", "numpy>=2"}, code: "unsupported_requirement"},
		{name: "unknown source", args: []string{"install", "numpy", "-i", "https://example.invalid/simple"}, code: "unknown_source"},
		{name: "extra source", args: []string{"install", "numpy", "--extra-index-url", "https://pypi.org/simple"}, code: "unsupported_option"},
	}
	for _, testCase := range tests {
		t.Run(testCase.name, func(t *testing.T) {
			_, err := policy.parseArgs("pip", testCase.args)
			if got := terminalPackageErrorCode(err); got != testCase.code {
				t.Fatalf("error code = %q, want %q (err=%v)", got, testCase.code, err)
			}
		})
	}
}

func TestTerminalPackageFrameDecoderStripsSplitOSCFrame(t *testing.T) {
	nonce := "nonce-123"
	encoded := encodeTerminalPackageFrame(t, terminalPackageShimFrame{
		Schema: terminalPackageIntentSchema, Nonce: nonce, Invocation: "pip", Args: []string{"install", "numpy==2.1.0"},
	})
	stream := append([]byte("before"), terminalPackageFramePrefix...)
	stream = append(stream, encoded...)
	stream = append(stream, terminalPackageFrameSuffix)
	stream = append(stream, []byte("after")...)

	decoder := &terminalPackageFrameDecoder{}
	visible := []byte{}
	frames := [][]byte{}
	for _, chunk := range [][]byte{stream[:9], stream[9:31], stream[31 : len(stream)-3], stream[len(stream)-3:]} {
		output, decoded := decoder.Push(chunk)
		visible = append(visible, output...)
		frames = append(frames, decoded...)
	}
	visible = append(visible, decoder.Flush()...)
	if string(visible) != "beforeafter" || bytes.Contains(visible, terminalPackageFramePrefix) {
		t.Fatalf("visible output = %q", visible)
	}
	if len(frames) != 1 || !bytes.Equal(frames[0], encoded) {
		t.Fatalf("decoded frames = %q", frames)
	}
	policy := newTerminalPackagePolicy(config.Default())
	intent, err := policy.parseFrame(frames[0], nonce)
	if err != nil || intent.Packages[0].Name != "numpy" {
		t.Fatalf("parsed frame = %#v, %v", intent, err)
	}
	if _, err := policy.parseFrame(frames[0], "different-session"); terminalPackageErrorCode(err) != "invalid_frame" {
		t.Fatalf("cross-session nonce was accepted: %v", err)
	}
}

func TestTerminalPackageFrameDecoderDropsOversizedAndTruncatedControlData(t *testing.T) {
	decoder := &terminalPackageFrameDecoder{}
	first := append(append([]byte{}, terminalPackageFramePrefix...), bytes.Repeat([]byte("x"), terminalPackageFrameMaxBytes+1)...)
	visible, frames := decoder.Push(first)
	if len(visible) != 0 || len(frames) != 0 {
		t.Fatalf("oversized partial frame leaked: visible=%d frames=%d", len(visible), len(frames))
	}
	visible, frames = decoder.Push(append([]byte{terminalPackageFrameSuffix}, []byte("tail")...))
	visible = append(visible, decoder.Flush()...)
	if string(visible) != "tail" || len(frames) != 0 {
		t.Fatalf("oversized frame recovery = visible %q frames %d", visible, len(frames))
	}

	truncated := &terminalPackageFrameDecoder{}
	visible, frames = truncated.Push(append(append([]byte("ok"), terminalPackageFramePrefix...), []byte("payload")...))
	visible = append(visible, truncated.Flush()...)
	if string(visible) != "ok" || len(frames) != 0 {
		t.Fatalf("truncated frame leaked: visible=%q frames=%d", visible, len(frames))
	}
}

func TestTerminalPackageFrameRejectsUnknownFields(t *testing.T) {
	raw := []byte(`{"schema":1,"nonce":"n","invocation":"pip","args":["install","numpy"],"extra":true}`)
	encoded := []byte(base64.RawURLEncoding.EncodeToString(raw))
	if _, err := newTerminalPackagePolicy(config.Default()).parseFrame(encoded, "n"); terminalPackageErrorCode(err) != "invalid_frame" {
		t.Fatalf("frame with unknown fields was accepted: %v", err)
	}
}

func TestTerminalPackageShimEmitsIntentAndDelegatesReadOnlyCommands(t *testing.T) {
	script, err := terminalPackageShimScript("nonce_123")
	if err != nil {
		t.Fatal(err)
	}
	for _, required := range []string{
		"BOBOCLOUD_PACKAGE", `"nonce": "nonce_123"`, "os.execv", `["-m", "pip"]`,
		`invocation in ("python", "python3")`, `invocation = invocation + "-pip"`,
		`[sys.executable, *arguments]`, `command = next((argument for argument in arguments if not argument.startswith("-")), "")`,
		`command not in ("install", "uninstall", "remove")`,
	} {
		if !strings.Contains(script, required) {
			t.Fatalf("shim is missing %q", required)
		}
	}
	if strings.Contains(script, "subprocess") || strings.Contains(script, "os.system") {
		t.Fatalf("shim can execute a mutation through a shell: %s", script)
	}
	if _, err := terminalPackageShimScript("bad nonce;exit"); err == nil {
		t.Fatal("unsafe shim nonce was accepted")
	}
	installShell := terminalPackageShimInstallShell()
	if !strings.Contains(installShell, "for command_name in pip pip3 python python3") ||
		!strings.Contains(installShell, terminalPackageShimRoot+"/bin/pip --version") ||
		!strings.Contains(installShell, terminalPackageShimRoot+"/bin/python -c") {
		t.Fatalf("shim installer does not install and probe every supported invocation: %s", installShell)
	}
}
