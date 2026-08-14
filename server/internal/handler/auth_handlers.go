package handler

import (
	"encoding/base64"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"strings"
	"time"

	"bobocloud-server/internal/auth"
	"bobocloud-server/internal/model"
	"bobocloud-server/internal/storage"
)

const maxAvatarBytes = 192 * 1024

var allowedAvatarPresets = map[string]bool{
	"ocean": true, "forest": true, "coral": true,
	"violet": true, "graphite": true, "amber": true,
}

func validateAvatar(value string) error {
	if allowedAvatarPresets[value] {
		return nil
	}
	comma := strings.IndexByte(value, ',')
	if comma < 0 {
		return fmt.Errorf("avatar must be a preset or an uploaded image")
	}
	header := value[:comma]
	encoded := value[comma+1:]
	mime := ""
	switch header {
	case "data:image/png;base64":
		mime = "png"
	case "data:image/jpeg;base64":
		mime = "jpeg"
	case "data:image/webp;base64":
		mime = "webp"
	case "data:image/gif;base64":
		mime = "gif"
	default:
		return fmt.Errorf("avatar must be PNG, JPEG, WebP or GIF")
	}
	if len(encoded) > base64.StdEncoding.EncodedLen(maxAvatarBytes) {
		return fmt.Errorf("avatar image is too large")
	}
	data, err := base64.StdEncoding.DecodeString(encoded)
	if err != nil || len(data) == 0 || len(data) > maxAvatarBytes {
		return fmt.Errorf("avatar image data is invalid")
	}
	valid := false
	switch mime {
	case "png":
		valid = len(data) >= 8 && string(data[:8]) == "\x89PNG\r\n\x1a\n"
	case "jpeg":
		valid = len(data) >= 3 && data[0] == 0xff && data[1] == 0xd8 && data[2] == 0xff
	case "gif":
		valid = len(data) >= 6 && (string(data[:6]) == "GIF87a" || string(data[:6]) == "GIF89a")
	case "webp":
		valid = len(data) >= 12 && string(data[:4]) == "RIFF" && string(data[8:12]) == "WEBP"
	}
	if !valid {
		return fmt.Errorf("avatar content does not match its image type")
	}
	return nil
}

// ============================================================
// auth_handlers.go — 账户系统处理器
//   预认证: serverInfo / login / register
//   登录态: whoami / logout / changePassword / listAuditLog
//   管理端: createInvite / listInvites / revokeInvite
//          listUsers / setUserDisabled / setUserRole
//          resetUserPassword / updateUserQuota / deleteUser
// ============================================================

type ctxKey string

const contextKeySessionToken ctxKey = "sessionToken"

// ---------- 工具 ----------

// clientIP 提取客户端 IP（去掉端口）
func clientIP(r *http.Request) string {
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	return host
}

// auditEvent 写一条审计日志（Store 为 nil 时静默跳过）
func (h *HTTPHandler) auditEvent(r *http.Request, userID, username, action, target, detail string, success bool) {
	if h.Audit == nil {
		return
	}
	if userID == "" {
		userID = auth.UserIDFromContext(r.Context())
	}
	if username == "" {
		if u := auth.UserFromContext(r.Context()); u != nil {
			username = u.Username
		}
	}
	e := &model.AuditEvent{
		ID:       auth.GenerateUUID(),
		Time:     time.Now(),
		UserID:   userID,
		Username: username,
		Action:   action,
		Target:   target,
		Detail:   detail,
		IP:       clientIP(r),
		Success:  success,
	}
	if err := h.Audit.Save(e); err != nil {
		slog.Warn("Failed to save audit event", "action", action, "error", err)
	}
}

// sanitizeUser 把 auth.User 转成安全视图（不含密码哈希）
func sanitizeUser(u *auth.User, includeAPIKey bool) *model.UserInfo {
	info := &model.UserInfo{
		ID:             u.ID,
		UID:            u.UID,
		Avatar:         u.Avatar,
		Username:       u.Username,
		Email:          u.Email,
		Name:           u.Name,
		Role:           u.EffectiveRole(),
		Disabled:       u.Disabled,
		ContainerLimit: u.ContainerLimit,
		RateLimit:      u.RateLimit,
		DiskQuotaMB:    u.DiskQuotaMB,
		CreatedAt:      u.CreatedAt,
	}
	if includeAPIKey {
		info.APIKey = u.APIKey
	}
	return info
}

// requireRole 检查当前请求角色是否达到 minLevel，不足则写 403 并返回 nil
func (h *HTTPHandler) requireRole(w http.ResponseWriter, r *http.Request, minLevel int) *auth.User {
	user := auth.UserFromContext(r.Context())
	if user == nil {
		writeJSON(w, http.StatusUnauthorized, model.Response{Success: false, Error: "Not authenticated"})
		return nil
	}
	if auth.RoleLevel(user.EffectiveRole()) < minLevel {
		writeJSON(w, http.StatusForbidden, model.Response{Success: false, Error: "Insufficient permission"})
		return nil
	}
	return user
}

// checkMultiMode 多人模式下账户功能才可用；单机模式返回错误提示
func (h *HTTPHandler) checkMultiMode(w http.ResponseWriter) bool {
	if !h.authEnabled {
		writeJSON(w, http.StatusBadRequest, model.Response{
			Success: false,
			Error:   "Server is in single-user mode; account features are disabled",
		})
		return false
	}
	return true
}

// ---------- 预认证：serverInfo ----------

// handleServerInfo 返回服务器公开信息（客户端据此决定显示登录窗还是直接使用）
func (h *HTTPHandler) handleServerInfo(w http.ResponseWriter, r *http.Request) {
	mode := "single"
	if h.authEnabled {
		mode = "multi"
	}
	writeJSON(w, http.StatusOK, model.Response{
		Success:  true,
		AuthMode: mode,
		Version:  h.Version,
		Data:     h.dapInfo(r.Context()),
	})
}

// ---------- 预认证：login ----------

func (h *HTTPHandler) handleLogin(w http.ResponseWriter, r *http.Request, req *model.Request) {
	if !h.checkMultiMode(w) {
		return
	}
	// 防爆破：按 IP 限速（独立于用户限速器）
	if h.LoginLimiter != nil && !h.LoginLimiter.Allow(clientIP(r)) {
		w.Header().Set("Retry-After", "10")
		h.auditEvent(r, "", req.Identity, "login", "", "rate limited", false)
		writeJSON(w, http.StatusTooManyRequests, model.Response{
			Success: false,
			Error:   "Too many login attempts. Please wait a minute.",
		})
		return
	}

	identity := strings.TrimSpace(req.Identity)
	if identity == "" || req.Password == "" {
		writeJSON(w, http.StatusBadRequest, model.Response{Success: false, Error: "identity and password are required"})
		return
	}

	// 用户名或邮箱登录：含 @ 优先按邮箱查，否则先用户名后邮箱兜底
	var user *auth.User
	var err error
	if strings.Contains(identity, "@") {
		user, err = h.UserStore.GetByEmail(identity)
		if err != nil {
			user, err = h.UserStore.GetByUsername(identity)
		}
	} else {
		user, err = h.UserStore.GetByUsername(identity)
		if err != nil {
			user, err = h.UserStore.GetByEmail(identity)
		}
	}
	if err != nil || !auth.CheckPassword(user.PasswordHash, req.Password) {
		h.auditEvent(r, "", identity, "login", "", "invalid credentials", false)
		writeJSON(w, http.StatusUnauthorized, model.Response{Success: false, Error: "Invalid username/email or password"})
		return
	}
	if user.Disabled {
		h.auditEvent(r, user.ID, user.Username, "login", "", "account disabled", false)
		writeJSON(w, http.StatusForbidden, model.Response{Success: false, Error: "Account is disabled. Contact your administrator."})
		return
	}

	sess, err := h.AuthSessions.Create(user.ID, h.Config.SessionTokenTTL())
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, model.Response{Success: false, Error: "Failed to create session"})
		return
	}

	h.auditEvent(r, user.ID, user.Username, "login", "", "", true)
	slog.Info("User logged in", "user_id", user.ID, "ip", clientIP(r))
	writeJSON(w, http.StatusOK, model.Response{
		Success:   true,
		Token:     sess.Token,
		ExpiresAt: &sess.ExpiresAt,
		User:      sanitizeUser(user, true),
	})
}

// ---------- 预认证：register（邀请制） ----------

func (h *HTTPHandler) handleRegister(w http.ResponseWriter, r *http.Request, req *model.Request) {
	if !h.checkMultiMode(w) {
		return
	}
	if h.LoginLimiter != nil && !h.LoginLimiter.Allow("register:"+clientIP(r)) {
		writeJSON(w, http.StatusTooManyRequests, model.Response{Success: false, Error: "Too many attempts. Please wait a minute."})
		return
	}

	username := strings.TrimSpace(req.Username)
	email := strings.TrimSpace(req.Email)
	if username == "" || email == "" || req.Password == "" || req.InviteCode == "" {
		writeJSON(w, http.StatusBadRequest, model.Response{Success: false, Error: "username, email, password and inviteCode are all required"})
		return
	}
	if err := auth.ValidateUsername(username); err != nil {
		writeJSON(w, http.StatusBadRequest, model.Response{Success: false, Error: err.Error()})
		return
	}
	if err := auth.ValidateEmail(email); err != nil {
		writeJSON(w, http.StatusBadRequest, model.Response{Success: false, Error: err.Error()})
		return
	}
	if err := auth.ValidatePassword(req.Password); err != nil {
		writeJSON(w, http.StatusBadRequest, model.Response{Success: false, Error: err.Error()})
		return
	}
	hash, err := auth.HashPassword(req.Password)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, model.Response{Success: false, Error: "Failed to process password"})
		return
	}

	// UserStore 的多个索引需要作为一个注册事务看待。序列化此区间，
	// 防止两个并发请求同时通过唯一性检查后覆盖用户名/邮箱索引。
	h.registrationMu.Lock()
	defer h.registrationMu.Unlock()

	// 唯一性检查（先于消耗邀请码，失败不浪费次数）
	if _, err := h.UserStore.GetByUsername(username); err == nil {
		writeJSON(w, http.StatusConflict, model.Response{Success: false, Error: "Username already taken"})
		return
	}
	if _, err := h.UserStore.GetByEmail(email); err == nil {
		writeJSON(w, http.StatusConflict, model.Response{Success: false, Error: "Email already registered"})
		return
	}
	if _, err := h.UserStore.Get(username); err == nil {
		writeJSON(w, http.StatusConflict, model.Response{Success: false, Error: "Username already taken"})
		return
	}

	// 原子消耗邀请码（校验有效期/剩余次数）
	inv, err := h.Invites.Consume(strings.ToUpper(strings.TrimSpace(req.InviteCode)))
	if err != nil {
		h.auditEvent(r, "", username, "register", req.InviteCode, "invite rejected: "+err.Error(), false)
		writeJSON(w, http.StatusBadRequest, model.Response{Success: false, Error: "Invite code invalid: " + err.Error()})
		return
	}

	role := inv.Role
	if role != auth.RoleAdmin {
		role = auth.RoleMember // 只允许 member/admin 两档，杜绝邀请码提权到 root
	}

	user := &auth.User{
		ID:             auth.GenerateUUID(),
		UID:            auth.GeneratePublicUID(),
		Avatar:         auth.DefaultAvatarForID(username),
		Username:       username,
		Email:          email,
		Name:           username,
		PasswordHash:   hash,
		Role:           role,
		APIKey:         "bobo_" + auth.GenerateToken(),
		ContainerLimit: h.Config.DefaultQuota,
		RateLimit:      h.Config.DefaultRateLimit,
		DiskQuotaMB:    h.Config.DefaultDiskQuotaMB,
		CreatedAt:      time.Now(),
	}
	if user.ContainerLimit <= 0 {
		user.ContainerLimit = 5
	}
	if user.RateLimit <= 0 {
		user.RateLimit = 60
	}
	if err := h.UserStore.Create(user); err != nil {
		writeJSON(w, http.StatusInternalServerError, model.Response{Success: false, Error: "Failed to create user"})
		return
	}
	if h.SetUserLimit != nil {
		h.SetUserLimit(user.ID, user.ContainerLimit)
	}

	// 注册即登录：直接签发会话
	sess, err := h.AuthSessions.Create(user.ID, h.Config.SessionTokenTTL())
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, model.Response{Success: false, Error: "User created but failed to create session; please login"})
		return
	}

	h.auditEvent(r, user.ID, user.Username, "register", inv.Code, "role="+role, true)
	slog.Info("User registered", "user_id", user.ID, "role", role, "invite", inv.Code)
	writeJSON(w, http.StatusOK, model.Response{
		Success:   true,
		Message:   "Registration successful",
		Token:     sess.Token,
		ExpiresAt: &sess.ExpiresAt,
		User:      sanitizeUser(user, true),
	})
}

func (h *HTTPHandler) handleUpdateProfile(w http.ResponseWriter, r *http.Request, req *model.Request) {
	requestUser := auth.UserFromContext(r.Context())
	if requestUser == nil {
		writeJSON(w, http.StatusUnauthorized, model.Response{Success: false, Error: "Not authenticated"})
		return
	}
	name := strings.TrimSpace(req.Name)
	if name != "" {
		if len([]rune(name)) > 80 {
			writeJSON(w, http.StatusBadRequest, model.Response{Success: false, Error: "Display name is too long"})
			return
		}
	}
	avatar := ""
	if req.Avatar != "" {
		avatar = strings.TrimSpace(req.Avatar)
		if err := validateAvatar(avatar); err != nil {
			writeJSON(w, http.StatusBadRequest, model.Response{Success: false, Error: err.Error()})
			return
		}
	}
	user, err := h.UserStore.UpdateProfile(requestUser.ID, name, avatar)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, model.Response{Success: false, Error: "Failed to update profile"})
		return
	}
	writeJSON(w, http.StatusOK, model.Response{Success: true, User: sanitizeUser(user, true)})
}

func (h *HTTPHandler) handleGetCompileActivity(w http.ResponseWriter, r *http.Request) {
	if h.CompileActivity == nil {
		writeJSON(w, http.StatusOK, model.Response{Success: true, Data: map[string]any{
			"timezone": "UTC", "days": []model.CompileActivityDay{},
		}})
		return
	}
	today := time.Now().UTC()
	from := today.AddDate(0, 0, -(storage.CompileActivityRetentionDays - 1))
	days, err := h.CompileActivity.List(auth.UserIDFromContext(r.Context()), from, today)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, model.Response{Success: false, Error: "Failed to load compile activity"})
		return
	}
	writeJSON(w, http.StatusOK, model.Response{Success: true, Data: map[string]any{
		"timezone": "UTC",
		"from":     from.Format("2006-01-02"),
		"through":  today.Format("2006-01-02"),
		"days":     days,
	}})
}

func (h *HTTPHandler) handleFindUser(w http.ResponseWriter, r *http.Request, req *model.Request) {
	uid := strings.TrimSpace(req.UserID)
	if uid == "" {
		writeJSON(w, http.StatusBadRequest, model.Response{Success: false, Error: "userId is required"})
		return
	}
	user, err := h.UserStore.GetByUID(uid)
	if err != nil || user.Disabled {
		writeJSON(w, http.StatusNotFound, model.Response{Success: false, Error: "User not found"})
		return
	}
	// Public lookup intentionally omits email, API key and quota fields.
	writeJSON(w, http.StatusOK, model.Response{Success: true, Data: map[string]any{
		"uid": user.UID, "username": user.Username, "name": user.Name, "avatar": user.Avatar,
	}})
}

// ---------- 登录态：whoami / logout / changePassword ----------

func (h *HTTPHandler) handleWhoami(w http.ResponseWriter, r *http.Request) {
	user := auth.UserFromContext(r.Context())
	if user == nil {
		writeJSON(w, http.StatusUnauthorized, model.Response{Success: false, Error: "Not authenticated"})
		return
	}
	mode := "single"
	if h.authEnabled {
		mode = "multi"
	}
	writeJSON(w, http.StatusOK, model.Response{
		Success:  true,
		AuthMode: mode,
		Version:  h.Version,
		User:     sanitizeUser(user, true),
	})
}

func (h *HTTPHandler) handleLogout(w http.ResponseWriter, r *http.Request) {
	if !h.checkMultiMode(w) {
		return
	}
	if token, ok := r.Context().Value(contextKeySessionToken).(string); ok && token != "" && h.AuthSessions != nil {
		h.AuthSessions.Delete(token)
	}
	h.auditEvent(r, "", "", "logout", "", "", true)
	writeJSON(w, http.StatusOK, model.Response{Success: true, Message: "Logged out"})
}

func (h *HTTPHandler) handleChangePassword(w http.ResponseWriter, r *http.Request, req *model.Request) {
	if !h.checkMultiMode(w) {
		return
	}
	user := auth.UserFromContext(r.Context())
	if user == nil {
		writeJSON(w, http.StatusUnauthorized, model.Response{Success: false, Error: "Not authenticated"})
		return
	}
	if req.OldPassword == "" || req.NewPassword == "" {
		writeJSON(w, http.StatusBadRequest, model.Response{Success: false, Error: "oldPassword and newPassword are required"})
		return
	}
	if err := auth.ValidatePassword(req.NewPassword); err != nil {
		writeJSON(w, http.StatusBadRequest, model.Response{Success: false, Error: err.Error()})
		return
	}
	// API-Key 老用户可能没有密码哈希：有旧哈希才校验旧密码
	if user.PasswordHash != "" && !auth.CheckPassword(user.PasswordHash, req.OldPassword) {
		h.auditEvent(r, "", "", "changePassword", "", "wrong old password", false)
		writeJSON(w, http.StatusUnauthorized, model.Response{Success: false, Error: "Old password is incorrect"})
		return
	}
	hash, err := auth.HashPassword(req.NewPassword)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, model.Response{Success: false, Error: "Failed to process password"})
		return
	}
	user.PasswordHash = hash
	if err := h.UserStore.Create(user); err != nil {
		writeJSON(w, http.StatusInternalServerError, model.Response{Success: false, Error: "Failed to save"})
		return
	}
	// 作废其它会话（保留当前会话），改密后其它设备需重新登录
	if h.AuthSessions != nil {
		currentToken, _ := r.Context().Value(contextKeySessionToken).(string)
		h.AuthSessions.DeleteByUserExcept(user.ID, currentToken)
	}
	h.auditEvent(r, "", "", "changePassword", "", "", true)
	writeJSON(w, http.StatusOK, model.Response{Success: true, Message: "Password changed. Other sessions have been logged out."})
}

// ---------- 审计查询 ----------

func (h *HTTPHandler) handleListAuditLog(w http.ResponseWriter, r *http.Request, req *model.Request) {
	if h.Audit == nil {
		writeJSON(w, http.StatusOK, model.Response{Success: true, Message: "audit not available"})
		return
	}
	user := auth.UserFromContext(r.Context())
	if user == nil {
		writeJSON(w, http.StatusUnauthorized, model.Response{Success: false, Error: "Not authenticated"})
		return
	}
	limit := req.Limit
	if limit <= 0 || limit > 500 {
		limit = 200
	}
	// 普通用户只能看自己的；admin/root 可看全部
	filterUser := ""
	if auth.RoleLevel(user.EffectiveRole()) < auth.RoleLevel(auth.RoleAdmin) {
		filterUser = user.ID
	} else if req.UserID != "" {
		filterUser = req.UserID
	}
	events, err := h.Audit.List(filterUser, limit)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, model.Response{Success: false, Error: fmt.Sprintf("Failed to list audit log: %v", err)})
		return
	}
	writeJSON(w, http.StatusOK, model.Response{Success: true, Events: events})
}

// ---------- 邀请码管理（admin+） ----------

func (h *HTTPHandler) handleCreateInvite(w http.ResponseWriter, r *http.Request, req *model.Request) {
	if !h.checkMultiMode(w) {
		return
	}
	caller := h.requireRole(w, r, auth.RoleLevel(auth.RoleAdmin))
	if caller == nil {
		return
	}
	// 邀请码角色：admin 只能发 member 邀请；root 可发 admin/member
	role := auth.RoleMember
	if req.Role == auth.RoleAdmin {
		if caller.EffectiveRole() != auth.RoleRoot {
			writeJSON(w, http.StatusForbidden, model.Response{Success: false, Error: "Only root can create admin invites"})
			return
		}
		role = auth.RoleAdmin
	}
	ttl := h.Config.InviteTTL()
	if req.ExpiresInHours > 0 {
		ttl = time.Duration(req.ExpiresInHours) * time.Hour
	}
	maxUses := req.MaxUses
	if maxUses <= 0 {
		maxUses = 1
	}

	inv := &auth.Invite{
		Code:      auth.GenerateInviteCode(),
		Role:      role,
		CreatedBy: caller.ID,
		CreatedAt: time.Now(),
		ExpiresAt: time.Now().Add(ttl),
		MaxUses:   maxUses,
	}
	if err := h.Invites.Create(inv); err != nil {
		writeJSON(w, http.StatusInternalServerError, model.Response{Success: false, Error: "Failed to create invite"})
		return
	}
	h.auditEvent(r, "", "", "createInvite", inv.Code, "role="+role, true)
	writeJSON(w, http.StatusOK, model.Response{Success: true, InviteCode: inv.Code})
}

func (h *HTTPHandler) handleListInvites(w http.ResponseWriter, r *http.Request) {
	if !h.checkMultiMode(w) {
		return
	}
	if h.requireRole(w, r, auth.RoleLevel(auth.RoleAdmin)) == nil {
		return
	}
	invites, err := h.Invites.List()
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, model.Response{Success: false, Error: "Failed to list invites"})
		return
	}
	infos := make([]*model.InviteInfo, 0, len(invites))
	for _, inv := range invites {
		infos = append(infos, &model.InviteInfo{
			Code: inv.Code, Role: inv.Role, CreatedBy: inv.CreatedBy,
			CreatedAt: inv.CreatedAt, ExpiresAt: inv.ExpiresAt,
			MaxUses: inv.MaxUses, UsedCount: inv.UsedCount,
		})
	}
	writeJSON(w, http.StatusOK, model.Response{Success: true, Invites: infos})
}

func (h *HTTPHandler) handleRevokeInvite(w http.ResponseWriter, r *http.Request, req *model.Request) {
	if !h.checkMultiMode(w) {
		return
	}
	if h.requireRole(w, r, auth.RoleLevel(auth.RoleAdmin)) == nil {
		return
	}
	if req.InviteCode == "" {
		writeJSON(w, http.StatusBadRequest, model.Response{Success: false, Error: "inviteCode is required"})
		return
	}
	if err := h.Invites.Delete(req.InviteCode); err != nil {
		writeJSON(w, http.StatusInternalServerError, model.Response{Success: false, Error: "Failed to revoke invite"})
		return
	}
	h.auditEvent(r, "", "", "revokeInvite", req.InviteCode, "", true)
	writeJSON(w, http.StatusOK, model.Response{Success: true, Message: "Invite revoked"})
}

// ---------- 用户管理（admin+ / root） ----------

func (h *HTTPHandler) handleListUsers(w http.ResponseWriter, r *http.Request) {
	if !h.checkMultiMode(w) {
		return
	}
	if h.requireRole(w, r, auth.RoleLevel(auth.RoleAdmin)) == nil {
		return
	}
	users, err := h.UserStore.List()
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, model.Response{Success: false, Error: "Failed to list users"})
		return
	}
	infos := make([]*model.UserInfo, 0, len(users))
	for _, u := range users {
		infos = append(infos, sanitizeUser(u, false)) // 列表不暴露 API Key
	}
	writeJSON(w, http.StatusOK, model.Response{Success: true, Users: infos})
}

// canManage 检查操作者能否管理目标用户：
// root 可管理任何人（除对 root 自身的危险操作由调用方单独拦截）；
// admin 只能管理 member；目标为 root/admin 时仅 root 可操作。
func canManage(caller, target *auth.User) bool {
	if caller.EffectiveRole() == auth.RoleRoot {
		return true
	}
	return auth.RoleLevel(target.EffectiveRole()) < auth.RoleLevel(auth.RoleAdmin)
}

func (h *HTTPHandler) handleSetUserDisabled(w http.ResponseWriter, r *http.Request, req *model.Request) {
	if !h.checkMultiMode(w) {
		return
	}
	caller := h.requireRole(w, r, auth.RoleLevel(auth.RoleAdmin))
	if caller == nil {
		return
	}
	if req.UserID == "" || req.Disabled == nil {
		writeJSON(w, http.StatusBadRequest, model.Response{Success: false, Error: "userId and disabled are required"})
		return
	}
	target, err := h.UserStore.Get(req.UserID)
	if err != nil {
		writeJSON(w, http.StatusNotFound, model.Response{Success: false, Error: "User not found"})
		return
	}
	if target.EffectiveRole() == auth.RoleRoot {
		writeJSON(w, http.StatusForbidden, model.Response{Success: false, Error: "Cannot disable the root account"})
		return
	}
	if target.ID == caller.ID && *req.Disabled {
		writeJSON(w, http.StatusBadRequest, model.Response{Success: false, Error: "Cannot disable yourself"})
		return
	}
	if !canManage(caller, target) {
		writeJSON(w, http.StatusForbidden, model.Response{Success: false, Error: "Insufficient permission for this user"})
		return
	}
	target.Disabled = *req.Disabled
	if err := h.UserStore.Create(target); err != nil {
		writeJSON(w, http.StatusInternalServerError, model.Response{Success: false, Error: "Failed to save"})
		return
	}
	// 禁用立即生效：作废目标用户全部会话
	if target.Disabled && h.AuthSessions != nil {
		h.AuthSessions.DeleteByUser(target.ID)
	}
	h.auditEvent(r, "", "", "setUserDisabled", target.ID, fmt.Sprintf("disabled=%v", target.Disabled), true)
	writeJSON(w, http.StatusOK, model.Response{Success: true, Message: fmt.Sprintf("User %s disabled=%v", target.ID, target.Disabled)})
}

func (h *HTTPHandler) handleSetUserRole(w http.ResponseWriter, r *http.Request, req *model.Request) {
	if !h.checkMultiMode(w) {
		return
	}
	caller := h.requireRole(w, r, auth.RoleLevel(auth.RoleRoot)) // 仅 root 可任免角色
	if caller == nil {
		return
	}
	if req.UserID == "" || (req.Role != auth.RoleAdmin && req.Role != auth.RoleMember) {
		writeJSON(w, http.StatusBadRequest, model.Response{Success: false, Error: "userId and role (admin|member) are required"})
		return
	}
	target, err := h.UserStore.Get(req.UserID)
	if err != nil {
		writeJSON(w, http.StatusNotFound, model.Response{Success: false, Error: "User not found"})
		return
	}
	if target.EffectiveRole() == auth.RoleRoot {
		writeJSON(w, http.StatusForbidden, model.Response{Success: false, Error: "Cannot change the root account's role"})
		return
	}
	oldRole := target.EffectiveRole()
	target.Role = req.Role
	if err := h.UserStore.Create(target); err != nil {
		writeJSON(w, http.StatusInternalServerError, model.Response{Success: false, Error: "Failed to save"})
		return
	}
	h.auditEvent(r, "", "", "setUserRole", target.ID, oldRole+"→"+req.Role, true)
	writeJSON(w, http.StatusOK, model.Response{Success: true, Message: fmt.Sprintf("User %s role: %s → %s", target.ID, oldRole, req.Role)})
}

func (h *HTTPHandler) handleResetUserPassword(w http.ResponseWriter, r *http.Request, req *model.Request) {
	if !h.checkMultiMode(w) {
		return
	}
	caller := h.requireRole(w, r, auth.RoleLevel(auth.RoleAdmin))
	if caller == nil {
		return
	}
	if req.UserID == "" {
		writeJSON(w, http.StatusBadRequest, model.Response{Success: false, Error: "userId is required"})
		return
	}
	target, err := h.UserStore.Get(req.UserID)
	if err != nil {
		writeJSON(w, http.StatusNotFound, model.Response{Success: false, Error: "User not found"})
		return
	}
	if !canManage(caller, target) {
		writeJSON(w, http.StatusForbidden, model.Response{Success: false, Error: "Insufficient permission for this user"})
		return
	}
	newPassword := req.NewPassword
	if newPassword == "" {
		newPassword = auth.GeneratePassword() // 未指定则自动生成，返回给管理员转交
	} else if err := auth.ValidatePassword(newPassword); err != nil {
		writeJSON(w, http.StatusBadRequest, model.Response{Success: false, Error: err.Error()})
		return
	}
	hash, err := auth.HashPassword(newPassword)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, model.Response{Success: false, Error: "Failed to process password"})
		return
	}
	target.PasswordHash = hash
	if err := h.UserStore.Create(target); err != nil {
		writeJSON(w, http.StatusInternalServerError, model.Response{Success: false, Error: "Failed to save"})
		return
	}
	if h.AuthSessions != nil {
		h.AuthSessions.DeleteByUser(target.ID) // 重置后强制重新登录
	}
	h.auditEvent(r, "", "", "resetUserPassword", target.ID, "", true)
	writeJSON(w, http.StatusOK, model.Response{
		Success:     true,
		Message:     "Password reset. Share the new password with the user securely.",
		NewPassword: newPassword, // 新密码只出现在本次响应中，服务端不落明文
	})
}

func (h *HTTPHandler) handleUpdateUserQuota(w http.ResponseWriter, r *http.Request, req *model.Request) {
	if !h.checkMultiMode(w) {
		return
	}
	caller := h.requireRole(w, r, auth.RoleLevel(auth.RoleAdmin))
	if caller == nil {
		return
	}
	if req.UserID == "" {
		writeJSON(w, http.StatusBadRequest, model.Response{Success: false, Error: "userId is required"})
		return
	}
	target, err := h.UserStore.Get(req.UserID)
	if err != nil {
		writeJSON(w, http.StatusNotFound, model.Response{Success: false, Error: "User not found"})
		return
	}
	if !canManage(caller, target) {
		writeJSON(w, http.StatusForbidden, model.Response{Success: false, Error: "Insufficient permission for this user"})
		return
	}
	if req.ContainerLimit > 0 {
		target.ContainerLimit = req.ContainerLimit
	}
	if req.RateLimit > 0 {
		target.RateLimit = req.RateLimit
	}
	if req.DiskQuotaMB >= 0 {
		target.DiskQuotaMB = req.DiskQuotaMB
	}
	if err := h.UserStore.Create(target); err != nil {
		writeJSON(w, http.StatusInternalServerError, model.Response{Success: false, Error: "Failed to save"})
		return
	}
	if h.SetUserLimit != nil {
		h.SetUserLimit(target.ID, target.ContainerLimit)
	}
	h.auditEvent(r, "", "", "updateUserQuota", target.ID,
		fmt.Sprintf("container=%d rate=%d disk=%dMB", target.ContainerLimit, target.RateLimit, target.DiskQuotaMB), true)
	writeJSON(w, http.StatusOK, model.Response{Success: true, Message: "Quota updated"})
}

func (h *HTTPHandler) handleDeleteUser(w http.ResponseWriter, r *http.Request, req *model.Request) {
	if !h.checkMultiMode(w) {
		return
	}
	caller := h.requireRole(w, r, auth.RoleLevel(auth.RoleRoot)) // 仅 root 可删除用户
	if caller == nil {
		return
	}
	if req.UserID == "" {
		writeJSON(w, http.StatusBadRequest, model.Response{Success: false, Error: "userId is required"})
		return
	}
	h.userDeletionMu.Lock()
	defer h.userDeletionMu.Unlock()
	target, err := h.UserStore.Get(req.UserID)
	if err != nil {
		if h.hasPendingUserDeletion(req.UserID) {
			pending := h.retryDeletedUserCleanup(req.UserID)
			if len(pending) == 0 {
				writeJSON(w, http.StatusOK, model.Response{Success: true, Message: fmt.Sprintf("User %s deletion cleanup completed", req.UserID)})
			} else {
				writeJSON(w, http.StatusOK, model.Response{Success: true, Message: fmt.Sprintf("User %s remains deleted; some cleanup is pending: %s", req.UserID, strings.Join(pending, ", "))})
			}
			return
		}
		writeJSON(w, http.StatusNotFound, model.Response{Success: false, Error: "User not found"})
		return
	}
	if target.EffectiveRole() == auth.RoleRoot {
		writeJSON(w, http.StatusForbidden, model.Response{Success: false, Error: "Cannot delete the root account"})
		return
	}
	if target.ID == caller.ID {
		writeJSON(w, http.StatusBadRequest, model.Response{Success: false, Error: "Cannot delete yourself"})
		return
	}
	if h.Lifecycle != nil {
		mutation, leaseErr := h.Lifecycle.BeginUserDeletion(target.ID)
		if leaseErr != nil {
			writeJSON(w, http.StatusConflict, model.Response{Success: false, Error: leaseErr.Error()})
			return
		}
		defer mutation.Release()
	}
	// Collaboration validation must not mutate memberships here. All cleanup is
	// post-commit so a failing user-store delete leaves the account untouched.
	if h.Collaboration != nil {
		if err := h.Collaboration.ValidateUserDeletion(target.ID); err != nil {
			writeJSON(w, http.StatusConflict, model.Response{Success: false, Error: err.Error()})
			return
		}
	}

	// Persistent phase. Deleting the user first makes authentication deny the
	// account immediately. Auxiliary persistent failures compensate by restoring
	// the exact user record before any sessions, teams, or files are touched.
	if err := h.UserStore.DeleteWithCleanupMarker(target.ID); err != nil {
		writeJSON(w, http.StatusInternalServerError, model.Response{Success: false, Error: "Failed to delete user"})
		return
	}
	rollbackUser := func(component string, cause error) {
		if restoreErr := h.UserStore.Restore(target); restoreErr != nil {
			slog.Error("Failed to restore user after pre-commit cleanup failure", "user_id", target.ID, "component", component, "cleanup_error", cause, "restore_error", restoreErr)
			writeJSON(w, http.StatusInternalServerError, model.Response{Success: false, Error: "Failed to delete user; account recovery also failed"})
			return
		}
		slog.Error("Pre-commit user cleanup failed; account restored", "user_id", target.ID, "component", component, "error", cause)
		writeJSON(w, http.StatusInternalServerError, model.Response{Success: false, Error: "Failed to delete user " + component})
	}
	if h.CompileActivity != nil {
		if err := h.CompileActivity.DeleteByUser(target.ID); err != nil {
			rollbackUser("compile activity", err)
			return
		}
	}
	// Commit point. Everything below is idempotent external cleanup. Once this
	// starts, never report a rollback-style failure: the account record and its
	// persistent per-user data are already gone.
	cleanupComponents := h.cleanupDeletedUser(target.ID)
	h.auditEvent(r, "", "", "deleteUser", target.ID, "username="+target.Username, true)
	if len(cleanupComponents) == 0 {
		if err := h.UserStore.DeleteDeletionCleanup(target.ID); err != nil {
			cleanupComponents = append(cleanupComponents, "cleanup_marker")
			slog.Error("Failed to clear completed user cleanup marker", "user_id", target.ID, "error", err)
		}
	} else {
		slog.Warn("User deleted with pending post-commit cleanup", "user_id", target.ID, "failures", len(cleanupComponents))
	}
	message := fmt.Sprintf("User %s deleted", target.ID)
	if len(cleanupComponents) > 0 {
		message += "; some cleanup is pending: " + strings.Join(cleanupComponents, ", ")
	}
	writeJSON(w, http.StatusOK, model.Response{Success: true, Message: message})
}

func (h *HTTPHandler) hasPendingUserDeletion(userID string) bool {
	userIDs, err := h.UserStore.ListDeletionCleanup()
	if err != nil {
		return false
	}
	for _, pending := range userIDs {
		if pending == userID {
			return true
		}
	}
	return false
}

func (h *HTTPHandler) retryDeletedUserCleanup(userID string) []string {
	pending := h.cleanupDeletedUser(userID)
	if len(pending) == 0 {
		if err := h.UserStore.DeleteDeletionCleanup(userID); err != nil {
			pending = append(pending, "cleanup_marker")
		}
	}
	return pending
}

// RetryPendingUserDeletions is called once all cleanup dependencies are wired.
// The marker remains stored until every idempotent cleanup step succeeds.
func (h *HTTPHandler) RetryPendingUserDeletions() {
	h.userDeletionMu.Lock()
	defer h.userDeletionMu.Unlock()
	userIDs, err := h.UserStore.ListDeletionCleanup()
	if err != nil {
		slog.Error("Failed to list pending user deletion cleanup", "error", err)
		return
	}
	for _, userID := range userIDs {
		if pending := h.retryDeletedUserCleanup(userID); len(pending) > 0 {
			slog.Warn("User deletion cleanup remains pending", "user_id", userID, "components", pending)
		} else {
			slog.Info("Pending user deletion cleanup completed", "user_id", userID)
		}
	}
}

func (h *HTTPHandler) cleanupDeletedUser(userID string) []string {
	pending := make([]string, 0, 5)
	cleanup := func(component string, action func() error) {
		if err := action(); err != nil {
			pending = append(pending, component)
			slog.Error("Post-commit user cleanup failed", "user_id", userID, "component", component, "error", err)
		}
	}
	if h.Collaboration != nil {
		cleanup("collaboration", func() error { return h.Collaboration.PrepareUserDeletion(userID) })
	}
	if h.CompileActivity != nil {
		cleanup("compile_activity", func() error { return h.CompileActivity.DeleteByUser(userID) })
	}
	if h.RunHistory != nil {
		cleanup("run_history", func() error { return h.RunHistory.DeleteByUser(userID) })
	}
	if h.AuthSessions != nil {
		cleanup("auth_sessions", func() error { return h.AuthSessions.DeleteByUser(userID) })
	}
	if h.OnUserDeleted != nil {
		cleanup("user_resources", func() error { return h.OnUserDeleted(userID) })
	}
	return pending
}
