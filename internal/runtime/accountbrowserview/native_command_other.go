//go:build !windows

package accountbrowserview

import "os/exec"

func prepareBrowserCommand(*exec.Cmd) {}
