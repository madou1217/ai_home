package main

import (
	"strings"
	"testing"

	"github.com/madou1217/ai_home/internal/runtime/persistent"
)

func pickerRows() []persistent.SessionRow {
	return []persistent.SessionRow{
		{Provider: "codebuddycn", Name: "p-a", NativeID: "01a1", Label: "会话A", Live: true},
		{Provider: "codebuddycn", Name: "p-b", Label: "会话B", Live: false},
	}
}

// TestPickerMovement 选中项在两端夹取，空列表不越界。
func TestPickerMovement(t *testing.T) {
	state := newPickerState(pickerRows())
	state.move(-1)
	if state.selected != 0 {
		t.Fatalf("selected = %d", state.selected)
	}
	state.move(10)
	if state.selected != 1 {
		t.Fatalf("selected = %d", state.selected)
	}
	empty := newPickerState(nil)
	empty.move(1)
	if empty.selected != 0 || empty.current() != nil {
		t.Fatalf("empty selected = %d", empty.selected)
	}
}

// TestPickerHandleKey 按键映射与 Node 选择器一致。
func TestPickerHandleKey(t *testing.T) {
	cases := map[string]pickerAction{
		"up": pickerNone, "k": pickerNone,
		"down": pickerNone, "j": pickerNone,
		"d":     pickerNone,
		"enter": pickerAttach,
		"c":     pickerCopyID,
		"y":     pickerCopyCommand,
		"x":     pickerClose,
		"X":     pickerCloseIdle,
		"q":     pickerQuit, "esc": pickerQuit, "ctrl-c": pickerQuit,
	}
	for key, want := range cases {
		state := newPickerState(pickerRows())
		if got := state.handleKey(key); got != want {
			t.Fatalf("handleKey(%q) = %v, want %v", key, got, want)
		}
	}
	if got := newPickerState(nil).handleKey("enter"); got != pickerNone {
		t.Fatalf("空列表回车 = %v", got)
	}
}

// TestParsePickerKey 方向键、回车、Ctrl-C 与单字符。
func TestParsePickerKey(t *testing.T) {
	cases := map[string]string{
		"\x1b[A": "up", "\x1b[B": "down", "\x1b": "esc",
		"\r": "enter", "\n": "enter", "\x03": "ctrl-c", "x": "x",
	}
	for raw, want := range cases {
		if got := parsePickerKey([]byte(raw)); got != want {
			t.Fatalf("parsePickerKey(%q) = %q, want %q", raw, got, want)
		}
	}
}

// TestPickerCopyText 优先原生会话 id，其次 tmux 名；y 生成 resume 命令。
func TestPickerCopyText(t *testing.T) {
	row := persistent.SessionRow{Provider: "codebuddycn", Name: "p-a", NativeID: "01a1"}
	if got := pickerCopyText(row); got != "01a1" {
		t.Fatalf("copy = %q", got)
	}
	if got := pickerResumeCommand(row); got != "aih codebuddycn resume 01a1" {
		t.Fatalf("command = %q", got)
	}
	withoutNative := persistent.SessionRow{Provider: "codebuddycn", Name: "p-b"}
	if got := pickerCopyText(withoutNative); got != "p-b" {
		t.Fatalf("fallback = %q", got)
	}
}

// TestRenderPicker 选中行有标记，详情里展示原生会话 id。
func TestRenderPicker(t *testing.T) {
	state := newPickerState(pickerRows())
	var output strings.Builder
	renderPicker(&output, state, map[string]string{})
	text := output.String()
	if !strings.Contains(text, "> ● 运行中") || !strings.Contains(text, "活跃持久会话（2）") {
		t.Fatalf("render = %q", text)
	}
	state.detail = true
	output.Reset()
	renderPicker(&output, state, map[string]string{})
	if !strings.Contains(output.String(), "原生会话 id: 01a1") {
		t.Fatalf("detail = %q", output.String())
	}
}
