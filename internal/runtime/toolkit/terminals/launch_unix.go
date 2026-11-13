//go:build !windows

package terminals

import "os/exec"

func applyPlatformLaunchAttrs(_ *exec.Cmd, _ LaunchSpec) {}
