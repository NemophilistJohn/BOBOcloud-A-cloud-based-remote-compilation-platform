package snapshot

import (
	"archive/zip"
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"math"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func testStore(t *testing.T) *Store {
	t.Helper()
	s, err := New(t.TempDir(), 16<<20, 1)
	if err != nil {
		t.Fatal(err)
	}
	s.free = func(string) (int64, error) { return math.MaxInt64, nil }
	return s
}

func writeTestFile(t *testing.T, root, name, text string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(filepath.Join(root, name)), 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, name), []byte(text), 0644); err != nil {
		t.Fatal(err)
	}
}

func captureTestProject(t *testing.T, s *Store, source string) (Version, func()) {
	t.Helper()
	v, release, err := s.Capture(context.Background(), source)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(release)
	return v, release
}

func archiveCount(t *testing.T, s *Store, want int) {
	t.Helper()
	files, err := os.ReadDir(s.root)
	if err != nil {
		t.Fatal(err)
	}
	if len(files) != want {
		t.Fatalf("archive files = %v; want %d (no partial files)", files, want)
	}
}

func TestCaptureFanoutReusesOneImmutableArchive(t *testing.T) {
	s := testStore(t)
	source := t.TempDir()
	writeTestFile(t, source, "课程/lesson.py", "print('first')\n")
	writeTestFile(t, source, ".git/objects/private", "not shared")
	writeTestFile(t, source, ".bobocloud-team.json", "not shared")
	first, release := captureTestProject(t, s, source)
	if first.Bytes != int64(len("print('first')\n")) {
		t.Fatalf("incorrect project byte count: %d", first.Bytes)
	}
	for recipient := range 20 {
		version, done := captureTestProject(t, s, source)
		if version.ID != first.ID {
			t.Fatalf("recipient %d received a second generation", recipient)
		}
		done()
	}
	archiveCount(t, s, 1)
	writeTestFile(t, source, "课程/lesson.py", "print('second')\n")
	second, _ := captureTestProject(t, s, source)
	if second.ID == first.ID {
		t.Fatal("changed project reused the old snapshot")
	}
	archiveCount(t, s, 2)
	destination := t.TempDir()
	if err := s.Extract(context.Background(), first.ID, destination); err != nil {
		t.Fatal(err)
	}
	content, err := os.ReadFile(filepath.Join(destination, "课程/lesson.py"))
	if err != nil || string(content) != "print('first')\n" {
		t.Fatalf("source edits changed immutable version: %q, %v", content, err)
	}
	if _, err := os.Stat(filepath.Join(destination, ".bobocloud-team.json")); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("private team mapping leaked into snapshot")
	}
	release()
}

func TestCaptureCapacityAndFailureLeaveNoPartialArchive(t *testing.T) {
	for _, mode := range []string{"capacity", "free-space", "free-space-error", "cancelled", "changed-file", "changed-tree"} {
		t.Run(mode, func(t *testing.T) {
			s := testStore(t)
			source := t.TempDir()
			writeTestFile(t, source, "code.py", "print(42)\n")
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			var changed bool
			s.free = func(string) (int64, error) {
				if !changed {
					changed = true
					switch mode {
					case "cancelled":
						cancel()
					case "changed-file":
						writeTestFile(t, source, "code.py", "print(43)\n")
					case "changed-tree":
						writeTestFile(t, source, "new.py", "new file")
					}
				}
				if mode == "free-space" {
					return s.reserve + blockAllowance, nil
				}
				if mode == "free-space-error" {
					return 0, io.ErrClosedPipe
				}
				return math.MaxInt64, nil
			}
			if mode == "capacity" {
				s.capacity = blockAllowance + 1
			}
			_, release, err := s.Capture(ctx, source)
			if release != nil {
				release()
			}
			if err == nil {
				t.Fatal("unsafe snapshot unexpectedly published")
			}
			archiveCount(t, s, 0)
		})
	}
}

func TestCaptureGlobalCapacityIncludesExistingGeneration(t *testing.T) {
	s := testStore(t)
	source := t.TempDir()
	writeTestFile(t, source, "first", "first")
	first, _ := captureTestProject(t, s, source)
	used, _, err := s.inventory()
	if err != nil {
		t.Fatal(err)
	}
	s.capacity = used + blockAllowance
	again, done := captureTestProject(t, s, source)
	done()
	if again.ID != first.ID {
		t.Fatal("existing generation changed")
	}
	writeTestFile(t, source, "second", "second")
	if _, release, err := s.Capture(context.Background(), source); !errors.Is(err, ErrCapacity) {
		if release != nil {
			release()
		}
		t.Fatalf("new snapshot should be rejected at global capacity, got %v", err)
	}
	archiveCount(t, s, 1)
}

func TestPruneRetainsPublishedReferencesAndActiveReaders(t *testing.T) {
	s := testStore(t)
	source := t.TempDir()
	writeTestFile(t, source, "code.py", "data")
	v, release := captureTestProject(t, s, source)
	prune := func(keep bool) {
		t.Helper()
		if err := s.Prune(func(id string) (bool, error) {
			if id != v.ID {
				t.Fatalf("unexpected generation %s", id)
			}
			return keep, nil
		}); err != nil {
			t.Fatal(err)
		}
	}
	prune(false)
	archiveCount(t, s, 1)
	release()
	prune(true)
	archiveCount(t, s, 1)
	file, closeReader, err := s.Open(v.ID)
	if err != nil {
		t.Fatal(err)
	}
	prune(false)
	archiveCount(t, s, 1)
	if _, err := file.Stat(); err != nil {
		t.Fatal(err)
	}
	closeReader()
	closeReader()
	prune(false)
	archiveCount(t, s, 0)
	if _, _, err := s.Open(v.ID); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("unreferenced generation still openable: %v", err)
	}
}

func TestCaptureIsGloballyBoundedAndCleanupSurvivesRestart(t *testing.T) {
	s := testStore(t)
	source := t.TempDir()
	writeTestFile(t, source, "code.py", "x")
	entered, resume := make(chan struct{}), make(chan struct{})
	s.free = func(string) (int64, error) {
		select {
		case <-entered:
		default:
			close(entered)
		}
		<-resume
		return math.MaxInt64, nil
	}
	done := make(chan error, 1)
	go func() {
		_, release, err := s.Capture(context.Background(), source)
		if release != nil {
			release()
		}
		done <- err
	}()
	<-entered
	_, _, err := s.Capture(context.Background(), source)
	close(resume)
	if !errors.Is(err, ErrBusy) {
		t.Fatalf("concurrent capture should fail without a second stage, got %v", err)
	}
	if err := <-done; err != nil {
		t.Fatal(err)
	}
	archiveCount(t, s, 1)
	writeTestFile(t, s.root, ".capture-crashed", "leftover")
	reopened, err := New(s.root, s.capacity, s.reserve)
	if err != nil {
		t.Fatal(err)
	}
	archiveCount(t, reopened, 1)
}

func TestExtractRejectsUntrustedZipEntries(t *testing.T) {
	for _, name := range []string{"../escape", "/absolute", "a/../../escape", "a\\escape", "C:/escape"} {
		t.Run(strings.ReplaceAll(name, "/", "_"), func(t *testing.T) {
			s := testStore(t)
			var data bytes.Buffer
			writer := zip.NewWriter(&data)
			file, err := writer.Create(name)
			if err != nil {
				t.Fatal(err)
			}
			_, _ = file.Write([]byte("escape"))
			if err := writer.Close(); err != nil {
				t.Fatal(err)
			}
			id := strings.Repeat("a", 64)
			if err := os.WriteFile(filepath.Join(s.root, id+".zip"), data.Bytes(), 0600); err != nil {
				t.Fatal(err)
			}
			if err := s.Extract(context.Background(), id, t.TempDir()); err == nil {
				t.Fatal("unsafe ZIP path was accepted")
			}
		})
	}
}

func TestExtractIsBoundedAndProtectsItsArchiveFromPrune(t *testing.T) {
	s := testStore(t)
	source := t.TempDir()
	writeTestFile(t, source, "code.py", "payload")
	v, release := captureTestProject(t, s, source)
	release()
	entered, resume := make(chan struct{}), make(chan struct{})
	s.free = func(string) (int64, error) {
		select {
		case <-entered:
		default:
			close(entered)
		}
		<-resume
		return math.MaxInt64, nil
	}
	destination := t.TempDir()
	done := make(chan error, 1)
	go func() { done <- s.Extract(context.Background(), v.ID, destination) }()
	<-entered
	if err := s.Prune(func(string) (bool, error) { return false, nil }); err != nil {
		t.Fatal(err)
	}
	archiveCount(t, s, 1)
	secondErr := s.Extract(context.Background(), v.ID, t.TempDir())
	close(resume)
	if !errors.Is(secondErr, ErrBusy) {
		t.Fatalf("concurrent extraction was not bounded: %v", secondErr)
	}
	if err := <-done; err != nil {
		t.Fatal(err)
	}
	if err := s.Prune(func(string) (bool, error) { return false, nil }); err != nil {
		t.Fatal(err)
	}
	archiveCount(t, s, 0)
	data, err := os.ReadFile(filepath.Join(destination, "code.py"))
	if err != nil || string(data) != "payload" {
		t.Fatalf("copy did not survive source cleanup: %q, %v", data, err)
	}
}

func TestSnapshotIDsAndFailedReferenceChecksFailClosed(t *testing.T) {
	s := testStore(t)
	for _, id := range []string{"../escape", strings.Repeat("A", 64), strings.Repeat("a", 62), ""} {
		if _, _, err := s.Open(id); !errors.Is(err, os.ErrNotExist) {
			t.Fatalf("unsafe ID was accepted: %q %v", id, err)
		}
	}
	source := t.TempDir()
	writeTestFile(t, source, "code", "data")
	_, release := captureTestProject(t, s, source)
	release()
	if err := s.Prune(func(string) (bool, error) { return false, io.ErrClosedPipe }); !errors.Is(err, io.ErrClosedPipe) {
		t.Fatal("reference lookup failure was swallowed")
	}
	archiveCount(t, s, 1)
}

func TestExtractRejectsSymlinkEntriesAndCancelledEmptyArchive(t *testing.T) {
	for _, symlink := range []bool{false, true} {
		t.Run(fmt.Sprintf("symlink=%v", symlink), func(t *testing.T) {
			s := testStore(t)
			var data bytes.Buffer
			writer := zip.NewWriter(&data)
			if symlink {
				header := &zip.FileHeader{Name: "link"}
				header.SetMode(os.ModeSymlink | 0777)
				file, err := writer.CreateHeader(header)
				if err != nil {
					t.Fatal(err)
				}
				_, _ = file.Write([]byte("outside"))
			}
			if err := writer.Close(); err != nil {
				t.Fatal(err)
			}
			id := strings.Repeat("a", 64)
			if err := os.WriteFile(filepath.Join(s.root, id+".zip"), data.Bytes(), 0600); err != nil {
				t.Fatal(err)
			}
			ctx, cancel := context.WithCancel(context.Background())
			if !symlink {
				cancel()
			}
			defer cancel()
			if err := s.Extract(ctx, id, t.TempDir()); err == nil {
				t.Fatal("unsupported entry or cancelled archive accepted")
			}
		})
	}
}
