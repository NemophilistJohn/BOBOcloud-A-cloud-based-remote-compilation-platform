package collab

import (
	"bytes"
	"context"
	"crypto/sha1"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"os/exec"
	"runtime"
	"strings"

	"bobocloud-server/internal/safefile"
)

type RealtimeBaselineChange struct {
	Path   string `json:"path"`
	Status string `json:"status"`
}

type RealtimeBaselineDetails struct {
	UserID    string                   `json:"userId"`
	UserName  string                   `json:"userName"`
	Branch    string                   `json:"branch"`
	Changes   []RealtimeBaselineChange `json:"changes"`
	Truncated bool                     `json:"truncated,omitempty"`
}

type boundedBaselineOutput struct {
	bytes.Buffer
	exceeded bool
}

func (b *boundedBaselineOutput) Write(data []byte) (int, error) {
	const limit = 1 << 20
	n := len(data)
	remaining := limit - b.Len()
	if remaining < n {
		b.exceeded = true
		if remaining > 0 {
			_, _ = b.Buffer.Write(data[:remaining])
		}
		return n, nil
	}
	return b.Buffer.Write(data)
}

func realtimeHostMetadata(path string) bool { return strings.EqualFold(path, ".bobocloud-team.json") }

// Identical untracked files may be leftovers from a mirror of a newer shared
// commit while this member's HEAD is older. Verify against the actual selected
// branch checkout; never normalize bytes or accept tracked/index changes.
func matchingRealtimeBaselineFile(ctx context.Context, worktree, baseline, path string) bool {
	if !realtimePathValid(path) {
		return false
	}
	local, localInfo, err := safefile.OpenRegularBeneath(worktree, path, realtimeFileBytes)
	if err != nil {
		return false
	}
	defer local.Close()
	index, err := gitRun(ctx, baseline, "ls-files", "--stage", "-z", "--", ":(literal)"+path)
	if err != nil {
		return false
	}
	parts := strings.SplitN(index, "\t", 2)
	if len(parts) != 2 || strings.TrimSuffix(parts[1], "\x00") != path {
		return false
	}
	fields := strings.Fields(parts[0])
	if len(fields) != 3 || fields[2] != "0" || (fields[0] != "100644" && fields[0] != "100755") {
		return false
	}
	if runtime.GOOS != "windows" && (localInfo.Mode().Perm()&0100 != 0) != (fields[0] == "100755") {
		return false
	}
	left, err := io.ReadAll(io.LimitReader(local, realtimeFileBytes+1))
	if err != nil {
		return false
	}
	if len(left) > realtimeFileBytes {
		return false
	}
	// Git object identity hashes the raw blob, including its type/size header.
	// Comparing index IDs avoids checkout filters and global CRLF conversion.
	payload := append([]byte(fmt.Sprintf("blob %d\x00", len(left))), left...)
	if len(fields[1]) == 64 {
		sum := sha256.Sum256(payload)
		return hex.EncodeToString(sum[:]) == fields[1]
	}
	sum := sha1.Sum(payload)
	return hex.EncodeToString(sum[:]) == fields[1]
}

func (m *Manager) realtimeBaselineError(ctx context.Context, userID, branch, worktree, baseline string) error {
	args := []string{"--no-optional-locks", "-C", worktree, "status", "--porcelain=v1", "-z", "--untracked-files=all"}
	if runtime.GOOS == "windows" {
		args = append([]string{"-c", "core.longpaths=true"}, args...)
	}
	command := exec.CommandContext(ctx, "git", args...)
	output := &boundedBaselineOutput{}
	diagnostic := &boundedBaselineOutput{}
	command.Stdout = output
	command.Stderr = diagnostic
	if err := command.Run(); err != nil {
		return fmt.Errorf("cannot inspect member baseline: %w", err)
	}
	details := &RealtimeBaselineDetails{UserID: userID, UserName: userID, Branch: branch, Changes: []RealtimeBaselineChange{}, Truncated: output.exceeded}
	if m.users != nil {
		if user, err := m.users.Get(userID); err == nil {
			details.UserName = user.Name
			if details.UserName == "" {
				details.UserName = user.Username
			}
		}
	}
	entries := bytes.Split(output.Bytes(), []byte{0})
	dirty := output.exceeded
	for i := 0; i < len(entries); i++ {
		entry := entries[i]
		if len(entry) == 0 {
			continue
		}
		if len(entry) < 4 || entry[2] != ' ' {
			dirty = true
			details.Truncated = true
			continue
		}
		status, path := string(entry[:2]), string(entry[3:])
		source := ""
		if strings.ContainsAny(status, "RC") {
			if i+1 >= len(entries) {
				dirty = true
				details.Truncated = true
				break
			}
			i++
			source = string(entries[i])
		}
		if realtimeHostMetadata(path) && (source == "" || realtimeHostMetadata(source)) {
			continue
		}
		if status == "??" && matchingRealtimeBaselineFile(ctx, worktree, baseline, path) {
			continue
		}
		dirty = true
		if len(details.Changes) < 64 {
			details.Changes = append(details.Changes, RealtimeBaselineChange{Path: path, Status: status})
		} else {
			details.Truncated = true
		}
	}
	if !dirty {
		return nil
	}
	paths := make([]string, 0, 3)
	for _, change := range details.Changes {
		if len(paths) >= 3 {
			break
		}
		value := change.Path
		if len(value) > 160 {
			value = value[:160] + "..."
		}
		paths = append(paths, value)
	}
	summary := strings.Join(paths, ", ")
	if details.Truncated || len(details.Changes) > 3 {
		summary += " ..."
	}
	if summary == "" {
		summary = "too many changes to list"
	}
	message := fmt.Sprintf("Member %s on branch %s has uncommitted changes: %s. Publish or preserve these changes before enabling live collaboration.", details.UserName, branch, summary)
	return operationError(ErrorCodeRealtimeBaselineDirty, message, ErrorDetails{Retryable: true, SuggestedAction: "publish_member_changes", Baseline: details}, nil)
}
