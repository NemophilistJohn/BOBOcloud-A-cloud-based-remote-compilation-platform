package docker

import (
	"strconv"
	"strings"
	"testing"
)

func TestContainerUserIsNumericWhenAvailable(t *testing.T) {
	identity := containerUser()
	if identity == "" {
		return
	}
	parts := strings.Split(identity, ":")
	if len(parts) != 2 {
		t.Fatalf("container user = %q, want uid:gid", identity)
	}
	for _, part := range parts {
		if _, err := strconv.ParseUint(part, 10, 32); err != nil {
			t.Fatalf("container user = %q, invalid numeric component %q: %v", identity, part, err)
		}
	}
}
