//go:build !windows

package webuiserverrestartapi

import (
	"os/exec"
	"testing"
)

func assertDetachedSysProcAttr(t *testing.T, cmd *exec.Cmd) {
	t.Helper()
	if cmd.SysProcAttr == nil || !cmd.SysProcAttr.Setsid {
		t.Fatalf("expected SysProcAttr{Setsid: true}, got %+v", cmd.SysProcAttr)
	}
}
