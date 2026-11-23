package workspaceconnector

import (
	"context"
	"errors"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"strconv"
	"strings"
	"sync/atomic"
	"syscall"
	"time"

	"github.com/madou1217/ai_home/internal/remoteconnector"
)

// RunJobRunner executes one spooled job. The connector starts it detached, so
// the job survives the connector process; the runner owns the shell process,
// enforces the timeout and records the final status for later watch calls.
func RunJobRunner(dir string) error {
	meta, err := readJSONMeta(filepath.Join(dir, "meta.json"))
	if err != nil || strings.TrimSpace(meta.Command) == "" || strings.TrimSpace(meta.Cwd) == "" {
		return errors.New("job metadata is unavailable")
	}
	pidPath := filepath.Join(dir, "runner.pid")
	if err := os.WriteFile(pidPath, []byte(strconv.Itoa(os.Getpid())), 0o600); err != nil {
		return errors.New("job state directory is not writable")
	}
	stopHeartbeat := startJobHeartbeat(dir)
	defer stopHeartbeat()

	stdout, err := newSpoolWriter(filepath.Join(dir, "stdout.log"))
	if err != nil {
		writeRunnerStatus(dir, jobStatus{State: remoteconnector.JobFailed, ExitCode: -1, EndedAt: time.Now().UnixMilli()})
		return nil
	}
	stderr, err := newSpoolWriter(filepath.Join(dir, "stderr.log"))
	if err != nil {
		writeRunnerStatus(dir, jobStatus{State: remoteconnector.JobFailed, ExitCode: -1, EndedAt: time.Now().UnixMilli()})
		return nil
	}

	ctx, cancel := context.WithTimeout(context.Background(), remoteconnector.JobTimeout(meta.TimeoutMS))
	defer cancel()
	shell, shellArgs := commandShell(meta.Command)
	process := exec.CommandContext(ctx, shell, shellArgs...)
	process.Dir = meta.Cwd
	process.Stdout = stdout
	process.Stderr = stderr
	process.WaitDelay = commandKillGrace
	configureCommand(process)

	var interrupted atomic.Bool
	signals := make(chan os.Signal, 1)
	signal.Notify(signals, syscall.SIGTERM, syscall.SIGINT)
	defer signal.Stop(signals)
	done := make(chan struct{})
	go func() {
		select {
		case <-signals:
			interrupted.Store(true)
			_ = terminateCommand(process)
		case <-done:
		}
	}()

	startedAt := time.Now().UnixMilli()
	if err := process.Start(); err != nil {
		close(done)
		writeRunnerStatus(dir, jobStatus{State: remoteconnector.JobFailed, ExitCode: -1, StartedAt: startedAt, EndedAt: time.Now().UnixMilli()})
		_ = os.Remove(pidPath)
		return nil
	}
	waitErr := process.Wait()
	close(done)
	_ = stdout.Close()
	_ = stderr.Close()

	state, exitCode := remoteconnector.JobExited, 0
	var exitErr *exec.ExitError
	switch {
	case interrupted.Load():
		state, exitCode = remoteconnector.JobInterrupted, -1
	case ctx.Err() == context.DeadlineExceeded:
		state, exitCode = remoteconnector.JobTimedOut, -1
	case errors.As(waitErr, &exitErr):
		exitCode = exitErr.ExitCode()
	case waitErr != nil:
		state, exitCode = remoteconnector.JobFailed, -1
	}
	writeRunnerStatus(dir, jobStatus{
		State: state, ExitCode: exitCode, StartedAt: startedAt, EndedAt: time.Now().UnixMilli(),
		StdoutBytes: stdout.Stored(), StderrBytes: stderr.Stored(),
		StdoutTruncated: stdout.Truncated(), StderrTruncated: stderr.Truncated(),
	})
	_ = os.Remove(pidPath)
	return nil
}

func startJobHeartbeat(dir string) func() {
	path := filepath.Join(dir, "heartbeat")
	touch := func() {
		now := time.Now()
		_ = os.Chtimes(path, now, now)
	}
	_ = os.WriteFile(path, nil, 0o600)
	touch()
	stop := make(chan struct{})
	go func() {
		ticker := time.NewTicker(2 * time.Second)
		defer ticker.Stop()
		for {
			select {
			case <-stop:
				return
			case <-ticker.C:
				touch()
			}
		}
	}()
	return func() {
		close(stop)
		touch()
	}
}

func writeRunnerStatus(dir string, status jobStatus) {
	_ = writeJSONFile(filepath.Join(dir, "status.json"), status)
}

// spoolWriter keeps at most jobSpoolBytes of one stream but always drains the
// process pipe, so a chatty command cannot block on a full file.
type spoolWriter struct {
	file      *os.File
	stored    int64
	truncated bool
}

func newSpoolWriter(path string) (*spoolWriter, error) {
	file, err := os.OpenFile(path, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o600)
	if err != nil {
		return nil, err
	}
	return &spoolWriter{file: file}, nil
}

func (writer *spoolWriter) Write(chunk []byte) (int, error) {
	remaining := int64(jobSpoolBytes) - writer.stored
	if remaining <= 0 {
		if len(chunk) > 0 {
			writer.truncated = true
		}
		return len(chunk), nil
	}
	head := chunk
	if int64(len(head)) > remaining {
		head = head[:remaining]
		writer.truncated = true
	}
	if len(head) > 0 {
		if _, err := writer.file.Write(head); err != nil {
			return 0, err
		}
		writer.stored += int64(len(head))
	}
	return len(chunk), nil
}

func (writer *spoolWriter) Stored() int64 { return writer.stored }

func (writer *spoolWriter) Truncated() bool { return writer.truncated }

func (writer *spoolWriter) Close() error { return writer.file.Close() }
