package workspaceconnector

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"os/exec"
	"strings"
	"sync"
	"time"

	"github.com/madou1217/ai_home/internal/remoteconnector"
)

const (
	maxJobs          = 16
	maxRunningJobs   = 4
	jobBufferBytes   = 512 * 1024
	jobChunkBytes    = 128 * 1024
	jobInterruptWait = 2 * time.Second
)

// jobManager owns detached commands on the local connector. A job is not tied
// to the RPC or the Server session that started it; it lives in this process.
type jobManager struct {
	files *filesystem

	mu    sync.Mutex
	jobs  map[string]*job
	order []string
}

type job struct {
	id        string
	cwd       string
	startedAt time.Time
	process   *exec.Cmd

	mu          sync.Mutex
	state       string
	exitCode    int
	endedAt     time.Time
	interrupted bool
	notifyCh    chan struct{}
	stdout      *jobStream
	stderr      *jobStream
}

func newJobManager(files *filesystem) *jobManager {
	return &jobManager{files: files, jobs: make(map[string]*job)}
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

	timeout := remoteconnector.JobTimeout(request.TimeoutMS)
	runCtx, cancel := context.WithTimeout(context.Background(), timeout)
	stdout := newJobStream(jobBufferBytes)
	stderr := newJobStream(jobBufferBytes)
	shell, shellArgs := commandShell(command)
	process := exec.CommandContext(runCtx, shell, shellArgs...)
	process.Dir = cwd
	process.WaitDelay = commandKillGrace
	configureCommand(process)

	job := &job{
		id: newJobID(), cwd: cwd, startedAt: time.Now(), process: process,
		state: remoteconnector.JobRunning, notifyCh: make(chan struct{}),
		stdout: stdout, stderr: stderr,
	}
	process.Stdout = jobStreamWriter{job: job, target: stdout}
	process.Stderr = jobStreamWriter{job: job, target: stderr}
	if err := process.Start(); err != nil {
		cancel()
		return remoteconnector.StartJobResult{}, remoteconnector.NewProtocolError(remoteconnector.CodeInternal, "job could not be started")
	}

	manager.mu.Lock()
	manager.jobs[job.id] = job
	manager.order = append(manager.order, job.id)
	manager.evictLocked()
	manager.mu.Unlock()

	go func() {
		waitErr := process.Wait()
		job.finish(waitErr, runCtx.Err() == context.DeadlineExceeded)
		cancel()
	}()

	return remoteconnector.StartJobResult{
		JobID: job.id, State: remoteconnector.JobRunning, Cwd: displayPath(manager.files.sandbox.root, cwd),
		StdoutStart: 0, StderrStart: 0, StartedAt: job.startedAt.UnixMilli(),
	}, nil
}

func (manager *jobManager) watch(request remoteconnector.WatchJobRequest) (remoteconnector.WatchJobResult, error) {
	job := manager.find(request.JobID)
	if job == nil {
		return remoteconnector.WatchJobResult{}, remoteconnector.NewProtocolError(remoteconnector.CodeJobNotFound, "job does not exist")
	}
	if request.StdoutOffset < 0 || request.StderrOffset < 0 {
		return remoteconnector.WatchJobResult{}, remoteconnector.NewProtocolError(remoteconnector.CodeInvalidPayload, "job cursor must not be negative")
	}
	deadline := time.Now().Add(remoteconnector.JobWait(request.WaitMS))
	for {
		job.mu.Lock()
		if request.StdoutOffset > job.stdout.Written() || request.StderrOffset > job.stderr.Written() {
			job.mu.Unlock()
			return remoteconnector.WatchJobResult{}, remoteconnector.NewProtocolError(remoteconnector.CodeInvalidPayload, "job cursor is ahead of the recorded output")
		}
		result, fresh := job.snapshotLocked(request)
		waiting := !fresh && job.state == remoteconnector.JobRunning && time.Now().Before(deadline)
		if !waiting {
			job.mu.Unlock()
			return result, nil
		}
		changed := job.notifyCh
		job.mu.Unlock()

		timer := time.NewTimer(time.Until(deadline))
		select {
		case <-changed:
		case <-timer.C:
		}
		timer.Stop()
	}
}

func (manager *jobManager) interrupt(request remoteconnector.InterruptJobRequest) (remoteconnector.InterruptJobResult, error) {
	job := manager.find(request.JobID)
	if job == nil {
		return remoteconnector.InterruptJobResult{}, remoteconnector.NewProtocolError(remoteconnector.CodeJobNotFound, "job does not exist")
	}
	job.mu.Lock()
	if job.state != remoteconnector.JobRunning {
		state := job.state
		job.mu.Unlock()
		return remoteconnector.InterruptJobResult{JobID: job.id, State: state}, nil
	}
	job.interrupted = true
	process := job.process
	job.mu.Unlock()

	forced := terminateCommand(process) == nil
	deadline := time.Now().Add(jobInterruptWait)
	for {
		job.mu.Lock()
		if job.state != remoteconnector.JobRunning {
			state := job.state
			job.mu.Unlock()
			return remoteconnector.InterruptJobResult{JobID: job.id, State: state, Forced: forced}, nil
		}
		if time.Now().After(deadline) {
			job.mu.Unlock()
			return remoteconnector.InterruptJobResult{JobID: job.id, State: remoteconnector.JobRunning, Forced: forced}, nil
		}
		changed := job.notifyCh
		job.mu.Unlock()
		select {
		case <-changed:
		case <-time.After(50 * time.Millisecond):
		}
	}
}

func (manager *jobManager) find(jobID string) *job {
	jobID = strings.TrimSpace(jobID)
	if jobID == "" {
		return nil
	}
	manager.mu.Lock()
	defer manager.mu.Unlock()
	return manager.jobs[jobID]
}

func (manager *jobManager) running() int {
	manager.mu.Lock()
	defer manager.mu.Unlock()
	count := 0
	for _, job := range manager.jobs {
		job.mu.Lock()
		if job.state == remoteconnector.JobRunning {
			count++
		}
		job.mu.Unlock()
	}
	return count
}

// evictLocked drops the oldest finished jobs; running jobs are never evicted.
func (manager *jobManager) evictLocked() {
	for len(manager.order) > maxJobs {
		id := manager.order[0]
		victim := manager.jobs[id]
		if victim == nil {
			manager.order = manager.order[1:]
			continue
		}
		victim.mu.Lock()
		running := victim.state == remoteconnector.JobRunning
		victim.mu.Unlock()
		if running {
			break
		}
		delete(manager.jobs, id)
		manager.order = manager.order[1:]
	}
}

func (job *job) finish(waitErr error, timedOut bool) {
	job.mu.Lock()
	defer job.mu.Unlock()
	job.endedAt = time.Now()
	var exitErr *exec.ExitError
	switch {
	case job.interrupted:
		job.state = remoteconnector.JobInterrupted
		job.exitCode = -1
	case timedOut:
		job.state = remoteconnector.JobTimedOut
		job.exitCode = -1
	case errors.As(waitErr, &exitErr):
		job.state = remoteconnector.JobExited
		job.exitCode = exitErr.ExitCode()
	case waitErr != nil:
		job.state = remoteconnector.JobFailed
		job.exitCode = -1
	default:
		job.state = remoteconnector.JobExited
		job.exitCode = 0
	}
	job.notifyLocked()
}

func (job *job) notify() {
	job.mu.Lock()
	job.notifyLocked()
	job.mu.Unlock()
}

func (job *job) notifyLocked() {
	close(job.notifyCh)
	job.notifyCh = make(chan struct{})
}

func (job *job) snapshotLocked(request remoteconnector.WatchJobRequest) (remoteconnector.WatchJobResult, bool) {
	stdout, stdoutNext, stdoutDropped := job.stdout.ReadFrom(request.StdoutOffset, jobChunkBytes)
	stderr, stderrNext, stderrDropped := job.stderr.ReadFrom(request.StderrOffset, jobChunkBytes)
	duration := job.endedAt.Sub(job.startedAt)
	if job.endedAt.IsZero() {
		duration = time.Since(job.startedAt)
	}
	result := remoteconnector.WatchJobResult{
		JobID: job.id, State: job.state, ExitCode: job.exitCode,
		Stdout:       base64.StdEncoding.EncodeToString(stdout),
		Stderr:       base64.StdEncoding.EncodeToString(stderr),
		Encoding:     "base64",
		StdoutOffset: stdoutNext, StderrOffset: stderrNext,
		Dropped:   stdoutDropped || stderrDropped,
		StartedAt: job.startedAt.UnixMilli(), DurationMS: duration.Milliseconds(),
	}
	if !job.endedAt.IsZero() {
		result.EndedAt = job.endedAt.UnixMilli()
	}
	return result, len(stdout) > 0 || len(stderr) > 0
}

// jobStreamWriter feeds process output into the job ring and wakes watchers.
type jobStreamWriter struct {
	job    *job
	target *jobStream
}

func (writer jobStreamWriter) Write(chunk []byte) (int, error) {
	writer.job.mu.Lock()
	_, _ = writer.target.Write(chunk)
	writer.job.notifyLocked()
	writer.job.mu.Unlock()
	return len(chunk), nil
}

// jobStream keeps the last capacity bytes of one output stream. Written is the
// absolute byte count, so cursors survive trimming of old bytes.
type jobStream struct {
	buffer  []byte
	start   int
	size    int
	written int64
}

func newJobStream(capacity int) *jobStream {
	return &jobStream{buffer: make([]byte, capacity)}
}

func (stream *jobStream) Written() int64 { return stream.written }

func (stream *jobStream) Write(chunk []byte) (int, error) {
	if len(chunk) == 0 {
		return 0, nil
	}
	capacity := len(stream.buffer)
	stream.written += int64(len(chunk))
	if len(chunk) >= capacity {
		copy(stream.buffer, chunk[len(chunk)-capacity:])
		stream.start = 0
		stream.size = capacity
		return len(chunk), nil
	}
	for _, value := range chunk {
		index := (stream.start + stream.size) % capacity
		if stream.size < capacity {
			stream.buffer[index] = value
			stream.size++
			continue
		}
		stream.buffer[stream.start] = value
		stream.start = (stream.start + 1) % capacity
	}
	return len(chunk), nil
}

// ReadFrom returns up to limit bytes after offset. dropped reports that the
// offset was older than the retained window.
func (stream *jobStream) ReadFrom(offset int64, limit int) ([]byte, int64, bool) {
	capacity := len(stream.buffer)
	first := stream.written - int64(stream.size)
	dropped := offset < first
	if dropped {
		offset = first
	}
	if offset > stream.written || limit <= 0 {
		return nil, offset, dropped
	}
	index := (stream.start + int(offset-first)) % capacity
	remaining := int(stream.written - offset)
	if remaining > limit {
		remaining = limit
	}
	chunk := make([]byte, 0, remaining)
	for len(chunk) < remaining {
		size := capacity - index
		if size > remaining-len(chunk) {
			size = remaining - len(chunk)
		}
		chunk = append(chunk, stream.buffer[index:index+size]...)
		index = (index + size) % capacity
	}
	return chunk, offset + int64(len(chunk)), dropped
}

func newJobID() string {
	buffer := make([]byte, 9)
	if _, err := rand.Read(buffer); err != nil {
		return "job-000000000000000000"
	}
	return "job-" + hex.EncodeToString(buffer)
}
