//go:build windows

package webuiserverrestartapi

import (
	"os/exec"
	"testing"
)

func assertDetachedSysProcAttr(t *testing.T, cmd *exec.Cmd) {
	t.Helper()
	wantFlags := uint32(createNewProcessGroup | detachedProcess)
	if cmd.SysProcAttr == nil || !cmd.SysProcAttr.HideWindow || cmd.SysProcAttr.CreationFlags != wantFlags {
		t.Fatalf("expected HideWindow=true CreationFlags=0x%x, got %+v", wantFlags, cmd.SysProcAttr)
	}
}
