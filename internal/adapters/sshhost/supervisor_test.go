package sshhost

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"testing"
	"time"
)

func TestShouldReconnect(t *testing.T) {
	t.Parallel()
	cases := []struct {
		name   string
		code   int
		signal string
		want   bool
	}{
		{name: "正常退出", code: 0, want: false},
		{name: "远端命令非零退出", code: 1, want: false},
		{name: "ssh 自身失败", code: 255, want: true},
		{name: "信号终止", code: 0, signal: "SIGTERM", want: true},
		{name: "SIGHUP", code: 0, signal: "SIGHUP", want: true},
		{name: "自身 SIGINT 视为用户结束", code: 0, signal: "SIGINT", want: false},
	}
	for _, testCase := range cases {
		testCase := testCase
		t.Run(testCase.name, func(t *testing.T) {
			t.Parallel()
			if got := ShouldReconnect(testCase.code, testCase.signal); got != testCase.want {
				t.Fatalf("ShouldReconnect(%d, %q) = %v, want %v", testCase.code, testCase.signal, got, testCase.want)
			}
		})
	}
}

func TestBackoffDelay(t *testing.T) {
	t.Parallel()
	cases := []struct {
		attempt int
		want    time.Duration
	}{
		{attempt: -1, want: 1 * time.Second},
		{attempt: 0, want: 1 * time.Second},
		{attempt: 1, want: 2 * time.Second},
		{attempt: 2, want: 5 * time.Second},
		{attempt: 3, want: 10 * time.Second},
		{attempt: 4, want: 20 * time.Second},
		{attempt: 5, want: 30 * time.Second},
		{attempt: 99, want: 30 * time.Second},
	}
	for _, testCase := range cases {
		testCase := testCase
		t.Run(fmt.Sprintf("attempt_%d", testCase.attempt), func(t *testing.T) {
			t.Parallel()
			if got := BackoffDelay(testCase.attempt); got != testCase.want {
				t.Fatalf("BackoffDelay(%d) = %v, want %v", testCase.attempt, got, testCase.want)
			}
		})
	}
}

func TestDecide(t *testing.T) {
	t.Parallel()
	cases := []struct {
		name    string
		exit    Exit
		attempt int
		want    Decision
	}{
		{
			name:    "远端正常结束",
			exit:    Exit{Code: 0, ConnectedFor: time.Second},
			attempt: 2,
			want:    Decision{Reconnect: false, Attempt: 2, ExitCode: 0},
		},
		{
			name:    "远端非零退出不重连",
			exit:    Exit{Code: 7, ConnectedFor: time.Second},
			attempt: 0,
			want:    Decision{Reconnect: false, Attempt: 0, ExitCode: 7},
		},
		{
			name:    "255 首次重连",
			exit:    Exit{Code: 255, ConnectedFor: time.Second},
			attempt: 0,
			want:    Decision{Reconnect: true, Delay: 1 * time.Second, Attempt: 1, ExitCode: 255},
		},
		{
			name:    "255 第二次重连",
			exit:    Exit{Code: 255, ConnectedFor: time.Second},
			attempt: 1,
			want:    Decision{Reconnect: true, Delay: 2 * time.Second, Attempt: 2, ExitCode: 255},
		},
		{
			name:    "信号断开",
			exit:    Exit{Code: 0, Signal: "SIGTERM"},
			attempt: 0,
			want:    Decision{Reconnect: true, Delay: 1 * time.Second, Attempt: 1, ExitCode: 0},
		},
		{
			name:    "稳定运行后重置退避",
			exit:    Exit{Code: 255, ConnectedFor: 61 * time.Second},
			attempt: 4,
			want:    Decision{Reconnect: true, Delay: 1 * time.Second, Attempt: 1, ExitCode: 255},
		},
		{
			name:    "守护停止",
			exit:    Exit{Code: 255, Stopping: true},
			attempt: 3,
			want:    Decision{Reconnect: false, Attempt: 3, ExitCode: 0},
		},
	}
	for _, testCase := range cases {
		testCase := testCase
		t.Run(testCase.name, func(t *testing.T) {
			t.Parallel()
			if got := Decide(testCase.exit, testCase.attempt); got != testCase.want {
				t.Fatalf("Decide() = %#v, want %#v", got, testCase.want)
			}
		})
	}
}

func mustJSON(t *testing.T, value any) string {
	t.Helper()
	encoded, err := json.Marshal(value)
	if err != nil {
		t.Fatalf("序列化测试数据失败: %v", err)
	}
	return string(encoded)
}

type fakeJSONReader struct {
	values map[string]string
}

func (reader *fakeJSONReader) ReadJSON(key string, destination any) error {
	raw, found := reader.values[key]
	if !found {
		return errors.New("missing")
	}
	return json.Unmarshal([]byte(raw), destination)
}

func newWorkspaceReader(t *testing.T) *fakeJSONReader {
	t.Helper()
	return &fakeJSONReader{values: map[string]string{
		"ssh_workspaces": mustJSON(t, []Workspace{
			{ID: "ws-1", ConnectionID: "conn-1", RemoteRoot: "/srv/app"},
			{ID: "ws-2", ConnectionID: "missing"},
		}),
		"ssh_connections": mustJSON(t, []Connection{
			{ID: "conn-1", Host: "example.com", User: "me", Port: 2222, AuthType: "agent"},
		}),
	}}
}

func TestLoadWorkspace(t *testing.T) {
	t.Parallel()
	reader := newWorkspaceReader(t)
	workspace, connection, err := LoadWorkspace(reader, "ws-1")
	if err != nil {
		t.Fatalf("LoadWorkspace() error = %v", err)
	}
	if workspace.RemoteRoot != "/srv/app" || connection.Host != "example.com" || connection.Port != 2222 {
		t.Fatalf("workspace/connection = %#v / %#v", workspace, connection)
	}

	if _, _, err := LoadWorkspace(reader, "missing"); !errors.Is(err, ErrWorkspaceNotFound) {
		t.Fatalf("未知工作区 error = %v", err)
	}
	if _, _, err := LoadWorkspace(reader, "ws-2"); !errors.Is(err, ErrConnectionNotFound) {
		t.Fatalf("缺少连接 error = %v", err)
	}
	corrupted := &fakeJSONReader{values: map[string]string{"ssh_workspaces": "not-json"}}
	if _, _, err := LoadWorkspace(corrupted, "ws-1"); !errors.Is(err, ErrWorkspaceNotFound) {
		t.Fatalf("损坏数据按未配置处理，error = %v", err)
	}
}

type fakeProcessHandle struct {
	status ExitStatus
	killed bool
}

func (handle *fakeProcessHandle) Wait() ExitStatus { return handle.status }

func (handle *fakeProcessHandle) Kill() error {
	handle.killed = true
	return nil
}

type supervisorHarness struct {
	reader   *fakeJSONReader
	files    *fakeCredentialFS
	output   *bytes.Buffer
	statuses []ExitStatus
	launches int
	sleeps   []time.Duration
	now      time.Time
}

func newSupervisorHarness(t *testing.T, statuses ...ExitStatus) *supervisorHarness {
	t.Helper()
	return &supervisorHarness{
		reader:   newWorkspaceReader(t),
		files:    newFakeCredentialFS(),
		output:   &bytes.Buffer{},
		statuses: statuses,
		now:      time.Unix(0, 0),
	}
}

func (harness *supervisorHarness) supervisor() *Supervisor {
	return &Supervisor{
		State:       harness.reader,
		AIHomeDir:   "/home/aih",
		HomeDir:     "/home/me",
		WorkspaceID: "ws-1",
		SessionKey:  "ws-1",
		Output:      harness.output,
		FS:          harness.files,
		Launch: func(context.Context, Command) (ProcessHandle, error) {
			index := harness.launches
			harness.launches++
			if index >= len(harness.statuses) {
				return &fakeProcessHandle{status: ExitStatus{Code: 0}}, nil
			}
			return &fakeProcessHandle{status: harness.statuses[index]}, nil
		},
		Sleep: func(_ context.Context, delay time.Duration) bool {
			harness.sleeps = append(harness.sleeps, delay)
			return true
		},
		AfterFunc: func(_ time.Duration, _ func()) func() {
			return func() {}
		},
		Now: func() time.Time {
			harness.now = harness.now.Add(time.Second)
			return harness.now
		},
	}
}

func TestSupervisorRunReconnects(t *testing.T) {
	t.Parallel()
	harness := newSupervisorHarness(t,
		ExitStatus{Code: 255},
		ExitStatus{Code: 255},
		ExitStatus{Code: 0},
	)
	if exitCode := harness.supervisor().Run(context.Background()); exitCode != 0 {
		t.Fatalf("Run() = %d, want 0", exitCode)
	}
	if harness.launches != 3 {
		t.Fatalf("启动次数 = %d, want 3", harness.launches)
	}
	wantSleeps := []time.Duration{1 * time.Second, 2 * time.Second}
	if len(harness.sleeps) != len(wantSleeps) {
		t.Fatalf("sleeps = %#v, want %#v", harness.sleeps, wantSleeps)
	}
	for index, want := range wantSleeps {
		if harness.sleeps[index] != want {
			t.Fatalf("sleeps[%d] = %v, want %v", index, harness.sleeps[index], want)
		}
	}
	text := harness.output.String()
	if !strings.Contains(text, "1 秒后自动重连（第 1 次）") || !strings.Contains(text, "2 秒后自动重连（第 2 次）") {
		t.Fatalf("重连提示缺失: %q", text)
	}
}

func TestSupervisorRunStopsWhenContextCancelled(t *testing.T) {
	t.Parallel()
	harness := newSupervisorHarness(t)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if exitCode := harness.supervisor().Run(ctx); exitCode != 0 {
		t.Fatalf("Run() = %d, want 0", exitCode)
	}
	if harness.launches != 0 {
		t.Fatalf("取消后仍启动了 %d 次", harness.launches)
	}
}

func TestSupervisorRunWorkspaceUnavailable(t *testing.T) {
	t.Parallel()
	harness := newSupervisorHarness(t)
	harness.reader = &fakeJSONReader{values: map[string]string{}}
	if exitCode := harness.supervisor().Run(context.Background()); exitCode != 1 {
		t.Fatalf("Run() = %d, want 1", exitCode)
	}
	if !strings.Contains(harness.output.String(), "工作区已删除") {
		t.Fatalf("提示缺失: %q", harness.output.String())
	}
}

func TestSupervisorRunConnectionInvalid(t *testing.T) {
	t.Parallel()
	harness := newSupervisorHarness(t)
	harness.reader.values["ssh_connections"] = mustJSON(t, []Connection{{ID: "conn-1", Host: "  "}})
	if exitCode := harness.supervisor().Run(context.Background()); exitCode != 1 {
		t.Fatalf("Run() = %d, want 1", exitCode)
	}
	if !strings.Contains(harness.output.String(), "SSH 连接配置无效：ssh_connection_invalid") {
		t.Fatalf("提示缺失: %q", harness.output.String())
	}
}

func TestSupervisorRunLaunchFailureWipesCredentials(t *testing.T) {
	t.Parallel()
	harness := newSupervisorHarness(t)
	harness.reader.values["ssh_connections"] = mustJSON(t, []Connection{{
		ID: "conn-1", Host: "example.com", AuthType: "key", PrivateKey: "KEY",
	}})
	supervisor := harness.supervisor()
	supervisor.Launch = func(context.Context, Command) (ProcessHandle, error) {
		return nil, errors.New("spawn failed")
	}
	if exitCode := supervisor.Run(context.Background()); exitCode != 1 {
		t.Fatalf("Run() = %d, want 1", exitCode)
	}
	if !strings.Contains(harness.output.String(), "无法启动 ssh：spawn failed") {
		t.Fatalf("提示缺失: %q", harness.output.String())
	}
	keyFile := CredentialDir("/home/aih") + "/ws-1.key"
	if _, found := harness.files.files[keyFile]; found {
		t.Fatal("启动失败后临时私钥未擦除")
	}
}

func TestSupervisorRunScheduledWipe(t *testing.T) {
	t.Parallel()
	harness := newSupervisorHarness(t, ExitStatus{Code: 0})
	harness.reader.values["ssh_connections"] = mustJSON(t, []Connection{{
		ID: "conn-1", Host: "example.com", AuthType: "key", PrivateKey: "KEY",
	}})
	supervisor := harness.supervisor()
	// 启动即触发擦除回调，验证 Run 确实安排了定时擦除。
	supervisor.AfterFunc = func(_ time.Duration, callback func()) func() {
		callback()
		return func() {}
	}
	if exitCode := supervisor.Run(context.Background()); exitCode != 0 {
		t.Fatalf("Run() = %d, want 0", exitCode)
	}
	keyFile := CredentialDir("/home/aih") + "/ws-1.key"
	if _, found := harness.files.files[keyFile]; found {
		t.Fatal("定时擦除未生效")
	}
}
