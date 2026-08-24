package handler

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/url"
	"os/exec"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"

	"bobocloud-server/internal/auth"
	"bobocloud-server/internal/config"
)

const (
	terminalPackageIntentSchema  = 1
	terminalPackageFrameMaxBytes = 16 << 10
	terminalPackageMaxArguments  = 72
	terminalPackageMaxPackages   = 64
	terminalPackageShimRoot      = "/tmp/bobocloud-terminal-control"
	terminalPackageIntentTimeout = 10 * time.Second
)

var (
	terminalPackageFramePrefix = []byte("\x1b]777;BOBOCLOUD_PACKAGE;")
	terminalPackageFrameSuffix = byte('\a')
	terminalPackageNamePattern = regexp.MustCompile(`^([A-Za-z0-9](?:[A-Za-z0-9._-]{0,127}))(?:\[([A-Za-z0-9._-]+(?:,[A-Za-z0-9._-]+)*)\])?(?:==([A-Za-z0-9](?:[A-Za-z0-9.!+_-]{0,127})))?$`)
	terminalPackageNameSep     = regexp.MustCompile(`[-_.]+`)
	terminalPackageIntentID    = regexp.MustCompile(`^[A-Za-z0-9_-]{1,256}$`)
	terminalPackageDecision    = regexp.MustCompile(`^[A-Za-z0-9_.-]{1,256}$`)
)

type terminalPackageShimFrame struct {
	Schema     int      `json:"schema"`
	Nonce      string   `json:"nonce"`
	Invocation string   `json:"invocation"`
	Args       []string `json:"args"`
}

type terminalPackageSpec struct {
	Name     string   `json:"name"`
	Version  string   `json:"version,omitempty"`
	Features []string `json:"features,omitempty"`
}

type terminalPackageIntent struct {
	Schema                int                   `json:"schema"`
	Type                  string                `json:"type"`
	IntentID              string                `json:"intentId"`
	SessionID             string                `json:"sessionId,omitempty"`
	RuntimeID             string                `json:"runtimeId,omitempty"`
	Workspace             map[string]string     `json:"workspace,omitempty"`
	Ecosystem             string                `json:"ecosystem"`
	Manager               string                `json:"manager"`
	Operation             string                `json:"operation"`
	Packages              []terminalPackageSpec `json:"packages"`
	SourceID              string                `json:"sourceId"`
	RequiresTerminalClose bool                  `json:"requiresTerminalClose"`
}

// terminalPackageIntentState keeps the container-side interception bounded.
// An intent is not eligible for publication until the client explicitly
// accepts it, and an abandoned decision can never pin the terminal forever.
type terminalPackageIntentState struct {
	mu       sync.Mutex
	intent   *terminalPackageIntent
	accepted bool
	deadline time.Time
}

func (state *terminalPackageIntentState) offer(intent terminalPackageIntent, now time.Time) (string, bool) {
	state.mu.Lock()
	defer state.mu.Unlock()
	state.expireLocked(now)
	if state.intent != nil {
		return state.intent.IntentID, false
	}
	copy := intent
	state.intent = &copy
	state.accepted = false
	state.deadline = now.Add(terminalPackageIntentTimeout)
	return "", true
}

func (state *terminalPackageIntentState) decide(intentID string, accepted bool, now time.Time) (string, bool) {
	state.mu.Lock()
	defer state.mu.Unlock()
	state.expireLocked(now)
	if state.intent == nil || strings.TrimSpace(intentID) == "" || state.intent.IntentID != intentID {
		return "package_intent_stale", false
	}
	if !accepted {
		state.clearLocked()
		return "", true
	}
	state.accepted = true
	state.deadline = now.Add(terminalPackageIntentTimeout)
	return "", true
}

func (state *terminalPackageIntentState) expire(now time.Time) string {
	state.mu.Lock()
	defer state.mu.Unlock()
	if state.intent == nil || now.Before(state.deadline) {
		return ""
	}
	intentID := state.intent.IntentID
	state.clearLocked()
	return intentID
}

func (state *terminalPackageIntentState) acceptedIntentID() string {
	state.mu.Lock()
	defer state.mu.Unlock()
	if state.intent == nil || !state.accepted {
		return ""
	}
	return state.intent.IntentID
}

func (state *terminalPackageIntentState) expireLocked(now time.Time) {
	if state.intent != nil && !now.Before(state.deadline) {
		state.clearLocked()
	}
}

func (state *terminalPackageIntentState) clearLocked() {
	state.intent = nil
	state.accepted = false
	state.deadline = time.Time{}
}

type terminalPackagePolicyError struct {
	code string
}

func (err *terminalPackagePolicyError) Error() string { return err.code }

func terminalPackageError(code string) error {
	return &terminalPackagePolicyError{code: code}
}

func terminalPackageErrorCode(err error) string {
	var policyErr *terminalPackagePolicyError
	if errors.As(err, &policyErr) && strings.TrimSpace(policyErr.code) != "" {
		return policyErr.code
	}
	return "invalid_frame"
}

func validTerminalPackageIntentID(value string) bool {
	return terminalPackageIntentID.MatchString(strings.TrimSpace(value))
}

func cleanTerminalPackageDecisionCode(value string) string {
	value = strings.TrimSpace(value)
	if !terminalPackageDecision.MatchString(value) {
		return "client_rejected"
	}
	return value
}

type terminalPackagePolicy struct {
	defaultSource string
	sourceByURL   map[string]string
}

func newTerminalPackagePolicy(cfg *config.Config) terminalPackagePolicy {
	policy := terminalPackagePolicy{sourceByURL: make(map[string]string)}
	if cfg == nil || !cfg.PackageCenterEnabled {
		return policy
	}
	for _, source := range cfg.PackageSources {
		if !strings.EqualFold(strings.TrimSpace(source.Ecosystem), "python") {
			continue
		}
		id := strings.TrimSpace(source.ID)
		canonical, ok := canonicalTerminalPackageSourceURL(source.InstallURL)
		if id == "" || !ok {
			continue
		}
		policy.sourceByURL[canonical] = id
	}
	if candidate := strings.TrimSpace(cfg.PackageDefaultSource); candidate != "" {
		for _, id := range policy.sourceByURL {
			if id == candidate {
				policy.defaultSource = candidate
				break
			}
		}
	}
	return policy
}

func canonicalTerminalPackageSourceURL(value string) (string, bool) {
	parsed, err := url.Parse(strings.TrimSpace(value))
	if err != nil || !strings.EqualFold(parsed.Scheme, "https") || parsed.User != nil || parsed.Hostname() == "" || parsed.RawQuery != "" || parsed.Fragment != "" {
		return "", false
	}
	parsed.Scheme = "https"
	parsed.Host = strings.ToLower(parsed.Host)
	parsed.Path = strings.TrimRight(parsed.Path, "/")
	parsed.RawPath = ""
	if parsed.Path == "" {
		parsed.Path = "/"
	}
	return parsed.String(), true
}

func (policy terminalPackagePolicy) enabled() bool {
	return policy.defaultSource != "" && len(policy.sourceByURL) > 0
}

func terminalPackageIntentEligible(requested bool, teamID, language string, personalCacheAvailable bool, policy terminalPackagePolicy) bool {
	return requested && personalCacheAvailable && strings.TrimSpace(teamID) == "" &&
		strings.EqualFold(strings.TrimSpace(language), "python") && policy.enabled()
}

func (policy terminalPackagePolicy) parseFrame(encoded []byte, nonce string) (terminalPackageIntent, error) {
	if !policy.enabled() || len(encoded) == 0 || len(encoded) > terminalPackageFrameMaxBytes {
		return terminalPackageIntent{}, terminalPackageError("invalid_frame")
	}
	raw, err := base64.RawURLEncoding.DecodeString(string(encoded))
	if err != nil || len(raw) == 0 || len(raw) > terminalPackageFrameMaxBytes {
		return terminalPackageIntent{}, terminalPackageError("invalid_frame")
	}
	var frame terminalPackageShimFrame
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if decoder.Decode(&frame) != nil || frame.Schema != terminalPackageIntentSchema || frame.Nonce != nonce || strings.TrimSpace(nonce) == "" {
		return terminalPackageIntent{}, terminalPackageError("invalid_frame")
	}
	if decoder.Decode(&struct{}{}) != io.EOF {
		return terminalPackageIntent{}, terminalPackageError("invalid_frame")
	}
	return policy.parseArgs(frame.Invocation, frame.Args)
}

func (policy terminalPackagePolicy) parseArgs(invocation string, args []string) (terminalPackageIntent, error) {
	invocation = strings.ToLower(strings.TrimSpace(invocation))
	if invocation != "pip" && invocation != "pip3" && invocation != "python-pip" && invocation != "python3-pip" {
		return terminalPackageIntent{}, terminalPackageError("unsupported_invocation")
	}
	if len(args) == 0 || len(args) > terminalPackageMaxArguments {
		return terminalPackageIntent{}, terminalPackageError("unsupported_command")
	}
	cleanArgs := make([]string, len(args))
	for index, value := range args {
		if value == "" || len(value) > 1024 || strings.IndexByte(value, 0) >= 0 || strings.ContainsAny(value, "\r\n") {
			return terminalPackageIntent{}, terminalPackageError("invalid_argument")
		}
		cleanArgs[index] = value
	}

	operation := ""
	sourceID := policy.defaultSource
	packages := make([]string, 0, len(cleanArgs))
	for index := 0; index < len(cleanArgs); index++ {
		argument := cleanArgs[index]
		switch argument {
		case "install":
			if operation != "" {
				return terminalPackageIntent{}, terminalPackageError("unsupported_command")
			}
			operation = "install"
		case "uninstall", "remove":
			if operation != "" {
				return terminalPackageIntent{}, terminalPackageError("unsupported_command")
			}
			operation = "remove"
		case "-i", "--index-url":
			index++
			if index >= len(cleanArgs) {
				return terminalPackageIntent{}, terminalPackageError("unknown_source")
			}
			resolved, ok := policy.sourceByURLValue(cleanArgs[index])
			if !ok {
				return terminalPackageIntent{}, terminalPackageError("unknown_source")
			}
			sourceID = resolved
		default:
			if strings.HasPrefix(argument, "--index-url=") {
				resolved, ok := policy.sourceByURLValue(strings.TrimPrefix(argument, "--index-url="))
				if !ok {
					return terminalPackageIntent{}, terminalPackageError("unknown_source")
				}
				sourceID = resolved
				continue
			}
			if strings.HasPrefix(argument, "-") {
				if !terminalPackageFlagAllowed(operation, argument) {
					return terminalPackageIntent{}, terminalPackageError("unsupported_option")
				}
				continue
			}
			if operation == "" {
				return terminalPackageIntent{}, terminalPackageError("unsupported_command")
			}
			packages = append(packages, argument)
		}
	}
	if operation == "" || len(packages) == 0 || len(packages) > terminalPackageMaxPackages {
		return terminalPackageIntent{}, terminalPackageError("unsupported_command")
	}

	specs := make([]terminalPackageSpec, 0, len(packages))
	seen := make(map[string]bool, len(packages))
	for _, candidate := range packages {
		spec, err := parseTerminalPackageSpec(candidate, operation)
		if err != nil {
			return terminalPackageIntent{}, err
		}
		if seen[spec.Name] {
			return terminalPackageIntent{}, terminalPackageError("duplicate_package")
		}
		seen[spec.Name] = true
		specs = append(specs, spec)
	}
	return terminalPackageIntent{
		Schema: terminalPackageIntentSchema, Type: "terminal.packageIntent", IntentID: auth.GenerateToken(),
		Ecosystem: "python", Manager: "pip", Operation: operation, Packages: specs, SourceID: sourceID,
		RequiresTerminalClose: true,
	}, nil
}

func terminalPackageFlagAllowed(operation, argument string) bool {
	switch argument {
	case "--isolated", "--disable-pip-version-check", "--no-cache-dir", "--no-input", "-q", "--quiet":
		return true
	case "-U", "--upgrade":
		return operation == "install"
	case "-y", "--yes":
		return operation == "remove"
	default:
		return false
	}
}

func (policy terminalPackagePolicy) sourceByURLValue(value string) (string, bool) {
	canonical, ok := canonicalTerminalPackageSourceURL(value)
	if !ok {
		return "", false
	}
	id, ok := policy.sourceByURL[canonical]
	return id, ok
}

func parseTerminalPackageSpec(value, operation string) (terminalPackageSpec, error) {
	match := terminalPackageNamePattern.FindStringSubmatch(strings.TrimSpace(value))
	if match == nil {
		return terminalPackageSpec{}, terminalPackageError("unsupported_requirement")
	}
	name := terminalPackageNameSep.ReplaceAllString(strings.ToLower(match[1]), "-")
	features := []string{}
	if match[2] != "" {
		features = strings.Split(strings.ToLower(match[2]), ",")
		sort.Strings(features)
		for index := 1; index < len(features); index++ {
			if features[index] == features[index-1] {
				return terminalPackageSpec{}, terminalPackageError("unsupported_requirement")
			}
		}
	}
	if operation == "remove" && (match[2] != "" || match[3] != "") {
		return terminalPackageSpec{}, terminalPackageError("unsupported_requirement")
	}
	return terminalPackageSpec{Name: name, Version: match[3], Features: features}, nil
}

// terminalPackageFrameDecoder removes BOBOCLOUD OSC frames from stdout while
// retaining ordinary terminal bytes. It keeps only a bounded partial frame
// between reads, including when the frame prefix itself is split.
type terminalPackageFrameDecoder struct {
	pending  []byte
	inFrame  bool
	dropping bool
}

func (decoder *terminalPackageFrameDecoder) Push(input []byte) ([]byte, [][]byte) {
	decoder.pending = append(decoder.pending, input...)
	visible := make([]byte, 0, len(decoder.pending))
	frames := make([][]byte, 0, 1)
	for len(decoder.pending) > 0 {
		if decoder.inFrame {
			end := bytes.IndexByte(decoder.pending, terminalPackageFrameSuffix)
			if end < 0 {
				if decoder.dropping || len(decoder.pending) > terminalPackageFrameMaxBytes {
					decoder.pending = nil
					decoder.dropping = true
				}
				break
			}
			if !decoder.dropping && end > 0 && end <= terminalPackageFrameMaxBytes {
				frames = append(frames, append([]byte(nil), decoder.pending[:end]...))
			}
			decoder.pending = decoder.pending[end+1:]
			decoder.inFrame = false
			decoder.dropping = false
			continue
		}
		start := bytes.Index(decoder.pending, terminalPackageFramePrefix)
		if start < 0 {
			keep := terminalPackagePrefixOverlap(decoder.pending)
			visible = append(visible, decoder.pending[:len(decoder.pending)-keep]...)
			decoder.pending = append([]byte(nil), decoder.pending[len(decoder.pending)-keep:]...)
			break
		}
		visible = append(visible, decoder.pending[:start]...)
		decoder.pending = decoder.pending[start+len(terminalPackageFramePrefix):]
		decoder.inFrame = true
	}
	return visible, frames
}

func (decoder *terminalPackageFrameDecoder) Flush() []byte {
	if decoder == nil {
		return nil
	}
	pending := decoder.pending
	decoder.pending = nil
	if decoder.inFrame {
		decoder.inFrame = false
		decoder.dropping = false
		return nil
	}
	// A partial prefix that never completed is ordinary output and may be shown.
	return pending
}

func terminalPackagePrefixOverlap(data []byte) int {
	limit := len(data)
	if limit >= len(terminalPackageFramePrefix) {
		limit = len(terminalPackageFramePrefix) - 1
	}
	for size := limit; size > 0; size-- {
		if bytes.Equal(data[len(data)-size:], terminalPackageFramePrefix[:size]) {
			return size
		}
	}
	return 0
}

func terminalPackageShimScript(nonce string) (string, error) {
	if nonce == "" || len(nonce) > 256 {
		return "", fmt.Errorf("terminal package nonce is invalid")
	}
	for _, char := range nonce {
		if (char < 'a' || char > 'z') && (char < 'A' || char > 'Z') && (char < '0' || char > '9') && char != '-' && char != '_' {
			return "", fmt.Errorf("terminal package nonce is invalid")
		}
	}
	return `import base64
import json
import os
import sys

invocation = os.path.basename(sys.argv[0])
arguments = sys.argv[1:]
if invocation in ("python", "python3"):
    if arguments[:2] == ["-m", "pip"]:
        invocation = invocation + "-pip"
        arguments = arguments[2:]
    else:
        os.execv(sys.executable, [sys.executable, *arguments])

command = next((argument for argument in arguments if not argument.startswith("-")), "")
if command not in ("install", "uninstall", "remove"):
    os.execv(sys.executable, [sys.executable, "-m", "pip", *arguments])

frame = {
    "schema": 1,
    "nonce": "` + nonce + `",
    "invocation": invocation,
    "args": arguments,
}
payload = base64.urlsafe_b64encode(
    json.dumps(frame, ensure_ascii=True, separators=(",", ":")).encode("utf-8")
).decode("ascii").rstrip("=")
sys.stdout.write("\x1b]777;BOBOCLOUD_PACKAGE;" + payload + "\x07")
sys.stdout.flush()
`, nil
}

func installTerminalPackageShim(ctx context.Context, containerID, nonce string) error {
	script, err := terminalPackageShimScript(nonce)
	if err != nil {
		return err
	}
	command := exec.CommandContext(ctx, "docker", "exec", "-i", "-w", "/", containerID, "sh", "-c", terminalPackageShimInstallShell())
	command.Stdin = strings.NewReader(script)
	if output, runErr := command.CombinedOutput(); runErr != nil {
		return fmt.Errorf("install terminal package shim: %s", strings.TrimSpace(string(output)))
	}
	return nil
}

func terminalPackageShimInstallShell() string {
	return "umask 077; real_python=$(command -v python3 || command -v python); test -n \"$real_python\"; rm -rf " + terminalPackageShimRoot + "; mkdir -p " + terminalPackageShimRoot + "/bin; { printf '#!%s\\n' \"$real_python\"; cat; } > " + terminalPackageShimRoot + "/terminalpackage.py; chmod 0700 " + terminalPackageShimRoot + "/terminalpackage.py; for command_name in pip pip3 python python3; do ln -s ../terminalpackage.py " + terminalPackageShimRoot + "/bin/$command_name; done; " + terminalPackageShimRoot + "/bin/pip --version >/dev/null; " + terminalPackageShimRoot + "/bin/python -c 'import sys; assert sys.version_info.major == 3'"
}
