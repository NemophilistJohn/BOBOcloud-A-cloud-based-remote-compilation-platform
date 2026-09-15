package docker

import (
	"context"
	"errors"
	"reflect"
	"strings"
	"testing"

	"bobocloud-server/internal/metrics"
)

const managedTopWithInit = `PID PPID COMMAND COMMAND
101 100 docker-init /sbin/docker-init -- tail -f /dev/null
102 101 tail tail -f /dev/null
`

const managedTopWithoutInit = `PID PPID COMMAND COMMAND
101 100 tail tail -f /dev/null
`

func TestParseManagedBaselineProcesses(t *testing.T) {
	for name, test := range map[string]struct {
		output string
		want   bool
		failed bool
	}{
		"init and tail": {output: managedTopWithInit, want: true},
		"tail only":     {output: managedTopWithoutInit, want: true},
		"extra process": {output: managedTopWithInit + "103 101 sleep sleep 60\n"},
		"renamed tail":  {output: "PID PPID COMMAND COMMAND\n101 100 tail tail -f /tmp/data\n"},
		"malformed":     {output: "PID PPID COMMAND COMMAND\ninvalid\n", failed: true},
	} {
		t.Run(name, func(t *testing.T) {
			got, err := parseManagedBaselineProcesses([]byte(test.output))
			if (err != nil) != test.failed {
				t.Fatalf("error = %v, failed=%t", err, test.failed)
			}
			if got != test.want {
				t.Fatalf("baseline = %t, want %t", got, test.want)
			}
		})
	}
}

func TestVerifiedResetSkipsRestartForManagedBaseline(t *testing.T) {
	registry := metrics.New(true, 16)
	commands := make([]string, 0)
	pool := &Pool{resetStrategy: ResetStrategyVerified, metrics: registry}
	pool.runDockerCommand = func(_ context.Context, args ...string) ([]byte, error) {
		commands = append(commands, strings.Join(args, " "))
		if args[0] == "top" {
			return []byte(managedTopWithInit), nil
		}
		return nil, nil
	}
	if err := pool.resetContainerForReuse("container-a"); err != nil {
		t.Fatal(err)
	}
	want := []string{
		"top container-a -eo pid,ppid,comm,args",
		"exec --user 0 -w / container-a sh -c " + (&Pool{}).workspaceCleanupCommand(),
	}
	if !reflect.DeepEqual(commands, want) {
		t.Fatalf("commands = %#v, want %#v", commands, want)
	}
	stages := registry.Snapshot().Stages
	if stages["container.recycle.verify"].Count != 1 || stages["container.recycle.workspace"].Count != 1 {
		t.Fatalf("metrics = %#v", stages)
	}
	if stages["container.recycle.restart"].Count != 0 {
		t.Fatalf("restart metric = %#v", stages["container.recycle.restart"])
	}
}

func TestVerifiedResetClearsAllWritableTmpfsMounts(t *testing.T) {
	commands := make([]string, 0)
	pool := &Pool{resetStrategy: ResetStrategyVerified, readOnlyRootfs: true}
	pool.runDockerCommand = func(_ context.Context, args ...string) ([]byte, error) {
		commands = append(commands, strings.Join(args, " "))
		if args[0] == "top" {
			return []byte(managedTopWithoutInit), nil
		}
		return nil, nil
	}
	if err := pool.resetContainerForReuse("container-a"); err != nil {
		t.Fatal(err)
	}
	if len(commands) != 2 {
		t.Fatalf("commands = %#v", commands)
	}
	cleanup := commands[1]
	for _, path := range []string{"find /workspace", "find /tmp", "find /home", "chmod 0700 /workspace", "chmod 1777 /tmp"} {
		if !strings.Contains(cleanup, path) {
			t.Fatalf("cleanup command %q does not reset %q", cleanup, path)
		}
	}
	if !strings.Contains(cleanup, "-name .bobocloud") || !strings.Contains(cleanup, "-name target") {
		t.Fatalf("cleanup command does not protect compiler cache mount points: %q", cleanup)
	}
	if strings.Contains(cleanup, "rm -rf -- /workspace") || strings.Contains(cleanup, "rm -rf /workspace") {
		t.Fatalf("cleanup command recursively removes the workspace mount: %q", cleanup)
	}
}

func TestHardenedWorkspaceResetRunsAsOwnedUID(t *testing.T) {
	commands := make([]string, 0)
	pool := &Pool{resetStrategy: ResetStrategyVerified, hardening: true}
	pool.runDockerCommand = func(_ context.Context, args ...string) ([]byte, error) {
		commands = append(commands, strings.Join(args, " "))
		if args[0] == "top" {
			return []byte(managedTopWithoutInit), nil
		}
		return nil, nil
	}
	if err := pool.resetContainerForReuse("container-a"); err != nil {
		t.Fatal(err)
	}
	if len(commands) != 2 {
		t.Fatalf("commands = %#v", commands)
	}
	wantUser := pool.workspaceExecUser()
	if !strings.Contains(commands[1], "exec --user "+wantUser+" -w /") {
		t.Fatalf("hardened reset user = %q, command = %q", wantUser, commands[1])
	}
	if strings.Contains(commands[1], "chown ") || !strings.Contains(commands[1], "chmod 0700 /workspace") {
		t.Fatalf("hardened reset widened ownership or skipped mode repair: %q", commands[1])
	}
}

func TestHardenedWorkspaceTmpfsBindsServiceIdentity(t *testing.T) {
	spec := containerWorkspaceTmpfsSpec("")
	if !strings.Contains(spec, ":rw,") || !strings.Contains(spec, "mode=0700") {
		t.Fatalf("workspace tmpfs spec = %q", spec)
	}
	if identity := containerUser(); identity != "" {
		parts := strings.Split(identity, ":")
		if !strings.Contains(spec, "uid="+parts[0]) || !strings.Contains(spec, "gid="+parts[1]) {
			t.Fatalf("workspace tmpfs spec %q does not bind identity %q", spec, identity)
		}
	}
}

func TestVerifiedResetFallsBackToRestartForExtraProcess(t *testing.T) {
	commands := make([]string, 0)
	pool := &Pool{resetStrategy: ResetStrategyVerified}
	pool.runDockerCommand = func(_ context.Context, args ...string) ([]byte, error) {
		commands = append(commands, strings.Join(args, " "))
		if args[0] == "top" {
			return []byte(managedTopWithInit + "103 101 sleep sleep 60\n"), nil
		}
		return nil, nil
	}
	if err := pool.resetContainerForReuse("container-a"); err != nil {
		t.Fatal(err)
	}
	if len(commands) != 3 || !strings.HasPrefix(commands[1], "restart -t 0 ") {
		t.Fatalf("commands = %#v", commands)
	}
}

func TestVerifiedResetFallsBackWhenTopFails(t *testing.T) {
	commands := make([]string, 0)
	pool := &Pool{resetStrategy: ResetStrategyVerified}
	pool.runDockerCommand = func(_ context.Context, args ...string) ([]byte, error) {
		commands = append(commands, strings.Join(args, " "))
		if args[0] == "top" {
			return []byte("daemon unavailable"), errors.New("top failed")
		}
		return nil, nil
	}
	if err := pool.resetContainerForReuse("container-a"); err != nil {
		t.Fatal(err)
	}
	if len(commands) != 3 || !strings.HasPrefix(commands[1], "restart -t 0 ") {
		t.Fatalf("commands = %#v", commands)
	}
}

func TestRestartStrategyNeverCallsTop(t *testing.T) {
	commands := make([]string, 0)
	pool := &Pool{resetStrategy: ResetStrategyRestart}
	pool.runDockerCommand = func(_ context.Context, args ...string) ([]byte, error) {
		commands = append(commands, strings.Join(args, " "))
		return nil, nil
	}
	if err := pool.resetContainerForReuse("container-a"); err != nil {
		t.Fatal(err)
	}
	if len(commands) != 2 || !strings.HasPrefix(commands[0], "restart -t 0 ") {
		t.Fatalf("commands = %#v", commands)
	}
}

func TestVerifiedResetRetriesWorkspaceCleanupAfterRestart(t *testing.T) {
	workspaceAttempts := 0
	commands := make([]string, 0)
	pool := &Pool{resetStrategy: ResetStrategyVerified}
	pool.runDockerCommand = func(_ context.Context, args ...string) ([]byte, error) {
		commands = append(commands, strings.Join(args, " "))
		switch args[0] {
		case "top":
			return []byte(managedTopWithoutInit), nil
		case "exec":
			workspaceAttempts++
			if workspaceAttempts == 1 {
				return []byte("busy"), errors.New("cleanup failed")
			}
		}
		return nil, nil
	}
	if err := pool.resetContainerForReuse("container-a"); err != nil {
		t.Fatal(err)
	}
	if workspaceAttempts != 2 || len(commands) != 4 || !strings.HasPrefix(commands[2], "restart -t 0 ") {
		t.Fatalf("attempts=%d commands=%#v", workspaceAttempts, commands)
	}
}
