package handler

import (
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"time"
)

const workspaceDisplayMetadataSchema = 1

type workspaceDisplayMetadata struct {
	Schema      int       `json:"schema"`
	FolderKey   string    `json:"folder_key"`
	DisplayName string    `json:"display_name"`
	UpdatedAt   time.Time `json:"updated_at"`
}

func (h *HTTPHandler) workspaceDisplayMetadataDir(userID string) string {
	if h == nil || h.Config == nil {
		return ""
	}
	if h.authEnabled {
		return filepath.Join(h.Config.DataDir, "users", userID, "workspace-metadata")
	}
	return filepath.Join(h.Config.DataDir, "workspace-metadata", "default")
}

func workspaceDisplayMetadataFilename(folderKey string) string {
	sum := sha256.Sum256([]byte(folderKey))
	return fmt.Sprintf("%x.json", sum)
}

func validWorkspaceDisplayValue(value string) bool {
	value = strings.TrimSpace(value)
	return value != "" && len(value) <= 512 && !strings.ContainsAny(value, "\x00\r\n/\\") && value != "." && value != ".."
}

func (h *HTTPHandler) writeWorkspaceDisplayName(userID, folderKey, displayName string) error {
	folderKey = strings.TrimSpace(folderKey)
	displayName = strings.TrimSpace(displayName)
	if !validWorkspaceDisplayValue(folderKey) || !validWorkspaceDisplayValue(displayName) {
		return errors.New("invalid project display metadata")
	}
	dir := h.workspaceDisplayMetadataDir(userID)
	if dir == "" {
		return errors.New("project metadata directory is unavailable")
	}
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	payload, err := json.Marshal(workspaceDisplayMetadata{
		Schema:      workspaceDisplayMetadataSchema,
		FolderKey:   folderKey,
		DisplayName: displayName,
		UpdatedAt:   time.Now().UTC(),
	})
	if err != nil {
		return err
	}
	temporary, err := os.CreateTemp(dir, ".workspace-name-*.tmp")
	if err != nil {
		return err
	}
	temporaryPath := temporary.Name()
	defer os.Remove(temporaryPath)
	if err := temporary.Chmod(0o600); err != nil {
		temporary.Close()
		return err
	}
	if _, err := temporary.Write(payload); err != nil {
		temporary.Close()
		return err
	}
	if err := temporary.Sync(); err != nil {
		temporary.Close()
		return err
	}
	if err := temporary.Close(); err != nil {
		return err
	}
	target := filepath.Join(dir, workspaceDisplayMetadataFilename(folderKey))
	if err := os.Rename(temporaryPath, target); err == nil {
		return nil
	}
	// Windows does not replace an existing destination with os.Rename.
	if err := os.Remove(target); err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	return os.Rename(temporaryPath, target)
}

func readWorkspaceDisplayMetadata(path string) (workspaceDisplayMetadata, error) {
	file, err := os.Open(path)
	if err != nil {
		return workspaceDisplayMetadata{}, err
	}
	defer file.Close()
	decoder := json.NewDecoder(io.LimitReader(file, 16<<10))
	decoder.DisallowUnknownFields()
	var metadata workspaceDisplayMetadata
	if err := decoder.Decode(&metadata); err != nil {
		return workspaceDisplayMetadata{}, err
	}
	if err := decoder.Decode(&struct{}{}); err != io.EOF {
		return workspaceDisplayMetadata{}, errors.New("project metadata must contain one JSON object")
	}
	if metadata.Schema != workspaceDisplayMetadataSchema ||
		!validWorkspaceDisplayValue(metadata.FolderKey) ||
		!validWorkspaceDisplayValue(metadata.DisplayName) {
		return workspaceDisplayMetadata{}, errors.New("invalid project metadata")
	}
	return metadata, nil
}

// loadWorkspaceDisplayNames also prunes metadata whose workspace no longer
// exists. The catalog lives outside the mirrored workspace so sync cannot erase
// it, while project deletion cannot leave permanent catalog entries behind.
func (h *HTTPHandler) loadWorkspaceDisplayNames(userID string, workspaces map[string]bool) map[string]string {
	result := make(map[string]string)
	dir := h.workspaceDisplayMetadataDir(userID)
	if dir == "" {
		return result
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		return result
	}
	for _, entry := range entries {
		if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".json") {
			continue
		}
		path := filepath.Join(dir, entry.Name())
		info, infoErr := entry.Info()
		if infoErr != nil || !info.Mode().IsRegular() || info.Size() > 16<<10 {
			slog.Warn("Ignoring invalid project display metadata", "path", path, "error", infoErr)
			continue
		}
		metadata, readErr := readWorkspaceDisplayMetadata(path)
		if readErr != nil || workspaceDisplayMetadataFilename(metadata.FolderKey) != entry.Name() {
			slog.Warn("Ignoring invalid project display metadata", "path", path, "error", readErr)
			continue
		}
		if !workspaces[metadata.FolderKey] {
			if removeErr := os.Remove(path); removeErr != nil && !errors.Is(removeErr, os.ErrNotExist) {
				slog.Warn("Failed to prune stale project display metadata", "path", path, "error", removeErr)
			}
			continue
		}
		result[metadata.FolderKey] = metadata.DisplayName
	}
	return result
}

func (h *HTTPHandler) deleteWorkspaceDisplayName(userID, folderKey string) error {
	if !validWorkspaceDisplayValue(folderKey) {
		return nil
	}
	dir := h.workspaceDisplayMetadataDir(userID)
	if dir == "" {
		return nil
	}
	err := os.Remove(filepath.Join(dir, workspaceDisplayMetadataFilename(strings.TrimSpace(folderKey))))
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	return err
}
