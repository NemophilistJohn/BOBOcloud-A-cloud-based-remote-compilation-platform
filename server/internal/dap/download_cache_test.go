package dap

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"testing"
)

func TestCleanupUserDownloadCacheContextRemovesOnlySelectedUser(t *testing.T) {
	dataDir := t.TempDir()
	aliceCache := filepath.Join(dataDir, "dap-cache", "downloads", "alice", "runtime", "adapter.zip")
	bobCache := filepath.Join(dataDir, "dap-cache", "downloads", "bob", "runtime", "adapter.zip")
	lspCache := filepath.Join(dataDir, "lsp-cache", "alice", "server.bin")
	for _, path := range []string{aliceCache, bobCache, lspCache} {
		if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte("sentinel"), 0o600); err != nil {
			t.Fatal(err)
		}
	}

	if err := CleanupUserDownloadCacheContext(context.Background(), dataDir, "alice"); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(dataDir, "dap-cache", "downloads", "alice")); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("alice cache still exists: %v", err)
	}
	for _, path := range []string{bobCache, lspCache} {
		if _, err := os.Stat(path); err != nil {
			t.Fatalf("unrelated cache %q was changed: %v", path, err)
		}
	}
	if err := CleanupUserDownloadCache(dataDir, "alice"); err != nil {
		t.Fatalf("idempotent cleanup failed: %v", err)
	}
}

func TestCleanupUserDownloadCacheContextRejectsUnsafeUserID(t *testing.T) {
	dataDir := t.TempDir()
	outside := filepath.Join(dataDir, "outside.txt")
	if err := os.WriteFile(outside, []byte("keep"), 0o600); err != nil {
		t.Fatal(err)
	}

	for _, userID := range []string{"", ".", "..", "../outside", `alice/bob`, `alice\bob`, " alice"} {
		t.Run(userID, func(t *testing.T) {
			if err := CleanupUserDownloadCacheContext(context.Background(), dataDir, userID); err == nil {
				t.Fatalf("unsafe user ID %q was accepted", userID)
			}
		})
	}
	if got, err := os.ReadFile(outside); err != nil || string(got) != "keep" {
		t.Fatalf("outside sentinel changed: content=%q err=%v", got, err)
	}
}

func TestCleanupUserDownloadCacheContextHonorsCancellation(t *testing.T) {
	dataDir := t.TempDir()
	cacheFile := filepath.Join(dataDir, "dap-cache", "downloads", "alice", "runtime", "adapter.zip")
	if err := os.MkdirAll(filepath.Dir(cacheFile), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(cacheFile, []byte("keep"), 0o600); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()

	err := CleanupUserDownloadCacheContext(ctx, dataDir, "alice")
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("cleanup error = %v, want context cancellation", err)
	}
	if _, err := os.Stat(cacheFile); err != nil {
		t.Fatalf("cancelled cleanup changed cache: %v", err)
	}
}

func TestCleanupUserDownloadCacheContextRejectsRedirectedRoot(t *testing.T) {
	dataDir := t.TempDir()
	outside := t.TempDir()
	sentinel := filepath.Join(outside, "alice", "runtime", "adapter.zip")
	if err := os.MkdirAll(filepath.Dir(sentinel), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(sentinel, []byte("keep"), 0o600); err != nil {
		t.Fatal(err)
	}
	dapRoot := filepath.Join(dataDir, "dap-cache")
	if err := os.MkdirAll(dapRoot, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, filepath.Join(dapRoot, "downloads")); err != nil {
		t.Skipf("symlinks are unavailable: %v", err)
	}

	if err := CleanupUserDownloadCacheContext(context.Background(), dataDir, "alice"); err == nil {
		t.Fatal("redirected downloads root was accepted")
	}
	if got, err := os.ReadFile(sentinel); err != nil || string(got) != "keep" {
		t.Fatalf("outside sentinel changed: content=%q err=%v", got, err)
	}
}

func TestCleanupUserDownloadCacheContextDoesNotFollowChildSymlink(t *testing.T) {
	dataDir := t.TempDir()
	outside := t.TempDir()
	sentinel := filepath.Join(outside, "adapter.zip")
	if err := os.WriteFile(sentinel, []byte("keep"), 0o600); err != nil {
		t.Fatal(err)
	}
	userCache := filepath.Join(dataDir, "dap-cache", "downloads", "alice")
	if err := os.MkdirAll(userCache, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, filepath.Join(userCache, "redirect")); err != nil {
		t.Skipf("symlinks are unavailable: %v", err)
	}

	if err := CleanupUserDownloadCacheContext(context.Background(), dataDir, "alice"); err != nil {
		t.Fatal(err)
	}
	if got, err := os.ReadFile(sentinel); err != nil || string(got) != "keep" {
		t.Fatalf("child symlink target changed: content=%q err=%v", got, err)
	}
}
