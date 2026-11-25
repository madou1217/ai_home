package acpclient

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
)

// ErrPathOutsideWorkspace is returned for any path that escapes the configured
// workspace root, including through a symlink.
var ErrPathOutsideWorkspace = errors.New("path outside workspace")

const defaultTerminalOutputLimit = 256 * 1024

// LocalWorkspaceHost is a workspace-confined FileSystem + TerminalHost.
// It is intentionally small: protocol translation lives in Client, not here.
type LocalWorkspaceHost struct {
	root string

	nextTerminalID atomic.Uint64
	mu             sync.Mutex
	terminals      map[string]*localTerminal
}

func NewLocalWorkspaceHost(root string) (*LocalWorkspaceHost, error) {
	if strings.TrimSpace(root) == "" {
		return nil, fmt.Errorf("workspace root is required")
	}
	abs, err := filepath.Abs(root)
	if err != nil {
		return nil, fmt.Errorf("resolve workspace root: %w", err)
	}
	real, err := filepath.EvalSymlinks(abs)
	if err != nil {
		return nil, fmt.Errorf("resolve workspace root symlinks: %w", err)
	}
	return &LocalWorkspaceHost{root: filepath.Clean(real), terminals: map[string]*localTerminal{}}, nil
}

func (host *LocalWorkspaceHost) Root() string { return host.root }

func (host *LocalWorkspaceHost) resolvePath(path string, forWrite bool) (string, error) {
	if !filepath.IsAbs(path) {
		return "", fmt.Errorf("%w: path must be absolute: %s", ErrPathOutsideWorkspace, path)
	}
	clean := filepath.Clean(path)
	// Resolve the existing part first: /var and /private/var (macOS) point to
	// the same directory, so comparing the unresolved path with the canonical
	// root would reject valid workspace paths.
	// Writes may target a new file, so resolve the parent directory instead of
	// the leaf.
	candidate := clean
	if forWrite {
		candidate = filepath.Dir(clean)
	}
	real, err := filepath.EvalSymlinks(candidate)
	if err != nil {
		if forWrite && errors.Is(err, os.ErrNotExist) {
			// A missing parent is fine only if its existing ancestor is inside
			// the root; MkdirAll below will create the missing part.
			real, err = evalExistingAncestor(host.root, candidate)
			if err != nil {
				return "", err
			}
		} else {
			return "", fmt.Errorf("resolve path: %w", err)
		}
	}
	if !isWithin(host.root, real) {
		return "", fmt.Errorf("%w: %s", ErrPathOutsideWorkspace, path)
	}
	return clean, nil
}

func evalExistingAncestor(root, path string) (string, error) {
	current := path
	for {
		real, err := filepath.EvalSymlinks(current)
		if err == nil {
			return real, nil
		}
		if !errors.Is(err, os.ErrNotExist) {
			return "", fmt.Errorf("resolve path: %w", err)
		}
		parent := filepath.Dir(current)
		if parent == current {
			return "", fmt.Errorf("%w: %s", ErrPathOutsideWorkspace, path)
		}
		current = parent
	}
}

func isWithin(root, candidate string) bool {
	rel, err := filepath.Rel(root, candidate)
	if err != nil {
		return false
	}
	return rel == "." || (rel != ".." && !strings.HasPrefix(rel, ".."+string(os.PathSeparator)))
}

func (host *LocalWorkspaceHost) ReadTextFile(_ context.Context, path string, line, limit *int64) (string, error) {
	resolved, err := host.resolvePath(path, false)
	if err != nil {
		return "", err
	}
	content, err := os.ReadFile(resolved)
	if err != nil {
		return "", fmt.Errorf("read file: %w", err)
	}
	text := string(content)
	if line == nil && limit == nil {
		return text, nil
	}
	lines := strings.Split(text, "\n")
	start := int64(0)
	if line != nil && *line > 0 {
		start = *line - 1
	}
	if start > int64(len(lines)) {
		start = int64(len(lines))
	}
	end := int64(len(lines))
	if limit != nil && *limit > 0 && start+*limit < end {
		end = start + *limit
	}
	return strings.Join(lines[start:end], "\n"), nil
}

func (host *LocalWorkspaceHost) WriteTextFile(_ context.Context, path, content string) error {
	resolved, err := host.resolvePath(path, true)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(resolved), 0o755); err != nil {
		return fmt.Errorf("create parent directory: %w", err)
	}
	if err := os.WriteFile(resolved, []byte(content), 0o644); err != nil {
		return fmt.Errorf("write file: %w", err)
	}
	return nil
}

func (host *LocalWorkspaceHost) Create(ctx context.Context, spec TerminalSpec) (string, error) {
	if strings.TrimSpace(spec.Command) == "" {
		return "", fmt.Errorf("terminal command is required")
	}
	cwd := spec.Cwd
	if strings.TrimSpace(cwd) == "" {
		cwd = host.root
	}
	resolvedCwd, err := host.resolvePath(cwd, false)
	if err != nil {
		return "", err
	}
	info, err := os.Stat(resolvedCwd)
	if err != nil {
		return "", fmt.Errorf("terminal cwd: %w", err)
	}
	if !info.IsDir() {
		return "", fmt.Errorf("terminal cwd is not a directory: %s", resolvedCwd)
	}

	command := exec.CommandContext(context.Background(), spec.Command, spec.Args...)
	command.Dir = resolvedCwd
	command.Env = append(os.Environ(), spec.Env...)
	configureCommand(command)
	limit := int64(defaultTerminalOutputLimit)
	if spec.OutputByteLimit != nil && *spec.OutputByteLimit > 0 {
		limit = *spec.OutputByteLimit
	}
	terminal := &localTerminal{
		command: command,
		output:  newBoundedBuffer(limit),
		done:    make(chan struct{}),
	}
	command.Stdout = terminal.output
	command.Stderr = terminal.output
	if err := command.Start(); err != nil {
		return "", fmt.Errorf("start terminal: %w", err)
	}
	go terminal.wait()

	id := fmt.Sprintf("acp-term-%d", host.nextTerminalID.Add(1))
	host.mu.Lock()
	host.terminals[id] = terminal
	host.mu.Unlock()
	return id, nil
}

func (host *LocalWorkspaceHost) terminal(id string) (*localTerminal, error) {
	host.mu.Lock()
	defer host.mu.Unlock()
	terminal, ok := host.terminals[id]
	if !ok {
		return nil, fmt.Errorf("unknown terminal: %s", id)
	}
	return terminal, nil
}

func (host *LocalWorkspaceHost) Output(_ context.Context, terminalID string) (TerminalOutput, error) {
	terminal, err := host.terminal(terminalID)
	if err != nil {
		return TerminalOutput{}, err
	}
	return terminal.snapshot(), nil
}

func (host *LocalWorkspaceHost) Wait(ctx context.Context, terminalID string) (TerminalExit, error) {
	terminal, err := host.terminal(terminalID)
	if err != nil {
		return TerminalExit{}, err
	}
	select {
	case <-terminal.done:
		return terminal.exit(), nil
	case <-ctx.Done():
		return TerminalExit{}, ctx.Err()
	}
}

func (host *LocalWorkspaceHost) Kill(_ context.Context, terminalID string) error {
	terminal, err := host.terminal(terminalID)
	if err != nil {
		return err
	}
	terminal.kill()
	return nil
}

func (host *LocalWorkspaceHost) Release(_ context.Context, terminalID string) error {
	host.mu.Lock()
	terminal, ok := host.terminals[terminalID]
	if ok {
		delete(host.terminals, terminalID)
	}
	host.mu.Unlock()
	if !ok {
		return nil
	}
	terminal.kill()
	return nil
}

type localTerminal struct {
	command *exec.Cmd
	output  *boundedBuffer
	done    chan struct{}
	once    sync.Once

	mu       sync.Mutex
	exitCode *int64
	signal   string
	waitErr  error
}

func (terminal *localTerminal) wait() {
	defer close(terminal.done)
	err := terminal.command.Wait()
	code, signal := terminalExitStatus(terminal.command.ProcessState)
	terminal.mu.Lock()
	terminal.exitCode = code
	terminal.signal = signal
	terminal.waitErr = err
	terminal.mu.Unlock()
}

func (terminal *localTerminal) snapshot() TerminalOutput {
	terminal.mu.Lock()
	code := terminal.exitCode
	signal := terminal.signal
	terminal.mu.Unlock()
	output, truncated := terminal.output.snapshot()
	return TerminalOutput{Output: output, Truncated: truncated, ExitCode: code, Signal: signal}
}

func (terminal *localTerminal) exit() TerminalExit {
	terminal.mu.Lock()
	defer terminal.mu.Unlock()
	return TerminalExit{ExitCode: terminal.exitCode, Signal: terminal.signal}
}

func (terminal *localTerminal) kill() {
	terminal.once.Do(func() {
		_ = terminateCommand(terminal.command)
	})
}

type boundedBuffer struct {
	mu        sync.Mutex
	buffer    bytes.Buffer
	limit     int64
	truncated bool
}

func newBoundedBuffer(limit int64) *boundedBuffer {
	if limit <= 0 {
		limit = defaultTerminalOutputLimit
	}
	return &boundedBuffer{limit: limit}
}

func (buffer *boundedBuffer) Write(chunk []byte) (int, error) {
	buffer.mu.Lock()
	defer buffer.mu.Unlock()
	if _, err := buffer.buffer.Write(chunk); err != nil {
		return 0, err
	}
	if int64(buffer.buffer.Len()) > buffer.limit {
		data := buffer.buffer.Bytes()
		keep := len(data) - int(buffer.limit)
		trimmed := append([]byte(nil), data[keep:]...)
		buffer.buffer.Reset()
		_, _ = buffer.buffer.Write(trimmed)
		buffer.truncated = true
	}
	return len(chunk), nil
}

func (buffer *boundedBuffer) snapshot() (string, bool) {
	buffer.mu.Lock()
	defer buffer.mu.Unlock()
	return buffer.buffer.String(), buffer.truncated
}
