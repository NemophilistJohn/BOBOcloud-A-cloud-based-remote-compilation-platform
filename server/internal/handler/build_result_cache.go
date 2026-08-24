package handler

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"bobocloud-server/internal/model"
	"bobocloud-server/internal/runner"
)

var buildFingerprintIgnored = map[string]bool{
	".git": true, ".bobocloud": true, "node_modules": true, "target": true,
	"build": true, "dist": true, "out": true, "__pycache__": true, ".venv": true, "venv": true,
}

func reusableCompilePlan(plan *runner.Plan) bool {
	if plan == nil {
		return false
	}
	hasCompile, hasRun := false, false
	for _, step := range plan.Steps {
		hasCompile = hasCompile || strings.HasPrefix(step.Stage, "compile:")
		hasRun = hasRun || strings.HasPrefix(step.Stage, "run:")
	}
	return hasCompile && hasRun
}

func compileCacheHitPlan(plan *runner.Plan) *runner.Plan {
	if plan == nil {
		return nil
	}
	result := *plan
	result.Note = ""
	result.Steps = make([]runner.Step, 0, len(plan.Steps))
	for _, step := range plan.Steps {
		if strings.HasPrefix(step.Stage, "run:") {
			result.Steps = append(result.Steps, step)
		}
	}
	return &result
}

func compileStageSucceeded(plan *runner.Plan, result *model.RunResult) bool {
	if plan == nil || result == nil || strings.TrimSpace(result.CompletedStage) == "" {
		return false
	}
	compilePassed := false
	for _, step := range plan.Steps {
		isCompile := strings.HasPrefix(step.Stage, "compile:")
		if step.Stage == result.CompletedStage {
			if isCompile {
				return result.Success
			}
			return compilePassed
		}
		if isCompile {
			compilePassed = true
		}
	}
	return result.Success && compilePassed
}

func ignoredBuildFingerprintPath(relative string) bool {
	for _, part := range strings.Split(filepath.ToSlash(relative), "/") {
		if buildFingerprintIgnored[part] {
			return true
		}
	}
	return false
}

func executionBuildFingerprint(ctx context.Context, root, runtimeFingerprint, dependencyDigest string, plan *runner.Plan, projectFiles []string) (string, error) {
	paths := make([]string, 0, len(projectFiles))
	for _, relative := range projectFiles {
		relative = filepath.ToSlash(strings.TrimSpace(relative))
		if relative == "" || ignoredBuildFingerprintPath(relative) {
			continue
		}
		paths = append(paths, relative)
	}
	sort.Strings(paths)
	hash := sha256.New()
	_, _ = io.WriteString(hash, "bobocloud.build-result/v2\x00"+runtimeFingerprint+"\x00"+dependencyDigest+"\x00")
	for _, relative := range paths {
		if err := ctx.Err(); err != nil {
			return "", err
		}
		_, _ = io.WriteString(hash, relative+"\x00")
		path := filepath.Join(root, filepath.FromSlash(relative))
		info, statErr := os.Lstat(path)
		if statErr != nil {
			return "", statErr
		}
		if !info.Mode().IsRegular() {
			continue
		}
		file, openErr := os.Open(path)
		if openErr != nil {
			return "", openErr
		}
		_, copyErr := io.Copy(hash, file)
		closeErr := file.Close()
		if copyErr != nil {
			return "", copyErr
		}
		if closeErr != nil {
			return "", closeErr
		}
		_, _ = hash.Write([]byte{0})
	}
	type compileDescriptor struct {
		Stage   string            `json:"stage"`
		Command []string          `json:"command"`
		WorkDir string            `json:"work_dir"`
		Env     map[string]string `json:"env,omitempty"`
	}
	descriptors := make([]compileDescriptor, 0)
	if plan != nil {
		for _, step := range plan.Steps {
			if strings.HasPrefix(step.Stage, "compile:") {
				descriptors = append(descriptors, compileDescriptor{Stage: step.Stage, Command: step.Cmd, WorkDir: step.WorkDir, Env: step.Env})
			}
		}
	}
	encoded, err := json.Marshal(descriptors)
	if err != nil {
		return "", err
	}
	_, _ = hash.Write(encoded)
	return hex.EncodeToString(hash.Sum(nil)), nil
}

func mergeCacheContext(target map[string]string, source map[string]string) map[string]string {
	if target == nil {
		target = make(map[string]string)
	}
	for key, value := range source {
		target[key] = value
	}
	return target
}
