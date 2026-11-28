// Package agentinstructions 把各 AI CLI 的用户级指令文件统一到一份真源。
//
// 设计：<hostHome>/AGENTS.md 是唯一真源，各 CLI 的全局指令文件都是指向它的
// 软链。一条规则只写一次，所有 CLI 都能读到；新装/重装 CLI 后由 server 启动
// 时自愈，不需要人工补软链。
package agentinstructions

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// CanonicalName 是真源文件名，位于 host home 根目录。
const CanonicalName = "AGENTS.md"

// DefaultTargets 是各 CLI 的全局指令文件，相对 host home。
// 只有父目录已存在时才处理：说明该 CLI 装过，不给没装的工具造目录。
var DefaultTargets = []string{
	".codebuddy/CODEBUDDY.md",    // CodeBuddy
	".codebuddy-cn/CODEBUDDY.md", // CodeBuddy CN
	".claude/CLAUDE.md",          // Claude Code
	".codex/AGENTS.md",           // Codex
	".gemini/GEMINI.md",          // Gemini CLI
}

const seedContent = `# AGENTS.md — 全局规则（所有项目 / 所有 AI）

<!--
本文件是所有 AI CLI 的唯一真源，由 aih server 在安装/启动时自动维护。
~/.codebuddy/CODEBUDDY.md、~/.codebuddy-cn/CODEBUDDY.md、~/.claude/CLAUDE.md、
~/.codex/AGENTS.md、~/.gemini/GEMINI.md 都是指向本文件的软链：只改这里。
-->
`

// Options 是 Ensure 的输入。
type Options struct {
	// HostHome 是宿主用户主目录（不是 AIH 数据目录）。
	HostHome string
	// Targets 覆盖默认目标列表（测试用）；相对路径按 HostHome 解析。
	Targets []string
	// Logf 接收迁移/链接结果；nil 时静默。
	Logf func(format string, args ...any)
}

// Result 汇总本次同步动作，便于启动日志和测试断言。
type Result struct {
	Canonical        string
	CreatedCanonical bool
	Linked           []string
	Migrated         []string
	AlreadyLinked    []string
	Skipped          []string
}

type outcome int

const (
	// outcomeNotInstalled 表示该 CLI 未安装（父目录不存在），不是异常，不记入
	// Skipped，否则每次启动日志都会被未安装的工具刷屏。
	outcomeNotInstalled outcome = iota
	outcomeSkipped
	outcomeLinked
	outcomeMigrated
	outcomeAlreadyLinked
)

// Ensure 保证 canonical 存在，并把各 CLI 的指令文件接成指向它的软链。
//
// 幂等；已有普通文件不会被静默丢弃：内容会先并入 canonical（去重），原文
// 备份为 <target>.aih-backup-<时间戳>，再替换成软链。指针别处的软链保持不动。
func Ensure(ctx context.Context, opts Options) (Result, error) {
	hostHome := strings.TrimSpace(opts.HostHome)
	if hostHome == "" {
		return Result{}, errors.New("agentinstructions: host home is empty")
	}
	absHome, err := filepath.Abs(hostHome)
	if err != nil {
		return Result{}, fmt.Errorf("agentinstructions: resolve host home: %w", err)
	}
	if info, statErr := os.Stat(absHome); statErr != nil || !info.IsDir() {
		return Result{}, fmt.Errorf("agentinstructions: host home %s is not a directory", absHome)
	}

	canonical := filepath.Join(absHome, CanonicalName)
	result := Result{Canonical: canonical}

	created, err := ensureCanonical(canonical)
	if err != nil {
		return result, err
	}
	result.CreatedCanonical = created

	targets := opts.Targets
	if len(targets) == 0 {
		targets = DefaultTargets
	}
	logf := opts.Logf
	if logf == nil {
		logf = func(string, ...any) {}
	}

	for _, rel := range targets {
		if err := ctx.Err(); err != nil {
			return result, err
		}
		rel = strings.TrimSpace(rel)
		if rel == "" {
			continue
		}
		target := rel
		if !filepath.IsAbs(target) {
			target = filepath.Join(absHome, rel)
		}
		got, targetErr := ensureTarget(canonical, target, rel)
		if targetErr != nil {
			result.Skipped = append(result.Skipped, target)
			logf("[aih] 全局指令文件跳过 %s: %v", target, targetErr)
			continue
		}
		switch got {
		case outcomeLinked:
			result.Linked = append(result.Linked, target)
			logf("[aih] 全局指令文件已链接 %s -> %s", target, canonical)
		case outcomeMigrated:
			result.Migrated = append(result.Migrated, target)
			logf("[aih] 全局指令文件已并入真源并链接 %s -> %s", target, canonical)
		case outcomeAlreadyLinked:
			result.AlreadyLinked = append(result.AlreadyLinked, target)
		case outcomeSkipped:
			result.Skipped = append(result.Skipped, target)
		}
	}
	return result, nil
}

func ensureCanonical(path string) (bool, error) {
	info, err := os.Lstat(path)
	if err == nil {
		if info.IsDir() {
			return false, fmt.Errorf("agentinstructions: %s is a directory", path)
		}
		return false, nil
	}
	if !os.IsNotExist(err) {
		return false, err
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return false, err
	}
	if err := os.WriteFile(path, []byte(seedContent), 0o644); err != nil {
		return false, err
	}
	return true, nil
}

func ensureTarget(canonical, target, label string) (outcome, error) {
	// 父目录不存在说明该 CLI 没装，跳过而不是造目录。
	if info, err := os.Stat(filepath.Dir(target)); err != nil || !info.IsDir() {
		return outcomeNotInstalled, nil
	}
	info, err := os.Lstat(target)
	if os.IsNotExist(err) {
		return outcomeLinked, linkTo(canonical, target)
	}
	if err != nil {
		return outcomeSkipped, err
	}
	if info.Mode()&os.ModeSymlink != 0 {
		resolved, resolveErr := filepath.EvalSymlinks(target)
		if resolveErr == nil && sameFile(resolved, canonical) {
			return outcomeAlreadyLinked, nil
		}
		return outcomeSkipped, errors.New("已是其它软链，保持不动")
	}
	if !info.Mode().IsRegular() {
		return outcomeSkipped, errors.New("不是普通文件")
	}
	data, err := os.ReadFile(target)
	if err != nil {
		return outcomeSkipped, err
	}
	if strings.TrimSpace(string(data)) == "" {
		if err := replaceWithLink(canonical, target, info.Mode().Perm()); err != nil {
			return outcomeSkipped, err
		}
		return outcomeLinked, nil
	}
	// 有内容：先并入真源，备份原文，再替换为软链，绝不静默丢规则。
	if err := mergeIntoCanonical(canonical, label, data); err != nil {
		return outcomeSkipped, err
	}
	if err := backupFile(target, data, info.Mode().Perm()); err != nil {
		return outcomeSkipped, err
	}
	if err := replaceWithLink(canonical, target, info.Mode().Perm()); err != nil {
		return outcomeSkipped, err
	}
	return outcomeMigrated, nil
}

func mergeIntoCanonical(canonical, label string, data []byte) error {
	text := strings.TrimSpace(string(data))
	if text == "" {
		return nil
	}
	current, err := os.ReadFile(canonical)
	if err != nil {
		return err
	}
	base := string(current)
	// 真源还是初始模板或空文件：直接把这份内容作为真源正文，避免留一份
	// 无意义的模板注释。
	if strings.TrimSpace(base) == "" || strings.TrimSpace(base) == strings.TrimSpace(seedContent) {
		if !strings.HasSuffix(text, "\n") {
			text += "\n"
		}
		return os.WriteFile(canonical, []byte(text), 0o644)
	}
	if strings.Contains(base, text) {
		return nil
	}
	section := fmt.Sprintf("<!-- migrated-from:%s -->\n%s\n", label, text)
	next := strings.TrimRight(base, "\n") + "\n\n" + section
	return os.WriteFile(canonical, []byte(next), 0o644)
}

func backupFile(target string, data []byte, perm os.FileMode) error {
	backup := fmt.Sprintf("%s.aih-backup-%s", target, time.Now().Format("20060102-150405"))
	return os.WriteFile(backup, data, perm)
}

func replaceWithLink(canonical, target string, _ os.FileMode) error {
	if err := os.Remove(target); err != nil && !os.IsNotExist(err) {
		return err
	}
	return linkTo(canonical, target)
}

func linkTo(canonical, target string) error {
	if err := os.Symlink(canonical, target); err != nil {
		return fmt.Errorf("创建软链失败（Windows 需要开发者模式）: %w", err)
	}
	return nil
}

func sameFile(resolved, canonical string) bool {
	canonicalResolved, err := filepath.EvalSymlinks(canonical)
	if err != nil {
		canonicalResolved = canonical
	}
	return filepath.Clean(resolved) == filepath.Clean(canonicalResolved)
}
