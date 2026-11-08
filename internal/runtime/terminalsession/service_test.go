package terminalsession

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"regexp"
	"runtime"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/madou1217/ai_home/internal/runtime/pty"
)

// fakeStarter 隔离真实 PTY，测试只验证服务编排与状态机。
type fakeStarter struct {
	mu        sync.Mutex
	terminals []*fakeTerminal
	specs     []pty.Spec
	err       error
}

func (starter *fakeStarter) Start(_ context.Context, spec pty.Spec) (pty.Session, error) {
	starter.mu.Lock()
	defer starter.mu.Unlock()
	if starter.err != nil {
		return nil, starter.err
	}
	terminal := newFakeTerminal()
	starter.terminals = append(starter.terminals, terminal)
	starter.specs = append(starter.specs, spec)
	return terminal, nil
}

func (starter *fakeStarter) last(t *testing.T) *fakeTerminal {
	t.Helper()
	starter.mu.Lock()
	defer starter.mu.Unlock()
	if len(starter.terminals) == 0 {
		t.Fatal("没有创建任何 fake terminal")
	}
	return starter.terminals[len(starter.terminals)-1]
}

func (starter *fakeStarter) lastSpec(t *testing.T) pty.Spec {
	t.Helper()
	starter.mu.Lock()
	defer starter.mu.Unlock()
	if len(starter.specs) == 0 {
		t.Fatal("没有收到任何 PTY spec")
	}
	return starter.specs[len(starter.specs)-1]
}

func (starter *fakeStarter) count() int {
	starter.mu.Lock()
	defer starter.mu.Unlock()
	return len(starter.terminals)
}

// fakeTerminal 是可编程的 PTY：输出从 channel 注入，写入按两半记录，
// 用来验证服务层的顺序与串行化。
type fakeTerminal struct {
	output    chan []byte
	closed    chan struct{}
	closeOnce sync.Once
	eofOnce   sync.Once

	readMu  sync.Mutex
	pending []byte

	recordMu sync.Mutex
	written  bytes.Buffer

	resizeMu       sync.Mutex
	resizeCalls    []pty.Size
	resizeAttempts []pty.Size
	resizeErrs     map[uint16]error

	waitErr error
}

func newFakeTerminal() *fakeTerminal {
	return &fakeTerminal{
		output:     make(chan []byte, 64),
		closed:     make(chan struct{}),
		resizeErrs: make(map[uint16]error),
	}
}

func (terminal *fakeTerminal) Read(payload []byte) (int, error) {
	for {
		terminal.readMu.Lock()
		if len(terminal.pending) > 0 {
			read := copy(payload, terminal.pending)
			terminal.pending = terminal.pending[read:]
			terminal.readMu.Unlock()
			return read, nil
		}
		terminal.readMu.Unlock()

		select {
		case chunk, ok := <-terminal.output:
			if !ok {
				return 0, io.EOF
			}
			terminal.readMu.Lock()
			terminal.pending = append(terminal.pending, chunk...)
			terminal.readMu.Unlock()
		case <-terminal.closed:
			return 0, io.EOF
		}
	}
}

func (terminal *fakeTerminal) Write(payload []byte) (int, error) {
	half := len(payload) / 2
	terminal.record(payload[:half])
	runtime.Gosched()
	terminal.record(payload[half:])
	return len(payload), nil
}

func (terminal *fakeTerminal) record(payload []byte) {
	terminal.recordMu.Lock()
	defer terminal.recordMu.Unlock()
	_, _ = terminal.written.Write(payload)
}

func (terminal *fakeTerminal) Resize(size pty.Size) error {
	terminal.resizeMu.Lock()
	defer terminal.resizeMu.Unlock()
	terminal.resizeAttempts = append(terminal.resizeAttempts, size)
	if err, ok := terminal.resizeErrs[size.Cols]; ok {
		return err
	}
	terminal.resizeCalls = append(terminal.resizeCalls, size)
	return nil
}

func (terminal *fakeTerminal) Close() error {
	terminal.closeOnce.Do(func() { close(terminal.closed) })
	return nil
}

func (terminal *fakeTerminal) Wait() error { return terminal.waitErr }

func (terminal *fakeTerminal) emit(text string) {
	// 与 Close 竞争时丢弃即可；测试不依赖关闭后的输出。
	defer func() { _ = recover() }()
	select {
	case terminal.output <- []byte(text):
	case <-terminal.closed:
	}
}

func (terminal *fakeTerminal) eof(waitErr error) {
	terminal.waitErr = waitErr
	terminal.eofOnce.Do(func() { close(terminal.output) })
}

func (terminal *fakeTerminal) writtenString() string {
	terminal.recordMu.Lock()
	defer terminal.recordMu.Unlock()
	return terminal.written.String()
}

func (terminal *fakeTerminal) resizeCount() int {
	terminal.resizeMu.Lock()
	defer terminal.resizeMu.Unlock()
	return len(terminal.resizeCalls)
}

func (terminal *fakeTerminal) attemptCount() int {
	terminal.resizeMu.Lock()
	defer terminal.resizeMu.Unlock()
	return len(terminal.resizeAttempts)
}

type fakeExitError struct{ code int }

func (err fakeExitError) Error() string { return fmt.Sprintf("exit %d", err.code) }
func (err fakeExitError) ExitCode() int { return err.code }

func TestServiceSessionLifecycle(t *testing.T) {
	starter := &fakeStarter{}
	service := NewService(starter, Options{})
	defer service.Shutdown()

	var created Snapshot
	steps := []struct {
		name    string
		run     func(t *testing.T) error
		wantErr error
		verify  func(t *testing.T)
	}{
		{
			name: "创建会话并规范化尺寸",
			run: func(t *testing.T) error {
				var err error
				created, err = service.Create(context.Background(), Spec{
					Key:  "account-cli:42",
					Path: "/bin/sh",
					Args: []string{"-l"},
					Dir:  t.TempDir(),
					Size: pty.Size{Rows: 30, Cols: 100},
				})
				return err
			},
			verify: func(t *testing.T) {
				if created.ID == "" || created.Status != StatusRunning || created.Reused {
					t.Fatalf("created = %#v", created)
				}
				if created.Cols != 100 || created.Rows != 30 || created.Key != "account-cli:42" {
					t.Fatalf("created = %#v", created)
				}
				spec := starter.lastSpec(t)
				if spec.Path != "/bin/sh" || spec.Size.Cols != 100 || spec.Size.Rows != 30 {
					t.Fatalf("spec = %#v", spec)
				}
				if !hasEnvironment(spec.Env, "TERM=xterm-256color") {
					t.Fatalf("spec.Env 缺少 TERM: %#v", spec.Env)
				}
			},
		},
		{
			name: "同 sessionKey 复用",
			run: func(t *testing.T) error {
				again, err := service.Create(context.Background(), Spec{Key: "account-cli:42", Path: "/bin/sh"})
				if err != nil {
					return err
				}
				if again.ID != created.ID || !again.Reused {
					t.Fatalf("复用结果 = %#v，期望 ID %s", again, created.ID)
				}
				if starter.count() != 1 {
					t.Fatalf("复用却创建了新 PTY: %d", starter.count())
				}
				return nil
			},
		},
		{
			name: "按 key attach 返回同一会话",
			run: func(t *testing.T) error {
				snapshot, err := service.Attach("account-cli:42")
				if err != nil {
					return err
				}
				if snapshot.ID != created.ID || snapshot.Cols != 100 || snapshot.Rows != 30 {
					t.Fatalf("snapshot = %#v", snapshot)
				}
				return nil
			},
		},
		{
			name: "写入 PTY",
			run: func(t *testing.T) error {
				if err := service.Write(created.ID, []byte("echo hi")); err != nil {
					return err
				}
				if got := starter.last(t).writtenString(); got != "echo hi" {
					t.Fatalf("写入内容 = %q", got)
				}
				return nil
			},
		},
		{
			name: "resize 更新尺寸并跳过重复",
			run: func(t *testing.T) error {
				snapshot, err := service.Resize(created.Key, pty.Size{Rows: 38, Cols: 112})
				if err != nil {
					return err
				}
				if snapshot.Cols != 112 || snapshot.Rows != 38 {
					t.Fatalf("snapshot = %#v", snapshot)
				}
				if _, err := service.Resize(created.ID, pty.Size{Rows: 38, Cols: 112}); err != nil {
					return err
				}
				if calls := starter.last(t).resizeCount(); calls != 1 {
					t.Fatalf("重复 resize 下发了 %d 次", calls)
				}
				return nil
			},
		},
		{
			name: "kill 终止并失联",
			run:  func(t *testing.T) error { return service.Kill(created.ID) },
			verify: func(t *testing.T) {
				if _, err := service.Attach(created.Key); !errors.Is(err, ErrSessionNotFound) {
					t.Fatalf("kill 后 attach error = %v", err)
				}
				if err := service.Write(created.ID, []byte("x")); !errors.Is(err, ErrSessionNotFound) {
					t.Fatalf("kill 后 write error = %v", err)
				}
				if _, err := service.Subscribe(created.ID, 4); !errors.Is(err, ErrSessionNotFound) {
					t.Fatalf("kill 后 subscribe error = %v", err)
				}
			},
		},
		{
			name:    "重复 kill 返回未找到",
			run:     func(t *testing.T) error { return service.Kill(created.ID) },
			wantErr: ErrSessionNotFound,
		},
	}

	for _, step := range steps {
		step := step
		t.Run(step.name, func(t *testing.T) {
			err := step.run(t)
			if !errors.Is(err, step.wantErr) {
				t.Fatalf("error = %v，期望 %v", err, step.wantErr)
			}
			if step.verify != nil {
				step.verify(t)
			}
		})
	}
}

func TestServiceResizeTable(t *testing.T) {
	cases := []struct {
		name         string
		initial      pty.Size
		change       pty.Size
		failCols     uint16
		want         pty.Size
		wantErr      bool
		wantAttempts int
	}{
		{name: "正常变更", initial: pty.Size{Rows: 24, Cols: 80}, change: pty.Size{Rows: 38, Cols: 112}, want: pty.Size{Rows: 38, Cols: 112}, wantAttempts: 1},
		{name: "同尺寸跳过", initial: pty.Size{Rows: 38, Cols: 112}, change: pty.Size{Rows: 38, Cols: 112}, want: pty.Size{Rows: 38, Cols: 112}, wantAttempts: 0},
		{name: "最小尺寸夹取", initial: pty.Size{Rows: 24, Cols: 80}, change: pty.Size{Rows: 1, Cols: 1}, want: pty.Size{Rows: 1, Cols: 2}, wantAttempts: 1},
		{name: "最大尺寸夹取", initial: pty.Size{Rows: 24, Cols: 80}, change: pty.Size{Rows: 999, Cols: 999}, want: pty.Size{Rows: 200, Cols: 500}, wantAttempts: 1},
		{name: "失败保留旧尺寸", initial: pty.Size{Rows: 24, Cols: 80}, change: pty.Size{Rows: 40, Cols: 113}, failCols: 113, want: pty.Size{Rows: 24, Cols: 80}, wantErr: true, wantAttempts: 1},
	}

	for _, testCase := range cases {
		testCase := testCase
		t.Run(testCase.name, func(t *testing.T) {
			starter := &fakeStarter{}
			service := NewService(starter, Options{})
			defer service.Shutdown()
			created, err := service.Create(context.Background(), Spec{
				Path: "/bin/sh",
				Dir:  t.TempDir(),
				Size: testCase.initial,
			})
			if err != nil {
				t.Fatalf("Create() error = %v", err)
			}
			terminal := starter.last(t)
			if testCase.failCols != 0 {
				terminal.resizeErrs[testCase.failCols] = errors.New("simulated resize failure")
			}

			snapshot, err := service.Resize(created.ID, testCase.change)
			if testCase.wantErr {
				if err == nil {
					t.Fatal("Resize() 期望失败")
				}
			} else if err != nil {
				t.Fatalf("Resize() error = %v", err)
			}
			if attempts := terminal.attemptCount(); attempts != testCase.wantAttempts {
				t.Fatalf("resize 尝试次数 = %d，期望 %d", attempts, testCase.wantAttempts)
			}
			after, err := service.Attach(created.ID)
			if err != nil {
				t.Fatalf("Attach() error = %v", err)
			}
			if after.Cols != testCase.want.Cols || after.Rows != testCase.want.Rows {
				t.Fatalf("尺寸 = %dx%d，期望 %dx%d", after.Cols, after.Rows, testCase.want.Cols, testCase.want.Rows)
			}
			if !testCase.wantErr && (snapshot.Cols != testCase.want.Cols || snapshot.Rows != testCase.want.Rows) {
				t.Fatalf("返回尺寸 = %#v", snapshot)
			}
		})
	}
}

func TestServiceOutputOrderTable(t *testing.T) {
	cases := []struct {
		name   string
		chunks []string
		want   string
	}{
		{name: "单块输出", chunks: []string{"hello"}, want: "hello"},
		{name: "多块保序", chunks: []string{"one", "-", "two", "-", "three"}, want: "one-two-three"},
		{name: "UTF-8 跨块拼接", chunks: []string{"你", "好", "，世界"}, want: "你好，世界"},
	}

	for _, testCase := range cases {
		testCase := testCase
		t.Run(testCase.name, func(t *testing.T) {
			starter := &fakeStarter{}
			service := NewService(starter, Options{})
			defer service.Shutdown()
			created, err := service.Create(context.Background(), Spec{Path: "/bin/sh", Dir: t.TempDir()})
			if err != nil {
				t.Fatalf("Create() error = %v", err)
			}
			sub, err := service.Subscribe(created.ID, 32)
			if err != nil {
				t.Fatalf("Subscribe() error = %v", err)
			}
			defer sub.Close()
			terminal := starter.last(t)
			for _, chunk := range testCase.chunks {
				terminal.emit(chunk)
			}
			if output := readUntil(t, sub, testCase.want); output != testCase.want {
				t.Fatalf("输出 = %q，期望 %q", output, testCase.want)
			}
		})
	}
}

func TestServiceReconnectReplayTable(t *testing.T) {
	cases := []struct {
		name    string
		durable bool
		chunks  []string
		want    string
	}{
		{
			name:   "重连回放断线期间输出",
			chunks: []string{"alpha", "beta", "gamma"},
			want:   "alphabetagamma",
		},
		{
			name:   "非 durable 回放保留终端查询",
			chunks: []string{"before", "\x1b[c", "after"},
			want:   "before\x1b[cafter",
		},
		{
			name:    "durable 回放剥离终端查询",
			durable: true,
			chunks:  []string{"\x1b[31mred\x1b[", "c\x1b[>c\x1b[6n\x1b[18t\x1b[>q\x1b]10;?\x1b\\", "\x1b[0m$ "},
			want:    "\x1b[31mred\x1b[0m$ ",
		},
	}

	for _, testCase := range cases {
		testCase := testCase
		t.Run(testCase.name, func(t *testing.T) {
			starter := &fakeStarter{}
			service := NewService(starter, Options{})
			defer service.Shutdown()
			created, err := service.Create(context.Background(), Spec{
				Path:    "/bin/sh",
				Dir:     t.TempDir(),
				Durable: testCase.durable,
			})
			if err != nil {
				t.Fatalf("Create() error = %v", err)
			}
			first, err := service.Subscribe(created.ID, 32)
			if err != nil {
				t.Fatalf("Subscribe() error = %v", err)
			}
			terminal := starter.last(t)
			for _, chunk := range testCase.chunks {
				terminal.emit(chunk)
			}
			waitForBuffer(t, service, created.ID, len(strings.Join(testCase.chunks, "")))
			first.Close()

			reconnected, err := service.Subscribe(created.ID, 32)
			if err != nil {
				t.Fatalf("重连 Subscribe() error = %v", err)
			}
			defer reconnected.Close()
			replay := readFrame(t, reconnected)
			if replay.Type != FrameOutput || string(replay.Data) != testCase.want {
				t.Fatalf("回放帧 = %#v，期望 %q", replay, testCase.want)
			}
		})
	}
}

func TestServiceReplayAfterExitAndBufferTrim(t *testing.T) {
	starter := &fakeStarter{}
	service := NewService(starter, Options{MaxBufferBytes: 8})
	defer service.Shutdown()
	created, err := service.Create(context.Background(), Spec{Key: "exit-replay", Path: "/bin/sh", Dir: t.TempDir()})
	if err != nil {
		t.Fatalf("Create() error = %v", err)
	}
	sub, err := service.Subscribe(created.ID, 8)
	if err != nil {
		t.Fatalf("Subscribe() error = %v", err)
	}
	terminal := starter.last(t)
	terminal.emit("aaaa")
	terminal.emit("bbbb")
	terminal.emit("cccc")
	waitForBuffer(t, service, created.ID, 8)
	terminal.eof(fakeExitError{code: 7})
	if frames := collectFrames(t, sub); !containsExit(frames, 7) {
		t.Fatalf("缺少退出帧: %#v", frames)
	}

	replaySub, err := service.Subscribe(created.ID, 8)
	if err != nil {
		t.Fatalf("退出后 Subscribe() error = %v", err)
	}
	defer replaySub.Close()
	frames := collectFrames(t, replaySub)
	if len(frames) != 2 || frames[0].Type != FrameOutput || string(frames[0].Data) != "bbbbcccc" {
		t.Fatalf("回放帧 = %#v", frames)
	}
	if frames[1].Type != FrameExit || frames[1].ExitCode != 7 {
		t.Fatalf("退出帧 = %#v", frames[1])
	}
}

func TestServiceConcurrentWritesTable(t *testing.T) {
	tokenPattern := regexp.MustCompile("<[0-9]{2}:[0-9]{3}>")
	cases := []struct {
		name      string
		writers   int
		perWriter int
	}{
		{name: "单写者", writers: 1, perWriter: 20},
		{name: "八写者并发", writers: 8, perWriter: 25},
	}

	for _, testCase := range cases {
		testCase := testCase
		t.Run(testCase.name, func(t *testing.T) {
			starter := &fakeStarter{}
			service := NewService(starter, Options{})
			defer service.Shutdown()
			created, err := service.Create(context.Background(), Spec{Path: "/bin/sh", Dir: t.TempDir()})
			if err != nil {
				t.Fatalf("Create() error = %v", err)
			}

			var wait sync.WaitGroup
			for writer := 0; writer < testCase.writers; writer++ {
				wait.Add(1)
				go func(writer int) {
					defer wait.Done()
					for index := 0; index < testCase.perWriter; index++ {
						token := fmt.Sprintf("<%02d:%03d>", writer, index)
						if err := service.Write(created.ID, []byte(token)); err != nil {
							t.Errorf("Write(%s) error = %v", token, err)
							return
						}
					}
				}(writer)
			}
			wait.Wait()

			written := starter.last(t).writtenString()
			matches := tokenPattern.FindAllString(written, -1)
			if strings.Join(matches, "") != written {
				t.Fatalf("并发写入发生交错: %q", written)
			}
			if len(matches) != testCase.writers*testCase.perWriter {
				t.Fatalf("写入条数 = %d，期望 %d", len(matches), testCase.writers*testCase.perWriter)
			}
			seen := make(map[string]struct{}, len(matches))
			for _, token := range matches {
				if _, duplicate := seen[token]; duplicate {
					t.Fatalf("重复写入 %s", token)
				}
				seen[token] = struct{}{}
			}
		})
	}
}

func TestServiceReapTable(t *testing.T) {
	cases := []struct {
		name       string
		persistent bool
		subscribe  bool
		options    Options
		advance    time.Duration
		wantReaped bool
	}{
		{
			name:       "空闲超时回收",
			options:    Options{IdleTimeout: time.Minute},
			advance:    2 * time.Minute,
			wantReaped: true,
		},
		{
			name:       "有订阅者不回收",
			subscribe:  true,
			options:    Options{IdleTimeout: time.Minute},
			advance:    2 * time.Minute,
			wantReaped: false,
		},
		{
			name:       "持久会话不回收",
			persistent: true,
			options:    Options{IdleTimeout: time.Minute},
			advance:    2 * time.Minute,
			wantReaped: false,
		},
		{
			name:       "未到空闲阈值不回收",
			options:    Options{IdleTimeout: 30 * time.Minute},
			advance:    time.Minute,
			wantReaped: false,
		},
	}

	for _, testCase := range cases {
		testCase := testCase
		t.Run(testCase.name, func(t *testing.T) {
			now := time.Date(2026, 11, 8, 10, 0, 0, 0, time.UTC)
			options := testCase.options
			options.Now = func() time.Time { return now }
			starter := &fakeStarter{}
			service := NewService(starter, options)
			defer service.Shutdown()
			created, err := service.Create(context.Background(), Spec{
				Path:       "/bin/sh",
				Dir:        t.TempDir(),
				Persistent: testCase.persistent,
			})
			if err != nil {
				t.Fatalf("Create() error = %v", err)
			}
			if testCase.subscribe {
				sub, err := service.Subscribe(created.ID, 8)
				if err != nil {
					t.Fatalf("Subscribe() error = %v", err)
				}
				defer sub.Close()
			}
			now = now.Add(testCase.advance)
			reaped := service.Reap()
			if reapedNow := len(reaped) > 0; reapedNow != testCase.wantReaped {
				t.Fatalf("Reap() = %#v，期望 reaped=%v", reaped, testCase.wantReaped)
			}
			_, err = service.Attach(created.ID)
			if testCase.wantReaped && !errors.Is(err, ErrSessionNotFound) {
				t.Fatalf("回收后 Attach() error = %v", err)
			}
			if !testCase.wantReaped && err != nil {
				t.Fatalf("不应回收，Attach() error = %v", err)
			}
		})
	}
}

func TestServiceLimitsTable(t *testing.T) {
	cases := []struct {
		name    string
		options Options
		wantErr error
	}{
		{name: "默认上限内创建", options: Options{}},
		{name: "超过会话上限", options: Options{MaxSessions: 1}, wantErr: ErrTooManySessions},
	}
	for _, testCase := range cases {
		testCase := testCase
		t.Run(testCase.name, func(t *testing.T) {
			service := NewService(&fakeStarter{}, testCase.options)
			defer service.Shutdown()
			if _, err := service.Create(context.Background(), Spec{Path: "/bin/sh", Dir: t.TempDir()}); err != nil {
				t.Fatalf("第一个 Create() error = %v", err)
			}
			_, err := service.Create(context.Background(), Spec{Path: "/bin/sh", Dir: t.TempDir()})
			if !errors.Is(err, testCase.wantErr) {
				t.Fatalf("第二个 Create() error = %v，期望 %v", err, testCase.wantErr)
			}
		})
	}
}

func TestReplayOutputTable(t *testing.T) {
	raw := "\x1b[31mred\x1b[c\x1b[>c\x1b[6n\x1b[18t\x1b[>q\x1b]10;?\x1b\\\x1b[0m$ "
	cases := []struct {
		name    string
		durable bool
		want    string
	}{
		{name: "直连 PTY 保留查询", durable: false, want: raw},
		{name: "durable 剥离查询", durable: true, want: "\x1b[31mred\x1b[0m$ "},
	}
	for _, testCase := range cases {
		testCase := testCase
		t.Run(testCase.name, func(t *testing.T) {
			if got := string(ReplayOutput(testCase.durable, []byte(raw))); got != testCase.want {
				t.Fatalf("ReplayOutput() = %q，期望 %q", got, testCase.want)
			}
		})
	}
}

func readUntil(t *testing.T, subscription *Subscription, want string) string {
	t.Helper()
	var output strings.Builder
	deadline := time.After(5 * time.Second)
	for {
		if strings.Contains(output.String(), want) {
			return output.String()
		}
		select {
		case frame, ok := <-subscription.C:
			if !ok {
				if strings.Contains(output.String(), want) {
					return output.String()
				}
				t.Fatalf("订阅已关闭，未等到 %q，已收到 %q", want, output.String())
			}
			if frame.Type == FrameOutput {
				output.Write(frame.Data)
			}
		case <-deadline:
			t.Fatalf("等待输出 %q 超时，已收到 %q", want, output.String())
		}
	}
}

func readFrame(t *testing.T, subscription *Subscription) Frame {
	t.Helper()
	select {
	case frame, ok := <-subscription.C:
		if !ok {
			t.Fatal("订阅已关闭，没有可读帧")
		}
		return frame
	case <-time.After(5 * time.Second):
		t.Fatal("等待帧超时")
	}
	return Frame{}
}

func collectFrames(t *testing.T, subscription *Subscription) []Frame {
	t.Helper()
	frames := make([]Frame, 0)
	deadline := time.After(5 * time.Second)
	for {
		select {
		case frame, ok := <-subscription.C:
			if !ok {
				return frames
			}
			frames = append(frames, frame)
		case <-deadline:
			t.Fatalf("收集帧超时: %#v", frames)
		}
	}
}

func containsExit(frames []Frame, code int) bool {
	for _, frame := range frames {
		if frame.Type == FrameExit && frame.ExitCode == code {
			return true
		}
	}
	return false
}

func waitForBuffer(t *testing.T, service *Service, id string, minimum int) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for {
		service.mu.Lock()
		found := service.sessions[id]
		size := 0
		if found != nil {
			size = found.bufferBytes
		}
		service.mu.Unlock()
		if size >= minimum {
			return
		}
		if time.Now().After(deadline) {
			t.Fatalf("等待回放缓冲 %d 字节超时，当前 %d", minimum, size)
		}
		time.Sleep(time.Millisecond)
	}
}

func hasEnvironment(environment []string, want string) bool {
	for _, entry := range environment {
		if entry == want {
			return true
		}
	}
	return false
}
