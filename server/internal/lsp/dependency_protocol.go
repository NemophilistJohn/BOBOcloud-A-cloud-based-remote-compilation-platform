package lsp

import (
	"bytes"
	"encoding/json"
	"fmt"
	"math/big"
	"strings"
)

// AnalysisDependencyStatus is the only dependency-view shape exposed to a
// client. Host paths, mount metadata, and local analyzer settings remain
// server-side even when a future host-based language server is selected.
type AnalysisDependencyStatus struct {
	Status        string         `json:"status"`
	Revision      string         `json:"revision,omitempty"`
	LanguageID    string         `json:"languageId"`
	RuntimeID     string         `json:"runtimeId"`
	Source        string         `json:"source,omitempty"`
	Configuration map[string]any `json:"configuration,omitempty"`
	Detail        string         `json:"detail,omitempty"`
}

func (v AnalysisDependencyView) PublicStatus(docker bool, source string) AnalysisDependencyStatus {
	status := "empty"
	if len(v.Mounts) > 0 {
		status = "ready"
	}
	configuration := map[string]any(nil)
	if docker {
		configuration = cloneAnyMap(v.DockerLSPSettings)
	}
	for _, mount := range v.Mounts {
		if mount.Legacy {
			source = "mixed"
			status = "mixed"
			break
		}
	}
	switch source {
	case "user", "team", "workspace", "runtime", "mixed":
	default:
		source = "runtime"
	}
	return AnalysisDependencyStatus{
		Status: status, Revision: v.Revision, LanguageID: v.LanguageID,
		RuntimeID: v.RuntimeID, Source: source, Configuration: configuration,
	}
}

func UnavailableDependencyStatus(languageID, runtimeID string) AnalysisDependencyStatus {
	return AnalysisDependencyStatus{
		Status: "unavailable", LanguageID: normalizeLanguage(languageID),
		RuntimeID: strings.TrimSpace(runtimeID), Source: "runtime",
	}
}

// SettingsForAnalyzer returns the private configuration used by the process.
// Local settings may contain the analysis-cache placeholder; it is expanded
// here so adapter implementations never need to know a session cache path.
func (v AnalysisDependencyView) SettingsForAnalyzer(docker bool, analysisCache string) map[string]any {
	settings := v.LocalLSPSettings
	if docker {
		settings = v.DockerLSPSettings
	}
	return replaceDependencyPlaceholders(cloneAnyMap(settings), analysisCache)
}

func replaceDependencyPlaceholders(values map[string]any, analysisCache string) map[string]any {
	if len(values) == 0 {
		return nil
	}
	for key, value := range values {
		values[key] = replaceDependencyValue(value, analysisCache)
	}
	return values
}

func replaceDependencyValue(value any, analysisCache string) any {
	switch typed := value.(type) {
	case string:
		return strings.ReplaceAll(typed, localAnalysisCachePlaceholder, analysisCache)
	case map[string]any:
		return replaceDependencyPlaceholders(cloneAnyMap(typed), analysisCache)
	case []string:
		out := make([]string, len(typed))
		for index, item := range typed {
			out[index] = strings.ReplaceAll(item, localAnalysisCachePlaceholder, analysisCache)
		}
		return out
	case []any:
		out := make([]any, len(typed))
		for index, item := range typed {
			out[index] = replaceDependencyValue(item, analysisCache)
		}
		return out
	default:
		return value
	}
}

type workspaceConfigurationRequest struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id"`
	Method  string          `json:"method"`
	Params  struct {
		Items []workspaceConfigurationItem `json:"items"`
	} `json:"params"`
}

type workspaceConfigurationItem struct {
	Section  string `json:"section"`
	ScopeURI string `json:"scopeUri,omitempty"`
	raw      json.RawMessage
}

func (i *workspaceConfigurationItem) UnmarshalJSON(data []byte) error {
	type itemAlias workspaceConfigurationItem
	var decoded itemAlias
	if err := json.Unmarshal(data, &decoded); err != nil {
		return err
	}
	*i = workspaceConfigurationItem(decoded)
	i.raw = append(i.raw[:0], data...)
	return nil
}

type workspaceConfigurationProxyItem struct {
	original    json.RawMessage
	override    any
	hasOverride bool
}

// WorkspaceConfigurationProxy records one analyzer request while its mixed or
// unknown sections make a client round trip. Its fields stay private so
// server-issued paths cannot accidentally be serialized to the client.
type WorkspaceConfigurationProxy struct {
	idKey string
	id    json.RawMessage
	items []workspaceConfigurationProxyItem
}

// NewWorkspaceConfigurationProxy captures the original item order and the
// server-issued overrides that must be merged into the eventual client result.
func NewWorkspaceConfigurationProxy(payload []byte, settings map[string]any) (*WorkspaceConfigurationProxy, error) {
	var request workspaceConfigurationRequest
	if err := json.Unmarshal(payload, &request); err != nil {
		return nil, fmt.Errorf("decode workspace configuration request: %w", err)
	}
	if request.JSONRPC != "2.0" || request.Method != "workspace/configuration" || len(request.ID) == 0 || string(request.ID) == "null" {
		return nil, fmt.Errorf("invalid workspace configuration request")
	}
	key, err := workspaceConfigurationIDKey(request.ID)
	if err != nil {
		return nil, err
	}
	proxy := &WorkspaceConfigurationProxy{
		idKey: key,
		id:    append(json.RawMessage(nil), request.ID...),
		items: make([]workspaceConfigurationProxyItem, len(request.Params.Items)),
	}
	for index, item := range request.Params.Items {
		proxy.items[index].original = append(json.RawMessage(nil), item.raw...)
		if dependencySettingsContainSection(settings, item.Section) {
			proxy.items[index].hasOverride = true
			proxy.items[index].override = cloneWorkspaceConfigurationValue(dependencyConfigurationSection(settings, item.Section))
		}
	}
	return proxy, nil
}

// IDKey is a connection-local lookup key. It preserves JSON-RPC string and
// number identity without exposing the original id or any dependency setting.
func (p *WorkspaceConfigurationProxy) IDKey() string {
	if p == nil {
		return ""
	}
	return p.idKey
}

func workspaceConfigurationIDKey(raw json.RawMessage) (string, error) {
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.UseNumber()
	var value any
	if err := decoder.Decode(&value); err != nil {
		return "", fmt.Errorf("decode workspace configuration id: %w", err)
	}
	switch typed := value.(type) {
	case string:
		return "s:" + typed, nil
	case json.Number:
		value, ok := new(big.Rat).SetString(typed.String())
		if !ok {
			return "", fmt.Errorf("workspace configuration id is not a valid JSON number")
		}
		return "n:" + value.RatString(), nil
	default:
		return "", fmt.Errorf("workspace configuration id must be a string or number")
	}
}

// WorkspaceConfigurationResponseKey extracts the response id for a
// connection-local pending lookup. It intentionally does not accept null,
// object, array, or boolean ids.
func WorkspaceConfigurationResponseKey(payload []byte) (string, error) {
	var response struct {
		JSONRPC string          `json:"jsonrpc"`
		ID      json.RawMessage `json:"id"`
		Method  string          `json:"method"`
	}
	if err := json.Unmarshal(payload, &response); err != nil {
		return "", fmt.Errorf("decode workspace configuration response: %w", err)
	}
	if response.JSONRPC != "2.0" || response.Method != "" || len(response.ID) == 0 || string(response.ID) == "null" {
		return "", fmt.Errorf("invalid workspace configuration response")
	}
	return workspaceConfigurationIDKey(response.ID)
}

// MergeResponse overlays server-issued dependency configuration onto the
// client result item-by-item. Client maps remain the base; dependency maps win
// recursively, while string arrays preserve client order and append unique
// server paths.
func (p *WorkspaceConfigurationProxy) MergeResponse(payload []byte) ([]byte, error) {
	if p == nil {
		return nil, fmt.Errorf("workspace configuration proxy is required")
	}
	var response struct {
		JSONRPC string          `json:"jsonrpc"`
		ID      json.RawMessage `json:"id"`
		Result  json.RawMessage `json:"result"`
		Error   json.RawMessage `json:"error"`
	}
	if err := json.Unmarshal(payload, &response); err != nil {
		return nil, fmt.Errorf("decode workspace configuration response: %w", err)
	}
	key, err := workspaceConfigurationIDKey(response.ID)
	if response.JSONRPC != "2.0" || err != nil || key != p.idKey {
		return nil, fmt.Errorf("workspace configuration response id does not match its request")
	}
	hasResult := len(response.Result) > 0
	hasError := len(response.Error) > 0
	if hasError {
		if hasResult {
			return nil, fmt.Errorf("workspace configuration response contains both result and error")
		}
		return p.FallbackResponse()
	}
	if !hasResult || bytes.Equal(bytes.TrimSpace(response.Result), []byte("null")) {
		return nil, fmt.Errorf("workspace configuration response result must be an array")
	}
	var result []any
	if err := json.Unmarshal(response.Result, &result); err != nil {
		return nil, fmt.Errorf("workspace configuration response result must be an array: %w", err)
	}
	if len(result) != len(p.items) {
		return nil, fmt.Errorf("workspace configuration response item count does not match its request")
	}
	for index, item := range p.items {
		if item.hasOverride {
			result[index] = mergeWorkspaceConfigurationValue(result[index], item.override)
		}
	}
	return json.Marshal(map[string]any{"jsonrpc": "2.0", "id": p.id, "result": result})
}

// FallbackResponse resolves a missing, failed, or timed-out client response
// without dropping dependency paths. Known items receive the server override;
// unknown items are null so no client setting is fabricated.
func (p *WorkspaceConfigurationProxy) FallbackResponse() ([]byte, error) {
	if p == nil || len(p.id) == 0 {
		return nil, fmt.Errorf("workspace configuration proxy is required")
	}
	result := make([]any, len(p.items))
	for index, item := range p.items {
		if item.hasOverride {
			result[index] = cloneWorkspaceConfigurationValue(item.override)
		}
	}
	return json.Marshal(map[string]any{"jsonrpc": "2.0", "id": p.id, "result": result})
}

func mergeWorkspaceConfigurationValue(userValue, serverValue any) any {
	userMap, userIsMap := userValue.(map[string]any)
	serverMap, serverIsMap := serverValue.(map[string]any)
	if userIsMap && serverIsMap {
		merged := cloneWorkspaceConfigurationMap(userMap)
		for key, serverItem := range serverMap {
			if userItem, exists := merged[key]; exists {
				merged[key] = mergeWorkspaceConfigurationValue(userItem, serverItem)
			} else {
				merged[key] = cloneWorkspaceConfigurationValue(serverItem)
			}
		}
		return merged
	}
	userStrings, userIsStrings := workspaceConfigurationStrings(userValue)
	serverStrings, serverIsStrings := workspaceConfigurationStrings(serverValue)
	if userIsStrings && serverIsStrings {
		merged := make([]string, 0, len(userStrings)+len(serverStrings))
		seen := make(map[string]struct{}, len(userStrings)+len(serverStrings))
		for _, values := range [][]string{userStrings, serverStrings} {
			for _, value := range values {
				if _, exists := seen[value]; exists {
					continue
				}
				seen[value] = struct{}{}
				merged = append(merged, value)
			}
		}
		return merged
	}
	return cloneWorkspaceConfigurationValue(serverValue)
}

func workspaceConfigurationStrings(value any) ([]string, bool) {
	switch typed := value.(type) {
	case []string:
		return append([]string(nil), typed...), true
	case []any:
		result := make([]string, len(typed))
		for index, item := range typed {
			text, ok := item.(string)
			if !ok {
				return nil, false
			}
			result[index] = text
		}
		return result, true
	default:
		return nil, false
	}
}

func cloneWorkspaceConfigurationMap(source map[string]any) map[string]any {
	if source == nil {
		return nil
	}
	result := make(map[string]any, len(source))
	for key, value := range source {
		result[key] = cloneWorkspaceConfigurationValue(value)
	}
	return result
}

func cloneWorkspaceConfigurationValue(value any) any {
	switch typed := value.(type) {
	case map[string]any:
		return cloneWorkspaceConfigurationMap(typed)
	case []string:
		return append([]string(nil), typed...)
	case []any:
		result := make([]any, len(typed))
		for index, item := range typed {
			result[index] = cloneWorkspaceConfigurationValue(item)
		}
		return result
	default:
		return value
	}
}

// WorkspaceConfigurationResponse answers analyzer-originated configuration
// requests inside the gateway. Dependency paths therefore never need a second
// client round-trip, and host-based settings are never disclosed.
func WorkspaceConfigurationResponse(payload []byte, settings map[string]any) ([]byte, error) {
	var request workspaceConfigurationRequest
	if err := json.Unmarshal(payload, &request); err != nil {
		return nil, fmt.Errorf("decode workspace configuration request: %w", err)
	}
	if request.JSONRPC != "2.0" || request.Method != "workspace/configuration" || len(request.ID) == 0 || string(request.ID) == "null" {
		return nil, fmt.Errorf("invalid workspace configuration request")
	}
	result := make([]any, len(request.Params.Items))
	for index, item := range request.Params.Items {
		result[index] = dependencyConfigurationSection(settings, item.Section)
	}
	return json.Marshal(map[string]any{"jsonrpc": "2.0", "id": request.ID, "result": result})
}

func dependencyConfigurationSection(settings map[string]any, section string) any {
	section = strings.TrimSpace(section)
	if section == "" {
		return cloneAnyMap(settings)
	}
	if direct, ok := settings[section]; ok {
		return replaceDependencyValue(direct, "")
	}
	var current any = settings
	for _, part := range strings.Split(section, ".") {
		object, ok := current.(map[string]any)
		if !ok {
			return nil
		}
		current, ok = object[part]
		if !ok {
			return nil
		}
	}
	return replaceDependencyValue(current, "")
}

func DidChangeConfigurationNotification(settings map[string]any) ([]byte, error) {
	if len(settings) == 0 {
		return nil, nil
	}
	return json.Marshal(map[string]any{
		"jsonrpc": "2.0", "method": "workspace/didChangeConfiguration",
		"params": map[string]any{"settings": settings},
	})
}

// MergeDependencyInitializationOptions injects server-owned analyzer options
// into an initialize request. User options are retained, but conflicting
// server fields win so a client cannot redirect executable/toolchain paths.
func MergeDependencyInitializationOptions(payload []byte, serverOptions map[string]any) ([]byte, error) {
	if len(serverOptions) == 0 {
		return append([]byte(nil), payload...), nil
	}
	var request map[string]any
	decoder := json.NewDecoder(bytes.NewReader(payload))
	decoder.UseNumber()
	if err := decoder.Decode(&request); err != nil {
		return nil, fmt.Errorf("decode initialize request: %w", err)
	}
	if request["jsonrpc"] != "2.0" || request["method"] != "initialize" {
		return nil, fmt.Errorf("dependency initialization options require an initialize request")
	}
	params, ok := request["params"].(map[string]any)
	if !ok {
		params = make(map[string]any)
		request["params"] = params
	}
	userOptions, _ := params["initializationOptions"].(map[string]any)
	params["initializationOptions"] = mergeDependencyOptionMaps(userOptions, serverOptions)
	return json.Marshal(request)
}

func mergeDependencyOptionMaps(user, server map[string]any) map[string]any {
	merged := cloneWorkspaceConfigurationMap(user)
	if merged == nil {
		merged = make(map[string]any, len(server))
	}
	for key, serverValue := range server {
		serverMap, serverIsMap := serverValue.(map[string]any)
		userMap, userIsMap := merged[key].(map[string]any)
		if serverIsMap && userIsMap {
			merged[key] = mergeDependencyOptionMaps(userMap, serverMap)
			continue
		}
		merged[key] = cloneWorkspaceConfigurationValue(serverValue)
	}
	return merged
}
