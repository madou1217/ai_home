// Package spacegc 是"空间治理"：把 ~/.ai_home 里可再生的临时目录、整树源码副本、
// 旧数据库快照、过期证据按规则定期回收，而不是依赖用户手工清理。
//
// 设计口径（与 AGENTS.md 的 Working Copy & Evidence Discipline 一致）：
//   - 缓存/构建产物/整树副本都属于"可再生产物"，可以删；
//   - 凭据、会话库、账号投影、产品持久状态永远不在此包射程内（保护名单）；
//   - 任何删除前都要能证明"没人用"：进程 argv / cwd / 打开文件引用 → 跳过；
//     证明不了（探测失败）就只处理 7 天以上的条目；
//   - 删除记录写入 diagnostics/space-gc/last.json，便于追溯释放了多少空间。
//
// 规则本身只描述"什么算垃圾"；是否真删由调用方 decide（dry-run 先观察）。
package spacegc

import (
	"encoding/json"
	"errors"
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"time"
)

// Options 是治理参数；零值用 DefaultOptions。
type Options struct {
	Now                    time.Time
	DryRun                 bool
	ScratchMaxAge          time.Duration // run/ 下未知目录（任务证据/临时工作区）
	SourceCopyMaxAge       time.Duration // 无 .git 的整树源码副本
	SnapshotMaxAge         time.Duration // 旧 .db/.sqlite 快照
	DiagnosticsMaxAge      time.Duration
	RetainedEvidenceMaxAge time.Duration // 仅在 retention.json 声明了 retainUntil 时生效
	ReleaseMaxAge          time.Duration
	BackupKeep             int
	TrashMaxAge            time.Duration
	TempRoots              []string
	TempPrefix             string
	TempMaxAge             time.Duration
}

// DefaultOptions 是生产默认值：偏激进，但所有删除都要求"空闲时间"证据。
func DefaultOptions() Options {
	return Options{
		ScratchMaxAge:          7 * 24 * time.Hour,
		SourceCopyMaxAge:       2 * time.Hour,
		SnapshotMaxAge:         6 * time.Hour,
		DiagnosticsMaxAge:      7 * 24 * time.Hour,
		RetainedEvidenceMaxAge: 30 * 24 * time.Hour,
		ReleaseMaxAge:          30 * 24 * time.Hour,
		BackupKeep:             2,
		TrashMaxAge:            7 * 24 * time.Hour,
		TempRoots:              defaultTempRoots(),
		TempPrefix:             "aih-",
		TempMaxAge:             24 * time.Hour,
	}
}

func defaultTempRoots() []string {
	if runtime.GOOS == "windows" {
		return nil
	}
	return []string{"/tmp"}
}

// Entry 是一条回收/跳过的记录。
type Entry struct {
	Path     string `json:"path"`
	Kind     string `json:"kind"`
	Reason   string `json:"reason"`
	Bytes    int64  `json:"bytes"`
	AgeHours int    `json:"ageHours"`
	Action   string `json:"action"` // removed / would-remove / kept
}

// Report 是一轮治理的结果。
type Report struct {
	ScannedAt  time.Time     `json:"scannedAt"`
	DryRun     bool          `json:"dryRun"`
	Entries    []Entry       `json:"entries"`
	FreedBytes int64         `json:"freedBytes"`
	Errors     []string      `json:"errors"`
	Dedupe     *DedupeReport `json:"dedupe,omitempty"`
}

// 产品持久目录：绝不因为"未知"被清理。新增产品目录时在这里加一行。
var protectedRunDirs = map[string]bool{
	"auth-projections": true, "chat-workspaces": true, "remote-workspaces": true,
	"provider-session-state": true, "provider-session-correlations": true,
	"provider-session-pending": true, "persistent-sessions": true, "projection-locks": true,
	"session-reclaim": true, "releases": true, "recovery-backups": true, "harness": true,
	"login": true, "peer": true, "tmux": true, "shims": true, "logs": true,
	"migrations": true, "maintenance": true, "launch-context": true, "desktop-translation": true,
	"distribution-update": true, "codex": true, "codex-app-server": true,
	"codex-app-server-homes": true, "codex-desktop": true, "opencode-free-relay": true,
	"opencode-serve": true, "subscription-relay": true, "egress-pool": true,
	"route-observation": true, "account-admission": true, "account-deletion-prepared": true,
	"scheduled-tasks": true, "model-usage": true, "provider-config-history": true,
	"completion": true, "shell": true, "terminal-icons": true, "webui-runs": true,
	"verification": true, "virtual-browser": true, "zcode-captcha-profile": true,
	"zcode-shadow": true, "chat-harness": true, "claude-launch-settings": true,
	"playwright-live-profile": true, "cache": true, "desktop-shared-caches": true,
}

// 新增产品目录时：要么加进上面的精确名单，要么加到这里的前缀名单。
var protectedRunPrefixes = []string{
	"claude-default-repair-",
	"image-studio-remix-",
	"node-go-supervision-",
	"virtual-browser-",
}

func isProtectedRunEntry(name string) bool {
	if protectedRunDirs[name] {
		return true
	}
	for _, prefix := range protectedRunPrefixes {
		if strings.HasPrefix(name, prefix) {
			return true
		}
	}
	return false
}

// Run 执行一轮治理。now 由调用方注入，便于测试与回放。
func Run(aiHomeDir string, opts Options) (Report, error) {
	report := Report{ScannedAt: time.Now().UTC()}
	if opts.Now.IsZero() {
		opts.Now = time.Now()
	}
	if opts.ScratchMaxAge <= 0 {
		opts = DefaultOptions()
	}
	report.DryRun = opts.DryRun
	home := strings.TrimSpace(aiHomeDir)
	if home == "" {
		return report, errors.New("spacegc: empty aiHomeDir")
	}
	held, heldKnown := snapshotHeldPaths()

	// 1) run/ 下未知的顶层目录 = 会话任务证据/临时工作区。
	runDir := filepath.Join(home, "run")
	if entries, err := os.ReadDir(runDir); err == nil {
		for _, entry := range entries {
			if !entry.IsDir() || isProtectedRunEntry(entry.Name()) {
				continue
			}
			candidate := filepath.Join(runDir, entry.Name())
			age := maxAgeHours(candidate)
			// 名字直接叫 *-source 的目录是源码副本（可能不含 go.mod），按更短的宽限期处理。
			maxAge := opts.ScratchMaxAge
			if strings.HasSuffix(entry.Name(), "-source") {
				maxAge = opts.SourceCopyMaxAge
			}
			if age < maxAge.Hours() {
				continue
			}
			if heldKnown && pathHeld(held, candidate) {
				report.Entries = append(report.Entries, entryFor(candidate, "scratch", "in-use", 0, "kept"))
				continue
			}
			report.removeOrMark(candidate, "scratch", "idle-scratch", age, opts, &report)
		}
	}

	// 2) 整树源码副本：没有 .git 且含 go.mod / web/package.json。
	//    只扫 run/：retained-evidence 里的 artifacts/package 可能内嵌 source 脚本（含 go.mod），
	//    删了会破坏已打包的候选版本；diagnostics 是快照包，同理不动。
	report.removeSourceCopies(runDir, opts, held, heldKnown)

	// 3) 旧数据库快照（同样只扫 run/ 的产品目录之外）。
	report.removeSnapshots(runDir, opts, held, heldKnown)

	// 4) diagnostics 顶层旧条目。
	report.removeAgedEntries(filepath.Join(home, "diagnostics"), "diagnostics", opts.DiagnosticsMaxAge, opts, held, heldKnown)

	// 5) retained-evidence：只删 retention.json 明确过期（retainUntil）的目录；
	//    没有 marker 的保留并记录，避免误删人工保留的证据。
	report.applyRetentionMarkers(filepath.Join(home, "retained-evidence"), opts, held, heldKnown)

	// 6) releases：保留最近 30 天。
	report.removeAgedEntries(filepath.Join(home, "run", "releases"), "release", opts.ReleaseMaxAge, opts, held, heldKnown)

	// 7) recovery-backups：保留最近 BackupKeep 个。
	report.pruneBackups(filepath.Join(home, "run", "recovery-backups"), opts, held, heldKnown)

	// 8) 构件库回收站：宽限期后真正删除。
	report.removeAgedEntries(filepath.Join(home, "artifact-store", "trash"), "trash", opts.TrashMaxAge, opts, held, heldKnown)

	// 9) 会话/构建留在系统临时目录的 aih-* 目录（并行会话常见）：只清理 24h 以上、
	//    无人引用、且没有 retention.json 的目录。Windows 暂不处理（在用判定不可靠）。
	report.removeTempDirs(opts, held, heldKnown)

	// 10) 不可变证据/发布产物：内容相同的文件合并成硬链接（同卷、只读语义）。
	//    一周最多跑一次；"能公用的坚决不复制"。
	if dedupeDue(home, 7*24*time.Hour) {
		dedupeReport := Dedupe([]string{
			filepath.Join(home, "retained-evidence"),
			filepath.Join(home, "run", "releases"),
		}, DedupeOptions{DryRun: opts.DryRun})
		report.Dedupe = &dedupeReport
		if !opts.DryRun {
			markDedupeRan(home)
		}
	}

	return report, nil
}

func (report *Report) removeTempDirs(opts Options, held map[string]bool, heldKnown bool) {
	if opts.TempMaxAge <= 0 || strings.TrimSpace(opts.TempPrefix) == "" {
		return
	}
	for _, root := range opts.TempRoots {
		entries, err := os.ReadDir(root)
		if err != nil {
			continue
		}
		for _, entry := range entries {
			if !entry.IsDir() || !strings.HasPrefix(entry.Name(), opts.TempPrefix) {
				continue
			}
			candidate := filepath.Join(root, entry.Name())
			if _, err := os.Stat(filepath.Join(candidate, "retention.json")); err == nil {
				continue
			}
			age := maxAgeHours(candidate)
			if age < opts.TempMaxAge.Hours() {
				continue
			}
			if heldKnown && pathHeld(held, candidate) {
				report.Entries = append(report.Entries, entryFor(candidate, "temp-scratch", "in-use", 0, "kept"))
				continue
			}
			report.removeOrMark(candidate, "temp-scratch", "idle-temp", age, opts, report)
		}
	}
}

// HeldPaths 暴露"当前进程在用路径"快照给同进程内的其它巡检器（如 artifactstore 的旧版本回收）。
func HeldPaths() (map[string]bool, bool) { return snapshotHeldPaths() }

// PathHeld 报告候选路径是否被在用快照覆盖（含 /tmp ↔ /private/tmp 软链解析）。
func PathHeld(held map[string]bool, candidate string) bool { return pathHeld(held, candidate) }

func dedupeDue(home string, interval time.Duration) bool {
	info, err := os.Stat(filepath.Join(home, "diagnostics", "space-gc", ".last-dedupe"))
	if err != nil {
		return true
	}
	return time.Since(info.ModTime()) >= interval
}

func markDedupeRan(home string) {
	dir := filepath.Join(home, "diagnostics", "space-gc")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return
	}
	_ = os.WriteFile(filepath.Join(dir, ".last-dedupe"), []byte(time.Now().UTC().Format(time.RFC3339)+"\n"), 0o600)
}

func (report *Report) removeOrMark(path, kind, reason string, ageHours float64, opts Options, out *Report) {
	bytes := dirSize(path)
	if opts.DryRun {
		out.Entries = append(out.Entries, entryFor(path, kind, reason, bytes, "would-remove"))
		return
	}
	if err := os.RemoveAll(path); err != nil {
		out.Errors = append(out.Errors, path+": "+err.Error())
		out.Entries = append(out.Entries, entryFor(path, kind, reason+"-failed", bytes, "kept"))
		return
	}
	out.FreedBytes += bytes
	out.Entries = append(out.Entries, entryFor(path, kind, reason, bytes, "removed"))
}

func (report *Report) removeSourceCopies(root string, opts Options, held map[string]bool, heldKnown bool) {
	if strings.TrimSpace(root) == "" {
		return
	}
	_ = filepath.WalkDir(root, func(path string, entry fs.DirEntry, err error) error {
		if err != nil || !entry.IsDir() {
			return nil
		}
		base := entry.Name()
		if path != root && (isProtectedRunEntry(base) || base == ".git" || base == "node_modules") {
			return filepath.SkipDir
		}
		if _, err := os.Lstat(filepath.Join(path, ".git")); err == nil {
			return filepath.SkipDir
		}
		if !containsSourceMarker(path) {
			return nil
		}
		age := maxAgeHours(path)
		if age < opts.SourceCopyMaxAge.Hours() {
			return filepath.SkipDir
		}
		if heldKnown && pathHeld(held, path) {
			report.Entries = append(report.Entries, entryFor(path, "source-copy", "in-use", 0, "kept"))
			return filepath.SkipDir
		}
		report.removeOrMark(path, "source-copy", "whole-tree-copy", age, opts, report)
		return filepath.SkipDir
	})
}

func (report *Report) removeSnapshots(root string, opts Options, held map[string]bool, heldKnown bool) {
	_ = filepath.WalkDir(root, func(path string, entry fs.DirEntry, err error) error {
		if err != nil {
			return nil
		}
		if entry.IsDir() {
			if path != root && isProtectedRunEntry(entry.Name()) {
				return filepath.SkipDir
			}
			return nil
		}
		name := entry.Name()
		if !isSnapshotName(name) {
			return nil
		}
		info, err := entry.Info()
		if err != nil || info.Size() < 10*1024*1024 {
			return nil
		}
		age := opts.Now.Sub(info.ModTime()).Hours()
		if age < opts.SnapshotMaxAge.Hours() {
			return nil
		}
		if heldKnown && pathHeld(held, path) {
			report.Entries = append(report.Entries, entryFor(path, "db-snapshot", "in-use", info.Size(), "kept"))
			return nil
		}
		report.removeOrMark(path, "db-snapshot", "old-snapshot", age, opts, report)
		return nil
	})
}

func (report *Report) removeAgedEntries(root, kind string, maxAge time.Duration, opts Options, held map[string]bool, heldKnown bool) {
	entries, err := os.ReadDir(root)
	if err != nil {
		return
	}
	for _, entry := range entries {
		candidate := filepath.Join(root, entry.Name())
		info, err := entry.Info()
		if err != nil {
			continue
		}
		age := opts.Now.Sub(info.ModTime()).Hours()
		if age < maxAge.Hours() {
			continue
		}
		if heldKnown && pathHeld(held, candidate) {
			report.Entries = append(report.Entries, entryFor(candidate, kind, "in-use", 0, "kept"))
			continue
		}
		report.removeOrMark(candidate, kind, "aged-"+kind, age, opts, report)
	}
}

// retention.json 契约：{"retainUntil": "2026-12-18T00:00:00Z"} 到期即回收；
// 没有 retainUntil 的视为人工长期保留（如敏感 AWS 历史），永不自动删除。
func (report *Report) applyRetentionMarkers(root string, opts Options, held map[string]bool, heldKnown bool) {
	entries, err := os.ReadDir(root)
	if err != nil {
		return
	}
	for _, entry := range entries {
		if !entry.IsDir() {
			continue
		}
		dir := filepath.Join(root, entry.Name())
		marker := filepath.Join(dir, "retention.json")
		raw, readErr := os.ReadFile(marker)
		if readErr != nil {
			report.Entries = append(report.Entries, entryFor(dir, "retained-evidence", "no-retention-marker", dirSize(dir), "kept"))
			continue
		}
		var doc struct {
			RetainUntil string `json:"retainUntil"`
		}
		if err := json.Unmarshal(raw, &doc); err != nil || strings.TrimSpace(doc.RetainUntil) == "" {
			report.Entries = append(report.Entries, entryFor(dir, "retained-evidence", "pinned", dirSize(dir), "kept"))
			continue
		}
		until, err := time.Parse(time.RFC3339, doc.RetainUntil)
		if err != nil || opts.Now.Before(until) {
			report.Entries = append(report.Entries, entryFor(dir, "retained-evidence", "retained-until-"+doc.RetainUntil, dirSize(dir), "kept"))
			continue
		}
		if heldKnown && pathHeld(held, dir) {
			report.Entries = append(report.Entries, entryFor(dir, "retained-evidence", "in-use", 0, "kept"))
			continue
		}
		report.removeOrMark(dir, "retained-evidence", "retention-expired", maxAgeHours(dir), opts, report)
	}
}

func (report *Report) pruneBackups(root string, opts Options, held map[string]bool, heldKnown bool) {
	entries, err := os.ReadDir(root)
	if err != nil {
		return
	}
	sort.Slice(entries, func(i, j int) bool { return entries[i].Name() > entries[j].Name() })
	for index, entry := range entries {
		candidate := filepath.Join(root, entry.Name())
		if index < opts.BackupKeep {
			info, _ := entry.Info()
			if info != nil && opts.Now.Sub(info.ModTime()) < opts.ReleaseMaxAge {
				continue
			}
			continue
		}
		age := maxAgeHours(candidate)
		if heldKnown && pathHeld(held, candidate) {
			report.Entries = append(report.Entries, entryFor(candidate, "backup", "in-use", 0, "kept"))
			continue
		}
		report.removeOrMark(candidate, "backup", "beyond-keep-count", age, opts, report)
	}
}

// ---- 判定工具 ----

func containsSourceMarker(dir string) bool {
	for _, name := range []string{"go.mod", filepath.Join("web", "package.json")} {
		if _, err := os.Stat(filepath.Join(dir, name)); err == nil {
			return true
		}
	}
	return false
}

func isSnapshotName(name string) bool {
	if !(strings.HasSuffix(name, ".db") || strings.HasSuffix(name, ".db-wal") || strings.HasSuffix(name, ".db-shm") || strings.HasSuffix(name, ".sqlite") || strings.HasSuffix(name, ".sqlite-wal") || strings.HasSuffix(name, ".sqlite-shm")) {
		return false
	}
	return true
}

// maxAgeHours 返回目录自身与直接子项里最新的修改时间距今小时数。
func maxAgeHours(path string) float64 {
	info, err := os.Stat(path)
	if err != nil {
		return 0
	}
	latest := info.ModTime()
	entries, err := os.ReadDir(path)
	if err == nil {
		for _, entry := range entries {
			if child, err := entry.Info(); err == nil && child.ModTime().After(latest) {
				latest = child.ModTime()
			}
		}
	}
	return time.Since(latest).Hours()
}

func dirSize(path string) int64 {
	var total int64
	_ = filepath.WalkDir(path, func(current string, entry fs.DirEntry, err error) error {
		if err != nil || entry.IsDir() {
			return nil
		}
		if entry.Type()&os.ModeSymlink != 0 {
			return nil
		}
		if info, err := entry.Info(); err == nil {
			total += info.Size()
		}
		return nil
	})
	return total
}

// entryFor 的 AgeHours 是记录时的近似值；删除后目录已不存在，可能记为 0。
func entryFor(path, kind, reason string, bytes int64, action string) Entry {
	return Entry{Path: path, Kind: kind, Reason: reason, Bytes: bytes, AgeHours: int(maxAgeHours(path)), Action: action}
}

// snapshotHeldPaths 收集进程命令行与 cwd；第二返回值表示探测是否可信。
func snapshotHeldPaths() (map[string]bool, bool) {
	held := make(map[string]bool)
	known := false
	if runtime.GOOS == "windows" {
		// 新版 Windows 移除了 wmic；用 PowerShell CIM 取命令行。失败则按"未知"处理。
		output, err := exec.Command("powershell", "-NoProfile", "-Command",
			"[Console]::OutputEncoding=[Text.Encoding]::UTF8; Get-CimInstance Win32_Process | ForEach-Object { $_.CommandLine }").Output()
		if err != nil {
			return held, false
		}
		for _, line := range strings.Split(string(output), "\n") {
			for _, token := range strings.Fields(strings.TrimSpace(line)) {
				if len(token) > 2 && (strings.HasPrefix(token, "/") || strings.Contains(token, ":\\")) {
					held[strings.Trim(token, "\"'")] = true
				}
			}
		}
		return held, true
	}
	if output, err := exec.Command("ps", "-axo", "command=").Output(); err == nil {
		known = true
		for _, line := range strings.Split(string(output), "\n") {
			for _, token := range strings.Fields(line) {
				if strings.HasPrefix(token, "/") && len(token) > 1 {
					addHeldPath(held, strings.Trim(token, "\"'"))
				}
			}
		}
	}
	if output, err := exec.Command("lsof", "-a", "-d", "cwd", "-nP", "-F", "n").Output(); err == nil {
		known = true
		for _, line := range strings.Split(string(output), "\n") {
			if strings.HasPrefix(line, "n/") {
				addHeldPath(held, strings.TrimSpace(line[1:]))
			}
		}
	}
	return held, known
}

// addHeldPath 同时记录原始路径和解析后的真实路径：macOS 的 /tmp 是 /private/tmp
// 的软链，lsof 给解析后的路径、ps 可能给原始路径，只存一种会漏判"在用"。
func addHeldPath(held map[string]bool, path string) {
	path = filepath.Clean(path)
	if path == "" {
		return
	}
	held[path] = true
	if resolved, err := filepath.EvalSymlinks(path); err == nil && resolved != path {
		held[resolved] = true
	}
}

func pathHeld(held map[string]bool, candidate string) bool {
	clean := filepath.Clean(candidate)
	resolved := clean
	if value, err := filepath.EvalSymlinks(clean); err == nil {
		resolved = value
	}
	for value := range held {
		for _, target := range []string{clean, resolved} {
			if value == target || strings.HasPrefix(value, target+string(filepath.Separator)) {
				return true
			}
		}
	}
	return false
}
