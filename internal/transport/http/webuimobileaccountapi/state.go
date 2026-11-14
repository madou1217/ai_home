package webuimobileaccountapi

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	accountcore "github.com/madou1217/ai_home/core/accounts"
)

const hookStateRelativePath = "run/codex/desktop-hook-state.json"

// errHookStateInvalid 表示状态文件存在但不是 JSON 对象。
// 这种情况下宁可报错也不覆盖：直接重写会把用户其它字段一起丢掉。
var errHookStateInvalid = errors.New("Codex App 状态文件无效")

// HookStatePath 返回 Codex Desktop 钩子状态文件路径。
func HookStatePath(aiHomeDir string) string {
	return filepath.Join(strings.TrimSpace(aiHomeDir), hookStateRelativePath)
}

// ReadDesktopAccountRef 只读返回当前绑定的 Codex Desktop 账号引用；缺失、损坏或非法时返回空串。
func ReadDesktopAccountRef(aiHomeDir string) string {
	trimmedDir := strings.TrimSpace(aiHomeDir)
	if trimmedDir == "" {
		return ""
	}
	state, exists, err := readHookState(HookStatePath(trimmedDir))
	if err != nil || !exists {
		return ""
	}
	accountRef := normalizeDesktopAccountRef(state["desktopAccountRef"])
	if _, parseErr := accountcore.ParseAccountRef(accountRef); parseErr != nil {
		return ""
	}
	return accountRef
}

type hookStateResult struct {
	DesktopAccountRef string
	Changed           bool
}

type hookStateStore struct {
	path string
	now  func() time.Time
}

// setDesktopAccountRef 把 desktopAccountRef 写成目标账号；其它键原样保留。
func (store *hookStateStore) setDesktopAccountRef(accountRef string) (hookStateResult, error) {
	state, _, err := readHookState(store.path)
	if err != nil {
		return hookStateResult{}, err
	}
	current := normalizeDesktopAccountRef(state["desktopAccountRef"])
	if current == accountRef {
		return hookStateResult{DesktopAccountRef: accountRef, Changed: false}, nil
	}
	state["desktopAccountRef"] = marshalString(accountRef)
	state["updatedAt"] = marshalString(store.timestamp())
	if err := writeHookState(store.path, state); err != nil {
		return hookStateResult{}, err
	}
	return hookStateResult{DesktopAccountRef: accountRef, Changed: true}, nil
}

// clearDesktopAccountRef 只在当前指向 expected（expected 为空时任意账号）时清空。
// 指向别的账号时返回当前值且 changed=false，不碰文件。
func (store *hookStateStore) clearDesktopAccountRef(expected string) (hookStateResult, error) {
	state, exists, err := readHookState(store.path)
	if err != nil {
		return hookStateResult{}, err
	}
	if !exists {
		return hookStateResult{DesktopAccountRef: "", Changed: false}, nil
	}
	current := normalizeDesktopAccountRef(state["desktopAccountRef"])
	if current == "" {
		return hookStateResult{DesktopAccountRef: "", Changed: false}, nil
	}
	if expected != "" && current != expected {
		return hookStateResult{DesktopAccountRef: current, Changed: false}, nil
	}
	state["desktopAccountRef"] = marshalString("")
	state["updatedAt"] = marshalString(store.timestamp())
	if err := writeHookState(store.path, state); err != nil {
		return hookStateResult{}, err
	}
	return hookStateResult{DesktopAccountRef: "", Changed: true}, nil
}

func (store *hookStateStore) timestamp() string {
	now := time.Now
	if store.now != nil {
		now = store.now
	}
	return now().UTC().Format("2006-01-02T15:04:05.000Z")
}

// readHookState 返回原始键值，保证未识别字段在写回时不被丢弃。
func readHookState(path string) (map[string]json.RawMessage, bool, error) {
	data, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return map[string]json.RawMessage{}, false, nil
	}
	if err != nil {
		return nil, false, fmt.Errorf("读取 Codex App 状态文件失败: %w", err)
	}
	var state map[string]json.RawMessage
	if err := json.Unmarshal(data, &state); err != nil {
		return nil, true, fmt.Errorf("%w: %v", errHookStateInvalid, err)
	}
	if state == nil {
		state = map[string]json.RawMessage{}
	}
	return state, true, nil
}

func writeHookState(path string, state map[string]json.RawMessage) error {
	payload, err := json.MarshalIndent(state, "", "  ")
	if err != nil {
		return fmt.Errorf("编码 Codex App 状态文件失败: %w", err)
	}
	directory := filepath.Dir(path)
	if err := os.MkdirAll(directory, 0o700); err != nil {
		return fmt.Errorf("创建 Codex App 状态目录失败: %w", err)
	}
	temporary, err := os.CreateTemp(directory, ".desktop-hook-state-*.tmp")
	if err != nil {
		return fmt.Errorf("创建 Codex App 状态临时文件失败: %w", err)
	}
	tempPath := temporary.Name()
	defer func() { _ = os.Remove(tempPath) }()
	if err := temporary.Chmod(0o600); err != nil {
		_ = temporary.Close()
		return fmt.Errorf("设置 Codex App 状态文件权限失败: %w", err)
	}
	_, writeErr := temporary.Write(payload)
	closeErr := temporary.Close()
	if err := errors.Join(writeErr, closeErr); err != nil {
		return fmt.Errorf("写入 Codex App 状态文件失败: %w", err)
	}
	if err := os.Rename(tempPath, path); err != nil {
		return fmt.Errorf("替换 Codex App 状态文件失败: %w", err)
	}
	return nil
}

// normalizeDesktopAccountRef 把存储值归一成规范账号引用；非法值按空处理。
func normalizeDesktopAccountRef(raw json.RawMessage) string {
	if len(raw) == 0 {
		return ""
	}
	var value string
	if err := json.Unmarshal(raw, &value); err != nil {
		return ""
	}
	accountRef, err := accountcore.ParseAccountRef(strings.TrimSpace(value))
	if err != nil {
		return ""
	}
	return accountRef.String()
}

func marshalString(value string) json.RawMessage {
	encoded, _ := json.Marshal(value)
	return encoded
}
