package handler

import (
	"strings"
	"testing"
	"unicode/utf8"

	"bobocloud-server/internal/model"
)

func TestRunHistorySummaryMarksAndSafelyRetainsTail(t *testing.T) {
	result := &model.RunResult{
		Stdout: strings.Repeat("早", runHistoryOutputLimit),
		Stderr: "last error",
	}

	summary, truncated := runHistorySummary(result)
	if !truncated {
		t.Fatal("expected oversized history output to be marked truncated")
	}
	if len(summary) > runHistoryOutputLimit {
		t.Fatalf("history summary exceeded limit: %d", len(summary))
	}
	if !utf8.ValidString(summary) {
		t.Fatal("history summary split a UTF-8 character")
	}
	if !strings.HasSuffix(summary, "last error") {
		t.Fatalf("history summary did not retain newest stderr: %q", summary[len(summary)-32:])
	}
}

func TestRunHistorySummaryCarriesRunnerTruncation(t *testing.T) {
	summary, truncated := runHistorySummary(&model.RunResult{Stdout: "tail", StdoutTruncated: true})
	if summary != "tail" || !truncated {
		t.Fatalf("summary=%q truncated=%v", summary, truncated)
	}
}
