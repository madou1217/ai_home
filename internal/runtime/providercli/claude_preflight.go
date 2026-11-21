package providercli

import (
	"encoding/json"
	"errors"
	"fmt"
	"github.com/madou1217/ai_home/internal/adapters/providerstorage/providerroot"
	"os"
	"path/filepath"
	"strings"
)

// ClaudePreflight 是启动 Claude CLI 时的首屏检查决策。
//
// Suppress=true 时在该配置根的 .claude.json 写入 onboarding 完成标记，跳过官方
// 首屏连通性检查；否则保留 Claude Code 自身的流程。Warning 只在启动前打印一次。
type ClaudePreflight struct {
	Suppress bool
	Warning  string
}

// applyClaudePreflight 在 Claude 子进程启动前执行首屏检查策略。
func (runner *Runner) applyClaudePreflight() {
	if runner == nil {
		return
	}
	policy := runner.claudePreflight
	if policy.Warning != "" {
		_, _ = fmt.Fprintf(runner.stderr, "aih: %s\n", policy.Warning)
	}
	if !policy.Suppress {
		return
	}
	home := strings.TrimSpace(runner.hostHomeDir)
	if home == "" {
		return
	}
	if err := ensureClaudeOnboarding(filepath.Join(home, providerroot.ConfigDir("claude"))); err != nil {
		_, _ = fmt.Fprintf(runner.stderr, "aih: 跳过 Claude 首屏检查失败: %v\n", err)
	}
}

// ensureClaudeOnboarding 保证 <configDir>/.claude.json 带有 onboarding 完成标记。
// 已有标记时不改写文件；缺失或为 false 时保留其余键，仅覆盖该字段。
func ensureClaudeOnboarding(configDir string) error {
	if strings.TrimSpace(configDir) == "" {
		return errors.New("Claude 配置根为空")
	}
	path := filepath.Join(configDir, ".claude.json")
	data, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		if mkdirErr := os.MkdirAll(configDir, 0o700); mkdirErr != nil {
			return mkdirErr
		}
		return writeClaudeConfig(path, map[string]json.RawMessage{
			"hasCompletedOnboarding": json.RawMessage("true"),
		})
	}
	if err != nil {
		return err
	}
	document := map[string]json.RawMessage{}
	if err := json.Unmarshal(data, &document); err != nil {
		return err
	}
	if raw, exists := document["hasCompletedOnboarding"]; exists {
		var completed bool
		if json.Unmarshal(raw, &completed) == nil && completed {
			return nil
		}
	}
	document["hasCompletedOnboarding"] = json.RawMessage("true")
	return writeClaudeConfig(path, document)
}

// writeClaudeConfig 以 0600 原子替换配置文件，避免半截 JSON 留在磁盘上。
func writeClaudeConfig(path string, document map[string]json.RawMessage) error {
	encoded, err := json.MarshalIndent(document, "", "  ")
	if err != nil {
		return err
	}
	encoded = append(encoded, '\n')
	temporary, err := os.CreateTemp(filepath.Dir(path), ".claude.json.aih-*")
	if err != nil {
		return err
	}
	temporaryPath := temporary.Name()
	defer func() {
		_ = temporary.Close()
		_ = os.Remove(temporaryPath)
	}()
	if err := temporary.Chmod(0o600); err != nil {
		return err
	}
	if _, err := temporary.Write(encoded); err != nil {
		return err
	}
	if err := temporary.Sync(); err != nil {
		return err
	}
	if err := temporary.Close(); err != nil {
		return err
	}
	return os.Rename(temporaryPath, path)
}
