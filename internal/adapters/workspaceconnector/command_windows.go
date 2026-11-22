//go:build windows

package workspaceconnector

import "os/exec"

// Windows has no portable process-group kill from this layer; the default
// CommandContext cancel (terminate the direct process) is the documented limit
// of the connector command channel.
func configureCommand(command *exec.Cmd) {}
