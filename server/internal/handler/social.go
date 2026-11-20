package handler

import (
	"context"
	"encoding/hex"
	"errors"
	"io"
	"mime"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"
	"unicode/utf8"

	"bobocloud-server/internal/auth"
	"bobocloud-server/internal/model"
	"bobocloud-server/internal/resourcecontrol"
	"bobocloud-server/internal/safefile"
	"bobocloud-server/internal/snapshot"
	"bobocloud-server/internal/social"
)

const inboxProjectPath = "/inbox/project/"

func socialContact(user *auth.User) social.Contact {
	return social.Contact{UID: user.UID, Name: user.Name, Avatar: user.Avatar}
}

func socialError(w http.ResponseWriter, err error) {
	status, code := http.StatusBadRequest, "social_request_failed"
	switch {
	case errors.Is(err, social.ErrNotFound), errors.Is(err, os.ErrNotExist):
		status, code = http.StatusNotFound, "social_not_found"
	case errors.Is(err, social.ErrInactive):
		status, code = http.StatusConflict, "social_offer_expired"
	case errors.Is(err, social.ErrBusy), errors.Is(err, snapshot.ErrBusy):
		status, code = http.StatusConflict, "social_busy"
	case errors.Is(err, social.ErrInboxFull), errors.Is(err, snapshot.ErrCapacity):
		status, code = http.StatusInsufficientStorage, "social_capacity"
	case errors.Is(err, snapshot.ErrChanged):
		status, code = http.StatusConflict, "social_project_changed"
	case errors.Is(err, social.ErrDuplicate):
		status, code = http.StatusConflict, "social_duplicate_invite"
	}
	writeJSON(w, status, model.Response{Success: false, Error: err.Error(), ErrorCode: code})
}

func validMessageID(id string) bool {
	raw, err := hex.DecodeString(id)
	return err == nil && len(raw) == 16 && strings.ToLower(id) == id
}

func (h *HTTPHandler) handleSocial(w http.ResponseWriter, r *http.Request, req *model.Request) {
	if !h.authEnabled || h.Social == nil || h.UserStore == nil {
		writeJSON(w, http.StatusServiceUnavailable, model.Response{Success: false, Error: "Social features require account persistence"})
		return
	}
	user := auth.UserFromContext(r.Context())
	if user == nil {
		writeJSON(w, http.StatusUnauthorized, model.Response{Success: false, Error: "Not authenticated"})
		return
	}
	var data any
	var err error
	switch req.Action {
	case "listFriends":
		data, err = h.listFriends(user.ID)
	case "listInbox":
		data, err = h.Social.List(user.ID, time.Now().UTC())
	case "sendInbox":
		data, err = h.sendInbox(r, user, req)
	case "respondInbox":
		data, err = h.respondInbox(r, user, req)
	case "recordWorkspaceSync":
		err = h.Social.RecordSync(user.ID, time.Now().UTC())
	case "downloadInboxProject":
		h.downloadInboxProject(w, r, user, req.MessageID)
		return
	default:
		err = errors.New("invalid social action")
	}
	if err != nil {
		socialError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, model.Response{Success: true, Data: data})
}

func (h *HTTPHandler) listFriends(currentID string) ([]social.Contact, error) {
	users, err := h.UserStore.List()
	if err != nil {
		return nil, err
	}
	stamps, err := h.Social.SyncTimes()
	if err != nil {
		return nil, err
	}
	contacts := make([]social.Contact, 0, len(users))
	for _, user := range users {
		if user.ID == currentID || user.Disabled || user.UID == "" {
			continue
		}
		contact := socialContact(user)
		if stamp, ok := stamps[user.ID]; ok {
			contact.LastSyncAt = &stamp
		}
		contacts = append(contacts, contact)
	}
	sort.Slice(contacts, func(i, j int) bool {
		if contacts[i].Name == contacts[j].Name {
			return contacts[i].UID < contacts[j].UID
		}
		return contacts[i].Name < contacts[j].Name
	})
	return contacts, nil
}

func (h *HTTPHandler) sendInbox(r *http.Request, sender *auth.User, req *model.Request) (social.Message, error) {
	if req.RecipientID == "" || sender.UID == req.RecipientID {
		return social.Message{}, errors.New("choose another recipient")
	}
	recipient, err := h.UserStore.GetByUID(req.RecipientID)
	if err != nil || recipient.Disabled {
		return social.Message{}, social.ErrNotFound
	}
	recipientLease, err := h.Lifecycle.AcquireRequest(recipient.ID)
	if err != nil {
		return social.Message{}, err
	}
	defer recipientLease.Release()
	// Bind the recipient as well so account deletion cannot finish between
	// validation and publication of a new inbox row.
	ctx, release, err := bindUserOperation(r.Context(), h.Lifecycle, h.UserStore, recipient.ID)
	if err != nil {
		return social.Message{}, err
	}
	defer release()
	r = r.WithContext(ctx)
	now := time.Now().UTC()
	entry := social.Entry{Message: social.Message{
		ID: auth.GenerateToken(), Sender: socialContact(sender), Kind: req.Kind,
		Status: "pending", CreatedAt: now,
	}, SenderID: sender.ID}
	switch req.Kind {
	case "note":
		entry.Note = strings.TrimSpace(req.Note)
		if !utf8.ValidString(entry.Note) || utf8.RuneCountInString(entry.Note) > 150 || entry.Note == "" || strings.ContainsRune(entry.Note, '\x00') {
			return social.Message{}, errors.New("notes must contain 1 to 150 characters")
		}
	case "invite":
		if h.Collaboration == nil {
			return social.Message{}, errors.New("team collaboration is unavailable")
		}
		team, err := h.Collaboration.Store().GetTeam(req.TeamID)
		if err != nil {
			return social.Message{}, social.ErrNotFound
		}
		if team.AdminUserID != sender.ID || !h.Collaboration.IsMember(sender.ID, team.ID) {
			return social.Message{}, errors.New("only the team administrator can invite members")
		}
		if h.Collaboration.IsMember(recipient.ID, team.ID) {
			return social.Message{}, errors.New("recipient is already a team member")
		}
		entry.TeamID, entry.Title = team.ID, team.Name
		expires := now.Add(social.OfferTTL)
		entry.ExpiresAt = &expires
	case "project":
		if h.ProjectSnapshots == nil {
			return social.Message{}, errors.New("project snapshots are unavailable")
		}
		key, err := safeWorkspaceKey("", req.ProjectKey)
		if err != nil {
			return social.Message{}, err
		}
		userRoot, err := auth.UserDataRoot(h.Config.DataDir, sender.ID)
		if err != nil {
			return social.Message{}, err
		}
		source, err := safefile.ResolveDirectoryBeneath(filepath.Join(userRoot, "workspaces"), key)
		if err != nil {
			return social.Message{}, err
		}
		entry.Title, entry.ProjectKey = key, key
		metadataPath := filepath.Join(h.workspaceDisplayMetadataDir(sender.ID), workspaceDisplayMetadataFilename(key))
		if meta, err := readWorkspaceDisplayMetadata(metadataPath); err == nil && meta.FolderKey == key {
			entry.Title = meta.DisplayName
		}
		expires := now.Add(social.OfferTTL)
		entry.ExpiresAt = &expires
		if err := h.Social.CheckCapacity(recipient.ID, entry, now); err != nil {
			return social.Message{}, err
		}
		// Reuse the centrally governed filesystem/package workload class;
		// snapshot capture does not acquire a Docker container.
		resources, err := acquireHandlerRuntimeResource(ctx, h.Resources, resourcecontrol.WorkloadPackage,
			sender.ID, projectResourceScope(key, "", ""), "share:"+entry.ID, "", "", "", false)
		if err != nil {
			return social.Message{}, err
		}
		defer releaseHandlerResource(resources)
		lease, err := h.Lifecycle.AcquireActivity(sender.ID, key)
		if err != nil {
			return social.Message{}, err
		}
		defer lease.Release()
		ctx, cancel := context.WithTimeout(ctx, 2*time.Minute)
		defer cancel()
		version, done, err := h.ProjectSnapshots.Capture(ctx, source)
		if err != nil {
			return social.Message{}, err
		}
		defer done() // publish metadata before releasing the snapshot GC pin
		entry.SnapshotID, entry.Bytes = version.ID, version.Bytes
	default:
		return social.Message{}, errors.New("invalid inbox message kind")
	}
	if err := r.Context().Err(); err != nil {
		return social.Message{}, err
	}
	if err := h.Social.Put(recipient.ID, entry, now); err != nil {
		return social.Message{}, err
	}
	return entry.Message, nil
}

func (h *HTTPHandler) respondInbox(r *http.Request, user *auth.User, req *model.Request) (any, error) {
	if !validMessageID(req.MessageID) {
		return nil, social.ErrNotFound
	}
	unlock, err := h.Social.LockDecision(user.ID, req.MessageID)
	if err != nil {
		return nil, err
	}
	defer unlock()
	started := time.Now().UTC()
	entry, err := h.Social.Get(user.ID, req.MessageID, started)
	if err != nil {
		return nil, err
	}
	// An acknowledged retry returns the prior result without repeating side
	// effects. A different decision against an archive always fails.
	if entry.Decision != "" && entry.Decision == req.Decision {
		return inboxDecisionData(entry), nil
	}
	if req.Decision == "read" && entry.Read {
		return inboxDecisionData(entry), nil
	}
	if entry.Status != "pending" {
		return nil, social.ErrInactive
	}
	key := ""
	switch req.Decision {
	case "read", "reject":
	case "cloud":
		if entry.Kind != "project" {
			return nil, errors.New("only project offers can be saved to cloud")
		}
		key, err = h.importInboxProject(r.Context(), user, entry, started)
	case "local":
		if entry.Kind != "project" {
			return nil, errors.New("only project offers can be downloaded")
		}
	case "invite":
		if entry.Kind != "invite" || h.Collaboration == nil {
			return nil, errors.New("this message is not a team invitation")
		}
		inviterLease, requestErr := h.Lifecycle.AcquireRequest(entry.SenderID)
		if requestErr != nil {
			return nil, requestErr
		}
		defer inviterLease.Release()
		inviterContext, releaseInviter, bindErr := bindUserOperation(r.Context(), h.Lifecycle, h.UserStore, entry.SenderID)
		if bindErr != nil {
			return nil, bindErr
		}
		defer releaseInviter()
		if err := inviterContext.Err(); err != nil {
			return nil, err
		}
		_, err = h.Collaboration.JoinDirectedInvitation(entry.SenderID, user.ID, entry.TeamID)
	default:
		return nil, errors.New("invalid inbox decision")
	}
	if err != nil {
		return nil, err
	}
	entry, err = h.Social.Finish(user.ID, entry.ID, req.Decision, key, started, time.Now().UTC())
	return inboxDecisionData(entry), err
}

func inboxDecisionData(entry social.Entry) any {
	return struct {
		social.Message
		ProjectKey string `json:"projectKey,omitempty"`
	}{entry.Message, entry.ProjectKey}
}

func (h *HTTPHandler) importInboxProject(ctx context.Context, user *auth.User, entry social.Entry, started time.Time) (string, error) {
	if h.ProjectSnapshots == nil {
		return "", errors.New("project snapshots are unavailable")
	}
	ctx, cancel := context.WithTimeout(ctx, 2*time.Minute)
	defer cancel()
	key := "received-" + entry.ID
	resources, err := acquireHandlerRuntimeResource(ctx, h.Resources, resourcecontrol.WorkloadPackage,
		user.ID, projectResourceScope(key, "", ""), "receive:"+entry.ID, "", "", "", false)
	if err != nil {
		return "", err
	}
	defer releaseHandlerResource(resources)
	lease, err := h.Lifecycle.BeginUserMutation(user.ID)
	if err != nil {
		return "", err
	}
	defer lease.Release()
	userDir, err := h.ensureUserDir(user.ID)
	if err != nil {
		return "", err
	}
	root, err := os.OpenRoot(userDir)
	if err != nil {
		return "", err
	}
	defer root.Close()
	target := "workspaces/" + key
	if info, err := root.Lstat(target); err == nil {
		// A deterministic target prevents duplicate imports after an uncertain
		// HTTP response. It is never overwritten, including after later edits.
		if info.IsDir() && info.Mode()&os.ModeSymlink == 0 && entry.ImportKey == key {
			if err := h.writeWorkspaceDisplayName(user.ID, key, entry.Title); err != nil {
				return "", err
			}
			return key, nil
		}
		return "", errors.New("received project destination already exists")
	} else if !errors.Is(err, os.ErrNotExist) {
		return "", err
	}
	// Refresh disk accounting under the user mutation lease. A stale sixty
	// second cached total must not allow parallel imports to overspend quota.
	usage, err := socialDiskUsage(ctx, userDir)
	if err != nil {
		return "", err
	}
	if user.DiskQuotaMB > 0 && usage+entry.Bytes > int64(user.DiskQuotaMB)*1e6 {
		return "", errors.New("disk quota exceeded")
	}
	staging := ".inbox-import-" + entry.ID
	if err := root.RemoveAll(staging); err != nil {
		return "", err
	}
	if err := root.Mkdir(staging, 0700); err != nil {
		return "", err
	}
	defer root.RemoveAll(staging)
	if err := h.ProjectSnapshots.Extract(ctx, entry.SnapshotID, filepath.Join(userDir, staging)); err != nil {
		return "", err
	}
	if err := ctx.Err(); err != nil {
		return "", err
	}
	// Persist an import receipt outside the mirrored workspace before rename.
	// The directory itself appears in the personal cloud list only when ready.
	if err := h.writeWorkspaceDisplayName(user.ID, key, entry.Title); err != nil {
		return "", err
	}
	if err := h.Social.PrepareCloud(user.ID, entry.ID, key, started); err != nil {
		_ = h.deleteWorkspaceDisplayName(user.ID, key)
		return "", err
	}
	if err := root.Rename(staging, target); err != nil {
		_ = h.deleteWorkspaceDisplayName(user.ID, key)
		return "", err
	}
	h.diskCache.Set(user.ID, 0, 1)
	return key, nil
}

func socialDiskUsage(ctx context.Context, root string) (int64, error) {
	var used int64
	err := filepath.WalkDir(root, func(_ string, entry os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if err := ctx.Err(); err != nil {
			return err
		}
		info, err := entry.Info()
		if err != nil {
			return err
		}
		used += info.Size()
		return nil
	})
	return used, err
}

func (h *HTTPHandler) downloadInboxProject(w http.ResponseWriter, r *http.Request, user *auth.User, id string) {
	if !validMessageID(id) || h.ProjectSnapshots == nil {
		socialError(w, social.ErrNotFound)
		return
	}
	entry, err := h.Social.Get(user.ID, id, time.Now().UTC())
	if err != nil {
		socialError(w, err)
		return
	}
	if entry.Status != "pending" || entry.Kind != "project" {
		socialError(w, social.ErrInactive)
		return
	}
	resources, err := acquireHandlerRuntimeResource(r.Context(), h.Resources, resourcecontrol.WorkloadPackage,
		user.ID, projectResourceScope("received-"+id, "", ""), "download:"+auth.GenerateToken(), "", "", "", false)
	if err != nil {
		writeResourcePressure(w)
		return
	}
	defer releaseHandlerResource(resources)
	// Admission may have waited while another window decided the offer or
	// while its 72-hour deadline elapsed.
	entry, err = h.Social.Get(user.ID, id, time.Now().UTC())
	if err != nil {
		socialError(w, err)
		return
	}
	if entry.Status != "pending" || entry.Kind != "project" {
		socialError(w, social.ErrInactive)
		return
	}
	file, done, err := h.ProjectSnapshots.Open(entry.SnapshotID)
	if err != nil {
		socialError(w, err)
		return
	}
	defer done()
	stat, err := file.Stat()
	if err != nil {
		socialError(w, err)
		return
	}
	w.Header().Set("Cache-Control", "private, no-store")
	w.Header().Set("Content-Type", "application/zip")
	w.Header().Set("Content-Disposition", mime.FormatMediaType("attachment", map[string]string{"filename": entry.Title + ".zip"}))
	w.Header().Set("X-Content-Type-Options", "nosniff")
	controller := http.NewResponseController(w)
	_ = controller.SetWriteDeadline(time.Now().Add(2 * time.Minute))
	defer controller.SetWriteDeadline(time.Time{})
	http.ServeContent(w, r, entry.Title+".zip", stat.ModTime(), file)
}

func (h *HTTPHandler) CleanupSocial(ctx context.Context) error {
	if h.Social == nil {
		return nil
	}
	if _, err := h.Social.Prune(time.Now().UTC()); err != nil {
		return err
	}
	if h.ProjectSnapshots == nil {
		return nil
	}
	return h.ProjectSnapshots.Prune(func(id string) (bool, error) {
		if err := ctx.Err(); err != nil {
			return false, err
		}
		return h.Social.SnapshotLive(id, time.Now().UTC())
	})
}

// RecoverSocialImports runs before listeners start. The user mutation fence
// makes the same helper safe for startup/recovery tests with a live lifecycle.
// Only deterministic private staging directories are removed: a published
// received-* workspace and its durable ImportKey are recovery evidence.
func (h *HTTPHandler) RecoverSocialImports(ctx context.Context) error {
	if h.UserStore == nil {
		return nil
	}
	users, err := h.UserStore.List()
	if err != nil {
		return err
	}
	for _, user := range users {
		if err := ctx.Err(); err != nil {
			return err
		}
		if err := h.recoverSocialUserImports(ctx, user.ID); err != nil {
			return err
		}
	}
	return nil
}

func (h *HTTPHandler) recoverSocialUserImports(ctx context.Context, userID string) error {
	lease, err := h.Lifecycle.BeginUserMutation(userID)
	if err != nil {
		return err
	}
	defer lease.Release()
	userDir, err := auth.UserDataRoot(h.Config.DataDir, userID)
	if err != nil {
		return err
	}
	userDir, err = safefile.RealDirectory(userDir)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	root, err := os.OpenRoot(userDir)
	if err != nil {
		return err
	}
	defer root.Close()
	dir, err := root.Open(".")
	if err != nil {
		return err
	}
	defer dir.Close()
	for {
		entries, err := dir.ReadDir(100)
		if err != nil && err != io.EOF {
			return err
		}
		for _, entry := range entries {
			if err := ctx.Err(); err != nil {
				return err
			}
			name := entry.Name()
			if strings.HasPrefix(name, ".inbox-import-") && validMessageID(strings.TrimPrefix(name, ".inbox-import-")) {
				if err := root.RemoveAll(name); err != nil {
					return err
				}
			}
		}
		if err == io.EOF {
			return nil
		}
	}
}
