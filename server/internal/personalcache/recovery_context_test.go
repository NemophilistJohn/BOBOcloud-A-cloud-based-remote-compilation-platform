package personalcache

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"sync"
	"testing"
)

type cancelAfterChecksContext struct {
	context.Context
	remaining int
	done      chan struct{}
	once      sync.Once
}

func newCancelAfterChecksContext(checks int) *cancelAfterChecksContext {
	return &cancelAfterChecksContext{Context: context.Background(), remaining: checks, done: make(chan struct{})}
}

func (ctx *cancelAfterChecksContext) Done() <-chan struct{} { return ctx.done }

func (ctx *cancelAfterChecksContext) Err() error {
	ctx.remaining--
	if ctx.remaining > 0 {
		return nil
	}
	ctx.once.Do(func() { close(ctx.done) })
	return context.Canceled
}

func TestRecoverOrphanedTransactionsContextHonorsCancellation(t *testing.T) {
	manager := newTestManager(t.TempDir(), Options{ReservationBytes: 8})
	marker := filepath.Join(manager.root, "u1", "keep")
	if err := os.MkdirAll(filepath.Dir(marker), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(marker, []byte("keep"), 0600); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()

	err := manager.RecoverOrphanedTransactionsContext(ctx)
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("RecoverOrphanedTransactionsContext() error = %v, want context cancellation", err)
	}
	if _, err := os.Stat(marker); err != nil {
		t.Fatalf("cancelled recovery changed user state: %v", err)
	}
}

func TestScanNodePackageTreeContextCancelsDuringWalk(t *testing.T) {
	root := filepath.Join(t.TempDir(), "node_modules")
	packageRoot := filepath.Join(root, "demo")
	if err := os.MkdirAll(packageRoot, 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(packageRoot, "package.json"), []byte(`{"name":"demo","version":"1.0.0"}`), 0600); err != nil {
		t.Fatal(err)
	}

	ctx := newCancelAfterChecksContext(3)
	_, _, _, err := scanNodePackageTreeContext(ctx, root)
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("scanNodePackageTreeContext() error = %v, want context cancellation", err)
	}
}

func TestScanPythonPackageTreeContextCancelsDuringRecords(t *testing.T) {
	root := t.TempDir()
	writeInventoryDistInfo(t, root, "demo", "1.0.0")

	ctx := newCancelAfterChecksContext(3)
	_, err := scanPythonPackageTreeDetailedContext(ctx, root)
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("scanPythonPackageTreeDetailedContext() error = %v, want context cancellation", err)
	}
}

func TestRemoveRecoveryTreeContextCancelsDuringTraversal(t *testing.T) {
	root := t.TempDir()
	for index := 0; index < 8; index++ {
		directory := filepath.Join(root, string(rune('a'+index)))
		if err := os.Mkdir(directory, 0700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(directory, "payload"), []byte("keep"), 0600); err != nil {
			t.Fatal(err)
		}
	}

	ctx := newCancelAfterChecksContext(6)
	err := removeRecoveryTreeContext(ctx, root)
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("removeRecoveryTreeContext() error = %v, want context cancellation", err)
	}
	if _, statErr := os.Stat(root); statErr != nil {
		t.Fatalf("cancelled recovery removed the entire transaction tree: %v", statErr)
	}
}
