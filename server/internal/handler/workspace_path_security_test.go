package handler

import (
	"context"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"

	"bobocloud-server/internal/auth"
	"bobocloud-server/internal/config"
	"bobocloud-server/internal/model"
)

func TestPersonalWorkspaceResolversRejectRedirectedWorkspace(t *testing.T) {
	dataDir := t.TempDir()
	workspaceRoot := filepath.Join(dataDir, "users", "user-a", "workspaces")
	if err := os.MkdirAll(workspaceRoot, 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(t.TempDir(), filepath.Join(workspaceRoot, "project")); err != nil {
		t.Skipf("symlink is unavailable: %v", err)
	}
	cfg := &config.Config{DataDir: dataDir, ServerRoot: t.TempDir()}
	user := &auth.User{ID: "user-a"}
	wsHandler := &WSHandler{Config: cfg, AuthEnabled: true}

	t.Run("run", func(t *testing.T) {
		if _, err := wsHandler.resolveWorkspace(context.Background(), &model.RunSession{UserID: user.ID, FolderKey: "project"}); err == nil {
			t.Fatal("run resolver accepted a redirected workspace")
		}
	})
	t.Run("terminal", func(t *testing.T) {
		if _, err := wsHandler.resolveTerminalWorkspace(context.Background(), user.ID, terminalWorkspaceRequest{Kind: "personal", FolderKey: "project"}); err == nil {
			t.Fatal("terminal resolver accepted a redirected workspace")
		}
	})
	t.Run("lsp", func(t *testing.T) {
		if _, _, _, _, _, err := wsHandler.resolveLSPWorkspace(context.Background(), user, lspWorkspaceStart{Kind: "personal", FolderKey: "project"}); err == nil {
			t.Fatal("LSP resolver accepted a redirected workspace")
		}
	})
	t.Run("dap", func(t *testing.T) {
		dapHandler := &DAPHandler{Config: cfg, AuthEnabled: true}
		if _, _, _, _, _, err := dapHandler.resolveWorkspace(context.Background(), user, dapWorkspaceStart{Kind: "personal", FolderKey: "project"}); err == nil {
			t.Fatal("DAP resolver accepted a redirected workspace")
		}
	})
}

func TestWorkspaceKeysAreSingleOpaqueComponents(t *testing.T) {
	for _, key := range []string{"nested/project", `nested\project`, ".", ".."} {
		if _, err := safeWorkspaceKey("Project", key); err == nil {
			t.Fatalf("workspace key %q was accepted", key)
		}
	}
	if key, err := safeWorkspaceKey("Project", "pabc123"); err != nil || key != "pabc123" {
		t.Fatalf("valid workspace key=%q err=%v", key, err)
	}
}

func TestPersonalWorkspaceResolversRejectUnsafeUserIdentity(t *testing.T) {
	cfg := &config.Config{DataDir: t.TempDir(), ServerRoot: t.TempDir()}
	unsafeID := "../../outside"
	user := &auth.User{ID: unsafeID}
	request := httptest.NewRequest(http.MethodPost, "/", nil)
	request = request.WithContext(context.WithValue(request.Context(), auth.ContextUserID, unsafeID))
	httpHandler := &HTTPHandler{Config: cfg, authEnabled: true}
	wsHandler := &WSHandler{Config: cfg, AuthEnabled: true}

	if _, err := httpHandler.resolveWorkspace(request, "Project", "project"); err == nil {
		t.Fatal("HTTP workspace resolver accepted unsafe user identity")
	}
	if _, err := wsHandler.resolveWorkspace(context.Background(), &model.RunSession{UserID: unsafeID, FolderKey: "project"}); err == nil {
		t.Fatal("run workspace resolver accepted unsafe user identity")
	}
	if _, err := wsHandler.resolveTerminalWorkspace(context.Background(), unsafeID, terminalWorkspaceRequest{Kind: "personal", FolderKey: "project"}); err == nil {
		t.Fatal("terminal workspace resolver accepted unsafe user identity")
	}
	if _, _, _, _, _, err := wsHandler.resolveLSPWorkspace(context.Background(), user, lspWorkspaceStart{Kind: "personal", FolderKey: "project"}); err == nil {
		t.Fatal("LSP workspace resolver accepted unsafe user identity")
	}
	dapHandler := &DAPHandler{Config: cfg, AuthEnabled: true}
	if _, _, _, _, _, err := dapHandler.resolveWorkspace(context.Background(), user, dapWorkspaceStart{Kind: "personal", FolderKey: "project"}); err == nil {
		t.Fatal("DAP workspace resolver accepted unsafe user identity")
	}
}

func TestDeleteFileDoesNotTraverseRedirectedParent(t *testing.T) {
	serverRoot := t.TempDir()
	project := filepath.Join(serverRoot, "project")
	outside := t.TempDir()
	if err := os.Mkdir(project, 0755); err != nil {
		t.Fatal(err)
	}
	sentinel := filepath.Join(outside, "sentinel")
	if err := os.WriteFile(sentinel, []byte("keep"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, filepath.Join(project, "redirect")); err != nil {
		t.Skipf("symlink is unavailable: %v", err)
	}
	handler := &HTTPHandler{Config: &config.Config{ServerRoot: serverRoot}}
	recorder := httptest.NewRecorder()
	handler.handleDeleteFile(recorder, httptest.NewRequest(http.MethodPost, "/", nil), &model.Request{
		FolderName: "project", FilePath: filepath.Join("redirect", "sentinel"),
	})
	if recorder.Code == http.StatusOK {
		t.Fatalf("redirected delete unexpectedly succeeded: %s", recorder.Body.String())
	}
	if data, err := os.ReadFile(sentinel); err != nil || string(data) != "keep" {
		t.Fatalf("outside file changed: data=%q err=%v", data, err)
	}
}

func TestDeleteProjectRejectsRedirectedWorkspace(t *testing.T) {
	serverRoot := t.TempDir()
	outside := t.TempDir()
	sentinel := filepath.Join(outside, "sentinel")
	if err := os.WriteFile(sentinel, []byte("keep"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, filepath.Join(serverRoot, "project")); err != nil {
		t.Skipf("symlink is unavailable: %v", err)
	}
	handler := &HTTPHandler{Config: &config.Config{ServerRoot: serverRoot}}
	recorder := httptest.NewRecorder()
	handler.handleDeleteProject(recorder, httptest.NewRequest(http.MethodPost, "/", nil), &model.Request{FolderKey: "project"})
	if recorder.Code != http.StatusBadRequest {
		t.Fatalf("redirected project status=%d body=%s", recorder.Code, recorder.Body.String())
	}
	if data, err := os.ReadFile(sentinel); err != nil || string(data) != "keep" {
		t.Fatalf("outside project changed: data=%q err=%v", data, err)
	}
}
