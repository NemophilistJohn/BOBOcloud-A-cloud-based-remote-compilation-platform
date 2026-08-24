package packageops

import (
	"bufio"
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"path/filepath"
	"regexp"
	"sort"
	"strings"

	"bobocloud-server/internal/model"
)

const (
	maxRequirementsBytes = int64(8 << 20)
	maxPackageChanges    = 64
)

var (
	pythonPackageNamePattern = regexp.MustCompile(`^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,127})$`)
	pythonVersionPattern     = regexp.MustCompile(`^[A-Za-z0-9](?:[A-Za-z0-9.!+_-]{0,127})$`)
	pythonFeaturePattern     = regexp.MustCompile(`^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,63})$`)
	pythonNameSeparator      = regexp.MustCompile(`[-_.]+`)
)

type RequirementsPlan struct {
	Changes         []model.ProjectPackageChange
	LocalChange     model.ProjectPackageLocalChange
	ManifestBinding model.ProjectPackageManifestBinding
	ManifestContent string
	Reinstall       bool
	Warnings        []string
}

func PlanPythonRequirements(root, requestedPath string, candidates []string, changes []model.ProjectPackageChange) (RequirementsPlan, error) {
	return PlanPythonRequirementsWithOptions(root, requestedPath, candidates, changes, RequirementsPlanOptions{})
}

type RequirementsPlanOptions struct {
	// AllowReinstall contains normalized distribution names that the trusted
	// inventory has declared but cannot find in the current generation.
	AllowReinstall map[string]bool
}

func PlanPythonRequirementsWithOptions(root, requestedPath string, candidates []string, changes []model.ProjectPackageChange, options RequirementsPlanOptions) (RequirementsPlan, error) {
	if len(changes) == 0 || len(changes) > maxPackageChanges {
		return RequirementsPlan{}, fmt.Errorf("package changes must contain between 1 and %d entries", maxPackageChanges)
	}
	manifestPath, err := selectRequirementsManifest(root, requestedPath, candidates)
	if err != nil {
		return RequirementsPlan{}, err
	}
	if _, err := safeRequirementsPath(root, manifestPath); err != nil {
		return RequirementsPlan{}, err
	}
	oldContent, oldExists, err := readRequirementsFile(root, manifestPath)
	if err != nil {
		return RequirementsPlan{}, err
	}
	if !oldExists && !strings.EqualFold(manifestPath, "requirements.txt") {
		return RequirementsPlan{}, fmt.Errorf("only the root requirements.txt may be created by the package center")
	}
	lines, trailingNewline := splitRequirementLines(oldContent)
	if requirementsUseHashChecking(lines) {
		return RequirementsPlan{}, fmt.Errorf("hash-locked requirements are read-only in the package center")
	}
	if err := validateSimpleRequirements(lines); err != nil {
		return RequirementsPlan{}, err
	}
	locations := indexRequirements(lines)
	removedLines := make(map[int]bool)
	normalized := make([]model.ProjectPackageChange, 0, len(changes))
	seen := make(map[string]bool, len(changes))
	reinstall := false
	for _, change := range changes {
		item, normalizeErr := normalizePythonChange(change)
		if normalizeErr != nil {
			return RequirementsPlan{}, normalizeErr
		}
		key := normalizePythonName(item.Name)
		if seen[key] {
			return RequirementsPlan{}, fmt.Errorf("package %s is changed more than once", item.Name)
		}
		seen[key] = true
		matches := locations[key]
		if len(matches) > 1 {
			return RequirementsPlan{}, fmt.Errorf("package %s is declared more than once in %s", item.Name, manifestPath)
		}
		switch item.Operation {
		case "add":
			if len(matches) != 0 {
				return RequirementsPlan{}, fmt.Errorf("package %s is already declared in %s", item.Name, manifestPath)
			}
			lines = append(lines, renderPythonRequirement(item))
			locations[key] = []int{len(lines) - 1}
		case "update":
			if len(matches) != 1 {
				return RequirementsPlan{}, fmt.Errorf("package %s is not declared in %s", item.Name, manifestPath)
			}
			if requirementUsesExtras(lines[matches[0]]) && len(item.Features) == 0 {
				return RequirementsPlan{}, fmt.Errorf("package %s uses extras; choose them explicitly before updating", item.Name)
			}
			replacement := replaceRequirementLine(lines[matches[0]], item)
			if replacement == lines[matches[0]] && options.AllowReinstall[key] {
				if len(changes) != 1 {
					return RequirementsPlan{}, fmt.Errorf("a package reinstall must be the only requested change")
				}
				reinstall = true
			}
			lines[matches[0]] = replacement
		case "remove":
			if len(matches) != 1 {
				return RequirementsPlan{}, fmt.Errorf("package %s is not declared in %s", item.Name, manifestPath)
			}
			removedLines[matches[0]] = true
		}
		normalized = append(normalized, item)
	}
	if len(removedLines) > 0 {
		compacted := make([]string, 0, len(lines))
		for index, line := range lines {
			if !removedLines[index] {
				compacted = append(compacted, line)
			}
		}
		lines = compacted
	}
	newContent := strings.Join(lines, "\n")
	if len(lines) > 0 && (trailingNewline || len(oldContent) == 0) {
		newContent += "\n"
	}
	if int64(len(newContent)) > maxRequirementsBytes {
		return RequirementsPlan{}, fmt.Errorf("updated requirements file exceeds %d bytes", maxRequirementsBytes)
	}
	if newContent == string(oldContent) && !reinstall {
		return RequirementsPlan{}, fmt.Errorf("package changes do not modify %s", manifestPath)
	}
	oldSHA := ""
	if oldExists {
		oldSHA = digestBytes(oldContent)
	}
	result := RequirementsPlan{
		Changes:         normalized,
		ManifestBinding: model.ProjectPackageManifestBinding{Path: manifestPath, SHA256: digestBytes([]byte(newContent))},
		ManifestContent: newContent,
		Reinstall:       reinstall,
		Warnings:        []string{},
	}
	if !reinstall {
		result.LocalChange = model.ProjectPackageLocalChange{
			Path: manifestPath, OldExists: oldExists, OldSHA256: oldSHA, NewContent: newContent, NewSHA256: result.ManifestBinding.SHA256,
			Description: "Update the project Python requirements manifest",
		}
	}
	return result, nil
}

func selectRequirementsManifest(root, requested string, candidates []string) (string, error) {
	requested = filepath.ToSlash(strings.TrimSpace(requested))
	editable := make([]string, 0, len(candidates))
	seen := make(map[string]bool)
	for _, candidate := range candidates {
		candidate = filepath.ToSlash(strings.TrimSpace(candidate))
		if !isRequirementsManifest(candidate) || seen[strings.ToLower(candidate)] {
			continue
		}
		if _, err := safeRequirementsPath(root, candidate); err != nil {
			continue
		}
		seen[strings.ToLower(candidate)] = true
		editable = append(editable, candidate)
	}
	sort.Strings(editable)
	if requested != "" {
		if !isRequirementsManifest(requested) {
			return "", fmt.Errorf("manifestPath must select a requirements*.txt file")
		}
		if _, err := safeRequirementsPath(root, requested); err != nil {
			return "", err
		}
		return requested, nil
	}
	for _, candidate := range editable {
		if strings.EqualFold(candidate, "requirements.txt") {
			return candidate, nil
		}
	}
	if len(editable) == 1 {
		return editable[0], nil
	}
	if len(editable) == 0 {
		return "requirements.txt", nil
	}
	return "", fmt.Errorf("manifestPath is required when multiple requirements files are available")
}

func safeRequirementsPath(root, relative string) (string, error) {
	root = filepath.Clean(strings.TrimSpace(root))
	relative = filepath.Clean(filepath.FromSlash(strings.TrimSpace(relative)))
	if root == "." || relative == "." || filepath.IsAbs(relative) || !isRequirementsManifest(filepath.ToSlash(relative)) {
		return "", fmt.Errorf("invalid requirements manifest path")
	}
	full := filepath.Clean(filepath.Join(root, relative))
	if full == root || !strings.HasPrefix(full, root+string(filepath.Separator)) {
		return "", fmt.Errorf("requirements manifest escapes the project workspace")
	}
	return full, nil
}

func isRequirementsManifest(relative string) bool {
	base := strings.ToLower(filepath.Base(filepath.FromSlash(relative)))
	return strings.HasPrefix(base, "requirements") && strings.HasSuffix(base, ".txt")
}

func splitRequirementLines(data []byte) ([]string, bool) {
	if len(data) == 0 {
		return []string{}, false
	}
	trailing := data[len(data)-1] == '\n'
	trimmed := strings.TrimSuffix(strings.ReplaceAll(string(data), "\r\n", "\n"), "\n")
	if trimmed == "" {
		return []string{}, trailing
	}
	return strings.Split(trimmed, "\n"), trailing
}

func indexRequirements(lines []string) map[string][]int {
	result := make(map[string][]int)
	for index, line := range lines {
		name, ok := simpleRequirementName(line)
		if ok {
			key := normalizePythonName(name)
			result[key] = append(result[key], index)
		}
	}
	return result
}

func simpleRequirementName(line string) (string, bool) {
	value := strings.TrimSpace(line)
	if value == "" || strings.HasPrefix(value, "#") || strings.HasPrefix(value, "-") || strings.Contains(value, "://") || strings.Contains(value, " @ ") || strings.HasSuffix(value, "\\") || strings.Contains(value, "--hash") {
		return "", false
	}
	if index := strings.Index(value, "#"); index >= 0 {
		value = strings.TrimSpace(value[:index])
	}
	if index := strings.Index(value, ";"); index >= 0 {
		value = strings.TrimSpace(value[:index])
	}
	nameEnd := len(value)
	for index, char := range value {
		if char == '[' || strings.ContainsRune("<>=!~ ", char) {
			nameEnd = index
			break
		}
	}
	name := strings.TrimSpace(value[:nameEnd])
	return name, pythonPackageNamePattern.MatchString(name)
}

func requirementsUseHashChecking(lines []string) bool {
	for _, line := range lines {
		value := strings.ToLower(strings.TrimSpace(line))
		if strings.HasPrefix(value, "--require-hashes") || strings.Contains(value, "--hash=") || strings.Contains(value, "--hash ") {
			return true
		}
	}
	return false
}

func validateSimpleRequirements(lines []string) error {
	for _, line := range lines {
		value := strings.TrimSpace(line)
		if strings.HasSuffix(value, "\\") {
			return fmt.Errorf("continued requirements are read-only in the package center")
		}
		if value == "" || strings.HasPrefix(value, "#") {
			continue
		}
		body := value
		if index := strings.Index(body, "#"); index >= 0 {
			body = body[:index]
		}
		if strings.Contains(body, ";") {
			return fmt.Errorf("environment-marked requirements are read-only in the package center")
		}
		lower := strings.ToLower(value)
		if strings.HasPrefix(lower, "-") {
			return fmt.Errorf("requirements directives are read-only in the package center")
		}
		if strings.Contains(lower, "://") || strings.Contains(lower, " @ ") || strings.HasPrefix(lower, "git+") || strings.HasPrefix(lower, "hg+") || strings.HasPrefix(lower, "svn+") || strings.HasPrefix(lower, "bzr+") || strings.HasPrefix(lower, "file:") {
			return fmt.Errorf("direct URL requirements are read-only in the package center")
		}
		if strings.Contains(lower, " --") {
			return fmt.Errorf("requirements options are read-only in the package center")
		}
		if _, ok := simpleRequirementName(value); !ok {
			return fmt.Errorf("non-simple requirements are read-only in the package center")
		}
	}
	return nil
}

func requirementUsesExtras(line string) bool {
	value := strings.TrimSpace(line)
	nameEnd := len(value)
	for index, char := range value {
		if strings.ContainsRune("<>=!~ ;#", char) {
			nameEnd = index
			break
		}
	}
	return strings.Contains(value[:nameEnd], "[")
}

func normalizePythonChange(change model.ProjectPackageChange) (model.ProjectPackageChange, error) {
	change.Operation = strings.ToLower(strings.TrimSpace(change.Operation))
	change.Name = strings.TrimSpace(change.Name)
	change.Version = strings.TrimSpace(change.Version)
	change.Scope = strings.ToLower(strings.TrimSpace(change.Scope))
	if change.Scope == "" {
		change.Scope = "runtime"
	}
	if change.Operation != "add" && change.Operation != "update" && change.Operation != "remove" {
		return model.ProjectPackageChange{}, fmt.Errorf("package operation must be add, update, or remove")
	}
	if !pythonPackageNamePattern.MatchString(change.Name) {
		return model.ProjectPackageChange{}, fmt.Errorf("invalid Python distribution name")
	}
	change.Name = normalizePythonName(change.Name)
	if change.Scope != "runtime" {
		return model.ProjectPackageChange{}, fmt.Errorf("Python requirements currently support only runtime scope")
	}
	if change.Operation != "remove" && !pythonVersionPattern.MatchString(change.Version) {
		return model.ProjectPackageChange{}, fmt.Errorf("add and update require an exact Python package version")
	}
	if change.Operation == "remove" {
		change.Version = ""
		change.Features = nil
		return change, nil
	}
	features := make([]string, 0, len(change.Features))
	seen := make(map[string]bool)
	for _, feature := range change.Features {
		feature = strings.ToLower(strings.TrimSpace(feature))
		if !pythonFeaturePattern.MatchString(feature) {
			return model.ProjectPackageChange{}, fmt.Errorf("invalid Python package extra")
		}
		if !seen[feature] {
			seen[feature] = true
			features = append(features, feature)
		}
	}
	sort.Strings(features)
	change.Features = features
	return change, nil
}

func normalizePythonName(value string) string {
	return strings.ToLower(pythonNameSeparator.ReplaceAllString(strings.TrimSpace(value), "-"))
}

func renderPythonRequirement(change model.ProjectPackageChange) string {
	name := change.Name
	if len(change.Features) > 0 {
		name += "[" + strings.Join(change.Features, ",") + "]"
	}
	return name + "==" + change.Version
}

func replaceRequirementLine(original string, change model.ProjectPackageChange) string {
	comment := ""
	body := original
	if index := strings.Index(body, "#"); index >= 0 {
		comment = strings.TrimSpace(body[index:])
		body = body[:index]
	}
	marker := ""
	if index := strings.Index(body, ";"); index >= 0 {
		marker = strings.TrimSpace(body[index:])
	}
	result := renderPythonRequirement(change)
	if marker != "" {
		result += " " + marker
	}
	if comment != "" {
		result += " " + comment
	}
	return result
}

func digestBytes(data []byte) string {
	hash := sha256.Sum256(data)
	return hex.EncodeToString(hash[:])
}

// ScanRequirements is used only by tests and future adapters to verify that
// edits preserve comments and unsupported requirement forms.
func ScanRequirements(data []byte) []string {
	result := []string{}
	scanner := bufio.NewScanner(bytes.NewReader(data))
	for scanner.Scan() {
		if name, ok := simpleRequirementName(scanner.Text()); ok {
			result = append(result, normalizePythonName(name))
		}
	}
	return result
}
