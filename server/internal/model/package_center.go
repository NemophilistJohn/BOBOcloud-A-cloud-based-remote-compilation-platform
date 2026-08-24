package model

// Package center contracts intentionally contain no host paths, registry
// credentials, or executable commands. The renderer may select only the IDs
// and structured changes advertised by the server.
type PackageCenterSource struct {
	ID               string `json:"id"`
	Ecosystem        string `json:"ecosystem"`
	Name             string `json:"name"`
	Kind             string `json:"kind"`
	Official         bool   `json:"official,omitempty"`
	EquivalenceGroup string `json:"equivalenceGroup"`
	CatalogAuthority string `json:"catalogAuthority"`
}

type PackageCenterCapability struct {
	Supported bool   `json:"supported"`
	Reason    string `json:"reason,omitempty"`
}

type ProjectPackageInventory struct {
	Status           string `json:"status"`
	Detail           string `json:"detail,omitempty"`
	Exact            bool   `json:"exact"`
	CheckedAt        int64  `json:"checkedAt,omitempty"`
	CacheID          string `json:"cacheId,omitempty"`
	DependencyDigest string `json:"dependencyDigest,omitempty"`
	Generation       string `json:"generation,omitempty"`
}

type ProjectPackageInstalled struct {
	Name         string   `json:"name"`
	Version      string   `json:"version,omitempty"`
	Relationship string   `json:"relationship"`
	DeclaredIn   []string `json:"declaredIn,omitempty"`
	Trust        string   `json:"trust,omitempty"`
}

type ProjectPackageCenterPackages struct {
	Declared  []ProjectEnvironmentPackage `json:"declared"`
	Installed []ProjectPackageInstalled   `json:"installed"`
	Missing   []ProjectEnvironmentPackage `json:"missing"`
	Unknown   []ProjectEnvironmentPackage `json:"unknown"`
}

type ProjectPackageCenterContext struct {
	Schema                  string                       `json:"schema"`
	Revision                string                       `json:"revision"`
	Workspace               ProjectEnvironmentWorkspace  `json:"workspace"`
	Language                ProjectEnvironmentLanguage   `json:"language"`
	Runtime                 ProjectEnvironmentRuntime    `json:"runtime"`
	Sources                 []PackageCenterSource        `json:"sources"`
	DefaultSource           string                       `json:"defaultSource,omitempty"`
	SearchMode              string                       `json:"searchMode"`
	CatalogTimeoutSeconds   int                          `json:"catalogTimeoutSeconds"`
	OperationTimeoutSeconds int                          `json:"operationTimeoutSeconds"`
	DefaultManifestPath     string                       `json:"defaultManifestPath,omitempty"`
	Manifests               []ProjectEnvironmentManifest `json:"manifests"`
	Packages                ProjectPackageCenterPackages `json:"packages"`
	Inventory               ProjectPackageInventory      `json:"inventory"`
	CanPlanChanges          PackageCenterCapability      `json:"canPlanChanges"`
}

type PackageCatalogVersion struct {
	Version          string `json:"version"`
	RequiresLanguage string `json:"requiresLanguage,omitempty"`
	Yanked           bool   `json:"yanked,omitempty"`
	PublishedAt      string `json:"publishedAt,omitempty"`
	Compatibility    string `json:"compatibility"`
	Reason           string `json:"reason,omitempty"`
}

type PackageCatalogItem struct {
	Name                string                  `json:"name"`
	LatestVersion       string                  `json:"latestVersion,omitempty"`
	RecommendedVersion  string                  `json:"recommendedVersion,omitempty"`
	Compatibility       string                  `json:"compatibility,omitempty"`
	CompatibilityReason string                  `json:"compatibilityReason,omitempty"`
	Description         string                  `json:"description,omitempty"`
	License             string                  `json:"license,omitempty"`
	Homepage            string                  `json:"homepage,omitempty"`
	RequiresLanguage    string                  `json:"requiresLanguage,omitempty"`
	CatalogAuthority    string                  `json:"catalogAuthority"`
	Versions            []PackageCatalogVersion `json:"versions,omitempty"`
}

type PackageCatalogSearchResult struct {
	Schema     string               `json:"schema"`
	Query      string               `json:"query"`
	SourceID   string               `json:"sourceId"`
	SearchMode string               `json:"searchMode"`
	Items      []PackageCatalogItem `json:"items"`
	NextCursor string               `json:"nextCursor,omitempty"`
}

type ProjectPackageChange struct {
	Operation string   `json:"operation"`
	Name      string   `json:"name"`
	Version   string   `json:"version,omitempty"`
	Scope     string   `json:"scope,omitempty"`
	Features  []string `json:"features,omitempty"`
}

type ProjectPackageLocalChange struct {
	Path        string `json:"path"`
	OldExists   bool   `json:"oldExists"`
	OldSHA256   string `json:"oldSha256"`
	NewContent  string `json:"newContent"`
	NewSHA256   string `json:"newSha256"`
	Description string `json:"description,omitempty"`
}

type ProjectPackageManifestBinding struct {
	Path   string `json:"path"`
	SHA256 string `json:"sha256"`
}

type ProjectPackagePlanStep struct {
	ID          string `json:"id"`
	Kind        string `json:"kind"`
	Manager     string `json:"manager"`
	Description string `json:"description"`
}

type ProjectPackageChangePlan struct {
	Schema               string                          `json:"schema"`
	PlanID               string                          `json:"planId,omitempty"`
	Revision             string                          `json:"revision"`
	ExpiresAt            int64                           `json:"expiresAt,omitempty"`
	Supported            bool                            `json:"supported"`
	Reason               string                          `json:"reason,omitempty"`
	RequiresConfirmation bool                            `json:"requiresConfirmation"`
	Workspace            ProjectEnvironmentWorkspace     `json:"workspace"`
	Runtime              ProjectEnvironmentRuntime       `json:"runtime"`
	Language             ProjectEnvironmentLanguage      `json:"language"`
	Source               PackageCenterSource             `json:"source"`
	Changes              []ProjectPackageChange          `json:"changes"`
	LocalChanges         []ProjectPackageLocalChange     `json:"localChanges"`
	ManifestBindings     []ProjectPackageManifestBinding `json:"manifestBindings,omitempty"`
	Reinstall            bool                            `json:"reinstall,omitempty"`
	Steps                []ProjectPackagePlanStep        `json:"steps"`
	Warnings             []string                        `json:"warnings"`
}

type ProjectPackageChangeResult struct {
	Schema                 string                       `json:"schema"`
	PlanID                 string                       `json:"planId"`
	Applied                bool                         `json:"applied"`
	ExitCode               int                          `json:"exitCode,omitempty"`
	Stdout                 string                       `json:"stdout,omitempty"`
	Stderr                 string                       `json:"stderr,omitempty"`
	Message                string                       `json:"message,omitempty"`
	ReconciliationRequired bool                         `json:"reconciliationRequired,omitempty"`
	Environment            *ProjectEnvironment          `json:"environment,omitempty"`
	Context                *ProjectPackageCenterContext `json:"context,omitempty"`
}
