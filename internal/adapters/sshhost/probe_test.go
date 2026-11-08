package sshhost

import (
	"context"
	"reflect"
	"strings"
	"testing"
	"time"
)

func TestBuildSSHArgs(t *testing.T) {
	t.Parallel()
	cases := []struct {
		name    string
		target  Target
		options ProbeOptions
		want    []string
	}{
		{
			name:   "默认参数",
			target: Target{Host: "example.com"},
			want: []string{
				"-o", "BatchMode=yes",
				"-o", "ConnectTimeout=12",
				"-o", "StrictHostKeyChecking=accept-new",
				"example.com", BuildRemoteProbeCommand(),
			},
		},
		{
			name:   "用户端口与私钥文件",
			target: Target{Host: "example.com", User: "me", Port: 2222},
			options: ProbeOptions{
				Timeout:         3 * time.Second,
				SSHIdentityFile: "/home/me/.ssh/id_ed25519",
			},
			want: []string{
				"-o", "BatchMode=yes",
				"-o", "ConnectTimeout=3",
				"-o", "StrictHostKeyChecking=accept-new",
				"-i", "/home/me/.ssh/id_ed25519",
				"-p", "2222",
				"me@example.com", BuildRemoteProbeCommand(),
			},
		},
		{
			name:    "超时向上取整",
			target:  Target{Host: "example.com"},
			options: ProbeOptions{Timeout: 12500 * time.Millisecond},
			want: []string{
				"-o", "BatchMode=yes",
				"-o", "ConnectTimeout=13",
				"-o", "StrictHostKeyChecking=accept-new",
				"example.com", BuildRemoteProbeCommand(),
			},
		},
		{
			name:    "不足一秒按一秒",
			target:  Target{Host: "example.com"},
			options: ProbeOptions{Timeout: 200 * time.Millisecond},
			want: []string{
				"-o", "BatchMode=yes",
				"-o", "ConnectTimeout=1",
				"-o", "StrictHostKeyChecking=accept-new",
				"example.com", BuildRemoteProbeCommand(),
			},
		},
	}
	for _, testCase := range cases {
		testCase := testCase
		t.Run(testCase.name, func(t *testing.T) {
			t.Parallel()
			got := BuildSSHArgs(testCase.target, testCase.options)
			if !reflect.DeepEqual(got, testCase.want) {
				t.Fatalf("BuildSSHArgs() = %#v, want %#v", got, testCase.want)
			}
		})
	}
}

func TestBuildRemoteProbeCommand(t *testing.T) {
	t.Parallel()
	command := BuildRemoteProbeCommand()
	for _, fragment := range []string{"uname -s", "uname -m", "node npm git aih", "=present"} {
		if !strings.Contains(command, fragment) {
			t.Fatalf("探测命令缺少 %q: %s", fragment, command)
		}
	}
}

func TestBuildWindowsRemoteProbeCommand(t *testing.T) {
	t.Parallel()
	command := BuildWindowsRemoteProbeCommand()
	const prefix = "powershell -NoProfile -ExecutionPolicy Bypass -EncodedCommand "
	if !strings.HasPrefix(command, prefix) {
		t.Fatalf("命令前缀错误: %s", command)
	}
	script := decodeUTF16LEBase64(t, strings.TrimPrefix(command, prefix))
	for _, fragment := range []string{"platform=Windows", "PROCESSOR_ARCHITECTURE", "Get-Command"} {
		if !strings.Contains(script, fragment) {
			t.Fatalf("脚本缺少 %q: %q", fragment, script)
		}
	}
}

func TestDetectAuthRequired(t *testing.T) {
	t.Parallel()
	cases := []struct {
		name   string
		result ProcessResult
		want   bool
	}{
		{name: "publickey 拒绝", result: ProcessResult{Stderr: "Permission denied (publickey)."}, want: true},
		{name: "password 拒绝", result: ProcessResult{Stderr: "permission denied (publickey,password)"}, want: true},
		{name: "keyboard-interactive", result: ProcessResult{Stderr: "Permission denied (keyboard-interactive)."}, want: true},
		{name: "超时不判定为认证问题", result: ProcessResult{Stderr: "Permission denied (publickey).", TimedOut: true}, want: false},
		{name: "连接拒绝", result: ProcessResult{Stderr: "Connection refused"}, want: false},
		{name: "空 stderr", result: ProcessResult{}, want: false},
	}
	for _, testCase := range cases {
		testCase := testCase
		t.Run(testCase.name, func(t *testing.T) {
			t.Parallel()
			if got := DetectAuthRequired(testCase.result); got != testCase.want {
				t.Fatalf("DetectAuthRequired() = %v, want %v", got, testCase.want)
			}
		})
	}
}

func TestParseFacts(t *testing.T) {
	t.Parallel()
	facts := ParseFacts("platform=Linux\r\narch=x86_64\nnode=present\nempty=\n=nokey\nnoequals\n")
	want := map[string]string{
		"platform": "Linux",
		"arch":     "x86_64",
		"node":     "present",
		"empty":    "",
	}
	if !reflect.DeepEqual(facts, want) {
		t.Fatalf("ParseFacts() = %#v, want %#v", facts, want)
	}
}

func TestRecommendationFor(t *testing.T) {
	t.Parallel()
	cases := []struct {
		name   string
		status string
		facts  map[string]string
		want   string
	}{
		{name: "认证失败", status: "auth-required", facts: map[string]string{}, want: "SSH 可达，但需要认证；请检查私钥、agent 或密码。"},
		{name: "不可达", status: "unreachable", facts: map[string]string{}, want: "SSH 不可达；请检查主机地址、端口和防火墙。"},
		{name: "全部就绪", status: "reachable", facts: map[string]string{"node": "present", "npm": "present", "git": "present", "aih": "present"}, want: "SSH 连接正常。"},
		{name: "缺少工具", status: "reachable", facts: map[string]string{"node": "present"}, want: "SSH 正常；远端缺少 npm / git / aih，部分功能可能不可用。"},
	}
	for _, testCase := range cases {
		testCase := testCase
		t.Run(testCase.name, func(t *testing.T) {
			t.Parallel()
			if got := RecommendationFor(testCase.status, testCase.facts); got != testCase.want {
				t.Fatalf("RecommendationFor() = %q, want %q", got, testCase.want)
			}
		})
	}
}

type runnerCall struct {
	name string
	args []string
}

func TestProbeSSHTarget(t *testing.T) {
	t.Parallel()
	posixFacts := "platform=Linux\narch=x86_64\nnode=present\nnpm=present\ngit=present\naih=missing\n"
	windowsFacts := "platform=Windows\narch=AMD64\nnode=present\n"
	cases := []struct {
		name          string
		target        Target
		results       []ProcessResult
		wantStatus    string
		wantPlatform  string
		wantArch      string
		wantNode      bool
		wantCalls     int
		wantTimedOut  bool
		wantRecommend string
	}{
		{
			name:          "POSIX 直连成功",
			target:        Target{Host: "example.com", User: "me"},
			results:       []ProcessResult{{Status: 0, Stdout: posixFacts}},
			wantStatus:    "reachable",
			wantPlatform:  "Linux",
			wantArch:      "x86_64",
			wantNode:      true,
			wantCalls:     1,
			wantRecommend: "SSH 正常；远端缺少 aih，部分功能可能不可用。",
		},
		{
			name:          "超时只跑一次",
			target:        Target{Host: "example.com"},
			results:       []ProcessResult{{Status: 124, TimedOut: true, Stderr: "timeout"}},
			wantStatus:    "unreachable",
			wantCalls:     1,
			wantTimedOut:  true,
			wantRecommend: "SSH 不可达；请检查主机地址、端口和防火墙。",
		},
		{
			name:   "认证失败",
			target: Target{Host: "example.com"},
			results: []ProcessResult{
				{Status: 255, Stderr: "Permission denied (publickey,password)."},
				{Status: 255, Stderr: "Permission denied (publickey,password)."},
			},
			wantStatus:    "auth-required",
			wantCalls:     2,
			wantRecommend: "SSH 可达，但需要认证；请检查私钥、agent 或密码。",
		},
		{
			name:   "Windows 回退成功",
			target: Target{Host: "example.com"},
			results: []ProcessResult{
				{Status: 1, Stderr: "uname: not found"},
				{Status: 0, Stdout: windowsFacts},
			},
			wantStatus:    "reachable",
			wantPlatform:  "Windows",
			wantArch:      "AMD64",
			wantNode:      true,
			wantCalls:     2,
			wantRecommend: "SSH 正常；远端缺少 npm / git / aih，部分功能可能不可用。",
		},
	}
	for _, testCase := range cases {
		testCase := testCase
		t.Run(testCase.name, func(t *testing.T) {
			t.Parallel()
			callIndex := 0
			calls := make([]runnerCall, 0)
			runner := func(_ context.Context, name string, args []string, _ time.Duration) ProcessResult {
				calls = append(calls, runnerCall{name: name, args: args})
				if callIndex >= len(testCase.results) {
					t.Fatalf("第 %d 次调用没有预置结果", callIndex)
				}
				result := testCase.results[callIndex]
				callIndex++
				return result
			}
			probe := ProbeSSHTarget(context.Background(), testCase.target, ProbeOptions{Runner: runner})
			if len(calls) != testCase.wantCalls {
				t.Fatalf("调用次数 = %d, want %d", len(calls), testCase.wantCalls)
			}
			if probe.Status != testCase.wantStatus {
				t.Fatalf("Status = %q, want %q", probe.Status, testCase.wantStatus)
			}
			if probe.Platform != testCase.wantPlatform || probe.Arch != testCase.wantArch {
				t.Fatalf("Platform/Arch = %q/%q", probe.Platform, probe.Arch)
			}
			if probe.Commands["node"] != testCase.wantNode {
				t.Fatalf("node = %v", probe.Commands["node"])
			}
			if probe.TimedOut != testCase.wantTimedOut {
				t.Fatalf("TimedOut = %v", probe.TimedOut)
			}
			if probe.Recommendation != testCase.wantRecommend {
				t.Fatalf("Recommendation = %q, want %q", probe.Recommendation, testCase.wantRecommend)
			}
			if probe.Kind != "ssh" || probe.Port != 22 {
				t.Fatalf("Kind/Port = %q/%d", probe.Kind, probe.Port)
			}
			wantTarget := testCase.target.Host
			if testCase.target.User != "" {
				wantTarget = testCase.target.User + "@" + testCase.target.Host
			}
			if probe.Target != wantTarget {
				t.Fatalf("Target = %q, want %q", probe.Target, wantTarget)
			}
			if len(calls) == 2 && !strings.Contains(calls[1].args[len(calls[1].args)-1], "powershell") {
				t.Fatalf("回退命令不是 PowerShell: %q", calls[1].args[len(calls[1].args)-1])
			}
		})
	}
}

func TestProbeSSHTargetTruncatesStderr(t *testing.T) {
	t.Parallel()
	longStderr := strings.Repeat("x", 2000)
	runner := func(context.Context, string, []string, time.Duration) ProcessResult {
		return ProcessResult{Status: 255, Stderr: longStderr}
	}
	probe := ProbeSSHTarget(context.Background(), Target{Host: "example.com"}, ProbeOptions{Runner: runner})
	if len(probe.Stderr) != 1000 {
		t.Fatalf("stderr 长度 = %d, want 1000", len(probe.Stderr))
	}
}
