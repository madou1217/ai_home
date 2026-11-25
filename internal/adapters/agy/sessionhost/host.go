// Package sessionhost 管理「一条需求一个常驻 AGY 进程」。
//
// 与一次性 `agy --print "<prompt>"` 不同，这里启动的是
// `agy --print= --input-format stream-json --output-format stream-json`：
// 进程只启动一次，之后按行写入 {"event":"user",...} 即可连续跑多轮，
// 同一进程内保持同一 conversation。进程退出后可用 --conversation 续接，
// 因此会话状态（conversation id）必须由调用方持久化。
//
// 本包只负责进程与协议，不负责持久化、HTTP 或 peer 投递。
package sessionhost

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/madou1217/ai_home/internal/adapters/sshhost"
)

const (
	// MaxQueueDepth 是同一会话排队等待的轮数上限；超出直接拒绝，不静默丢消息。
	MaxQueueDepth = 8
	// defaultLineLimit 是单行 NDJSON 的上限（工具输出事件可能很长）。
	defaultLineLimit = 8 << 20
	// maxRetainedEvents 是宿主为每个会话保留的事件上限（游标读取用）。
	maxRetainedEvents = 4000
)

// SSHTransport 描述在远端主机执行 agy 的连接参数。
type SSHTransport struct {
	Host         string `json:"host"`
	User         string `json:"user"`
	Port         int    `json:"port"`
	IdentityFile string `json:"identityFile"`
}

// Spec 是一次会话启动所需的全部事实。
type Spec struct {
	// SessionID 是宿主内稳定标识，仅用于日志与文件名，不进入命令行。
	SessionID string
	// Binary 为 agy 可执行文件；远端留空时用 $HOME/.local/bin/agy。
	Binary string
	// WorkDir 是 agy 的工作目录（项目根）。
	WorkDir string
	// HomeDir 是 agy 的 HOME（账号投影目录）；远端留空表示不改 HOME。
	HomeDir string
	// Model 是 CLI 模型名（已由 catalog 映射过）。
	Model string
	// Effort 可选：low|medium|high|xhigh|max。
	Effort string
	// ConversationID 非空时用 --conversation 续接既有会话。
	ConversationID string
	// SSH 非空时在远端执行；否则在本机直接执行。
	SSH *SSHTransport
	// ResumeOffset 是远端 out.ndjson 的字节偏移；>0 时从该位置继续消费（Server 重启后续接）。
	ResumeOffset int64
}

// TurnState 是一轮对话的生命周期状态。
type TurnState string

const (
	TurnQueued  TurnState = "queued"
	TurnRunning TurnState = "running"
	TurnDone    TurnState = "done"
	TurnFailed  TurnState = "failed"
)

// Turn 是一轮用户输入及其产出。
type Turn struct {
	ID         int64     `json:"id"`
	Prompt     string    `json:"prompt"`
	State      TurnState `json:"state"`
	Reply      string    `json:"reply"`
	Error      string    `json:"error"`
	PeerID     string    `json:"peerMessageId,omitempty"`
	StartedAt  int64     `json:"startedAt,omitempty"`
	FinishedAt int64     `json:"finishedAt,omitempty"`
}

// Event 是供游标读取的增量事件。
type Event struct {
	Seq    int64  `json:"seq"`
	TurnID int64  `json:"turnId"`
	Kind   string `json:"kind"` // turn-start | delta | result | process | error
	Text   string `json:"text,omitempty"`
	Status string `json:"status,omitempty"`
	Tool   string `json:"tool,omitempty"`
	At     int64  `json:"at"`
}

// Sink 接收宿主产生的事件；实现必须快速返回（宿主在读取协程中调用）。
type Sink func(Event)

// Process 是一个常驻 agy 进程；同一时刻只跑一轮，其余排队。
type Process struct {
	spec Spec

	mu           sync.Mutex
	cmd          *exec.Cmd
	stdin        io.WriteCloser
	alive        bool
	starting     bool
	closed       bool
	conversation string
	queue        []*Turn
	current      *Turn
	nextTurnID   int64
	stderrTail   string

	events       []Event
	nextEvent    int64
	sink         Sink
	writerWake   chan struct{}
	done         chan struct{}
	remote       *remoteSession
	followerCtx  context.CancelFunc
	remoteOffset int64
}

// New 创建一个未启动的会话宿主。
func New(spec Spec) *Process {
	proc := &Process{
		spec:       spec,
		writerWake: make(chan struct{}, 1),
		done:       make(chan struct{}),
	}
	if isRemoteSpec(spec) {
		proc.remote = newRemoteSession(spec)
	}
	return proc
}

// ConversationID 返回当前 agy conversation id（未初始化时为空）。
func (p *Process) ConversationID() string {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.conversation
}

// Alive 报告进程当前是否可接受新轮。
func (p *Process) Alive() bool {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.alive && !p.closed
}

// CurrentTurn 返回正在执行的一轮（空闲时为 nil）。
func (p *Process) CurrentTurn() *Turn {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.current == nil {
		return nil
	}
	copy := *p.current
	return &copy
}

// EnsureStarted 启动进程（幂等）。调用方负责在失败时决定是否重试。
func (p *Process) EnsureStarted(ctx context.Context) error {
	p.mu.Lock()
	if p.closed {
		p.mu.Unlock()
		return errors.New("agy_session_closed")
	}
	// 管道模式保持原短路；远端模式的 alive 只代表「上次探测结论」，必须重新探测，
	// 否则远端 tmux 已被杀掉时这里会误判为健康、跳过后面的重启。
	if p.starting || (p.alive && p.remote == nil) {
		p.mu.Unlock()
		return nil
	}
	p.starting = true
	conversation := p.conversation
	remote := p.remote
	p.mu.Unlock()

	var err error
	if remote != nil {
		err = p.ensureRemoteStarted(ctx, remote, conversation)
	} else {
		err = p.start(conversation)
	}

	p.mu.Lock()
	p.starting = false
	p.mu.Unlock()
	return err
}

func (p *Process) start(conversation string) error {
	args := buildAGYArgs(p.spec, conversation)
	var cmd *exec.Cmd
	if p.spec.SSH != nil {
		remote := buildRemoteCommand(p.spec)
		sshArgs := buildSSHArgs(*p.spec.SSH, remote)
		cmd = exec.Command("ssh", sshArgs...)
	} else {
		binary := strings.TrimSpace(p.spec.Binary)
		if binary == "" {
			binary = "agy"
		}
		cmd = exec.Command(binary, args...)
		if dir := strings.TrimSpace(p.spec.WorkDir); dir != "" {
			cmd.Dir = dir
		}
		if home := strings.TrimSpace(p.spec.HomeDir); home != "" {
			cmd.Env = append(os.Environ(), "HOME="+home)
		}
	}
	stdin, err := cmd.StdinPipe()
	if err != nil {
		return fmt.Errorf("agy_session_stdin: %w", err)
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return fmt.Errorf("agy_session_stdout: %w", err)
	}
	stderr, err := cmd.StderrPipe()
	if err != nil {
		return fmt.Errorf("agy_session_stderr: %w", err)
	}
	if err := cmd.Start(); err != nil {
		return fmt.Errorf("agy_session_start: %w", err)
	}

	p.mu.Lock()
	p.cmd = cmd
	p.stdin = stdin
	p.alive = true
	p.stderrTail = ""
	p.mu.Unlock()

	go p.readStdout(stdout)
	go p.readStderr(stderr)
	go func() {
		err := cmd.Wait()
		p.handleExit(err)
	}()
	return nil
}

func (p *Process) readStderr(reader io.Reader) {
	scanner := bufio.NewScanner(reader)
	scanner.Buffer(make([]byte, 0, 64<<10), 1<<20)
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" {
			continue
		}
		p.mu.Lock()
		p.stderrTail = line
		p.mu.Unlock()
	}
}

func (p *Process) readStdout(reader io.Reader) {
	scanner := bufio.NewScanner(reader)
	scanner.Buffer(make([]byte, 0, 1<<20), defaultLineLimit)
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" {
			continue
		}
		p.consumeLine(line)
	}
}

// consumeLine 解析 AGY 的 stream-json 事件；只保留会话需要的字段。
func (p *Process) consumeLine(line string) {
	var envelope map[string]any
	if err := json.Unmarshal([]byte(line), &envelope); err != nil {
		return
	}
	kind := asString(envelope["event"])
	payload, _ := envelope[kind].(map[string]any)
	conversation := firstNonEmpty(asString(envelope["conversation_id"]), asString(payload["conversation_id"]))
	if conversation != "" {
		p.mu.Lock()
		p.conversation = conversation
		p.mu.Unlock()
	}
	switch kind {
	case "step_update":
		stepType := asString(payload["step_type"])
		switch stepType {
		case "agent_response":
			if delta := asString(payload["text_delta"]); delta != "" {
				p.mu.Lock()
				if p.current != nil {
					p.current.Reply += delta
					turnID := p.current.ID
					p.mu.Unlock()
					p.emit(Event{TurnID: turnID, Kind: "delta", Text: delta})
					return
				}
				p.mu.Unlock()
			}
		case "tool":
			p.mu.Lock()
			turnID := int64(0)
			if p.current != nil {
				turnID = p.current.ID
			}
			p.mu.Unlock()
			p.emit(Event{TurnID: turnID, Kind: "process", Tool: asString(payload["tool_name"])})
		}
	case "result":
		p.finishTurn(payload)
	}
}

func (p *Process) finishTurn(payload map[string]any) {
	status := asString(payload["status"])
	response := asString(payload["response"])

	p.mu.Lock()
	turn := p.current
	p.current = nil
	if turn == nil {
		p.mu.Unlock()
		return
	}
	if status == "SUCCESS" {
		turn.State = TurnDone
		if strings.TrimSpace(turn.Reply) == "" {
			turn.Reply = response
		}
	} else {
		turn.State = TurnFailed
		message := strings.TrimSpace(asString(payload["error"]))
		if message == "" {
			message = "agy_result_" + strings.ToLower(status)
		}
		turn.Error = message
	}
	turn.FinishedAt = nowMillis()
	finished := *turn
	stderrTail := p.stderrTail
	p.mu.Unlock()

	kind := "result"
	if finished.State == TurnFailed {
		kind = "error"
	}
	event := Event{TurnID: finished.ID, Kind: kind, Text: finished.Reply, Status: status}
	if kind == "error" {
		event.Text = finished.Error
		if stderrTail != "" && !strings.Contains(event.Text, stderrTail) {
			event.Status = strings.TrimSpace(status + ": " + truncate(stderrTail, 300))
		}
	}
	p.emit(event)
	p.wakeWriter()
}

func (p *Process) handleExit(err error) {
	p.mu.Lock()
	wasAlive := p.alive
	p.alive = false
	p.stdin = nil
	current := p.current
	p.current = nil
	queued := p.queue
	p.queue = nil
	p.mu.Unlock()
	if !wasAlive {
		return
	}
	message := "agy_session_process_exited"
	if err != nil {
		message = err.Error()
	}
	if current != nil {
		p.mu.Lock()
		current.State = TurnFailed
		current.Error = message
		current.FinishedAt = nowMillis()
		id := current.ID
		p.mu.Unlock()
		p.emit(Event{TurnID: id, Kind: "error", Text: message})
	}
	for _, queuedTurn := range queued {
		p.mu.Lock()
		queuedTurn.State = TurnFailed
		queuedTurn.Error = "agy_session_process_exited"
		queuedTurn.FinishedAt = nowMillis()
		id := queuedTurn.ID
		p.mu.Unlock()
		p.emit(Event{TurnID: id, Kind: "error", Text: "agy_session_process_exited"})
	}
	p.emit(Event{Kind: "process", Status: "exited", Text: message})
}

// Submit 入队一轮对话。调用方必须先 EnsureStarted。
func (p *Process) Submit(ctx context.Context, prompt, peerMessageID string) (int64, error) {
	text := strings.TrimSpace(prompt)
	if text == "" {
		return 0, errors.New("agy_session_prompt_required")
	}
	p.mu.Lock()
	if p.closed {
		p.mu.Unlock()
		return 0, errors.New("agy_session_closed")
	}
	if !p.alive {
		p.mu.Unlock()
		return 0, errors.New("agy_session_not_running")
	}
	if len(p.queue)+boolToInt(p.current != nil) >= MaxQueueDepth {
		p.mu.Unlock()
		return 0, errors.New("agy_session_queue_full")
	}
	p.nextTurnID++
	turn := &Turn{ID: p.nextTurnID, Prompt: text, State: TurnQueued, PeerID: peerMessageID}
	remote := p.remote
	if remote != nil {
		// 远端模式：立即写入远端收件行；结果按 FIFO 归属。
		if p.current == nil {
			p.current = turn
			turn.State = TurnRunning
			turn.StartedAt = nowMillis()
			turnID := turn.ID
			p.mu.Unlock()
			line, encErr := encodeUserMessage(text)
			if encErr != nil {
				p.finishTurn(map[string]any{"status": "ERROR", "error": "agy_session_encode_failed"})
				return 0, encErr
			}
			if writeErr := remote.writeTurn(ctx, line); writeErr != nil {
				p.finishTurn(map[string]any{"status": "ERROR", "error": writeErr.Error()})
				return 0, writeErr
			}
			p.emit(Event{TurnID: turnID, Kind: "turn-start"})
			return turnID, nil
		}
		p.queue = append(p.queue, turn)
		turnID := turn.ID
		p.mu.Unlock()
		line, encErr := encodeUserMessage(text)
		if encErr != nil {
			return 0, encErr
		}
		if writeErr := remote.writeTurn(ctx, line); writeErr != nil {
			return 0, writeErr
		}
		p.emit(Event{TurnID: turnID, Kind: "process", Status: "queued"})
		return turnID, nil
	}
	p.queue = append(p.queue, turn)
	turnID := turn.ID
	p.mu.Unlock()

	p.emit(Event{TurnID: turnID, Kind: "process", Status: "queued"})
	p.wakeWriter()
	return turnID, nil
}

// wakeWriter 只在空闲时唤醒写协程；写协程自己串行处理队列。
func (p *Process) wakeWriter() {
	select {
	case p.writerWake <- struct{}{}:
	default:
	}
}

// Run 是会话的主循环：串行地把队列中的一轮写进 stdin，等待其 result。
func (p *Process) Run(ctx context.Context) {
	for {
		select {
		case <-ctx.Done():
			return
		case <-p.done:
			return
		case <-p.writerWake:
			p.drainQueue()
		}
	}
}

// IsRemote 报告该会话是否跑在远端自持模式（tmux + 文件收发）。
func (p *Process) IsRemote() bool {
	return p.remote != nil
}

// AdoptPendingTurn 在 Server 重启后接管上一进程在途的一轮：
// 它的输入已经写进远端，结果仍会从 out.ndjson 读回来。
func (p *Process) AdoptPendingTurn(turnID int64, prompt, peerMessageID string, startedAtMs int64) {
	if turnID <= 0 {
		return
	}
	if startedAtMs <= 0 {
		startedAtMs = nowMillis()
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	turn := &Turn{ID: turnID, Prompt: prompt, State: TurnRunning, PeerID: peerMessageID, StartedAt: startedAtMs}
	p.current = turn
	if turnID > p.nextTurnID {
		p.nextTurnID = turnID
	}
}

// ensureRemoteStarted 保证远端管道与本地跟随协程都在位；Server 重启后从偏移续接。
func (p *Process) ensureRemoteStarted(ctx context.Context, remote *remoteSession, conversation string) error {
	remote.mu.Lock()
	recent := !remote.probedAt.IsZero() && time.Since(remote.probedAt) < 2*time.Second
	remote.mu.Unlock()
	alive := false
	var bootAt int64
	if recent {
		p.mu.Lock()
		alive = p.alive
		p.mu.Unlock()
	} else {
		alive, bootAt = remote.aliveRemote(ctx)
		remote.mu.Lock()
		remote.probedAt = time.Now()
		remote.mu.Unlock()
	}
	// 主机重启过：上一轮的结果不可能再回来，明确失败而不是让它一直 running。
	if p.current != nil {
		p.mu.Lock()
		startedAt := p.current.StartedAt
		p.mu.Unlock()
		if bootAt > 0 && startedAt > 0 && startedAt < bootAt {
			p.finishTurn(map[string]any{"status": "ERROR", "error": "agy_host_rebooted"})
		}
	}
	pipelineStarted := false
	if !alive {
		p.mu.Lock()
		interrupted := p.current != nil
		p.mu.Unlock()
		rotated, err := remote.startPipeline(ctx, conversation)
		if err != nil {
			return err
		}
		pipelineStarted = true
		if rotated {
			// 输出已轮转：旧偏移失效，从新文件头开始跟随。
			p.mu.Lock()
			p.remoteOffset = 0
			if p.followerCtx != nil {
				p.followerCtx()
				p.followerCtx = nil
			}
			p.mu.Unlock()
		}
		// 远端管道已经不在：在途那轮的结果不会再来，明确失败，别让会话永远卡在 running。
		if interrupted {
			p.finishTurn(map[string]any{"status": "ERROR", "error": "agy_remote_pipeline_restarted"})
		}
	}
	p.mu.Lock()
	p.alive = true
	offset := p.remoteOffset
	if offset == 0 {
		offset = p.spec.ResumeOffset
	}
	needFollower := p.followerCtx == nil
	if needFollower {
		followCtx, cancel := context.WithCancel(context.Background())
		p.followerCtx = cancel
		conversationKnown := p.conversation != ""
		p.mu.Unlock()
		go remote.follow(followCtx, offset, p.consumeLine, func(error) {})
		if pipelineStarted && !conversationKnown {
			// tail -n +1 从文件头读，提示不会落在盲区；只需短暂等 init 以尽早拿到 conversation。
			waitCtx, waitCancel := context.WithTimeout(ctx, 1200*time.Millisecond)
			defer waitCancel()
			for waitCtx.Err() == nil {
				p.mu.Lock()
				ready := p.conversation != ""
				p.mu.Unlock()
				if ready {
					break
				}
				select {
				case <-waitCtx.Done():
				case <-time.After(150 * time.Millisecond):
				}
			}
		}
		return nil
	}
	p.mu.Unlock()
	return nil
}

// RemoteOffset 返回远端输出已消费到的字节位置，供上层持久化。
func (p *Process) RemoteOffset() int64 {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.remoteOffset == 0 {
		return p.spec.ResumeOffset
	}
	return p.remoteOffset
}

func (p *Process) drainQueue() {
	if p.remote != nil {
		return
	}
	for {
		p.mu.Lock()
		if p.closed || !p.alive || p.current != nil || len(p.queue) == 0 {
			p.mu.Unlock()
			return
		}
		turn := p.queue[0]
		p.queue = p.queue[1:]
		p.current = turn
		turn.State = TurnRunning
		turn.StartedAt = nowMillis()
		stdin := p.stdin
		p.mu.Unlock()

		if stdin == nil {
			p.finishTurn(map[string]any{"status": "ERROR", "error": "agy_session_stdin_missing"})
			return
		}
		line, err := encodeUserMessage(turn.Prompt)
		if err != nil {
			p.finishTurn(map[string]any{"status": "ERROR", "error": "agy_session_encode_failed"})
			return
		}
		p.emit(Event{TurnID: turn.ID, Kind: "turn-start"})
		if _, err := io.WriteString(stdin, line); err != nil {
			// 写失败时不能假装这一轮已发出：交给进程退出路径统一失败处理。
			p.mu.Lock()
			p.alive = false
			p.mu.Unlock()
			p.finishTurn(map[string]any{"status": "ERROR", "error": "agy_session_write_failed"})
			return
		}
	}
}

// Close 结束进程；未完成的轮会被标记失败。
func (p *Process) Close() {
	p.mu.Lock()
	if p.closed {
		p.mu.Unlock()
		return
	}
	p.closed = true
	stdin := p.stdin
	p.mu.Unlock()
	close(p.done)
	if stdin != nil {
		_ = stdin.Close()
	}
	p.mu.Lock()
	cmd := p.cmd
	p.mu.Unlock()
	if cmd != nil && cmd.Process != nil {
		_ = cmd.Process.Kill()
	}
	if p.remote != nil {
		if p.followerCtx != nil {
			p.followerCtx()
			p.followerCtx = nil
		}
		p.remote.killRemote(context.Background())
	}
}

// EventsAfter 返回指定游标之后的事件副本；events 只保留最近一段。
func (p *Process) EventsAfter(after int64) []Event {
	p.mu.Lock()
	defer p.mu.Unlock()
	out := make([]Event, 0, len(p.events))
	for _, event := range p.events {
		if event.Seq > after {
			out = append(out, event)
		}
	}
	return out
}

// Cursor 返回当前最后一个事件序号。
func (p *Process) Cursor() int64 {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.nextEvent
}

func (p *Process) emit(event Event) {
	p.mu.Lock()
	p.nextEvent++
	event.Seq = p.nextEvent
	if event.At == 0 {
		event.At = nowMillis()
	}
	p.events = append(p.events, event)
	if len(p.events) > maxRetainedEvents {
		p.events = append([]Event(nil), p.events[len(p.events)-maxRetainedEvents:]...)
	}
	sink := p.sink
	p.mu.Unlock()
	if sink != nil {
		sink(event)
	}
}

// SetSink 安装事件回调（可在会话运行中替换）。
func (p *Process) SetSink(sink Sink) {
	p.mu.Lock()
	p.sink = sink
	p.mu.Unlock()
}

func buildAGYArgs(spec Spec, conversation string) []string {
	args := []string{}
	if conversation != "" {
		args = append(args, "--conversation", conversation)
	}
	args = append(args,
		// --print= 只为进入 print 模式；提示词走 stdin 的 stream-json。
		"--print=",
		"--input-format", "stream-json",
		"--output-format", "stream-json",
		"--dangerously-skip-permissions",
	)
	if model := strings.TrimSpace(spec.Model); model != "" {
		args = append(args, "--model", model)
	}
	if effort := strings.TrimSpace(spec.Effort); effort != "" {
		args = append(args, "--effort", effort)
	}
	return args
}

// buildRemoteCommand 在远端 shell 里拼接 cd/HOME/binary。
func buildRemoteCommand(spec Spec) string {
	binary := strings.TrimSpace(spec.Binary)
	if binary == "" {
		binary = "$HOME/.local/bin/agy"
	}
	args := buildAGYArgs(spec, spec.ConversationID)
	quoted := make([]string, 0, len(args))
	for _, arg := range args {
		quoted = append(quoted, sshhost.ShellQuote(arg))
	}
	command := binary
	if len(quoted) > 0 {
		command += " " + strings.Join(quoted, " ")
	}
	if home := strings.TrimSpace(spec.HomeDir); home != "" {
		command = "HOME=" + sshhost.ShellQuote(home) + " " + command
	}
	if dir := strings.TrimSpace(spec.WorkDir); dir != "" {
		command = "cd " + sshhost.ShellQuote(dir) + " && " + command
	}
	return command
}

func buildSSHArgs(transport SSHTransport, remoteCommand string) []string {
	args := []string{
		"-o", "BatchMode=yes",
		"-o", "StrictHostKeyChecking=accept-new",
		// 一轮可能几十分钟没有可读输出；keepalive 太短会把长轮误判为断线（ssh 退出 255）。
		"-o", "ServerAliveInterval=10",
		"-o", "ServerAliveCountMax=18",
		"-o", "TCPKeepAlive=yes",
		"-o", "ConnectionAttempts=2",
	}
	if identity := strings.TrimSpace(transport.IdentityFile); identity != "" {
		args = append(args, "-i", identity)
	}
	if transport.Port != 0 {
		args = append(args, "-p", strconv.Itoa(transport.Port))
	}
	destination := transport.Host
	if strings.TrimSpace(transport.User) != "" {
		destination = transport.User + "@" + transport.Host
	}
	return append(args, destination, remoteCommand)
}

func encodeUserMessage(prompt string) (string, error) {
	body, err := json.Marshal(map[string]any{
		"event": "user",
		"message": map[string]any{
			"role":    "user",
			"content": prompt,
		},
	})
	if err != nil {
		return "", err
	}
	return string(body) + "\n", nil
}

func asString(value any) string {
	if text, ok := value.(string); ok {
		return text
	}
	return ""
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			return strings.TrimSpace(value)
		}
	}
	return ""
}

func truncate(value string, limit int) string {
	if len(value) <= limit {
		return value
	}
	return value[:limit]
}

func boolToInt(value bool) int {
	if value {
		return 1
	}
	return 0
}

func nowMillis() int64 {
	return time.Now().UnixMilli()
}
