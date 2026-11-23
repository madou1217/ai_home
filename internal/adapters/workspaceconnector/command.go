package workspaceconnector

import (
	"bytes"
	"context"
	"encoding/base64"
	"errors"
	"os"
	"os/exec"
	"runtime"
	"strings"
	"time"

	"github.com/madou1217/ai_home/internal/remoteconnector"
)

const (
	maxCommandBytes  = 64 * 1024
	maxCommandOutput = 256 * 1024
	commandKillGrace = 5 * time.Second
)

// runCommand executes one synchronous shell command. The working directory is
// confined to the workspace root; the command itself runs with the local user's
// own authority and is not an OS sandbox.
func (fs *filesystem) runCommand(ctx context.Context, request remoteconnector.RunCommandRequest) (remoteconnector.RunCommandResult, error) {
	command := request.Command
	if strings.TrimSpace(command) == "" {
		return remoteconnector.RunCommandResult{}, remoteconnector.NewProtocolError(remoteconnector.CodeInvalidPayload, "command is required")
	}
	if len(command) > maxCommandBytes {
		return remoteconnector.RunCommandResult{}, remoteconnector.NewProtocolError(remoteconnector.CodeInvalidPayload, "command is larger than the command limit")
	}
	cwd, err := fs.commandDir(request.Cwd)
	if err != nil {
		return remoteconnector.RunCommandResult{}, err
	}
	runCtx, cancel := context.WithTimeout(ctx, remoteconnector.CommandTimeout(request.TimeoutMS))
	defer cancel()

	stdout := newBoundedBuffer(maxCommandOutput)
	stderr := newBoundedBuffer(maxCommandOutput)
	shell, shellArgs := commandShell(command)
	process := exec.CommandContext(runCtx, shell, shellArgs...)
	process.Dir = cwd
	process.Stdout = stdout
	process.Stderr = stderr
	process.WaitDelay = commandKillGrace
	configureCommand(process)

	started := time.Now()
	if err := process.Start(); err != nil {
		return remoteconnector.RunCommandResult{}, remoteconnector.NewProtocolError(remoteconnector.CodeInternal, "command could not be started")
	}
	waitErr := process.Wait()
	result := remoteconnector.RunCommandResult{
		Cwd:        displayPath(fs.sandbox.root, cwd),
		Stdout:     base64.StdEncoding.EncodeToString(stdout.Bytes()),
		Stderr:     base64.StdEncoding.EncodeToString(stderr.Bytes()),
		Encoding:   "base64",
		Truncated:  stdout.Truncated() || stderr.Truncated(),
		DurationMS: time.Since(started).Milliseconds(),
	}
	if waitErr == nil {
		return result, nil
	}
	var exitErr *exec.ExitError
	if errors.As(waitErr, &exitErr) {
		result.ExitCode = exitErr.ExitCode()
		result.TimedOut = runCtx.Err() != nil
		return result, nil
	}
	if runCtx.Err() != nil {
		result.ExitCode = -1
		result.TimedOut = true
		return result, nil
	}
	return remoteconnector.RunCommandResult{}, remoteconnector.NewProtocolError(remoteconnector.CodeInternal, "command execution failed")
}

// commandDir resolves an optional workspace-relative cwd and requires it to be
// an existing directory inside the sandbox.
func (fs *filesystem) commandDir(relative string) (string, error) {
	relative = strings.TrimSpace(relative)
	if relative == "" {
		return fs.sandbox.root, nil
	}
	resolved, err := fs.sandbox.resolve(relative, false)
	if err != nil {
		return "", err
	}
	info, statErr := os.Stat(resolved)
	if statErr != nil {
		return "", fileError(statErr)
	}
	if !info.IsDir() {
		return "", remoteconnector.NewProtocolError(remoteconnector.CodeNotADirectory, "command cwd is not a directory")
	}
	return resolved, nil
}

// commandShell picks the local shell. The command is passed as a single argv
// element, so callers never deal with shell quoting at this layer.
func commandShell(command string) (string, []string) {
	if runtime.GOOS == "windows" {
		return "powershell.exe", []string{"-NoProfile", "-NonInteractive", "-Command", command}
	}
	return "sh", []string{"-c", command}
}

// boundedBuffer keeps the first limit bytes of a stream and keeps draining the
// rest, so a chatty command is never blocked by the output cap.
type boundedBuffer struct {
	limit     int
	buffer    bytes.Buffer
	truncated bool
}

func newBoundedBuffer(limit int) *boundedBuffer {
	return &boundedBuffer{limit: limit}
}

func (buffer *boundedBuffer) Write(chunk []byte) (int, error) {
	remaining := buffer.limit - buffer.buffer.Len()
	switch {
	case remaining <= 0:
		if len(chunk) > 0 {
			buffer.truncated = true
		}
	case len(chunk) > remaining:
		buffer.truncated = true
		_, _ = buffer.buffer.Write(chunk[:remaining])
	default:
		_, _ = buffer.buffer.Write(chunk)
	}
	return len(chunk), nil
}

func (buffer *boundedBuffer) Bytes() []byte { return buffer.buffer.Bytes() }

func (buffer *boundedBuffer) Truncated() bool { return buffer.truncated }
