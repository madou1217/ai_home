package acpclient

import (
	"context"
	"fmt"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
)

// ConnectorHost exposes a local Connector workspace through the ACP
// FileSystem/TerminalHost interfaces. The agent thinks it is working under
// root (the Server-side shadow); every path is translated to a workspace-
// relative path before it reaches the Connector.
type ConnectorHost struct {
	root   string
	client ToolClient

	nextTerminalID atomic.Uint64
	mu             sync.Mutex
	terminals      map[string]*connectorTerminal
}

type connectorTerminal struct {
	jobID     string
	cursor    string
	output    strings.Builder
	limit     int64
	truncated bool
	done      bool
	exitCode  *int64
	signal    string
}

func NewConnectorHost(root string, client ToolClient) (*ConnectorHost, error) {
	if strings.TrimSpace(root) == "" {
		return nil, fmt.Errorf("connector shadow root is required")
	}
	if client == nil {
		return nil, fmt.Errorf("workspace tool client is required")
	}
	abs, err := filepath.Abs(root)
	if err != nil {
		return nil, fmt.Errorf("resolve connector shadow root: %w", err)
	}
	return &ConnectorHost{
		root:      filepath.Clean(abs),
		client:    client,
		terminals: map[string]*connectorTerminal{},
	}, nil
}

func (host *ConnectorHost) Root() string { return host.root }

func (host *ConnectorHost) relative(path string) (string, error) {
	if !filepath.IsAbs(path) {
		return "", fmt.Errorf("%w: path must be absolute: %s", ErrPathOutsideWorkspace, path)
	}
	rel, err := filepath.Rel(host.root, filepath.Clean(path))
	if err != nil {
		return "", fmt.Errorf("%w: %s", ErrPathOutsideWorkspace, path)
	}
	if rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
		return "", fmt.Errorf("%w: %s", ErrPathOutsideWorkspace, path)
	}
	return filepath.ToSlash(rel), nil
}

func (host *ConnectorHost) ReadTextFile(ctx context.Context, path string, line, limit *int64) (string, error) {
	rel, err := host.relative(path)
	if err != nil {
		return "", err
	}
	args := map[string]any{"path": rel}
	if line != nil && *line > 0 {
		args["offset"] = *line
	}
	if limit != nil && *limit > 0 {
		args["limit"] = *limit
	}
	result, err := host.client.Call(ctx, "read_file", args)
	if err != nil {
		return "", err
	}
	if result.IsError {
		return "", fmt.Errorf("read_file: %s", strings.TrimSpace(result.Text))
	}
	_, body, err := parseReadFile(result.Text)
	if err != nil {
		return "", err
	}
	return body, nil
}

func (host *ConnectorHost) WriteTextFile(ctx context.Context, path, content string) error {
	rel, err := host.relative(path)
	if err != nil {
		return err
	}
	// ACP has no version token. Read first so the Connector can reject a
	// concurrent modification instead of silently overwriting it.
	version := ""
	if read, readErr := host.client.Call(ctx, "read_file", map[string]any{"path": rel}); readErr == nil && !read.IsError {
		version, _, _ = parseReadFile(read.Text)
	}
	result, err := host.client.Call(ctx, "write_file", map[string]any{
		"path":             rel,
		"content":          content,
		"expected_version": version,
	})
	if err != nil {
		return err
	}
	if result.IsError {
		return fmt.Errorf("write_file: %s", strings.TrimSpace(result.Text))
	}
	return nil
}

func (host *ConnectorHost) Create(ctx context.Context, spec TerminalSpec) (string, error) {
	cwd := spec.Cwd
	if strings.TrimSpace(cwd) == "" {
		cwd = host.root
	}
	relCwd, err := host.relative(cwd)
	if err != nil {
		return "", err
	}
	if relCwd == "" {
		relCwd = "."
	}
	command := joinCommand(spec.Command, spec.Args)
	result, err := host.client.Call(ctx, "start_job", map[string]any{
		"command": command,
		"cwd":     relCwd,
	})
	if err != nil {
		return "", err
	}
	if result.IsError {
		return "", fmt.Errorf("start_job: %s", strings.TrimSpace(result.Text))
	}
	jobID, cursor, err := parseJobStart(result.Text)
	if err != nil {
		return "", err
	}
	limit := int64(defaultTerminalOutputLimit)
	if spec.OutputByteLimit != nil && *spec.OutputByteLimit > 0 {
		limit = *spec.OutputByteLimit
	}
	terminal := &connectorTerminal{jobID: jobID, cursor: cursor, limit: limit}
	id := fmt.Sprintf("acp-connector-%d", host.nextTerminalID.Add(1))
	host.mu.Lock()
	host.terminals[id] = terminal
	host.mu.Unlock()
	return id, nil
}

func (host *ConnectorHost) terminal(id string) (*connectorTerminal, error) {
	host.mu.Lock()
	defer host.mu.Unlock()
	terminal, ok := host.terminals[id]
	if !ok {
		return nil, fmt.Errorf("unknown terminal: %s", id)
	}
	return terminal, nil
}

func (host *ConnectorHost) Output(ctx context.Context, terminalID string) (TerminalOutput, error) {
	terminal, err := host.terminal(terminalID)
	if err != nil {
		return TerminalOutput{}, err
	}
	if !terminal.done {
		_ = host.readJob(ctx, terminal, 1)
	}
	return terminal.snapshot(), nil
}

func (host *ConnectorHost) Wait(ctx context.Context, terminalID string) (TerminalExit, error) {
	terminal, err := host.terminal(terminalID)
	if err != nil {
		return TerminalExit{}, err
	}
	for !terminal.done {
		select {
		case <-ctx.Done():
			return TerminalExit{}, ctx.Err()
		default:
		}
		if err := host.readJob(ctx, terminal, 10000); err != nil {
			return TerminalExit{}, err
		}
	}
	return TerminalExit{ExitCode: terminal.exitCode, Signal: terminal.signal}, nil
}

func (host *ConnectorHost) Kill(ctx context.Context, terminalID string) error {
	terminal, err := host.terminal(terminalID)
	if err != nil {
		return err
	}
	result, err := host.client.Call(ctx, "interrupt_job", map[string]any{"job_id": terminal.jobID})
	if err != nil {
		return err
	}
	if result.IsError {
		return fmt.Errorf("interrupt_job: %s", strings.TrimSpace(result.Text))
	}
	return nil
}

func (host *ConnectorHost) Release(ctx context.Context, terminalID string) error {
	host.mu.Lock()
	terminal, ok := host.terminals[terminalID]
	if ok {
		delete(host.terminals, terminalID)
	}
	host.mu.Unlock()
	if !ok {
		return nil
	}
	if !terminal.done {
		_, _ = host.client.Call(ctx, "interrupt_job", map[string]any{"job_id": terminal.jobID})
	}
	return nil
}

func (host *ConnectorHost) readJob(ctx context.Context, terminal *connectorTerminal, waitMS int64) error {
	result, err := host.client.Call(ctx, "watch_job", map[string]any{
		"job_id":  terminal.jobID,
		"cursor":  terminal.cursor,
		"wait_ms": waitMS,
	})
	if err != nil {
		return err
	}
	if result.IsError {
		return fmt.Errorf("watch_job: %s", strings.TrimSpace(result.Text))
	}
	watch, err := parseJobWatch(result.Text)
	if err != nil {
		return err
	}
	terminal.cursor = watch.cursor
	if watch.state != "" && watch.state != "running" {
		terminal.done = true
		terminal.exitCode = watch.exitCode
		terminal.signal = watch.signal
	}
	terminal.append(watch.stdout + watch.stderr)
	if watch.truncated {
		terminal.truncated = true
	}
	return nil
}

func (terminal *connectorTerminal) append(text string) {
	if text == "" {
		return
	}
	terminal.output.WriteString(text)
	if terminal.limit > 0 && int64(terminal.output.Len()) > terminal.limit {
		data := terminal.output.String()
		terminal.output.Reset()
		terminal.output.WriteString(data[int64(len(data))-terminal.limit:])
		terminal.truncated = true
	}
}

func (terminal *connectorTerminal) snapshot() TerminalOutput {
	return TerminalOutput{
		Output:    terminal.output.String(),
		Truncated: terminal.truncated,
		ExitCode:  terminal.exitCode,
		Signal:    terminal.signal,
	}
}

func joinCommand(command string, args []string) string {
	if len(args) == 0 {
		return command
	}
	parts := make([]string, 0, len(args)+1)
	parts = append(parts, shellQuote(command))
	for _, arg := range args {
		parts = append(parts, shellQuote(arg))
	}
	return strings.Join(parts, " ")
}

func shellQuote(value string) string {
	if value == "" {
		return "''"
	}
	return "'" + strings.ReplaceAll(value, "'", "'\"'\"'") + "'"
}

type jobWatch struct {
	state     string
	cursor    string
	stdout    string
	stderr    string
	exitCode  *int64
	signal    string
	truncated bool
}

func parseReadFile(text string) (string, string, error) {
	lines := strings.Split(strings.ReplaceAll(text, "\r\n", "\n"), "\n")
	if len(lines) < 2 || !strings.HasPrefix(lines[0], "version:") || !strings.HasPrefix(lines[1], "lines:") {
		return "", "", fmt.Errorf("read_file returned an unexpected result")
	}
	version := strings.TrimSpace(strings.TrimPrefix(lines[0], "version:"))
	bodyLines := make([]string, 0, len(lines)-2)
	for _, line := range lines[2:] {
		if line == "" {
			continue
		}
		if index := strings.IndexByte(line, '|'); index >= 0 {
			line = line[index+1:]
		}
		bodyLines = append(bodyLines, line)
	}
	return version, strings.Join(bodyLines, "\n"), nil
}

func parseJobStart(text string) (string, string, error) {
	jobID := lineValue(text, "job:")
	cursor := lineValue(text, "cursor:")
	if jobID == "" {
		return "", "", fmt.Errorf("start_job returned no job id")
	}
	if cursor == "" {
		cursor = "0:0"
	}
	return jobID, cursor, nil
}

func parseJobWatch(text string) (jobWatch, error) {
	watch := jobWatch{
		state:  lineValue(text, "state:"),
		cursor: lineValue(text, "cursor:"),
	}
	if watch.cursor == "" {
		return jobWatch{}, fmt.Errorf("watch_job returned no cursor")
	}
	if code := lineValue(text, "exit code:"); code != "" {
		fields := strings.Fields(code)
		if len(fields) > 0 {
			if parsed, err := strconv.ParseInt(fields[0], 10, 64); err == nil {
				watch.exitCode = &parsed
			}
		}
	}
	if strings.Contains(text, "部分旧输出已被丢弃") || strings.Contains(text, "输出超过 8 MiB") {
		watch.truncated = true
	}
	stdout, stderr := splitJobOutput(text)
	watch.stdout = stdout
	watch.stderr = stderr
	return watch, nil
}

func splitJobOutput(text string) (string, string) {
	const stdoutMarker = "\nstdout:\n"
	const stderrMarker = "\nstderr:\n"
	stdout, stderr := "", ""
	if index := strings.Index(text, stdoutMarker); index >= 0 {
		rest := text[index+len(stdoutMarker):]
		if stderrIndex := strings.Index(rest, stderrMarker); stderrIndex >= 0 {
			stdout = rest[:stderrIndex]
			stderr = rest[stderrIndex+len(stderrMarker):]
		} else {
			stdout = rest
		}
	} else if index := strings.Index(text, stderrMarker); index >= 0 {
		stderr = text[index+len(stderrMarker):]
	}
	return stdout, stderr
}

func lineValue(text, prefix string) string {
	for _, line := range strings.Split(strings.ReplaceAll(text, "\r\n", "\n"), "\n") {
		if strings.HasPrefix(line, prefix) {
			return strings.TrimSpace(strings.TrimPrefix(line, prefix))
		}
	}
	return ""
}
