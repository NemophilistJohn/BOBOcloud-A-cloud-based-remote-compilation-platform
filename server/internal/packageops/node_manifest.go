package packageops

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"path"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"unicode/utf8"

	"bobocloud-server/internal/model"
)

const maxNodePackageJSONBytes = 8 << 20

var (
	nodePackagePartPattern  = regexp.MustCompile(`^[a-z0-9](?:[a-z0-9._~-]{0,212}[a-z0-9._~-])?$`)
	nodeExactVersionPattern = regexp.MustCompile(`^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$`)
)

var nodeDependencyFields = map[string]string{
	"runtime":  "dependencies",
	"dev":      "devDependencies",
	"optional": "optionalDependencies",
}

var managedNodeManifestNames = map[string]bool{
	"package.json":        true,
	"package-lock.json":   true,
	"npm-shrinkwrap.json": true,
	"pnpm-lock.yaml":      true,
}

// ReadNodeDependencySnapshot opens a managed Node manifest through the same
// no-follow project path walk used by the Python adapter and verifies the
// reviewed digest when one is supplied.
func ReadNodeDependencySnapshot(root, relative, expectedSHA256 string) ([]byte, bool, error) {
	normalized, err := normalizeNodeProjectPath(relative)
	if err != nil || !managedNodeManifestNames[path.Base(normalized)] {
		return nil, false, fmt.Errorf("invalid managed Node dependency file")
	}
	data, exists, err := readRequirementsFile(root, filepath.Clean(filepath.FromSlash(normalized)))
	if err != nil || !exists {
		return data, exists, err
	}
	if expected := strings.TrimSpace(expectedSHA256); expected != "" {
		digest := sha256.Sum256(data)
		if !strings.EqualFold(hex.EncodeToString(digest[:]), expected) {
			return nil, true, fmt.Errorf("Node dependency file no longer matches the reviewed package plan")
		}
	}
	return data, true, nil
}

// NodePackageManagerHint describes the manager selected from project-owned
// metadata. It is only a hint for the caller; this package never executes it.
type NodePackageManagerHint struct {
	Manager  string
	Evidence string
}

// NodeManifestPlan is a pure, filesystem-independent package.json change.
// Callers remain responsible for CAS validation and atomic publication.
type NodeManifestPlan struct {
	Changes         []model.ProjectPackageChange
	LocalChange     model.ProjectPackageLocalChange
	ManifestBinding model.ProjectPackageManifestBinding
	ManifestContent string
	ManagerHint     NodePackageManagerHint
	Warnings        []string
}

// PlanNodePackageJSON plans direct dependency changes without reading files or
// running a package manager. manifestPaths are used only to infer npm or pnpm.
func PlanNodePackageJSON(manifestPath string, packageJSON []byte, manifestPaths []string, changes []model.ProjectPackageChange) (NodeManifestPlan, error) {
	if len(changes) == 0 || len(changes) > maxPackageChanges {
		return NodeManifestPlan{}, fmt.Errorf("package changes must contain between 1 and %d entries", maxPackageChanges)
	}
	manifestPath, err := normalizeNodePackageJSONPath(manifestPath)
	if err != nil {
		return NodeManifestPlan{}, err
	}
	root, err := parseNodePackageJSON(packageJSON)
	if err != nil {
		return NodeManifestPlan{}, err
	}
	if _, workspace := root.object.byKey["workspaces"]; workspace {
		return NodeManifestPlan{}, fmt.Errorf("Node workspace dependency changes are not supported yet")
	}
	managerHint, err := detectNodePackageManager(root, manifestPath, manifestPaths)
	if err != nil {
		return NodeManifestPlan{}, err
	}

	sections := make(map[string]*nodeDependencySection, len(nodeDependencyFields))
	for _, scope := range []string{"runtime", "dev", "optional"} {
		field := nodeDependencyFields[scope]
		section, parseErr := parseNodeDependencySection(root, field)
		if parseErr != nil {
			return NodeManifestPlan{}, parseErr
		}
		sections[scope] = section
	}

	normalized := make([]model.ProjectPackageChange, 0, len(changes))
	seen := make(map[string]bool, len(changes))
	for _, requested := range changes {
		change, normalizeErr := normalizeNodeChange(requested)
		if normalizeErr != nil {
			return NodeManifestPlan{}, normalizeErr
		}
		if seen[change.Name] {
			return NodeManifestPlan{}, fmt.Errorf("package %s is changed more than once", change.Name)
		}
		seen[change.Name] = true

		foundScope, foundIndex, findErr := findNodeDependency(sections, change.Name)
		if findErr != nil {
			return NodeManifestPlan{}, findErr
		}
		switch change.Operation {
		case "add":
			if foundScope != "" {
				return NodeManifestPlan{}, fmt.Errorf("package %s is already declared in %s", change.Name, nodeDependencyFields[foundScope])
			}
			sections[change.Scope].add(change.Name, change.Version)
		case "update":
			if foundScope == "" {
				return NodeManifestPlan{}, fmt.Errorf("package %s is not declared in package.json", change.Name)
			}
			targetScope := change.Scope
			if targetScope == "" {
				targetScope = foundScope
			}
			change.Scope = targetScope
			current := sections[foundScope].entries[foundIndex]
			if foundScope == targetScope {
				sections[foundScope].setVersion(foundIndex, change.Version)
			} else {
				sections[foundScope].remove(foundIndex)
				sections[targetScope].add(change.Name, change.Version)
			}
			if foundScope == targetScope && current.value == change.Version {
				return NodeManifestPlan{}, fmt.Errorf("package changes do not modify %s", manifestPath)
			}
		case "remove":
			if foundScope == "" {
				return NodeManifestPlan{}, fmt.Errorf("package %s is not declared in package.json", change.Name)
			}
			if change.Scope != "" && change.Scope != foundScope {
				return NodeManifestPlan{}, fmt.Errorf("package %s is declared in %s, not %s", change.Name, nodeDependencyFields[foundScope], nodeDependencyFields[change.Scope])
			}
			change.Scope = foundScope
			sections[foundScope].remove(foundIndex)
		}
		normalized = append(normalized, change)
	}

	updated := append([]byte(nil), packageJSON...)
	type replacement struct {
		start int
		end   int
		data  []byte
	}
	replacements := make([]replacement, 0, len(sections))
	missing := make([]string, 0, len(sections))
	style := detectNodeJSONStyle(packageJSON, root.object)
	for _, scope := range []string{"runtime", "dev", "optional"} {
		section := sections[scope]
		if !section.changed {
			continue
		}
		rendered := renderNodeDependencySection(section, style)
		if section.exists {
			replacements = append(replacements, replacement{start: section.rootMember.valueStart, end: section.rootMember.valueEnd, data: rendered})
		} else {
			missing = append(missing, scope)
		}
	}
	sort.Slice(replacements, func(i, j int) bool { return replacements[i].start > replacements[j].start })
	for _, item := range replacements {
		updated = replaceNodeJSONRange(updated, item.start, item.end, item.data)
	}
	for _, scope := range missing {
		currentRoot, parseErr := parseNodePackageJSON(updated)
		if parseErr != nil {
			return NodeManifestPlan{}, fmt.Errorf("render updated package.json: %w", parseErr)
		}
		section := sections[scope]
		updated, parseErr = appendNodeRootProperty(updated, currentRoot.object, nodeDependencyFields[scope], renderNodeDependencySection(section, detectNodeJSONStyle(updated, currentRoot.object)))
		if parseErr != nil {
			return NodeManifestPlan{}, parseErr
		}
	}
	if bytes.Equal(updated, packageJSON) {
		return NodeManifestPlan{}, fmt.Errorf("package changes do not modify %s", manifestPath)
	}
	newSHA := digestBytes(updated)
	return NodeManifestPlan{
		Changes: normalized,
		LocalChange: model.ProjectPackageLocalChange{
			Path: manifestPath, OldExists: true, OldSHA256: digestBytes(packageJSON), NewContent: string(updated), NewSHA256: newSHA,
			Description: "Update the project Node package manifest",
		},
		ManifestBinding: model.ProjectPackageManifestBinding{Path: manifestPath, SHA256: newSHA},
		ManifestContent: string(updated),
		ManagerHint:     managerHint,
		Warnings:        []string{},
	}, nil
}

type nodePackageJSON struct {
	data   []byte
	object rawJSONObject
}

func parseNodePackageJSON(data []byte) (nodePackageJSON, error) {
	if len(data) == 0 {
		return nodePackageJSON{}, fmt.Errorf("package.json must already exist")
	}
	if len(data) > maxNodePackageJSONBytes {
		return nodePackageJSON{}, fmt.Errorf("package.json exceeds %d bytes", maxNodePackageJSONBytes)
	}
	if !utf8.Valid(data) || !json.Valid(data) {
		return nodePackageJSON{}, fmt.Errorf("package.json is not valid UTF-8 JSON")
	}
	trimmed := bytes.TrimSpace(data)
	if len(trimmed) == 0 || trimmed[0] != '{' {
		return nodePackageJSON{}, fmt.Errorf("package.json root must be an object")
	}
	object, err := scanRawJSONObject(data)
	if err != nil {
		return nodePackageJSON{}, fmt.Errorf("parse package.json: %w", err)
	}
	return nodePackageJSON{data: data, object: object}, nil
}

type nodeDependencyEntry struct {
	name     string
	value    string
	rawKey   []byte
	rawValue []byte
	modified bool
}

type nodeDependencySection struct {
	field      string
	exists     bool
	changed    bool
	raw        []byte
	object     rawJSONObject
	rootMember rawJSONMember
	entries    []nodeDependencyEntry
}

func parseNodeDependencySection(root nodePackageJSON, field string) (*nodeDependencySection, error) {
	section := &nodeDependencySection{field: field, entries: []nodeDependencyEntry{}}
	member, ok := root.object.byKey[field]
	if !ok {
		return section, nil
	}
	section.exists = true
	section.rootMember = member
	section.raw = append([]byte(nil), root.data[member.valueStart:member.valueEnd]...)
	trimmed := bytes.TrimSpace(section.raw)
	if len(trimmed) == 0 || trimmed[0] != '{' {
		return nil, fmt.Errorf("package.json field %s must be an object", field)
	}
	object, err := scanRawJSONObject(section.raw)
	if err != nil {
		return nil, fmt.Errorf("parse package.json field %s: %w", field, err)
	}
	section.object = object
	for _, item := range object.members {
		var value string
		if err := json.Unmarshal(section.raw[item.valueStart:item.valueEnd], &value); err != nil {
			return nil, fmt.Errorf("package.json field %s must contain only string versions", field)
		}
		section.entries = append(section.entries, nodeDependencyEntry{
			name:     item.key,
			value:    value,
			rawKey:   append([]byte(nil), section.raw[item.keyStart:item.keyEnd]...),
			rawValue: append([]byte(nil), section.raw[item.valueStart:item.valueEnd]...),
		})
	}
	return section, nil
}

func (section *nodeDependencySection) add(name, version string) {
	section.entries = append(section.entries, nodeDependencyEntry{name: name, value: version, modified: true})
	section.changed = true
}

func (section *nodeDependencySection) setVersion(index int, version string) {
	if section.entries[index].value == version {
		return
	}
	section.entries[index].value = version
	section.entries[index].modified = true
	section.changed = true
}

func (section *nodeDependencySection) remove(index int) {
	section.entries = append(section.entries[:index], section.entries[index+1:]...)
	section.changed = true
}

func findNodeDependency(sections map[string]*nodeDependencySection, name string) (string, int, error) {
	foundScope := ""
	foundIndex := -1
	for _, scope := range []string{"runtime", "dev", "optional"} {
		for index, entry := range sections[scope].entries {
			if !strings.EqualFold(entry.name, name) {
				continue
			}
			if foundScope != "" {
				return "", -1, fmt.Errorf("package %s is declared in more than one dependency scope", name)
			}
			foundScope = scope
			foundIndex = index
		}
	}
	return foundScope, foundIndex, nil
}

func normalizeNodeChange(change model.ProjectPackageChange) (model.ProjectPackageChange, error) {
	change.Operation = strings.ToLower(strings.TrimSpace(change.Operation))
	change.Name = strings.TrimSpace(change.Name)
	change.Version = strings.TrimSpace(change.Version)
	change.Scope = strings.ToLower(strings.TrimSpace(change.Scope))
	if change.Operation != "add" && change.Operation != "update" && change.Operation != "remove" {
		return model.ProjectPackageChange{}, fmt.Errorf("package operation must be add, update, or remove")
	}
	if !validNodePackageName(change.Name) {
		return model.ProjectPackageChange{}, fmt.Errorf("invalid npm package name")
	}
	if change.Scope != "" && nodeDependencyFields[change.Scope] == "" {
		return model.ProjectPackageChange{}, fmt.Errorf("Node dependencies support only runtime, dev, or optional scope")
	}
	if len(change.Features) != 0 {
		return model.ProjectPackageChange{}, fmt.Errorf("Node dependency changes do not support package features")
	}
	change.Features = nil
	if change.Operation == "remove" {
		change.Version = ""
		return change, nil
	}
	if !nodeExactVersionPattern.MatchString(change.Version) {
		return model.ProjectPackageChange{}, fmt.Errorf("add and update require an exact npm package version")
	}
	if change.Operation == "add" && change.Scope == "" {
		change.Scope = "runtime"
	}
	return change, nil
}

func validNodePackageName(name string) bool {
	if name == "" || len(name) > 214 || name != strings.ToLower(name) || strings.ContainsAny(name, "\\%:") {
		return false
	}
	if strings.HasPrefix(name, "@") {
		parts := strings.Split(name[1:], "/")
		return len(parts) == 2 && nodePackagePartPattern.MatchString(parts[0]) && nodePackagePartPattern.MatchString(parts[1])
	}
	return !strings.Contains(name, "/") && nodePackagePartPattern.MatchString(name)
}

func normalizeNodePackageJSONPath(value string) (string, error) {
	if strings.TrimSpace(value) == "" {
		return "package.json", nil
	}
	value, err := normalizeNodeProjectPath(value)
	if err != nil || path.Base(value) != "package.json" {
		return "", fmt.Errorf("invalid package.json manifest path")
	}
	return value, nil
}

func normalizeNodeProjectPath(value string) (string, error) {
	value = strings.TrimSpace(strings.ReplaceAll(value, "\\", "/"))
	if value == "" || strings.HasPrefix(value, "/") || path.IsAbs(value) || (len(value) >= 2 && value[1] == ':') {
		return "", fmt.Errorf("invalid project-relative manifest path")
	}
	for _, char := range value {
		if char < 0x20 || char == 0x7f {
			return "", fmt.Errorf("invalid project-relative manifest path")
		}
	}
	for _, part := range strings.Split(value, "/") {
		if part == "" || part == "." || part == ".." {
			return "", fmt.Errorf("invalid project-relative manifest path")
		}
	}
	cleaned := path.Clean(value)
	if cleaned == "." || strings.HasPrefix(cleaned, "../") {
		return "", fmt.Errorf("invalid project-relative manifest path")
	}
	return cleaned, nil
}

func detectNodePackageManager(root nodePackageJSON, packagePath string, manifestPaths []string) (NodePackageManagerHint, error) {
	declared := ""
	if member, ok := root.object.byKey["packageManager"]; ok {
		var value string
		if err := json.Unmarshal(root.data[member.valueStart:member.valueEnd], &value); err != nil {
			return NodePackageManagerHint{}, fmt.Errorf("package.json field packageManager must be a string")
		}
		name := value
		if index := strings.Index(name, "@"); index >= 0 {
			name = name[:index]
		}
		name = strings.ToLower(strings.TrimSpace(name))
		if name != "npm" && name != "pnpm" {
			return NodePackageManagerHint{}, fmt.Errorf("package.json selects unsupported Node package manager %q", name)
		}
		declared = name
	}

	packageDir := path.Dir(packagePath)
	if packageDir == "." {
		packageDir = ""
	}
	lockManagers := make(map[string]bool)
	for _, candidate := range manifestPaths {
		if strings.TrimSpace(candidate) == "" {
			continue
		}
		normalized, err := normalizeNodeProjectPath(candidate)
		if err != nil {
			return NodePackageManagerHint{}, err
		}
		if containsNodeModulesPath(normalized) || !nodeManifestAppliesToPackage(path.Dir(normalized), packageDir) {
			continue
		}
		switch strings.ToLower(path.Base(normalized)) {
		case "pnpm-lock.yaml", "pnpm-workspace.yaml":
			lockManagers["pnpm"] = true
		case "package-lock.json", "npm-shrinkwrap.json":
			lockManagers["npm"] = true
		}
	}
	if len(lockManagers) > 1 {
		return NodePackageManagerHint{}, fmt.Errorf("conflicting npm and pnpm lock metadata")
	}
	lockManager := ""
	for manager := range lockManagers {
		lockManager = manager
	}
	if declared != "" && lockManager != "" && declared != lockManager {
		return NodePackageManagerHint{}, fmt.Errorf("packageManager selects %s but project lock metadata selects %s", declared, lockManager)
	}
	if declared != "" {
		return NodePackageManagerHint{Manager: declared, Evidence: "packageManager"}, nil
	}
	if lockManager != "" {
		return NodePackageManagerHint{Manager: lockManager, Evidence: "lockfile"}, nil
	}
	return NodePackageManagerHint{Manager: "npm", Evidence: "default"}, nil
}

func containsNodeModulesPath(value string) bool {
	for _, part := range strings.Split(value, "/") {
		if strings.EqualFold(part, "node_modules") {
			return true
		}
	}
	return false
}

func nodeManifestAppliesToPackage(candidateDir, packageDir string) bool {
	if candidateDir == "." {
		candidateDir = ""
	}
	if candidateDir == packageDir {
		return true
	}
	if candidateDir == "" {
		return true
	}
	return strings.HasPrefix(packageDir, candidateDir+"/")
}

type rawJSONMember struct {
	key        string
	keyStart   int
	keyEnd     int
	valueStart int
	valueEnd   int
}

type rawJSONObject struct {
	open    int
	close   int
	members []rawJSONMember
	byKey   map[string]rawJSONMember
}

func scanRawJSONObject(data []byte) (rawJSONObject, error) {
	index := skipNodeJSONWhitespace(data, 0)
	if index >= len(data) || data[index] != '{' {
		return rawJSONObject{}, fmt.Errorf("JSON value must be an object")
	}
	result := rawJSONObject{open: index, byKey: make(map[string]rawJSONMember)}
	index++
	for {
		index = skipNodeJSONWhitespace(data, index)
		if index >= len(data) {
			return rawJSONObject{}, fmt.Errorf("unterminated JSON object")
		}
		if data[index] == '}' {
			result.close = index
			if skipNodeJSONWhitespace(data, index+1) != len(data) {
				return rawJSONObject{}, fmt.Errorf("unexpected content after JSON object")
			}
			return result, nil
		}
		keyStart := index
		keyEnd, err := scanNodeJSONString(data, keyStart)
		if err != nil {
			return rawJSONObject{}, err
		}
		var key string
		if err := json.Unmarshal(data[keyStart:keyEnd], &key); err != nil {
			return rawJSONObject{}, fmt.Errorf("invalid JSON object key")
		}
		if _, exists := result.byKey[key]; exists {
			return rawJSONObject{}, fmt.Errorf("duplicate JSON object key %q", key)
		}
		index = skipNodeJSONWhitespace(data, keyEnd)
		if index >= len(data) || data[index] != ':' {
			return rawJSONObject{}, fmt.Errorf("missing colon after JSON object key")
		}
		valueStart := skipNodeJSONWhitespace(data, index+1)
		valueEnd, err := scanNodeJSONValue(data, valueStart)
		if err != nil {
			return rawJSONObject{}, err
		}
		member := rawJSONMember{key: key, keyStart: keyStart, keyEnd: keyEnd, valueStart: valueStart, valueEnd: valueEnd}
		result.members = append(result.members, member)
		result.byKey[key] = member
		index = skipNodeJSONWhitespace(data, valueEnd)
		if index >= len(data) {
			return rawJSONObject{}, fmt.Errorf("unterminated JSON object")
		}
		if data[index] == ',' {
			index++
			continue
		}
		if data[index] != '}' {
			return rawJSONObject{}, fmt.Errorf("missing comma between JSON object fields")
		}
	}
}

func scanNodeJSONString(data []byte, start int) (int, error) {
	if start >= len(data) || data[start] != '"' {
		return 0, fmt.Errorf("JSON object keys must be strings")
	}
	for index := start + 1; index < len(data); index++ {
		switch data[index] {
		case '\\':
			index++
			if index >= len(data) {
				return 0, fmt.Errorf("unterminated JSON escape")
			}
		case '"':
			return index + 1, nil
		}
	}
	return 0, fmt.Errorf("unterminated JSON string")
}

func scanNodeJSONValue(data []byte, start int) (int, error) {
	if start >= len(data) {
		return 0, fmt.Errorf("missing JSON value")
	}
	if data[start] == '"' {
		return scanNodeJSONString(data, start)
	}
	if data[start] != '{' && data[start] != '[' {
		index := start
		for index < len(data) && !isNodeJSONWhitespace(data[index]) && data[index] != ',' && data[index] != '}' && data[index] != ']' {
			index++
		}
		return index, nil
	}
	stack := []byte{matchingNodeJSONDelimiter(data[start])}
	for index := start + 1; index < len(data); index++ {
		if data[index] == '"' {
			end, err := scanNodeJSONString(data, index)
			if err != nil {
				return 0, err
			}
			index = end - 1
			continue
		}
		switch data[index] {
		case '{', '[':
			stack = append(stack, matchingNodeJSONDelimiter(data[index]))
		case '}', ']':
			if len(stack) == 0 || data[index] != stack[len(stack)-1] {
				return 0, fmt.Errorf("mismatched JSON delimiter")
			}
			stack = stack[:len(stack)-1]
			if len(stack) == 0 {
				return index + 1, nil
			}
		}
	}
	return 0, fmt.Errorf("unterminated JSON value")
}

func matchingNodeJSONDelimiter(value byte) byte {
	if value == '{' {
		return '}'
	}
	return ']'
}

func skipNodeJSONWhitespace(data []byte, index int) int {
	for index < len(data) && isNodeJSONWhitespace(data[index]) {
		index++
	}
	return index
}

func isNodeJSONWhitespace(value byte) bool {
	return value == ' ' || value == '\t' || value == '\r' || value == '\n'
}

type nodeJSONStyle struct {
	multiline      bool
	lineEnding     string
	propertyIndent string
	indentUnit     string
}

func detectNodeJSONStyle(data []byte, object rawJSONObject) nodeJSONStyle {
	style := nodeJSONStyle{lineEnding: "\n", propertyIndent: "  ", indentUnit: "  "}
	if bytes.Contains(data, []byte("\r\n")) {
		style.lineEnding = "\r\n"
	}
	style.multiline = bytes.Contains(data[object.open:object.close], []byte("\n"))
	if len(object.members) == 0 {
		return style
	}
	indent := nodeJSONLineIndent(data, object.members[0].keyStart)
	if indent != "" {
		style.propertyIndent = indent
		style.indentUnit = indent
	}
	return style
}

func nodeJSONLineIndent(data []byte, position int) string {
	start := bytes.LastIndexByte(data[:position], '\n') + 1
	for index := start; index < position; index++ {
		if data[index] != ' ' && data[index] != '\t' && data[index] != '\r' {
			return ""
		}
	}
	return strings.TrimSuffix(string(data[start:position]), "\r")
}

func renderNodeDependencySection(section *nodeDependencySection, rootStyle nodeJSONStyle) []byte {
	if len(section.entries) == 0 {
		return []byte("{}")
	}
	multiline := rootStyle.multiline
	lineEnding := rootStyle.lineEnding
	entryIndent := rootStyle.propertyIndent + rootStyle.indentUnit
	closingIndent := rootStyle.propertyIndent
	colon := ": "
	comma := ", "
	if section.exists {
		multiline = bytes.Contains(section.raw, []byte("\n"))
		if multiline && len(section.object.members) > 0 {
			if detected := nodeJSONLineIndent(section.raw, section.object.members[0].keyStart); detected != "" {
				entryIndent = detected
			}
			if detected := nodeJSONLineIndent(section.raw, section.object.close); detected != "" {
				closingIndent = detected
			}
		}
		if len(section.object.members) > 0 {
			first := section.object.members[0]
			between := string(section.raw[first.keyEnd:first.valueStart])
			if strings.Contains(between, ":") {
				colon = between
			}
		}
	}
	var output bytes.Buffer
	output.WriteByte('{')
	for index, entry := range section.entries {
		if index > 0 {
			if multiline {
				output.WriteByte(',')
			} else {
				output.WriteString(comma)
			}
		}
		if multiline {
			output.WriteString(lineEnding)
			output.WriteString(entryIndent)
		}
		if len(entry.rawKey) > 0 {
			output.Write(entry.rawKey)
		} else {
			encoded, _ := json.Marshal(entry.name)
			output.Write(encoded)
		}
		output.WriteString(colon)
		if !entry.modified && len(entry.rawValue) > 0 {
			output.Write(entry.rawValue)
		} else {
			encoded, _ := json.Marshal(entry.value)
			output.Write(encoded)
		}
	}
	if multiline {
		output.WriteString(lineEnding)
		output.WriteString(closingIndent)
	}
	output.WriteByte('}')
	return output.Bytes()
}

func replaceNodeJSONRange(data []byte, start, end int, replacement []byte) []byte {
	result := make([]byte, 0, len(data)-(end-start)+len(replacement))
	result = append(result, data[:start]...)
	result = append(result, replacement...)
	result = append(result, data[end:]...)
	return result
}

func appendNodeRootProperty(data []byte, object rawJSONObject, field string, value []byte) ([]byte, error) {
	if _, exists := object.byKey[field]; exists {
		return nil, fmt.Errorf("package.json field %s already exists", field)
	}
	style := detectNodeJSONStyle(data, object)
	encodedField, _ := json.Marshal(field)
	property := append(append(append([]byte(nil), encodedField...), []byte(": ")...), value...)
	if len(object.members) == 0 {
		insertion := property
		if style.multiline {
			insertion = append([]byte(style.lineEnding+style.propertyIndent), property...)
			insertion = append(insertion, []byte(style.lineEnding)...)
		}
		return replaceNodeJSONRange(data, object.open+1, object.close, insertion), nil
	}
	last := object.members[len(object.members)-1]
	whitespace := data[last.valueEnd:object.close]
	var insertion []byte
	if bytes.Contains(whitespace, []byte("\n")) || style.multiline {
		closingIndent := nodeJSONLineIndent(data, object.close)
		insertion = append(insertion, ',')
		insertion = append(insertion, []byte(style.lineEnding+style.propertyIndent)...)
		insertion = append(insertion, property...)
		insertion = append(insertion, []byte(style.lineEnding+closingIndent)...)
	} else {
		separator := ","
		if len(whitespace) > 0 || bytes.Contains(data[object.open:object.close], []byte(" ")) {
			separator = ", "
		}
		insertion = append([]byte(separator), property...)
		insertion = append(insertion, whitespace...)
	}
	return replaceNodeJSONRange(data, last.valueEnd, object.close, insertion), nil
}
