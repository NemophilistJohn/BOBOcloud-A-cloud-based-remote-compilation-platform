package auth

import (
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"regexp"
	"strings"

	"golang.org/x/crypto/bcrypt"
)

// ============================================================
// password.go — 密码哈希（bcrypt）与注册字段校验
// ============================================================

// HashPassword 使用 bcrypt 哈希明文密码
func HashPassword(plain string) (string, error) {
	b, err := bcrypt.GenerateFromPassword([]byte(plain), bcrypt.DefaultCost)
	if err != nil {
		return "", fmt.Errorf("failed to hash password: %w", err)
	}
	return string(b), nil
}

// CheckPassword 校验明文密码与 bcrypt 哈希是否匹配
func CheckPassword(hash, plain string) bool {
	if hash == "" || plain == "" {
		return false
	}
	return bcrypt.CompareHashAndPassword([]byte(hash), []byte(plain)) == nil
}

// ---------- 注册字段校验 ----------

var (
	usernameRe = regexp.MustCompile(`^[a-zA-Z0-9_-]{3,32}$`)
	emailRe    = regexp.MustCompile(`^[^@\s]+@[^@\s]+\.[^@\s]+$`)
)

// ValidateUsername 校验用户名：3-32 位字母/数字/下划线/短横线
func ValidateUsername(username string) error {
	if !usernameRe.MatchString(username) {
		return fmt.Errorf("username must be 3-32 chars of letters, digits, '_' or '-'")
	}
	return nil
}

// ValidateEmail 校验邮箱格式（简单校验，够用即可）
func ValidateEmail(email string) error {
	if !emailRe.MatchString(email) {
		return fmt.Errorf("invalid email format")
	}
	return nil
}

// ValidatePassword 校验密码强度：至少 6 位
func ValidatePassword(password string) error {
	if len(password) < 6 {
		return fmt.Errorf("password must be at least 6 characters")
	}
	if len(password) > 128 {
		return fmt.Errorf("password too long (max 128)")
	}
	return nil
}

// GeneratePassword 生成随机初始密码（12 位可读字符，用于 root 种子 / 管理员重置）
func GeneratePassword() string {
	b := make([]byte, 9)
	rand.Read(b)
	return "Bobo" + hex.EncodeToString(b)[:8]
}

// GenerateInviteCode 生成邀请码：INV-XXXXXXXX（8 位大写字母数字，便于口头/IM 传递）
func GenerateInviteCode() string {
	const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789" // 去掉易混淆的 0/O/1/I
	b := make([]byte, 8)
	rand.Read(b)
	var sb strings.Builder
	sb.WriteString("INV-")
	for i := 0; i < 8; i++ {
		sb.WriteByte(alphabet[int(b[i])%len(alphabet)])
	}
	return sb.String()
}
