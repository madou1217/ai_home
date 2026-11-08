package sshhost

import (
	"reflect"
	"testing"
)

func TestParseAihSSHArgs(t *testing.T) {
	t.Parallel()
	cases := []struct {
		name string
		args []string
		want ParsedSSHArgs
	}{
		{
			name: "空参数",
			args: nil,
			want: ParsedSSHArgs{SSHArgs: []string{}, RemoteArgs: []string{}, MaxBytes: DefaultClipMaxBytes, ChunkSize: DefaultClipChunkSize},
		},
		{
			name: "普通 ssh 参数",
			args: []string{"-p", "2222", "me@example.com"},
			want: ParsedSSHArgs{SSHArgs: []string{"-p", "2222", "me@example.com"}, RemoteArgs: []string{}, MaxBytes: DefaultClipMaxBytes, ChunkSize: DefaultClipChunkSize},
		},
		{
			name: "分隔符后的远端命令",
			args: []string{"me@example.com", "--", "aih", "claude", "--resume"},
			want: ParsedSSHArgs{
				SSHArgs:    []string{"me@example.com"},
				RemoteArgs: []string{"aih", "claude", "--resume"},
				MaxBytes:   DefaultClipMaxBytes,
				ChunkSize:  DefaultClipChunkSize,
			},
		},
		{
			name: "剪贴板开关",
			args: []string{"--watch-clipboard", "me@example.com", "--no-watch-clipboard"},
			want: ParsedSSHArgs{
				SSHArgs:        []string{"me@example.com"},
				RemoteArgs:     []string{},
				WatchClipboard: false,
				MaxBytes:       DefaultClipMaxBytes,
				ChunkSize:      DefaultClipChunkSize,
			},
		},
		{
			name: "开关最终生效值",
			args: []string{"--aih-no-watch-clipboard", "--aih-watch-clipboard", "host"},
			want: ParsedSSHArgs{
				SSHArgs:        []string{"host"},
				RemoteArgs:     []string{},
				WatchClipboard: true,
				MaxBytes:       DefaultClipMaxBytes,
				ChunkSize:      DefaultClipChunkSize,
			},
		},
		{
			name: "剪贴板大小与分片",
			args: []string{"--clip-max-bytes", "1024", "--aih-clip-chunk-size", "512", "host"},
			want: ParsedSSHArgs{
				SSHArgs:    []string{"host"},
				RemoteArgs: []string{},
				MaxBytes:   1024,
				ChunkSize:  512,
			},
		},
		{
			name: "非法数值回退",
			args: []string{"--clip-max-bytes", "0", "--clip-chunk-size", "abc", "host"},
			want: ParsedSSHArgs{
				SSHArgs:    []string{"host"},
				RemoteArgs: []string{},
				MaxBytes:   DefaultClipMaxBytes,
				ChunkSize:  DefaultClipChunkSize,
			},
		},
		{
			name: "缺少数值时回退且不吞掉后续参数",
			args: []string{"--clip-max-bytes", "host"},
			want: ParsedSSHArgs{
				SSHArgs:    []string{},
				RemoteArgs: []string{},
				MaxBytes:   DefaultClipMaxBytes,
				ChunkSize:  DefaultClipChunkSize,
			},
		},
	}
	for _, testCase := range cases {
		testCase := testCase
		t.Run(testCase.name, func(t *testing.T) {
			t.Parallel()
			got := ParseAihSSHArgs(testCase.args)
			if !reflect.DeepEqual(got, testCase.want) {
				t.Fatalf("ParseAihSSHArgs() = %#v, want %#v", got, testCase.want)
			}
		})
	}
}

func TestShellQuoteRemoteArg(t *testing.T) {
	t.Parallel()
	cases := []struct {
		input string
		want  string
	}{
		{input: "aih", want: "aih"},
		{input: "claude", want: "claude"},
		{input: "--resume=abc", want: "--resume=abc"},
		{input: "/usr/local/bin/aih", want: "/usr/local/bin/aih"},
		{input: "a b", want: "'a b'"},
		{input: "it's", want: "'it'\\''s'"},
		{input: "", want: "''"},
		{input: "a;rm -rf /", want: "'a;rm -rf /'"},
	}
	for _, testCase := range cases {
		testCase := testCase
		t.Run(testCase.input, func(t *testing.T) {
			t.Parallel()
			if got := ShellQuoteRemoteArg(testCase.input); got != testCase.want {
				t.Fatalf("ShellQuoteRemoteArg(%q) = %q, want %q", testCase.input, got, testCase.want)
			}
		})
	}
}

func TestBuildSSHSpawnArgs(t *testing.T) {
	t.Parallel()
	cases := []struct {
		name   string
		parsed ParsedSSHArgs
		want   []string
	}{
		{
			name:   "没有远端命令",
			parsed: ParsedSSHArgs{SSHArgs: []string{"-p", "2222", "host"}},
			want:   []string{"-p", "2222", "host"},
		},
		{
			name: "拼接远端命令",
			parsed: ParsedSSHArgs{
				SSHArgs:    []string{"host"},
				RemoteArgs: []string{"aih", "claude", "--prompt", "hello world"},
			},
			want: []string{"host", "aih claude --prompt 'hello world'"},
		},
	}
	for _, testCase := range cases {
		testCase := testCase
		t.Run(testCase.name, func(t *testing.T) {
			t.Parallel()
			if got := BuildSSHSpawnArgs(testCase.parsed); !reflect.DeepEqual(got, testCase.want) {
				t.Fatalf("BuildSSHSpawnArgs() = %#v, want %#v", got, testCase.want)
			}
		})
	}
}

func TestClipboardTriggers(t *testing.T) {
	t.Parallel()
	altVCases := []struct {
		input string
		want  bool
	}{
		{input: "\x1bv", want: true},
		{input: "\x1bV", want: true},
		{input: "\x1b[118;3u", want: true},
		{input: "\x1b[86;3;1u", want: true},
		{input: "\x1b[27;3;118~", want: true},
		{input: "\x1b[27;3;86;1~", want: true},
		{input: "v", want: false},
		{input: "\x1bvx", want: false},
		{input: "\x16", want: false},
		{input: "\x1b[118;5u", want: false},
	}
	for _, testCase := range altVCases {
		testCase := testCase
		t.Run("alt/"+testCase.input, func(t *testing.T) {
			t.Parallel()
			if got := IsAltVClipboardTrigger([]byte(testCase.input)); got != testCase.want {
				t.Fatalf("IsAltVClipboardTrigger(%q) = %v, want %v", testCase.input, got, testCase.want)
			}
		})
	}

	ctrlVCases := []struct {
		input string
		want  bool
	}{
		{input: "\x16", want: true},
		{input: "\x1b[118;5u", want: true},
		{input: "\x1b[86;4;2u", want: true},
		{input: "\x1b[27;5;118~", want: true},
		{input: "\x1b[27;4;86~", want: true},
		{input: "v", want: false},
		{input: "\x16x", want: false},
		{input: "\x1b[118;3u", want: false},
	}
	for _, testCase := range ctrlVCases {
		testCase := testCase
		t.Run("ctrl/"+testCase.input, func(t *testing.T) {
			t.Parallel()
			if got := IsCtrlVClipboardTrigger([]byte(testCase.input)); got != testCase.want {
				t.Fatalf("IsCtrlVClipboardTrigger(%q) = %v, want %v", testCase.input, got, testCase.want)
			}
		})
	}
}

func TestBracketedPaste(t *testing.T) {
	t.Parallel()
	if !IsEmptyBracketedPaste([]byte("\x1b[200~\x1b[201~")) {
		t.Fatal("空 bracketed paste 未识别")
	}
	if IsEmptyBracketedPaste([]byte("\x1b[200~x\x1b[201~")) {
		t.Fatal("非空内容不应判为空粘贴")
	}
	payload, ok := ExtractBracketedPastePayload([]byte("\x1b[200~hello\x1b[201~"))
	if !ok || payload != "hello" {
		t.Fatalf("payload = %q, ok = %v", payload, ok)
	}
	if _, ok := ExtractBracketedPastePayload([]byte("hello")); ok {
		t.Fatal("普通文本不应命中")
	}
}
