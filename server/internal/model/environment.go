package model

// ProjectEnvironment is the stable aggregate contract consumed by the
// renderer. Host paths and analyzer-private configuration must never be added
// to this public shape.
type ProjectEnvironment struct {
	Schema          string                            `json:"schema"`
	Revision        string                            `json:"revision"`
	CheckedAt       int64                             `json:"checkedAt"`
	Workspace       ProjectEnvironmentWorkspace       `json:"workspace"`
	Language        ProjectEnvironmentLanguage        `json:"language"`
	Runtime         ProjectEnvironmentRuntime         `json:"runtime"`
	Manifests       []ProjectEnvironmentManifest      `json:"manifests"`
	Packages        ProjectEnvironmentPackages        `json:"packages"`
	Consistency     ProjectEnvironmentConsistency     `json:"consistency"`
	Activity        ProjectEnvironmentActivity        `json:"activity"`
	Actions         ProjectEnvironmentActions         `json:"actions"`
	DependencyCache ProjectEnvironmentDependencyCache `json:"dependencyCache"`
}

type ProjectEnvironmentDependencyCache struct {
	Scope              string `json:"scope"`
	Digest             string `json:"digest,omitempty"`
	Source             string `json:"source,omitempty"`
	Status             string `json:"status"`
	SizeBytes          int64  `json:"sizeBytes,omitempty"`
	LastUsedAt         int64  `json:"lastUsedAt,omitempty"`
	InventoryStatus    string `json:"inventoryStatus,omitempty"`
	InventoryDetail    string `json:"inventoryDetail,omitempty"`
	InventoryCheckedAt int64  `json:"inventoryCheckedAt,omitempty"`
}

type ProjectEnvironmentWorkspace struct {
	Kind      string `json:"kind"`
	ID        string `json:"id"`
	Name      string `json:"name"`
	Key       string `json:"key,omitempty"`
	TeamID    string `json:"teamId,omitempty"`
	ProjectID string `json:"projectId,omitempty"`
	Branch    string `json:"branch,omitempty"`
}

type ProjectEnvironmentLanguage struct {
	ID     string `json:"id"`
	Source string `json:"source"`
}

type ProjectEnvironmentRuntime struct {
	ID          string `json:"id"`
	Language    string `json:"language,omitempty"`
	Version     string `json:"version,omitempty"`
	Image       string `json:"image,omitempty"`
	DisplayName string `json:"displayName,omitempty"`
	Status      string `json:"status"`
}

type ProjectEnvironmentManifest struct {
	Path     string `json:"path"`
	Kind     string `json:"kind"`
	Manager  string `json:"manager"`
	Language string `json:"language"`
	Lockfile bool   `json:"lockfile"`
	Parsed   bool   `json:"parsed"`
	Status   string `json:"status"`
}

type ProjectEnvironmentPackage struct {
	Name       string `json:"name"`
	Version    string `json:"version,omitempty"`
	Constraint string `json:"constraint,omitempty"`
	Scope      string `json:"scope,omitempty"`
	Source     string `json:"source"`
	Trust      string `json:"trust,omitempty"`
	Reason     string `json:"reason,omitempty"`
}

type ProjectEnvironmentPackages struct {
	Declared  []ProjectEnvironmentPackage `json:"declared"`
	Installed []ProjectEnvironmentPackage `json:"installed"`
	Missing   []ProjectEnvironmentPackage `json:"missing"`
	Unknown   []ProjectEnvironmentPackage `json:"unknown"`
}

type ProjectEnvironmentConsistency struct {
	Status            string                  `json:"status"`
	LanguageRuntime   ProjectEnvironmentCheck `json:"languageRuntime"`
	DependencyRuntime ProjectEnvironmentCheck `json:"dependencyRuntime"`
	LSPDependencies   ProjectEnvironmentCheck `json:"lspDependencies"`
	Detail            string                  `json:"detail,omitempty"`
}

type ProjectEnvironmentCheck struct {
	Status string `json:"status"`
	Detail string `json:"detail,omitempty"`
}

type ProjectEnvironmentActivity struct {
	LastIndexedAt   int64 `json:"lastIndexedAt,omitempty"`
	LastInstalledAt int64 `json:"lastInstalledAt,omitempty"`
	LastCompiledAt  int64 `json:"lastCompiledAt,omitempty"`
}

type ProjectEnvironmentCapability struct {
	Supported            bool   `json:"supported"`
	RequiresConfirmation bool   `json:"requiresConfirmation,omitempty"`
	Scope                string `json:"scope,omitempty"`
	Reason               string `json:"reason,omitempty"`
}

type ProjectEnvironmentActions struct {
	RefreshIndex ProjectEnvironmentCapability `json:"refreshIndex"`
	ClearCache   ProjectEnvironmentCapability `json:"clearCache"`
	Repair       ProjectEnvironmentCapability `json:"repair"`
	Rebuild      ProjectEnvironmentCapability `json:"rebuild"`
}

type ProjectEnvironmentRepairStep struct {
	ID           string `json:"id"`
	Kind         string `json:"kind"`
	Manager      string `json:"manager"`
	ManifestPath string `json:"manifestPath,omitempty"`
	Description  string `json:"description"`
	Command      string `json:"-"`
}

type ProjectEnvironmentRepairPlan struct {
	Schema               string                         `json:"schema"`
	Revision             string                         `json:"revision"`
	Action               string                         `json:"action"`
	Supported            bool                           `json:"supported"`
	RequiresConfirmation bool                           `json:"requiresConfirmation"`
	Reason               string                         `json:"reason,omitempty"`
	Steps                []ProjectEnvironmentRepairStep `json:"steps"`
}

type ProjectEnvironmentActionResult struct {
	Schema      string              `json:"schema"`
	Action      string              `json:"action"`
	Applied     bool                `json:"applied"`
	ExitCode    int                 `json:"exitCode,omitempty"`
	Stdout      string              `json:"stdout,omitempty"`
	Stderr      string              `json:"stderr,omitempty"`
	Message     string              `json:"message,omitempty"`
	Environment *ProjectEnvironment `json:"environment,omitempty"`
}
