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
	terminalNodePackagePart    = regexp.MustCompile(`^[a-z0-9](?:[a-z0-9._~-]{0,212}[a-z0-9._~-])?$`)
	terminalNodeExactVersion   = regexp.MustCompile(`^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$`)
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
	Scope    string   `json:"scope,omitempty"`
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

type terminalPackageSourcePolicy struct {
	defaultSource string
	sourceByURL   map[string]string
}

type terminalPackagePolicy struct {
	byEcosystem map[string]terminalPackageSourcePolicy
}

func newTerminalPackagePolicy(cfg *config.Config) terminalPackagePolicy {
	policy := terminalPackagePolicy{byEcosystem: make(map[string]terminalPackageSourcePolicy)}
	if cfg == nil || !cfg.PackageCenterEnabled {
		return policy
	}
	for _, source := range cfg.PackageSources {
		ecosystem := strings.ToLower(strings.TrimSpace(source.Ecosystem))
		if ecosystem != "python" && ecosystem != "node" {
			continue
		}
		id := strings.TrimSpace(source.ID)
		canonical, ok := canonicalTerminalPackageSourceURL(source.InstallURL)
		if id == "" || !ok {
			continue
		}
		sourcePolicy := policy.byEcosystem[ecosystem]
		if sourcePolicy.sourceByURL == nil {
			sourcePolicy.sourceByURL = make(map[string]string)
		}
		sourcePolicy.sourceByURL[canonical] = id
		policy.byEcosystem[ecosystem] = sourcePolicy
	}
	for ecosystem, sourcePolicy := range policy.byEcosystem {
		candidate := strings.TrimSpace(cfg.PackageDefaultSources[ecosystem])
		if ecosystem == "python" && candidate == "" {
			candidate = strings.TrimSpace(cfg.PackageDefaultSource)
		}
		if candidate != "" {
			for _, id := range sourcePolicy.sourceByURL {
				if id == candidate {
					sourcePolicy.defaultSource = candidate
					break
				}
			}
		}
		if sourcePolicy.defaultSource == "" {
			delete(policy.byEcosystem, ecosystem)
		} else {
			policy.byEcosystem[ecosystem] = sourcePolicy
		}
	}
	return policy
}

func (policy terminalPackagePolicy) sourcePolicy(ecosystem string) (terminalPackageSourcePolicy, bool) {
	sourcePolicy, ok := policy.byEcosystem[strings.ToLower(strings.TrimSpace(ecosystem))]
	return sourcePolicy, ok && sourcePolicy.defaultSource != "" && len(sourcePolicy.sourceByURL) > 0
}

func (policy terminalPackagePolicy) enabledFor(language string) bool {
	_, ok := policy.sourcePolicy(language)
	return ok
}

func (policy terminalPackagePolicy) enabled() bool {
	for ecosystem := range policy.byEcosystem {
		if policy.enabledFor(ecosystem) {
			return true
		}
	}
	return false
}

func terminalPackageEcosystem(invocation string) (string, string, bool) {
	switch strings.ToLower(strings.TrimSpace(invocation)) {
	case "pip", "pip3", "python-pip", "python3-pip":
		return "python", "pip", true
	case "npm":
		return "node", "npm", true
	case "pnpm":
		return "node", "pnpm", true
	default:
		return "", "", false
	}
}

func cleanTerminalPackageArguments(args []string) ([]string, error) {
	if len(args) == 0 || len(args) > terminalPackageMaxArguments {
		return nil, terminalPackageError("unsupported_command")
	}
	cleanArgs := make([]string, len(args))
	for index, value := range args {
		if value == "" || len(value) > 1024 || strings.IndexByte(value, 0) >= 0 || strings.ContainsAny(value, "\r\n") {
			return nil, terminalPackageError("invalid_argument")
		}
		cleanArgs[index] = value
	}
	return cleanArgs, nil
}

func (policy terminalPackagePolicy) parseArgs(invocation string, args []string) (terminalPackageIntent, error) {
	ecosystem, manager, ok := terminalPackageEcosystem(invocation)
	if !ok {
		return terminalPackageIntent{}, terminalPackageError("unsupported_invocation")
	}
	sourcePolicy, ok := policy.sourcePolicy(ecosystem)
	if !ok {
		return terminalPackageIntent{}, terminalPackageError("unsupported_invocation")
	}
	cleanArgs, err := cleanTerminalPackageArguments(args)
	if err != nil {
		return terminalPackageIntent{}, err
	}
	if ecosystem == "python" {
		return sourcePolicy.parsePythonArgs(cleanArgs)
	}
	return sourcePolicy.parseNodeArgs(manager, cleanArgs)
}

func (policy terminalPackageSourcePolicy) parsePythonArgs(cleanArgs []string) (terminalPackageIntent, error) {
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
				break
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

func (policy terminalPackageSourcePolicy) parseNodeArgs(manager string, cleanArgs []string) (terminalPackageIntent, error) {
	operation := ""
	sourceID := policy.defaultSource
	scope := "runtime"
	scopeExplicit := false
	packages := make([]string, 0, len(cleanArgs))
	for index := 0; index < len(cleanArgs); index++ {
		argument := cleanArgs[index]
		if resolvedOperation, command := terminalNodePackageOperation(manager, argument); command {
			if operation != "" {
				return terminalPackageIntent{}, terminalPackageError("unsupported_command")
			}
			operation = resolvedOperation
			continue
		}
		switch argument {
		case "--registry":
			index++
			if index >= len(cleanArgs) {
				return terminalPackageIntent{}, terminalPackageError("unknown_source")
			}
			resolved, ok := policy.sourceByURLValue(cleanArgs[index])
			if !ok {
				return terminalPackageIntent{}, terminalPackageError("unknown_source")
			}
			sourceID = resolved
		case "-D", "--save-dev":
			if scopeExplicit && scope != "dev" {
				return terminalPackageIntent{}, terminalPackageError("unsupported_option")
			}
			scope, scopeExplicit = "dev", true
		case "-O", "--save-optional":
			if scopeExplicit && scope != "optional" {
				return terminalPackageIntent{}, terminalPackageError("unsupported_option")
			}
			scope, scopeExplicit = "optional", true
		case "-P", "--save-prod":
			if scopeExplicit && scope != "runtime" {
				return terminalPackageIntent{}, terminalPackageError("unsupported_option")
			}
			scope, scopeExplicit = "runtime", true
		default:
			if strings.HasPrefix(argument, "--registry=") {
				resolved, ok := policy.sourceByURLValue(strings.TrimPrefix(argument, "--registry="))
				if !ok {
					return terminalPackageIntent{}, terminalPackageError("unknown_source")
				}
				sourceID = resolved
				continue
			}
			if strings.HasPrefix(argument, "-") {
				if !terminalNodePackageFlagAllowed(operation, argument) {
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
		spec, err := parseTerminalNodePackageSpec(candidate, operation, scope)
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
		Ecosystem: "node", Manager: manager, Operation: operation, Packages: specs, SourceID: sourceID,
		RequiresTerminalClose: true,
	}, nil
}

func terminalNodePackageOperation(manager, argument string) (string, bool) {
	switch manager {
	case "npm":
		switch argument {
		case "install", "i", "add":
			return "install", true
		case "uninstall", "remove", "rm":
			return "remove", true
		}
	case "pnpm":
		switch argument {
		case "add":
			return "install", true
		case "remove", "rm":
			return "remove", true
		}
	}
	return "", false
}

func terminalNodePackageFlagAllowed(operation, argument string) bool {
	switch argument {
	case "--ignore-scripts", "--no-audit", "--no-fund", "--no-progress", "--silent", "--quiet":
		return true
	case "-E", "--save-exact":
		return operation == "" || operation == "install"
	default:
		return false
	}
}

func parseTerminalNodePackageSpec(value, operation, scope string) (terminalPackageSpec, error) {
	value = strings.TrimSpace(value)
	name, version := value, ""
	hasVersion := false
	if strings.HasPrefix(value, "@") {
		slash := strings.IndexByte(value, '/')
		if slash < 2 {
			return terminalPackageSpec{}, terminalPackageError("unsupported_requirement")
		}
		if versionAt := strings.IndexByte(value[slash+1:], '@'); versionAt >= 0 {
			versionAt += slash + 1
			name, version = value[:versionAt], value[versionAt+1:]
			hasVersion = true
		}
	} else if versionAt := strings.LastIndexByte(value, '@'); versionAt >= 0 {
		name, version = value[:versionAt], value[versionAt+1:]
		hasVersion = true
	}
	if !validTerminalNodePackageName(name) || (hasVersion && !terminalNodeExactVersion.MatchString(version)) {
		return terminalPackageSpec{}, terminalPackageError("unsupported_requirement")
	}
	if operation == "remove" && version != "" {
		return terminalPackageSpec{}, terminalPackageError("unsupported_requirement")
	}
	return terminalPackageSpec{Name: name, Version: version, Scope: scope}, nil
}

func validTerminalNodePackageName(name string) bool {
	if name == "" || len(name) > 214 || name != strings.ToLower(name) || strings.ContainsAny(name, "\\%:") {
		return false
	}
	if strings.HasPrefix(name, "@") {
		parts := strings.Split(name[1:], "/")
		return len(parts) == 2 && terminalNodePackagePart.MatchString(parts[0]) && terminalNodePackagePart.MatchString(parts[1])
	}
	return !strings.Contains(name, "/") && terminalNodePackagePart.MatchString(name)
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

func terminalPackageIntentEligible(requested bool, teamID, language string, personalCacheAvailable bool, policy terminalPackagePolicy) bool {
	return requested && personalCacheAvailable && strings.TrimSpace(teamID) == "" && policy.enabledFor(language)
}

func (policy terminalPackagePolicy) parseFrame(encoded []byte, nonce, expectedEcosystem string) (terminalPackageIntent, error) {
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
	intent, err := policy.parseArgs(frame.Invocation, frame.Args)
	if err != nil {
		return terminalPackageIntent{}, err
	}
	if !strings.EqualFold(strings.TrimSpace(intent.Ecosystem), strings.TrimSpace(expectedEcosystem)) {
		return terminalPackageIntent{}, terminalPackageError("unsupported_invocation")
	}
	return intent, nil
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

func (policy terminalPackageSourcePolicy) sourceByURLValue(value string) (string, bool) {
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
	return terminalPackageSpec{Name: name, Version: match[3], Features: features, Scope: "runtime"}, nil
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

func terminalPackageShimScript(nonce, language string) (string, error) {
	if nonce == "" || len(nonce) > 256 {
		return "", fmt.Errorf("terminal package nonce is invalid")
	}
	for _, char := range nonce {
		if (char < 'a' || char > 'z') && (char < 'A' || char > 'Z') && (char < '0' || char > '9') && char != '-' && char != '_' {
			return "", fmt.Errorf("terminal package nonce is invalid")
		}
	}
	if strings.EqualFold(strings.TrimSpace(language), "node") {
		return terminalNodePackageShimScript(nonce), nil
	}
	if !strings.EqualFold(strings.TrimSpace(language), "python") {
		return "", fmt.Errorf("terminal package shim language is unsupported")
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

known_commands = {
    "install", "uninstall", "remove", "download", "freeze", "inspect", "list",
    "show", "check", "config", "search", "cache", "index", "wheel", "hash",
    "completion", "debug", "help", "lock",
}
command = next((argument for argument in arguments if argument in known_commands), "")
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

func terminalNodePackageShimScript(nonce string) string {
	return `'use strict';
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const invocation = path.basename(process.argv[1] || '');
const cliArgs = process.argv.slice(2);
const mutationCommands = invocation === 'npm'
  ? new Set(['install', 'i', 'add', 'uninstall', 'remove', 'rm', 'update', 'up', 'ci', 'prune', 'dedupe', 'link', 'unlink', 'rebuild'])
  : new Set(['add', 'install', 'i', 'remove', 'rm', 'update', 'up', 'prune', 'dedupe', 'link', 'unlink', 'import', 'rebuild']);
const knownCommands = new Set([
  ...mutationCommands,
  'access', 'audit', 'bugs', 'cache', 'completion', 'config', 'diff', 'dist-tag',
  'docs', 'doctor', 'exec', 'explain', 'explore', 'find-dupes', 'fund', 'help',
  'help-search', 'init', 'login', 'logout', 'ls', 'list', 'org', 'outdated',
  'owner', 'pack', 'ping', 'pkg', 'prefix', 'profile', 'publish', 'query', 'repo',
  'restart', 'root', 'run', 'run-script', 'search', 'shrinkwrap', 'star', 'stars',
  'start', 'stop', 'store', 'team', 'test', 'token', 'unpublish', 'unstar',
  'version', 'view', 'why', 'whoami'
]);
const command = cliArgs.find((argument) => knownCommands.has(argument)) || '';
const shimBin = path.resolve('` + terminalPackageShimRoot + `/bin');
const delegatedPath = String(process.env.PATH || '').split(path.delimiter)
  .filter((entry) => entry && path.resolve(entry) !== shimBin)
  .join(path.delimiter);

function findExecutable(name) {
  for (const directory of delegatedPath.split(path.delimiter)) {
    const candidate = path.join(directory, name);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch (_) {}
  }
  return '';
}

function delegate() {
  let executable = findExecutable(invocation);
  let delegatedArguments = cliArgs;
  if (!executable && invocation === 'pnpm') {
    executable = findExecutable('corepack');
    delegatedArguments = ['pnpm', ...cliArgs];
  }
  if (!executable) {
    process.stderr.write(invocation + ': original package manager is unavailable\n');
    process.exit(127);
  }
  const child = spawn(executable, delegatedArguments, {
    stdio: 'inherit', env: { ...process.env, PATH: delegatedPath }
  });
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.on(signal, () => child.kill(signal));
  }
  child.on('error', (error) => {
    process.stderr.write(String(error && error.message || error) + '\n');
    process.exit(127);
  });
  child.on('exit', (code, signal) => {
    if (signal) process.kill(process.pid, signal);
    else process.exit(Number.isInteger(code) ? code : 1);
  });
}

if (!mutationCommands.has(command)) {
  delegate();
} else {
  const frame = { schema: 1, nonce: '` + nonce + `', invocation, args: cliArgs };
  const payload = Buffer.from(JSON.stringify(frame), 'utf8').toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
  process.stdout.write('\x1b]777;BOBOCLOUD_PACKAGE;' + payload + '\x07');
}
`
}

func installTerminalPackageShim(ctx context.Context, containerID, nonce, language string) error {
	script, err := terminalPackageShimScript(nonce, language)
	if err != nil {
		return err
	}
	command := exec.CommandContext(ctx, "docker", "exec", "-i", "-w", "/", containerID, "sh", "-c", terminalPackageShimInstallShell(language))
	command.Stdin = strings.NewReader(script)
	if output, runErr := command.CombinedOutput(); runErr != nil {
		return fmt.Errorf("install terminal package shim: %s", strings.TrimSpace(string(output)))
	}
	return nil
}

func terminalPackageShimInstallShell(language string) string {
	if strings.EqualFold(strings.TrimSpace(language), "node") {
		return "umask 077; real_node=$(command -v node); real_npm=$(command -v npm); test -n \"$real_node\"; test -n \"$real_npm\"; rm -rf " + terminalPackageShimRoot + "; mkdir -p " + terminalPackageShimRoot + "/bin; { printf '#!%s\\n' \"$real_node\"; cat; } > " + terminalPackageShimRoot + "/terminalpackage.js; chmod 0700 " + terminalPackageShimRoot + "/terminalpackage.js; for command_name in npm pnpm; do cp " + terminalPackageShimRoot + "/terminalpackage.js " + terminalPackageShimRoot + "/bin/$command_name; chmod 0700 " + terminalPackageShimRoot + "/bin/$command_name; done; " + terminalPackageShimRoot + "/bin/npm --version >/dev/null"
	}
	return "umask 077; real_python=$(command -v python3 || command -v python); test -n \"$real_python\"; rm -rf " + terminalPackageShimRoot + "; mkdir -p " + terminalPackageShimRoot + "/bin; { printf '#!%s\\n' \"$real_python\"; cat; } > " + terminalPackageShimRoot + "/terminalpackage.py; chmod 0700 " + terminalPackageShimRoot + "/terminalpackage.py; for command_name in pip pip3 python python3; do ln -s ../terminalpackage.py " + terminalPackageShimRoot + "/bin/$command_name; done; " + terminalPackageShimRoot + "/bin/pip --version >/dev/null; " + terminalPackageShimRoot + "/bin/python -c 'import sys; assert sys.version_info.major == 3'"
}
