package handler

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"bobocloud-server/internal/model"
)

func validTaskRequest(runID string) model.Request {
	return model.Request{
		Action:     "runTask",
		RunID:      runID,
		FolderName: "project",
		Runtime:    "python:3.11",
		Task: &model.TaskExecution{
			SchemaVersion: 1,
			Label:         "Build project",
			Kind:          "build",
			Source:        "bobocloud",
			Steps: []model.TaskStep{{
				ID: "build", Label: "Build project", Kind: "build", Type: "process",
				Argv: []string{"python", "-m", "compileall", "."}, Env: map[string]string{"MODE": "test"},
			}},
		},
	}
}

func issueTaskRequest(t *testing.T, handler http.Handler, request model.Request) (*httptest.ResponseRecorder, model.Response) {
	t.Helper()
	body, err := json.Marshal(request)
	if err != nil {
		t.Fatal(err)
	}
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, httptest.NewRequest(http.MethodPost, "/api", bytes.NewReader(body)))
	var response model.Response
	if err := json.Unmarshal(recorder.Body.Bytes(), &response); err != nil {
		t.Fatalf("decode response: %v: %s", err, recorder.Body.String())
	}
	return recorder, response
}

func TestRunTaskHandshakeStoresValidatedCloudPlan(t *testing.T) {
	handler, store, channels := newRunLifecycleHTTPHandler(t)
	recorder, response := issueTaskRequest(t, handler, validTaskRequest("task-handshake"))
	if recorder.Code != http.StatusOK || !response.Success || response.Token == "" {
		t.Fatalf("task handshake failed: status=%d body=%s", recorder.Code, recorder.Body.String())
	}
	sess, exists := store.Get("task-handshake")
	if !exists || sess.Task == nil || sess.Task.Label != "Build project" || sess.FilePath != "" {
		t.Fatalf("task session was not stored correctly: %#v", sess)
	}
	if channel := channels.GetOrCreate("task-handshake", false); channel == nil {
		t.Fatal("task handshake did not create its WebSocket channel")
	}
}

func TestRunTaskRejectsLocalUnknownAndInvalidPlans(t *testing.T) {
	for name, mutate := range map[string]func(*model.Request){
		"empty runtime": func(request *model.Request) { request.Runtime = "" },
		"local runtime": func(request *model.Request) { request.Runtime = "local" },
		"invalid kind":  func(request *model.Request) { request.Task.Kind = "deploy" },
		"cycle": func(request *model.Request) {
			request.Task.Steps = append(request.Task.Steps,
				model.TaskStep{ID: "test", Label: "Test", Kind: "test", Type: "process", Argv: []string{"test"}, DependsOn: []string{"build"}})
			request.Task.Steps[0].DependsOn = []string{"test"}
		},
	} {
		t.Run(name, func(t *testing.T) {
			handler, store, _ := newRunLifecycleHTTPHandler(t)
			request := validTaskRequest("invalid-task")
			mutate(&request)
			recorder, response := issueTaskRequest(t, handler, request)
			if recorder.Code != http.StatusBadRequest || response.Success {
				t.Fatalf("invalid task accepted: status=%d body=%s", recorder.Code, recorder.Body.String())
			}
			if _, exists := store.Get("invalid-task"); exists {
				t.Fatal("invalid task created a run session")
			}
		})
	}
}

func TestValidateTaskExecutionKeepsPayloadBelowHTTPBodyLimit(t *testing.T) {
	task := validTaskRequest("size").Task
	task.Steps[0].Env = map[string]string{}
	for index := 0; index < 64; index++ {
		task.Steps[0].Env[string(rune('A'+index%26))+strings.Repeat("X", index)] = strings.Repeat("v", 8192)
	}
	if err := validateTaskExecution(task); err == nil || !strings.Contains(err.Error(), "payload is too large") {
		t.Fatalf("oversized task was not rejected consistently with the HTTP body cap: %v", err)
	}
}

func TestValidateTaskExecutionRejectsInvalidGraphAndProcessFields(t *testing.T) {
	for name, mutate := range map[string]func(*model.TaskExecution){
		"duplicate id":       func(task *model.TaskExecution) { task.Steps = append(task.Steps, task.Steps[0]) },
		"unknown dependency": func(task *model.TaskExecution) { task.Steps[0].DependsOn = []string{"missing"} },
		"cwd escape":         func(task *model.TaskExecution) { task.Steps[0].Cwd = "../outside" },
		"bad env":            func(task *model.TaskExecution) { task.Steps[0].Env = map[string]string{"BAD-NAME": "value"} },
		"bad type":           func(task *model.TaskExecution) { task.Steps[0].Type = "npm" },
	} {
		t.Run(name, func(t *testing.T) {
			task := validTaskRequest("validate").Task
			mutate(task)
			if err := validateTaskExecution(task); err == nil {
				t.Fatal("invalid task execution was accepted")
			}
		})
	}

	valid := validTaskRequest("valid").Task
	valid.Steps = []model.TaskStep{
		{ID: "run", Label: "Run", Kind: "run", Type: "process", Argv: []string{"run"}, DependsOn: []string{"build"}},
		{ID: "build", Label: "Build", Kind: "build", Type: "process", Argv: []string{"build"}},
	}
	if err := validateTaskExecution(valid); err != nil {
		t.Fatalf("valid out-of-order DAG was rejected: %v", err)
	}
}

func TestRunHistoryTargetDescribesProjectTasksAndKeepsFileCompatibility(t *testing.T) {
	display, targetType, label, kind := runHistoryTarget(&model.RunSession{Task: &model.TaskExecution{Label: "Verify", Kind: "test"}})
	if display != "Task [test]: Verify" || targetType != "task" || label != "Verify" || kind != "test" {
		t.Fatalf("unexpected task history target: %q %q %q %q", display, targetType, label, kind)
	}
	display, targetType, label, kind = runHistoryTarget(&model.RunSession{FilePath: "main.go"})
	if display != "main.go" || targetType != "file" || label != "" || kind != "" {
		t.Fatalf("unexpected file history target: %q %q %q %q", display, targetType, label, kind)
	}
}

func TestRunHistoryStatusDoesNotConfuseNormalSocketCloseWithCancellation(t *testing.T) {
	for name, fixture := range map[string]struct {
		result *model.RunResult
		want   string
	}{
		"success":   {result: &model.RunResult{Success: true}, want: "completed"},
		"failure":   {result: &model.RunResult{Success: false, ReturnCode: 1}, want: "failed"},
		"timeout":   {result: &model.RunResult{TimedOut: true}, want: "timed_out"},
		"cancelled": {result: &model.RunResult{Cancelled: true}, want: "cancelled"},
	} {
		t.Run(name, func(t *testing.T) {
			if got := runHistoryStatus(fixture.result); got != fixture.want {
				t.Fatalf("got %q want %q", got, fixture.want)
			}
		})
	}
}
