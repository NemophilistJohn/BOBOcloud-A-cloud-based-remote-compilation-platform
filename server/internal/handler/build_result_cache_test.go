package handler

import (
	"testing"

	"bobocloud-server/internal/model"
	"bobocloud-server/internal/runner"
)

func TestCompileStageSucceeded(t *testing.T) {
	plan := &runner.Plan{Steps: []runner.Step{
		{Stage: "setup"},
		{Stage: "compile:go"},
		{Stage: "run:go"},
	}}
	tests := []struct {
		name   string
		result *model.RunResult
		want   bool
	}{
		{name: "compile success", result: &model.RunResult{Success: true, CompletedStage: "compile:go"}, want: true},
		{name: "compile failure", result: &model.RunResult{Success: false, CompletedStage: "compile:go"}, want: false},
		{name: "run success", result: &model.RunResult{Success: true, CompletedStage: "run:go"}, want: true},
		{name: "run failure keeps valid compile", result: &model.RunResult{Success: false, CompletedStage: "run:go"}, want: true},
		{name: "setup failure", result: &model.RunResult{Success: false, CompletedStage: "setup"}, want: false},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if got := compileStageSucceeded(plan, test.result); got != test.want {
				t.Fatalf("compileStageSucceeded() = %v, want %v", got, test.want)
			}
		})
	}
}
