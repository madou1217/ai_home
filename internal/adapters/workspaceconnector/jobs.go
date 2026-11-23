package workspaceconnector

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/madou1217/ai_home/internal/remoteconnector"
)

const (
	maxJobs          = 16
	maxRunningJobs   = 4
	jobChunkBytes    = 128 * 1024
	jobSpoolBytes    = 8 * 1024 * 1024
	jobPollInterval  = 150 * time.Millisecond
	jobInterruptWait = 5 * time.Second
	jobHeartbeat     = 10 * time.Second
)

// jobMeta and jobStatus are the on-disk spool contract. They deliberately have
// no json tags: the spool is private to this package and never crosses the
// connector protocol.
type jobMeta struct {
	ID        string
	Command   string
	Cwd       string
	TimeoutMS int
	CreatedAt int64
}

type jobStatus struct {
	State           string
	ExitCode        int
	StartedAt       int64
	EndedAt         int64
	StdoutBytes     int64
	StderrBytes     int64
	StdoutTruncated bool
	StderrTruncated bool
}

// jobManager keeps jobs in a spool directory so they survive connector
// restarts. The command itself runs in a detached runner process.
type jobManager struct {
	files      *filesystem
	stateDir   string
	executable string
}

func newJobManager(files *filesystem, stateDir, executable string) *jobManager {
	if strings.TrimSpace(stateDir) == "" {
		stateDir = filepath.Join(os.TempDir(), "aih-workspace-jobs")
	}
	return &jobManager{files: files, stateDir: stateDir, executable: executable}
}

func (manager *jobManager) execute(ctx context.Context, operation string, raw json.RawMessage) (any, error) {
	switch operation {
	case remoteconnector.OperationStartJob:
		var request remoteconnector.StartJobRequest
		if err := decodePayload(raw, &request); err != nil {
			return nil, err
		}
		return manager.start(request)
	case remoteconnector.OperationWatchJob:
		var request remoteconnector.WatchJobRequest
		if err := decodePayload(raw, &request); err != nil {
			return nil, err
		}
		return manager.watch(request)
	case remoteconnector.OperationInterruptJob:
		var request remoteconnector.InterruptJobRequest
		if err := decodePayload(raw, &request); err != nil {
			return nil, err
		}
		return manager.interrupt(request)
	default:
		return nil, remoteconnector.NewProtocolError(remoteconnector.CodeUnsupportedOperation, "operation is not implemented by this connector")
	}
}

func (manager *jobManager) start(request remoteconnector.StartJobRequest) (remoteconnector.StartJobResult, error) {
	command := request.Command
	if strings.TrimSpace(command) == "" {
		return remoteconnector.StartJobResult{}, remoteconnector.NewProtocolError(remoteconnector.CodeInvalidPayload, "command is required")
	}
	if len(command) > maxCommandBytes {
		return remoteconnector.StartJobResult{}, remoteconnector.NewProtocolError(remoteconnector.CodeInvalidPayload, "command is larger than the command limit")
	}
	cwd, err := manager.files.commandDir(request.Cwd)
	if err != nil {
		return remoteconnector.StartJobResult{}, err
	}
	if running := manager.running(); running >= maxRunningJobs {
		return remoteconnector.StartJobResult{}, remoteconnector.NewProtocolError(remoteconnector.CodeJobLimit, "too many running jobs")
	}
	if err := os.MkdirAll(manager.stateDir, 0o700); err != nil {
		return remoteconnector.StartJobResult{}, remoteconnector.NewProtocolError(remoteconnector.CodeInternal, "job state directory is unavailable")
	}
	manager.prune()

	id := newJobID()
	dir := filepath.Join(manager.stateDir, id)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return remoteconnector.StartJobResult{}, remoteconnector.NewProtocolError(remoteconnector.CodeInternal, "job state directory is unavailable")
	}
	meta := jobMeta{ID: id, Command: command, Cwd: cwd, TimeoutMS: request.TimeoutMS, CreatedAt: time.Now().UnixMilli()}
	if err := writeJSONFile(filepath.Join(dir, "meta.json"), meta); err != nil {
		_ = os.RemoveAll(dir)
		return remoteconnector.StartJobResult{}, remoteconnector.NewProtocolError(remoteconnector.CodeInternal, "cannot write job metadata")
	}
	// The connector owns the first heartbeat so a just-started job is counted as
	// running before its detached runner has booted.
	_ = os.WriteFile(filepath.Join(dir, "heartbeat"), nil, 0o600)
	if err := manager.spawn(dir); err != nil {
		_ = os.RemoveAll(dir)
		return remoteconnector.StartJobResult{}, remoteconnector.NewProtocolError(remoteconnector.CodeInternal, "job runner could not be started")
	}
	return remoteconnector.StartJobResult{
		JobID: id, State: remoteconnector.JobRunning,
		Cwd:         displayPath(manager.files.sandbox.root, cwd),
		StdoutStart: 0, StderrStart: 0, StartedAt: meta.CreatedAt,
	}, nil
}

func (manager *jobManager) spawn(dir string) error {
	executable := strings.TrimSpace(manager.executable)
	if executable == "" {
		resolved, err := os.Executable()
		if err != nil {
			return err
		}
		executable = resolved
	}
	process := exec.Command(executable, "workspace", "__job-runner", dir)
	process.Dir = dir
	process.Env = os.Environ()
	configureDetached(process)
	if err := process.Start(); err != nil {
		return err
	}
	return process.Process.Release()
}

func (manager *jobManager) watch(request remoteconnector.WatchJobRequest) (remoteconnector.WatchJobResult, error) {
	meta, dir, err := manager.load(request.JobID)
	if err != nil {
		return remoteconnector.WatchJobResult{}, err
	}
	if request.StdoutOffset < 0 || request.StderrOffset < 0 {
		return remoteconnector.WatchJobResult{}, remoteconnector.NewProtocolError(remoteconnector.CodeInvalidPayload, "job cursor must not be negative")
	}
	deadline := time.Now().Add(remoteconnector.JobWait(request.WaitMS))
	for {
		result, fresh, err := manager.snapshot(meta, dir, request)
		if err != nil {
			return remoteconnector.WatchJobResult{}, err
		}
		if fresh || result.State != remoteconnector.JobRunning || !time.Now().Before(deadline) {
			return result, nil
		}
		time.Sleep(jobPollInterval)
	}
}

func (manager *jobManager) interrupt(request remoteconnector.InterruptJobRequest) (remoteconnector.InterruptJobResult, error) {
	meta, dir, err := manager.load(request.JobID)
	if err != nil {
		return remoteconnector.InterruptJobResult{}, err
	}
	status, found := readJSONStatus(filepath.Join(dir, "status.json"))
	state := status.State
	if !found || state == "" {
		if runnerAlive(dir) {
			state = remoteconnector.JobRunning
		} else {
			state = remoteconnector.JobLost
		}
	}
	if state != remoteconnector.JobRunning {
		return remoteconnector.InterruptJobResult{JobID: meta.ID, State: state}, nil
	}
	pid := readRunnerPID(dir)
	if pid <= 0 {
		writeInterrupted(dir)
		return remoteconnector.InterruptJobResult{JobID: meta.ID, State: remoteconnector.JobInterrupted}, nil
	}
	forced := false
	_ = signalRunner(pid, false)
	deadline := time.Now().Add(jobInterruptWait)
	for time.Now().Before(deadline) {
		if status, found := readJSONStatus(filepath.Join(dir, "status.json")); found && status.State != "" {
			return remoteconnector.InterruptJobResult{JobID: meta.ID, State: status.State, Forced: forced}, nil
		}
		time.Sleep(100 * time.Millisecond)
	}
	_ = signalRunner(pid, true)
	forced = true
	writeInterrupted(dir)
	return remoteconnector.InterruptJobResult{JobID: meta.ID, State: remoteconnector.JobInterrupted, Forced: forced}, nil
}

func (manager *jobManager) snapshot(meta jobMeta, dir string, request remoteconnector.WatchJobRequest) (remoteconnector.WatchJobResult, bool, error) {
	status, found := readJSONStatus(filepath.Join(dir, "status.json"))
	state := status.State
	if !found || state == "" {
		if runnerAlive(dir) {
			state = remoteconnector.JobRunning
		} else {
			state = remoteconnector.JobLost
		}
	}
	stdout, stdoutNext, err := readSpool(filepath.Join(dir, "stdout.log"), request.StdoutOffset, jobChunkBytes)
	if err != nil {
		return remoteconnector.WatchJobResult{}, false, err
	}
	stderr, stderrNext, err := readSpool(filepath.Join(dir, "stderr.log"), request.StderrOffset, jobChunkBytes)
	if err != nil {
		return remoteconnector.WatchJobResult{}, false, err
	}
	startedAt := status.StartedAt
	if startedAt == 0 {
		startedAt = meta.CreatedAt
	}
	duration := time.Duration(0)
	if status.EndedAt > 0 {
		duration = time.Duration(status.EndedAt-startedAt) * time.Millisecond
	} else if startedAt > 0 {
		duration = time.Since(time.UnixMilli(startedAt))
	}
	result := remoteconnector.WatchJobResult{
		JobID: meta.ID, State: state, ExitCode: status.ExitCode,
		Stdout:       base64.StdEncoding.EncodeToString(stdout),
		Stderr:       base64.StdEncoding.EncodeToString(stderr),
		Encoding:     "base64",
		StdoutOffset: stdoutNext, StderrOffset: stderrNext,
		Truncated: status.StdoutTruncated || status.StderrTruncated,
		StartedAt: startedAt, EndedAt: status.EndedAt,
		DurationMS: duration.Milliseconds(),
	}
	return result, len(stdout) > 0 || len(stderr) > 0, nil
}

func (manager *jobManager) load(jobID string) (jobMeta, string, error) {
	jobID = strings.TrimSpace(jobID)
	if !validJobID(jobID) {
		return jobMeta{}, "", remoteconnector.NewProtocolError(remoteconnector.CodeJobNotFound, "job does not exist")
	}
	dir := filepath.Join(manager.stateDir, jobID)
	meta, err := readJSONMeta(filepath.Join(dir, "meta.json"))
	if err != nil {
		return jobMeta{}, "", remoteconnector.NewProtocolError(remoteconnector.CodeJobNotFound, "job does not exist")
	}
	return meta, dir, nil
}

func (manager *jobManager) running() int {
	entries, err := os.ReadDir(manager.stateDir)
	if err != nil {
		return 0
	}
	count := 0
	for _, entry := range entries {
		if !entry.IsDir() || !validJobID(entry.Name()) {
			continue
		}
		dir := filepath.Join(manager.stateDir, entry.Name())
		status, found := readJSONStatus(filepath.Join(dir, "status.json"))
		if found && status.State != "" {
			continue
		}
		if runnerAlive(dir) {
			count++
		}
	}
	return count
}

func (manager *jobManager) prune() {
	entries, err := os.ReadDir(manager.stateDir)
	if err != nil {
		return
	}
	type candidate struct {
		dir     string
		created int64
	}
	items := make([]candidate, 0, len(entries))
	for _, entry := range entries {
		if !entry.IsDir() || !validJobID(entry.Name()) {
			continue
		}
		dir := filepath.Join(manager.stateDir, entry.Name())
		meta, err := readJSONMeta(filepath.Join(dir, "meta.json"))
		if err != nil {
			continue
		}
		items = append(items, candidate{dir: dir, created: meta.CreatedAt})
	}
	sort.Slice(items, func(left, right int) bool { return items[left].created < items[right].created })
	for len(items) > maxJobs {
		oldest := items[0]
		items = items[1:]
		if runnerAlive(oldest.dir) {
			continue
		}
		_ = os.RemoveAll(oldest.dir)
	}
}

// writeInterrupted is the fallback when the runner cannot report its own exit.
func writeInterrupted(dir string) {
	status := jobStatus{State: remoteconnector.JobInterrupted, ExitCode: -1, EndedAt: time.Now().UnixMilli()}
	status.StdoutBytes = fileSize(filepath.Join(dir, "stdout.log"))
	status.StderrBytes = fileSize(filepath.Join(dir, "stderr.log"))
	_ = writeJSONFile(filepath.Join(dir, "status.json"), status)
	_ = os.Remove(filepath.Join(dir, "runner.pid"))
}

func validJobID(jobID string) bool {
	if len(jobID) != 22 || !strings.HasPrefix(jobID, "job-") {
		return false
	}
	for _, char := range jobID[4:] {
		if !((char >= '0' && char <= '9') || (char >= 'a' && char <= 'f')) {
			return false
		}
	}
	return true
}

func newJobID() string {
	buffer := make([]byte, 9)
	if _, err := rand.Read(buffer); err != nil {
		return "job-000000000000000000"
	}
	return "job-" + hex.EncodeToString(buffer)
}

// runnerAlive uses a heartbeat file instead of process probes so the answer is
// the same on every platform and survives a connector restart.
func runnerAlive(dir string) bool {
	info, err := os.Stat(filepath.Join(dir, "heartbeat"))
	if err != nil {
		return false
	}
	return time.Since(info.ModTime()) < jobHeartbeat
}

func readRunnerPID(dir string) int {
	raw, err := os.ReadFile(filepath.Join(dir, "runner.pid"))
	if err != nil {
		return 0
	}
	pid, err := strconv.Atoi(strings.TrimSpace(string(raw)))
	if err != nil || pid <= 0 {
		return 0
	}
	return pid
}

func fileSize(path string) int64 {
	info, err := os.Stat(path)
	if err != nil {
		return 0
	}
	return info.Size()
}

func readSpool(path string, offset int64, limit int) ([]byte, int64, error) {
	file, err := os.Open(path)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return nil, offset, nil
		}
		return nil, offset, remoteconnector.NewProtocolError(remoteconnector.CodeInternal, "job output is unavailable")
	}
	defer func() { _ = file.Close() }()
	info, err := file.Stat()
	if err != nil {
		return nil, offset, remoteconnector.NewProtocolError(remoteconnector.CodeInternal, "job output is unavailable")
	}
	if offset > info.Size() {
		return nil, offset, remoteconnector.NewProtocolError(remoteconnector.CodeInvalidPayload, "job cursor is ahead of the recorded output")
	}
	remaining := info.Size() - offset
	if remaining <= 0 || limit <= 0 {
		return nil, offset, nil
	}
	if int64(limit) < remaining {
		remaining = int64(limit)
	}
	buffer := make([]byte, remaining)
	if _, err := file.ReadAt(buffer, offset); err != nil && !errors.Is(err, io.EOF) {
		return nil, offset, remoteconnector.NewProtocolError(remoteconnector.CodeInternal, "job output is unavailable")
	}
	return buffer, offset + int64(len(buffer)), nil
}

func readJSONMeta(path string) (jobMeta, error) {
	var meta jobMeta
	raw, err := os.ReadFile(path)
	if err != nil {
		return meta, err
	}
	if err := json.Unmarshal(raw, &meta); err != nil {
		return meta, err
	}
	return meta, nil
}

func readJSONStatus(path string) (jobStatus, bool) {
	var status jobStatus
	raw, err := os.ReadFile(path)
	if err != nil {
		return status, false
	}
	if err := json.Unmarshal(raw, &status); err != nil {
		return status, false
	}
	return status, true
}

func writeJSONFile(path string, value any) error {
	encoded, err := json.Marshal(value)
	if err != nil {
		return err
	}
	temp := fmt.Sprintf("%s.tmp-%d", path, time.Now().UnixNano())
	if err := os.WriteFile(temp, encoded, 0o600); err != nil {
		return err
	}
	return os.Rename(temp, path)
}
