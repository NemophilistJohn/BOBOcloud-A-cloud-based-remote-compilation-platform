package log

import (
	"context"
	"log/slog"
	"os"
)

// contextKey 是 context 中存储值的 key 类型
type contextKey string

const (
	ContextUserID contextKey = "userID"
	ContextRunID  contextKey = "runID"
	ContextAction contextKey = "action"
)

// NewLogger 创建结构化日志记录器。
// level 可以是 "debug", "info", "warn", "error"。
// format 可以是 "json" 或 "text"。
func NewLogger(level, format string) *slog.Logger {
	var programLevel = new(slog.LevelVar)
	switch level {
	case "debug":
		programLevel.Set(slog.LevelDebug)
	case "warn":
		programLevel.Set(slog.LevelWarn)
	case "error":
		programLevel.Set(slog.LevelError)
	default:
		programLevel.Set(slog.LevelInfo)
	}

	var handler slog.Handler
	if format == "text" {
		handler = slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{Level: programLevel})
	} else {
		handler = slog.NewJSONHandler(os.Stderr, &slog.HandlerOptions{Level: programLevel})
	}

	return slog.New(handler)
}

// WithContext 从 context 中提取已知字段并附加到日志记录。
func WithContext(ctx context.Context, logger *slog.Logger) *slog.Logger {
	attrs := []slog.Attr{}
	if v := ctx.Value(ContextUserID); v != nil {
		attrs = append(attrs, slog.String("user_id", v.(string)))
	}
	if v := ctx.Value(ContextRunID); v != nil {
		attrs = append(attrs, slog.String("run_id", v.(string)))
	}
	if v := ctx.Value(ContextAction); v != nil {
		attrs = append(attrs, slog.String("action", v.(string)))
	}
	if len(attrs) == 0 {
		return logger
	}
	// 将 Attr 切片转为 any 切片
	args := make([]any, len(attrs))
	for i, a := range attrs {
		args[i] = a
	}
	return logger.With(slog.Group("request", args...))
}

// L 是全局默认 logger 的便捷访问。
// 在 main 中通过 SetDefault 设置后可用。
var L *slog.Logger

func init() {
	// 默认初始化，后续由 main 中的配置覆盖
	L = slog.New(slog.NewJSONHandler(os.Stderr, &slog.HandlerOptions{
		Level: slog.LevelInfo,
	}))
}
