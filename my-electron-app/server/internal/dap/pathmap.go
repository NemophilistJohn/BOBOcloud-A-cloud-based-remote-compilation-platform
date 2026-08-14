package dap

import (
	"encoding/json"
	"fmt"
	"net/url"
	"path"
	"strings"
)

const (
	VirtualRootURI = "bobocloud-dap:///"
	ContainerRoot  = "/workspace"
)

type PathMapper struct{}

func NewPathMapper() *PathMapper { return &PathMapper{} }

func cleanRelative(value string) (string, error) {
	value = strings.ReplaceAll(strings.TrimSpace(value), "\\", "/")
	if value == "" || value == "." {
		return "", nil
	}
	for _, segment := range strings.Split(value, "/") {
		if segment == ".." {
			return "", fmt.Errorf("path escapes the debug workspace")
		}
	}
	cleaned := path.Clean(strings.TrimPrefix(value, "/"))
	if cleaned == ".." || strings.HasPrefix(cleaned, "../") {
		return "", fmt.Errorf("path escapes the debug workspace")
	}
	return cleaned, nil
}

func (m *PathMapper) ToContainer(value string) (string, error) {
	value = strings.TrimSpace(value)
	if value == "" {
		return "", nil
	}
	if strings.HasPrefix(value, VirtualRootURI) {
		parsed, err := url.Parse(value)
		if err != nil || parsed.Scheme != "bobocloud-dap" || parsed.Host != "" || parsed.RawQuery != "" || parsed.Fragment != "" {
			return "", fmt.Errorf("invalid BOBOCloud debug path")
		}
		relative, err := cleanRelative(parsed.Path)
		if err != nil {
			return "", err
		}
		if relative == "" {
			return ContainerRoot, nil
		}
		return path.Join(ContainerRoot, relative), nil
	}
	normalized := strings.ReplaceAll(value, "\\", "/")
	if normalized == ContainerRoot || strings.HasPrefix(normalized, ContainerRoot+"/") {
		relative, err := cleanRelative(strings.TrimPrefix(normalized, ContainerRoot))
		if err != nil {
			return "", err
		}
		if relative == "" {
			return ContainerRoot, nil
		}
		return path.Join(ContainerRoot, relative), nil
	}
	if strings.HasPrefix(normalized, "/") || (len(normalized) >= 2 && normalized[1] == ':') {
		return "", fmt.Errorf("absolute paths outside the debug workspace are not allowed")
	}
	relative, err := cleanRelative(normalized)
	if err != nil {
		return "", err
	}
	if relative == "" {
		return ContainerRoot, nil
	}
	return path.Join(ContainerRoot, relative), nil
}

func (m *PathMapper) ToVirtual(value string) string {
	normalized := path.Clean(strings.ReplaceAll(strings.TrimSpace(value), "\\", "/"))
	if normalized != ContainerRoot && !strings.HasPrefix(normalized, ContainerRoot+"/") {
		return value
	}
	relative := strings.TrimPrefix(strings.TrimPrefix(normalized, ContainerRoot), "/")
	if relative == "" {
		return VirtualRootURI
	}
	segments := strings.Split(relative, "/")
	for index := range segments {
		segments[index] = url.PathEscape(segments[index])
	}
	return VirtualRootURI + strings.Join(segments, "/")
}

func decodeObject(payload []byte) (map[string]any, error) {
	var value map[string]any
	decoderErr := json.Unmarshal(payload, &value)
	if decoderErr != nil || value == nil {
		return nil, fmt.Errorf("DAP message must be a JSON object")
	}
	return value, nil
}

func (m *PathMapper) RewriteInbound(payload []byte, spec AdapterSpec) ([]byte, error) {
	message, err := decodeObject(payload)
	if err != nil {
		return nil, err
	}
	command, _ := message["command"].(string)
	arguments, _ := message["arguments"].(map[string]any)
	if arguments == nil {
		return payload, nil
	}
	if command == "initialize" {
		arguments["pathFormat"] = "path"
		arguments["linesStartAt1"] = true
		arguments["columnsStartAt1"] = true
	}
	if command == "launch" {
		for key, value := range spec.LaunchDefaults {
			if _, exists := arguments[key]; !exists {
				arguments[key] = value
			}
		}
		arguments["request"] = "launch"
		arguments["console"] = "internalConsole"
		if spec.ID == "go-delve" {
			arguments["outputMode"] = "remote"
		}
		delete(arguments, "connect")
		delete(arguments, "listen")
		delete(arguments, "port")
		delete(arguments, "host")
		for _, key := range []string{"program", "cwd", "dlvCwd"} {
			if raw, ok := arguments[key].(string); ok && strings.TrimSpace(raw) != "" {
				mapped, mapErr := m.ToContainer(raw)
				if mapErr != nil {
					return nil, fmt.Errorf("invalid launch %s: %w", key, mapErr)
				}
				arguments[key] = mapped
			}
		}
		if raw, ok := arguments["runtimeExecutable"].(string); ok && strings.TrimSpace(raw) != "" {
			normalized := strings.ReplaceAll(strings.TrimSpace(raw), "\\", "/")
			if strings.Contains(normalized, "/") || strings.HasPrefix(normalized, VirtualRootURI) {
				mapped, mapErr := m.ToContainer(raw)
				if mapErr != nil {
					return nil, fmt.Errorf("invalid launch runtimeExecutable: %w", mapErr)
				}
				arguments["runtimeExecutable"] = mapped
			}
		}
		if _, ok := arguments["cwd"]; !ok {
			arguments["cwd"] = ContainerRoot
		}
	}
	if sourceCommands[command] {
		if source, ok := arguments["source"].(map[string]any); ok {
			if raw, ok := source["path"].(string); ok && strings.TrimSpace(raw) != "" {
				mapped, mapErr := m.ToContainer(raw)
				if mapErr != nil {
					return nil, fmt.Errorf("invalid source path: %w", mapErr)
				}
				source["path"] = mapped
			}
		}
	}
	return json.Marshal(message)
}

var sourceCommands = map[string]bool{
	"setBreakpoints": true, "breakpointLocations": true, "source": true, "gotoTargets": true,
}

func (m *PathMapper) RewriteOutbound(payload []byte) ([]byte, error) {
	message, err := decodeObject(payload)
	if err != nil {
		return nil, err
	}
	rewriteOutboundSources(message, m, false)
	return json.Marshal(message)
}

func rewriteOutboundSources(value any, mapper *PathMapper, sourceContext bool) {
	switch current := value.(type) {
	case map[string]any:
		if sourceContext {
			if raw, ok := current["path"].(string); ok {
				current["path"] = mapper.ToVirtual(raw)
			}
		}
		for key, child := range current {
			rewriteOutboundSources(child, mapper, key == "source" || key == "sources")
		}
	case []any:
		for _, child := range current {
			rewriteOutboundSources(child, mapper, sourceContext)
		}
	}
}
