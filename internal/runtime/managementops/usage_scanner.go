package managementops

import (
	"bufio"
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"github.com/madou1217/ai_home/internal/adapters/sqlitefile"
	"io"
	"math"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	accountapp "github.com/madou1217/ai_home/application/accounts"
	accountcore "github.com/madou1217/ai_home/core/accounts"
	"github.com/madou1217/ai_home/core/providers"
	"github.com/madou1217/ai_home/internal/adapters/accounts/sqliteaccount"
	"github.com/madou1217/ai_home/internal/runtime/platform"
)

const (
	codexUsageStreamLimit      = 16
	codexUsageEventLimit       = 32
	codexScanContextVersion    = 2
	codexDefaultScanByteBudget = 4 * 1024 * 1024
	firstJSONLEntryChunkBytes  = 8 * 1024
	firstJSONLEntryMaxBytes    = 256 * 1024
	scopeGraceMS               = 120 * 1000
	qoderContextWindowTokens   = 200000
	qoderEstimatedSourceSuffix = "_estimated"
	kiroPromptCacheTTLMS       = 5 * 60 * 1000
	kiroSessionUsageSourceKind = "native_kiro_session_estimated"
	grokUsageProjectionVersion = 2
	usageScanSchemaVersion     = 1
	usageScanKind              = "usage.scan"
	usageScanSourceID          = "local-sessions"
	usageScanStatusOK          = "ok"
	usageScanStatusEmpty       = "empty"
	usageScanStatusUnavailable = "unavailable"
)

var (
	codexThreadUUIDRe   = regexp.MustCompile(`(?i)[0-9a-f]{8}-[0-9a-f]{4}-[47][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}`)
	uuidV7PrefixRe      = regexp.MustCompile(`(?i)^([0-9a-f]{8})-([0-9a-f]{4})-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`)
	kiroHexHash16Re     = regexp.MustCompile(`^[0-9a-f]{16}$`)
	opencodeDBPatternRe = regexp.MustCompile(`^opencode\.db(?:\.\d+)?$`)
	grokSessionIDRe     = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$`)
)

var kiroModelMaxInputTokens = map[string]int64{
	"auto":              1000000,
	"claude-opus-5.5":   1000000,
	"claude-sonnet-5.5": 1000000,
	"claude-opus-5":     1000000,
	"claude-sonnet-5":   1000000,
	"claude-opus-4.8":   1000000,
	"claude-opus-4.7":   1000000,
	"claude-opus-4.6":   1000000,
	"claude-sonnet-4.6": 1000000,
	"claude-opus-4.5":   200000,
	"claude-sonnet-4.5": 200000,
	"claude-haiku-4.5":  200000,
	"gpt-5.6-sol":       922000,
	"gpt-5.6-terra":     922000,
	"gpt-5.6-luna":      922000,
	"deepseek-3.2":      164000,
	"minimax-m2.5":      196000,
	"minimax-m2.1":      196000,
	"glm-5":             200000,
	"qwen3-coder-next":  256000,
	"kimi-k3":           1000000,
}

// ScanUsageOptions 定义本地客户端会话扫描的执行参数。
type ScanUsageOptions struct {
	AIHomeDir               string
	HostHomeDir             string
	Store                   *UsageStore
	AccountStore            *sqliteaccount.Store
	Catalog                 *providers.Catalog
	Providers               []string
	ProviderIDs             []string
	ReindexCodexForkHistory bool
	CodexScanByteBudget     int64
	GrokSessionID           string
	CodebuddySessionID      string
	CodebuddyScope          string
	Platform                string
	Now                     func() time.Time
}

type providerScanCounters struct {
	Files           int
	Records         int
	Prompts         int
	Skipped         int
	FilesDeferred   int
	ReindexRequired int
	Errors          int
	Reason          string
}

type fileScanOutcome struct {
	Records         int
	Prompts         int
	BytesRead       int64
	FilesDeferred   int
	ReindexRequired int
	Reason          string
}

type jsonlReadResult struct {
	Offset            int64
	HadTrailingLine   bool
	TrailingLineStart int64
}

// ScanModelUsageSources 扫描宿主机与 AIHome 隔离投影下的各 Provider 本地会话并写入 UsageStore。
func ScanModelUsageSources(ctx context.Context, opts ScanUsageOptions) (UsageScanResult, error) {
	if opts.Store == nil {
		return UsageScanResult{}, errors.New("未提供可用的模型用量存储实例")
	}
	hostHomeDir := strings.TrimSpace(opts.HostHomeDir)
	if hostHomeDir == "" {
		return UsageScanResult{}, errors.New("未提供宿主机用户目录 hostHomeDir")
	}
	aiHomeDir := strings.TrimSpace(opts.AIHomeDir)
	nowFn := opts.Now
	if nowFn == nil {
		nowFn = time.Now
	}

	targetProviders, requested := resolveTargetScanProviders(opts)
	rawProviders := make(map[string]providerScanCounters)

	if targetProviders["codex"] {
		codexRoot := filepath.Join(hostHomeDir, ".codex", "sessions")
		ownership := loadCodexSessionOwnershipIndex(aiHomeDir)
		files := listFilesRecursive(codexRoot, func(_ string, name string) bool {
			return strings.HasSuffix(name, ".jsonl")
		})
		budget := opts.CodexScanByteBudget
		if budget <= 0 {
			budget = codexDefaultScanByteBudget
		}
		rawProviders["codex"] = scanProviderFiles(files, budget, func(filePath string, remaining int64) (fileScanOutcome, error) {
			return scanCodexFile(ctx, opts.Store, filePath, opts.ReindexCodexForkHistory, remaining, ownership)
		})
	}

	if targetProviders["claude"] {
		claudeRoot := filepath.Join(hostHomeDir, ".claude", "projects")
		files := listFilesRecursive(claudeRoot, func(_ string, name string) bool {
			return strings.HasSuffix(name, ".jsonl")
		})
		rawProviders["claude"] = scanProviderFiles(files, -1, func(filePath string, _ int64) (fileScanOutcome, error) {
			return scanClaudeFile(ctx, opts.Store, filePath)
		})
	}

	if targetProviders["gemini"] {
		geminiDir := filepath.Join(hostHomeDir, ".gemini")
		geminiRoot := filepath.Join(geminiDir, "tmp")
		chatsMarker := string(filepath.Separator) + "chats" + string(filepath.Separator)
		files := listFilesRecursive(geminiRoot, func(full, name string) bool {
			return strings.HasSuffix(name, ".json") && strings.Contains(full, chatsMarker)
		})
		rawProviders["gemini"] = scanProviderFiles(files, -1, func(filePath string, _ int64) (fileScanOutcome, error) {
			return scanGeminiFile(ctx, opts.Store, filePath, geminiDir)
		})
	}

	if targetProviders["kimi"] {
		rawProviders["kimi"] = scanKimiProvider(ctx, opts.Store, hostHomeDir, aiHomeDir)
	}

	if targetProviders["opencode"] {
		files := discoverOpenCodeUsageFiles(hostHomeDir, aiHomeDir)
		rawProviders["opencode"] = scanProviderFiles(files, -1, func(filePath string, _ int64) (fileScanOutcome, error) {
			return scanOpenCodeFile(ctx, opts.Store, filePath, nowFn)
		})
	}

	if targetProviders["zcode"] {
		rawProviders["zcode"] = scanZcodeProvider(ctx, opts, hostHomeDir, aiHomeDir, nowFn)
	}

	qoderProviders := make([]string, 0, 2)
	for _, p := range []string{"qoder", "qodercn"} {
		if targetProviders[p] {
			qoderProviders = append(qoderProviders, p)
		}
	}
	if len(qoderProviders) > 0 {
		for _, p := range qoderProviders {
			rawProviders[p] = scanQoderProvider(ctx, opts.Store, hostHomeDir, aiHomeDir, p)
		}
	}

	if targetProviders["cline"] {
		ownership := loadRegistryScopeOwnership(aiHomeDir, "cline")
		files := discoverClineUsageFiles(hostHomeDir)
		rawProviders["cline"] = scanProviderFiles(files, -1, func(filePath string, _ int64) (fileScanOutcome, error) {
			return scanClineSessionFile(ctx, opts.Store, filePath, ownership)
		})
	}

	if targetProviders["kiro"] {
		ownership := loadRegistryScopeOwnership(aiHomeDir, "kiro")
		files := discoverKiroSessionFiles(hostHomeDir)
		rawProviders["kiro"] = scanProviderFiles(files, -1, func(filePath string, _ int64) (fileScanOutcome, error) {
			return scanKiroSessionFile(ctx, opts.Store, filePath, ownership)
		})
	}

	if targetProviders["agy"] {
		rawProviders["agy"] = providerScanCounters{
			Reason: "agy_local_conversations_are_protobuf; use server-side usage recording",
		}
	}

	if targetProviders["grok"] {
		files := discoverGrokUsageFiles(hostHomeDir, aiHomeDir, opts.GrokSessionID)
		rawProviders["grok"] = scanProviderFiles(files, -1, func(filePath string, _ int64) (fileScanOutcome, error) {
			return scanGrokUsageFile(ctx, opts.Store, filePath, aiHomeDir)
		})
	}

	familyProviders := make([]string, 0, 4)
	for _, p := range codebuddyFamilyProviders {
		if targetProviders[p] {
			familyProviders = append(familyProviders, p)
		}
	}
	if len(familyProviders) > 0 {
		cbResults := scanCodebuddyFamilySources(ctx, opts, familyProviders, nowFn)
		for p, cnt := range cbResults {
			rawProviders[p] = cnt
		}
	}

	return NormalizeUsageScanResult(rawProviders, requested, nowFn()), nil
}

func resolveTargetScanProviders(opts ScanUsageOptions) (map[string]bool, []string) {
	supported := make(map[string]bool)
	var ordered []string
	var defs []providers.Definition
	if opts.Catalog != nil {
		defs = opts.Catalog.List()
	} else {
		defs = providers.BuiltinManifest().Providers
	}
	for _, def := range defs {
		hasScan := false
		for _, capItem := range def.Capabilities {
			if capItem == providers.CapabilityUsageScan {
				hasScan = true
				break
			}
		}
		if !hasScan {
			continue
		}
		id := strings.ToLower(strings.TrimSpace(def.ID))
		if id == "" || supported[id] {
			continue
		}
		supported[id] = true
		ordered = append(ordered, id)
	}
	if len(supported) == 0 {
		for _, id := range defaultScanProviderIDs() {
			supported[id] = true
			ordered = append(ordered, id)
		}
	}
	sort.Strings(ordered)

	reqSet := make(map[string]bool)
	reqList := make([]string, 0, len(opts.Providers))
	for _, p := range opts.Providers {
		norm := strings.ToLower(strings.TrimSpace(p))
		if norm == "" || reqSet[norm] {
			continue
		}
		reqSet[norm] = true
		reqList = append(reqList, norm)
	}
	sort.Strings(reqList)

	if len(reqList) == 0 {
		return supported, nil
	}
	target := make(map[string]bool, len(reqList))
	for _, id := range reqList {
		if supported[id] {
			target[id] = true
		}
	}
	return target, reqList
}

func defaultScanProviderIDs() []string {
	return []string{
		"agy", "claude", "cline", "codebuddy", "codebuddycn",
		"codex", "gemini", "grok", "kimi", "kiro",
		"opencode", "qoder", "qodercn", "workbuddy", "workbuddycn", "zcode",
	}
}

// NormalizeUsageScanResult 将各 Provider 原始扫描计数归一为 `usage.scan` v1 标准契约。
func NormalizeUsageScanResult(
	rawProviders map[string]providerScanCounters,
	requested []string,
	scannedAt time.Time,
) UsageScanResult {
	providersOut := make(map[string]UsageScanProviderResult, len(rawProviders))
	counts := UsageScanCounts{}
	keys := make([]string, 0, len(rawProviders))
	for name := range rawProviders {
		norm := strings.ToLower(strings.TrimSpace(name))
		if norm != "" {
			keys = append(keys, norm)
		}
	}
	sort.Strings(keys)

	for _, name := range keys {
		raw := rawProviders[name]
		status := usageScanStatusEmpty
		if raw.Records > 0 {
			status = usageScanStatusOK
		} else if raw.Reason != "" || (raw.Files == 0 && raw.Errors > 0) {
			status = usageScanStatusUnavailable
		}
		entry := UsageScanProviderResult{
			Files:           maxIntZero(raw.Files),
			Records:         maxIntZero(raw.Records),
			Prompts:         maxIntZero(raw.Prompts),
			Skipped:         maxIntZero(raw.Skipped),
			FilesDeferred:   maxIntZero(raw.FilesDeferred),
			ReindexRequired: maxIntZero(raw.ReindexRequired),
			Errors:          maxIntZero(raw.Errors),
			Reason:          strings.TrimSpace(raw.Reason),
			Status:          status,
		}
		providersOut[name] = entry
		counts.Files += entry.Files
		counts.Records += entry.Records
		counts.Prompts += entry.Prompts
		counts.Skipped += entry.Skipped
		counts.FilesDeferred += entry.FilesDeferred
		counts.ReindexRequired += entry.ReindexRequired
	}

	reqCopy := append([]string(nil), requested...)
	sort.Strings(reqCopy)

	overallStatus := resolveScanOverallStatus(providersOut, reqCopy)
	attemptTargets := reqCopy
	if len(attemptTargets) == 0 {
		attemptTargets = keys
	}
	attempts := make([]UsageScanAttempt, 0, len(attemptTargets))
	for _, p := range attemptTargets {
		if entry, ok := providersOut[p]; ok {
			attempts = append(attempts, UsageScanAttempt{
				Provider: p,
				Status:   entry.Status,
				Reason:   entry.Reason,
			})
		} else {
			attempts = append(attempts, UsageScanAttempt{
				Provider: p,
				Status:   usageScanStatusUnavailable,
				Reason:   "provider_not_scanned",
			})
		}
	}

	warnings := buildUsageScanWarnings(overallStatus, providersOut, reqCopy)
	scannedMS := scannedAt.UnixMilli()
	scannedISO := scannedAt.UTC().Format("2006-01-02T15:04:05.000Z")

	return UsageScanResult{
		SchemaVersion: usageScanSchemaVersion,
		Kind:          usageScanKind,
		Status:        overallStatus,
		Source: UsageScanSource{
			ID:        usageScanSourceID,
			Kind:      usageScanSourceID,
			Authority: nil,
			Conf:      nil,
			FetchedAt: scannedISO,
			Stale:     false,
		},
		ScannedAt:          scannedMS,
		ScannedAtIso:       scannedISO,
		Stale:              false,
		RequestedProviders: reqCopy,
		Providers:          providersOut,
		Counts:             counts,
		Files:              counts.Files,
		Records:            counts.Records,
		Prompts:            counts.Prompts,
		Skipped:            counts.Skipped,
		FilesDeferred:      counts.FilesDeferred,
		ReindexRequired:    counts.ReindexRequired,
		Attempts:           attempts,
		Warnings:           warnings,
	}
}

func resolveScanOverallStatus(providers map[string]UsageScanProviderResult, requested []string) string {
	targets := make([]UsageScanProviderResult, 0, len(providers))
	if len(requested) > 0 {
		for _, p := range requested {
			if entry, ok := providers[p]; ok {
				targets = append(targets, entry)
			}
		}
	} else {
		for _, entry := range providers {
			targets = append(targets, entry)
		}
	}
	for _, e := range targets {
		if e.Status == usageScanStatusOK {
			return usageScanStatusOK
		}
	}
	for _, e := range targets {
		if e.Status == usageScanStatusEmpty {
			return usageScanStatusEmpty
		}
	}
	return usageScanStatusUnavailable
}

func buildUsageScanWarnings(status string, providers map[string]UsageScanProviderResult, requested []string) []UsageScanWarning {
	warnings := make([]UsageScanWarning, 0)
	var targets []string
	if len(requested) > 0 {
		targets = requested
	} else {
		for k := range providers {
			targets = append(targets, k)
		}
		sort.Strings(targets)
	}
	for _, p := range targets {
		entry, ok := providers[p]
		if !ok {
			warnings = append(warnings, UsageScanWarning{
				Code:     "usage_scan_provider_missing",
				Provider: p,
			})
			continue
		}
		if entry.Status == usageScanStatusUnavailable && entry.Reason != "" {
			warnings = append(warnings, UsageScanWarning{
				Code:     "usage_scan_provider_unavailable",
				Provider: p,
				Detail:   entry.Reason,
			})
		}
		if entry.FilesDeferred > 0 {
			warnings = append(warnings, UsageScanWarning{
				Code:     "usage_scan_files_deferred",
				Provider: p,
				Count:    entry.FilesDeferred,
			})
		}
		if entry.Skipped > 0 {
			warnings = append(warnings, UsageScanWarning{
				Code:     "usage_scan_files_skipped",
				Provider: p,
				Count:    entry.Skipped,
			})
		}
	}
	if status == usageScanStatusEmpty {
		warnings = append(warnings, UsageScanWarning{Code: "usage_scan_empty"})
	} else if status == usageScanStatusUnavailable {
		warnings = append(warnings, UsageScanWarning{Code: "usage_scan_unavailable"})
	}
	return warnings
}

func scanProviderFiles(
	files []string,
	byteBudget int64,
	scanFn func(filePath string, remainingBytes int64) (fileScanOutcome, error),
) providerScanCounters {
	out := providerScanCounters{}
	hasBudget := byteBudget > 0
	remaining := byteBudget
	for _, filePath := range files {
		if hasBudget && remaining <= 0 {
			out.FilesDeferred++
			continue
		}
		res, err := scanFn(filePath, remaining)
		if err != nil {
			out.Skipped++
			continue
		}
		out.Files++
		out.Records += res.Records
		out.Prompts += res.Prompts
		out.FilesDeferred += res.FilesDeferred
		out.ReindexRequired += res.ReindexRequired
		if out.ReindexRequired > 0 && out.Reason == "" {
			if res.Reason != "" {
				out.Reason = res.Reason
			} else {
				out.Reason = "codex_fork_reindex_required"
			}
		}
		if hasBudget {
			remaining -= res.BytesRead
		}
	}
	return out
}

// ---------- Shared file, path, JSON & timestamp helpers ----------

func maxIntZero(v int) int {
	if v < 0 {
		return 0
	}
	return v
}

func maxInt64Zero(v int64) int64 {
	if v < 0 {
		return 0
	}
	return v
}

func pathExists(target string) bool {
	if strings.TrimSpace(target) == "" {
		return false
	}
	_, err := os.Stat(target)
	return err == nil
}

func isAccountRefFormat(value string) bool {
	return accountRefRe.MatchString(strings.TrimSpace(value))
}

func resolvePhysicalPath(target string) string {
	cleaned := filepath.Clean(target)
	if abs, err := filepath.Abs(cleaned); err == nil {
		cleaned = abs
	}
	if resolved, err := filepath.EvalSymlinks(cleaned); err == nil {
		return resolved
	}
	return cleaned
}

func isPathWithinRoot(targetPath, rootPath string) bool {
	absRoot, err1 := filepath.Abs(filepath.Clean(rootPath))
	absTarget, err2 := filepath.Abs(filepath.Clean(targetPath))
	if err1 != nil || err2 != nil {
		return false
	}
	rel, err := filepath.Rel(absRoot, absTarget)
	if err != nil {
		return false
	}
	return rel == "." || (rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator)) && !filepath.IsAbs(rel))
}

func listFilesRecursive(root string, accept func(full, name string) bool) []string {
	if strings.TrimSpace(root) == "" || !pathExists(root) {
		return nil
	}
	var out []string
	stack := []string{root}
	for len(stack) > 0 {
		dir := stack[len(stack)-1]
		stack = stack[:len(stack)-1]
		entries, err := os.ReadDir(dir)
		if err != nil {
			continue
		}
		for _, entry := range entries {
			name := entry.Name()
			full := filepath.Join(dir, name)
			if entry.IsDir() {
				stack = append(stack, full)
				continue
			}
			isFile := entry.Type().IsRegular()
			if !isFile && entry.Type()&os.ModeSymlink != 0 {
				if st, sErr := os.Stat(full); sErr == nil && st.Mode().IsRegular() {
					isFile = true
				}
			}
			if isFile && (accept == nil || accept(full, name)) {
				out = append(out, full)
			}
		}
	}
	sort.Strings(out)
	return out
}

func basenameWithoutExt(filePath string) string {
	base := filepath.Base(filePath)
	ext := filepath.Ext(base)
	if ext != "" && len(base) > len(ext) {
		return base[:len(base)-len(ext)]
	}
	return base
}

func inferProjectFromCwd(cwd, fallback string) string {
	trimmed := strings.TrimSpace(cwd)
	if trimmed != "" {
		return filepath.Base(trimmed)
	}
	return strings.TrimSpace(fallback)
}

func buildFileEventKey(provider, filePath string, lineOffset int64, kind string) string {
	return fmt.Sprintf("%s:file:%s:%d:%s", provider, StableHash(filePath), lineOffset, kind)
}

func readJSONLFromOffset(filePath string, offset int64, maxBytes int64, onLine func(line string, lineOffset int64)) (jsonlReadResult, error) {
	f, err := os.Open(filePath)
	if err != nil {
		return jsonlReadResult{}, err
	}
	defer func() { _ = f.Close() }()
	st, err := f.Stat()
	if err != nil {
		return jsonlReadResult{}, err
	}
	size := st.Size()
	if offset < 0 {
		offset = 0
	}
	if offset >= size {
		return jsonlReadResult{Offset: size}, nil
	}
	limit := size
	if maxBytes > 0 && offset+maxBytes < limit {
		limit = offset + maxBytes
	}
	if _, err := f.Seek(offset, io.SeekStart); err != nil {
		return jsonlReadResult{}, err
	}

	const chunkSize = 64 * 1024
	buf := make([]byte, chunkSize)
	pos := offset
	var pending []byte
	pendingStart := offset
	var lastCompleted int64 = offset
	stopEarly := false

	for pos < limit && !stopEarly {
		toRead := int64(chunkSize)
		if pos+toRead > limit {
			toRead = limit - pos
		}
		n, rErr := f.Read(buf[:toRead])
		if n > 0 {
			chunk := buf[:n]
			scanFrom := 0
			for i := 0; i < len(chunk); i++ {
				if chunk[i] == '\n' {
					lineBytes := chunk[scanFrom:i]
					if len(pending) > 0 {
						pending = append(pending, lineBytes...)
						lineBytes = pending
					}
					if len(lineBytes) > 0 && lineBytes[len(lineBytes)-1] == '\r' {
						lineBytes = lineBytes[:len(lineBytes)-1]
					}
					trimmed := strings.TrimSpace(string(lineBytes))
					if trimmed != "" {
						onLine(trimmed, pendingStart)
					}
					pending = pending[:0]
					lineEndPos := pos + int64(i) + 1
					pendingStart = lineEndPos
					lastCompleted = lineEndPos
					scanFrom = i + 1
					if maxBytes > 0 && lineEndPos-offset >= maxBytes {
						stopEarly = true
						break
					}
				}
			}
			if !stopEarly && scanFrom < len(chunk) {
				pending = append(pending, chunk[scanFrom:]...)
			}
			pos += int64(n)
		}
		if rErr != nil {
			if rErr == io.EOF {
				break
			}
			return jsonlReadResult{}, rErr
		}
	}

	if !stopEarly && len(pending) > 0 && pos >= size {
		trimmed := strings.TrimSpace(string(pending))
		if trimmed != "" {
			onLine(trimmed, pendingStart)
		}
		return jsonlReadResult{
			Offset:            size,
			HadTrailingLine:   trimmed != "",
			TrailingLineStart: pendingStart,
		}, nil
	}

	if lastCompleted > offset || stopEarly {
		return jsonlReadResult{Offset: lastCompleted}, nil
	}
	return jsonlReadResult{Offset: offset}, nil
}

func readFirstJSONLEntry(filePath string) map[string]any {
	f, err := os.Open(filePath)
	if err != nil {
		return nil
	}
	defer func() { _ = f.Close() }()
	reader := bufio.NewReaderSize(f, firstJSONLEntryChunkBytes)
	var collected []byte
	for len(collected) < firstJSONLEntryMaxBytes {
		line, err := reader.ReadBytes('\n')
		if len(line) > 0 {
			collected = append(collected, line...)
			trimmed := strings.TrimSpace(string(collected))
			if trimmed != "" {
				var obj map[string]any
				if json.Unmarshal([]byte(trimmed), &obj) == nil {
					return obj
				}
				return nil
			}
		}
		if err != nil {
			break
		}
	}
	return nil
}

func safeParseJSONMap(raw string) map[string]any {
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" {
		return nil
	}
	var out map[string]any
	if json.Unmarshal([]byte(trimmed), &out) != nil {
		return nil
	}
	return out
}

func readJSONFileMap(filePath string) map[string]any {
	raw, err := os.ReadFile(filePath)
	if err != nil {
		return nil
	}
	var out map[string]any
	if json.Unmarshal(raw, &out) != nil {
		return nil
	}
	return out
}

func strVal(m map[string]any, keys ...string) string {
	if m == nil {
		return ""
	}
	for _, k := range keys {
		if v, ok := m[k]; ok && v != nil {
			switch s := v.(type) {
			case string:
				if t := strings.TrimSpace(s); t != "" {
					return t
				}
			}
		}
	}
	return ""
}

func mapVal(m map[string]any, key string) map[string]any {
	if m == nil {
		return nil
	}
	if v, ok := m[key].(map[string]any); ok {
		return v
	}
	return nil
}

func int64Val(v any) int64 {
	switch x := v.(type) {
	case int:
		return maxInt64Zero(int64(x))
	case int64:
		return maxInt64Zero(x)
	case float64:
		if math.IsNaN(x) || math.IsInf(x, 0) || x < 0 {
			return 0
		}
		return int64(math.Round(x))
	case json.Number:
		if f, err := x.Float64(); err == nil && !math.IsNaN(f) && !math.IsInf(f, 0) && f >= 0 {
			return int64(math.Round(f))
		}
	}
	return 0
}

func int64FromMap(m map[string]any, keys ...string) int64 {
	if m == nil {
		return 0
	}
	for _, k := range keys {
		if v, ok := m[k]; ok && v != nil {
			if n := int64Val(v); n > 0 {
				return n
			}
		}
	}
	return 0
}

func floatValPtr(v any) (float64, bool) {
	switch x := v.(type) {
	case float64:
		if math.IsNaN(x) || math.IsInf(x, 0) {
			return 0, false
		}
		return x, true
	case int64:
		return float64(x), true
	case int:
		return float64(x), true
	case json.Number:
		if f, err := x.Float64(); err == nil && !math.IsNaN(f) && !math.IsInf(f, 0) {
			return f, true
		}
	case string:
		if f, err := strconv.ParseFloat(strings.TrimSpace(x), 64); err == nil && !math.IsNaN(f) && !math.IsInf(f, 0) {
			return f, true
		}
	}
	return 0, false
}

func boolVal(m map[string]any, key string) (bool, bool) {
	if m == nil {
		return false, false
	}
	v, exists := m[key]
	if !exists {
		return false, false
	}
	b, ok := v.(bool)
	return b, ok
}

func toTimestampMS(v any) int64 {
	if v == nil {
		return 0
	}
	switch x := v.(type) {
	case float64:
		if math.IsNaN(x) || math.IsInf(x, 0) || x <= 0 {
			return 0
		}
		if x > 1e12 {
			return int64(math.Round(x))
		}
		if x > 1e9 {
			return int64(math.Round(x * 1000))
		}
		return int64(math.Round(x))
	case int64:
		if x <= 0 {
			return 0
		}
		if x > 1e12 {
			return x
		}
		if x > 1e9 {
			return x * 1000
		}
		return x
	case string:
		s := strings.TrimSpace(x)
		if s == "" {
			return 0
		}
		if n, err := strconv.ParseFloat(s, 64); err == nil && !math.IsNaN(n) && n > 0 {
			if n > 1e12 {
				return int64(math.Round(n))
			}
			if n > 1e9 {
				return int64(math.Round(n * 1000))
			}
			return int64(math.Round(n))
		}
		layouts := []string{
			time.RFC3339Nano,
			time.RFC3339,
			"2006-01-02T15:04:05.999999999",
			"2006-01-02 15:04:05.999999999",
			"2006-01-02 15:04:05",
			"2006-01-02",
		}
		for _, layout := range layouts {
			if t, err := time.Parse(layout, s); err == nil {
				if ms := t.UnixMilli(); ms > 0 {
					return ms
				}
			}
		}
	}
	return 0
}

func parseUUIDv7Timestamp(id string) int64 {
	m := uuidV7PrefixRe.FindStringSubmatch(strings.TrimSpace(id))
	if len(m) != 3 {
		return 0
	}
	ms, err := strconv.ParseInt(m[1]+m[2], 16, 64)
	if err != nil || ms <= 0 {
		return 0
	}
	return ms
}

func statDevIno(st os.FileInfo) (string, string) {
	if st == nil {
		return "", ""
	}
	dev, ino := platform.FileIdentity(st)
	return strconv.FormatUint(dev, 10), strconv.FormatUint(ino, 10)
}

func contextString(ctx map[string]any, key string) string {
	if ctx == nil {
		return ""
	}
	switch v := ctx[key].(type) {
	case string:
		return strings.TrimSpace(v)
	}
	return ""
}

func contextInt64(ctx map[string]any, key string) int64 {
	if ctx == nil {
		return 0
	}
	return int64Val(ctx[key])
}

func contextFloat64(ctx map[string]any, key string) float64 {
	if ctx == nil {
		return 0
	}
	if f, ok := floatValPtr(ctx[key]); ok {
		return f
	}
	return 0
}

func contextBool(ctx map[string]any, key string) bool {
	if ctx == nil {
		return false
	}
	b, _ := ctx[key].(bool)
	return b
}

// ---------- Persistent session registry ownership (Codex & Cline/Kiro) ----------

type persistentSessionEntry struct {
	Provider        string   `json:"provider"`
	SessionID       string   `json:"sessionId"`
	NativeSessionID string   `json:"nativeSessionId"`
	AccountRef      string   `json:"accountRef"`
	CWD             string   `json:"cwd"`
	State           string   `json:"state"`
	Gateway         bool     `json:"gateway"`
	CreatedAt       any      `json:"createdAt"`
	UpdatedAt       any      `json:"updatedAt"`
	ForwardArgs     []string `json:"forwardArgs"`
}

func readPersistentSessionEntries(aiHomeDir string) []persistentSessionEntry {
	if strings.TrimSpace(aiHomeDir) == "" {
		return nil
	}
	dir := filepath.Join(aiHomeDir, "run", "persistent-sessions")
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil
	}
	out := make([]persistentSessionEntry, 0, len(entries))
	for _, entry := range entries {
		if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".json") {
			continue
		}
		raw, err := os.ReadFile(filepath.Join(dir, entry.Name()))
		if err != nil {
			continue
		}
		var item persistentSessionEntry
		if json.Unmarshal(raw, &item) != nil {
			continue
		}
		out = append(out, item)
	}
	return out
}

type codexThreadOwnership struct {
	AccountRefs   map[string]struct{}
	EarliestByRef map[string]int64
	HasGateway    bool
	GatewaySince  int64
}

type codexOwnershipResolved struct {
	AccountRef string
	Gateway    bool
	Since      int64
}

type codexSessionOwnershipIndex struct {
	threads map[string]*codexThreadOwnership
}

func loadCodexSessionOwnershipIndex(aiHomeDir string) *codexSessionOwnershipIndex {
	idx := &codexSessionOwnershipIndex{threads: make(map[string]*codexThreadOwnership)}
	for _, item := range readPersistentSessionEntries(aiHomeDir) {
		if strings.ToLower(strings.TrimSpace(item.Provider)) != "codex" {
			continue
		}
		threadID := extractCodexThreadID(item)
		if threadID == "" {
			continue
		}
		ref := strings.TrimSpace(item.AccountRef)
		if !item.Gateway && !isAccountRefFormat(ref) {
			continue
		}
		entry := idx.threads[threadID]
		if entry == nil {
			entry = &codexThreadOwnership{
				AccountRefs:   make(map[string]struct{}),
				EarliestByRef: make(map[string]int64),
			}
			idx.threads[threadID] = entry
		}
		ts := toTimestampMS(item.CreatedAt)
		if item.Gateway {
			entry.HasGateway = true
			if ts > 0 && (entry.GatewaySince == 0 || ts < entry.GatewaySince) {
				entry.GatewaySince = ts
			}
			continue
		}
		entry.AccountRefs[ref] = struct{}{}
		if ts > 0 {
			if prev, ok := entry.EarliestByRef[ref]; !ok || ts < prev {
				entry.EarliestByRef[ref] = ts
			}
		}
	}
	return idx
}

func extractCodexThreadID(item persistentSessionEntry) string {
	nativeID := strings.TrimSpace(item.NativeSessionID)
	if codexThreadUUIDRe.MatchString(nativeID) {
		return strings.ToLower(codexThreadUUIDRe.FindString(nativeID))
	}
	for i := 0; i < len(item.ForwardArgs); i++ {
		arg := strings.TrimSpace(item.ForwardArgs[i])
		if (arg == "resume" || arg == "/resume") && i+1 < len(item.ForwardArgs) {
			next := strings.TrimSpace(item.ForwardArgs[i+1])
			if m := codexThreadUUIDRe.FindString(next); m != "" {
				return strings.ToLower(m)
			}
		}
	}
	return ""
}

func (idx *codexSessionOwnershipIndex) resolve(sessionID, filePath string) codexOwnershipResolved {
	if idx == nil {
		return codexOwnershipResolved{}
	}
	cand := strings.ToLower(codexThreadUUIDRe.FindString(sessionID))
	if cand == "" {
		cand = strings.ToLower(codexThreadUUIDRe.FindString(filePath))
	}
	if cand == "" {
		return codexOwnershipResolved{}
	}
	entry := idx.threads[cand]
	if entry == nil {
		return codexOwnershipResolved{}
	}
	if len(entry.AccountRefs) == 0 && entry.HasGateway {
		return codexOwnershipResolved{Gateway: true, Since: entry.GatewaySince}
	}
	if len(entry.AccountRefs) != 1 {
		return codexOwnershipResolved{}
	}
	var soleRef string
	for k := range entry.AccountRefs {
		soleRef = k
	}
	if entry.HasGateway {
		accSince := entry.EarliestByRef[soleRef]
		if entry.GatewaySince > accSince {
			return codexOwnershipResolved{Gateway: true, Since: entry.GatewaySince}
		}
		return codexOwnershipResolved{AccountRef: soleRef, Since: accSince}
	}
	return codexOwnershipResolved{AccountRef: soleRef, Since: 0}
}

type scopeWindow struct {
	AccountRef string
	CWD        string
	StartMS    int64
	EndMS      int64
	HasEnd     bool
}

type registryScopeOwnership struct {
	scopes []scopeWindow
}

func loadRegistryScopeOwnership(aiHomeDir, provider string) *registryScopeOwnership {
	normProv := strings.ToLower(strings.TrimSpace(provider))
	var scopes []scopeWindow
	for _, item := range readPersistentSessionEntries(aiHomeDir) {
		if strings.ToLower(strings.TrimSpace(item.Provider)) != normProv || item.Gateway {
			continue
		}
		ref := strings.TrimSpace(item.AccountRef)
		if !isAccountRefFormat(ref) {
			continue
		}
		created := toTimestampMS(item.CreatedAt)
		if created <= 0 {
			continue
		}
		updated := toTimestampMS(item.UpdatedAt)
		if updated < created {
			updated = created
		}
		live := strings.ToLower(strings.TrimSpace(item.State)) == "live"
		scopes = append(scopes, scopeWindow{
			AccountRef: ref,
			CWD:        strings.TrimSpace(item.CWD),
			StartMS:    created - scopeGraceMS,
			EndMS:      updated + scopeGraceMS,
			HasEnd:     !live,
		})
	}
	return &registryScopeOwnership{scopes: scopes}
}

func (r *registryScopeOwnership) resolve(cwd string, atMS int64) string {
	if r == nil || len(r.scopes) == 0 {
		return ""
	}
	normCWD := filepath.Clean(strings.TrimSpace(cwd))
	if normCWD == "." {
		normCWD = ""
	}
	matchedRefs := make(map[string]struct{})
	for _, sc := range r.scopes {
		if atMS > 0 {
			if atMS < sc.StartMS {
				continue
			}
			if sc.HasEnd && atMS > sc.EndMS {
				continue
			}
		}
		scCWD := filepath.Clean(sc.CWD)
		if scCWD == "." {
			scCWD = ""
		}
		if normCWD != "" && scCWD != "" && normCWD != scCWD {
			continue
		}
		matchedRefs[sc.AccountRef] = struct{}{}
	}
	if len(matchedRefs) != 1 {
		return ""
	}
	for ref := range matchedRefs {
		return ref
	}
	return ""
}

// ---------- Codex scanner ----------

type codexUsageSnapshot struct {
	InputTokens     int64 `json:"inputTokens"`
	CachedTokens    int64 `json:"cachedTokens"`
	OutputTokens    int64 `json:"outputTokens"`
	ReasoningTokens int64 `json:"reasoningTokens"`
	TotalTokens     int64 `json:"totalTokens"`
}

type codexUsageDelta struct {
	InputTokens           int64
	OutputTokens          int64
	CacheReadInputTokens  int64
	ReasoningOutputTokens int64
	TotalTokens           int64
}

type codexUsageTracker struct {
	Baselines    []codexUsageSnapshot
	RecentEvents []string
}

func newCodexUsageTracker(ctx map[string]any) *codexUsageTracker {
	tracker := &codexUsageTracker{}
	if ctx == nil {
		return tracker
	}
	if rawBase, ok := ctx["codexUsageBaselines"].([]any); ok {
		for _, item := range rawBase {
			if m, ok := item.(map[string]any); ok {
				tracker.Baselines = append(tracker.Baselines, codexUsageSnapshot{
					InputTokens:     int64FromMap(m, "inputTokens"),
					CachedTokens:    int64FromMap(m, "cachedTokens"),
					OutputTokens:    int64FromMap(m, "outputTokens"),
					ReasoningTokens: int64FromMap(m, "reasoningTokens"),
					TotalTokens:     int64FromMap(m, "totalTokens"),
				})
			}
		}
		if len(tracker.Baselines) > codexUsageStreamLimit {
			tracker.Baselines = tracker.Baselines[len(tracker.Baselines)-codexUsageStreamLimit:]
		}
	}
	if rawEvents, ok := ctx["codexUsageEventSignatures"].([]any); ok {
		for _, item := range rawEvents {
			if s, ok := item.(string); ok && strings.TrimSpace(s) != "" {
				tracker.RecentEvents = append(tracker.RecentEvents, s)
			}
		}
		if len(tracker.RecentEvents) > codexUsageEventLimit {
			tracker.RecentEvents = tracker.RecentEvents[len(tracker.RecentEvents)-codexUsageEventLimit:]
		}
	}
	return tracker
}

func (t *codexUsageTracker) reset() {
	t.Baselines = nil
	t.RecentEvents = nil
}

func normalizeCodexTokenUsage(m map[string]any) (codexUsageSnapshot, bool) {
	if m == nil {
		return codexUsageSnapshot{}, false
	}
	in := int64FromMap(m, "input_tokens", "inputTokens")
	cached := int64FromMap(m, "cached_input_tokens", "cachedInputTokens")
	out := int64FromMap(m, "output_tokens", "outputTokens")
	reasoning := int64FromMap(m, "reasoning_output_tokens", "reasoningOutputTokens")
	total := int64FromMap(m, "total_tokens", "totalTokens")
	if total == 0 {
		total = in + out
	}
	if in == 0 && cached == 0 && out == 0 && reasoning == 0 && total == 0 {
		return codexUsageSnapshot{}, false
	}
	return codexUsageSnapshot{
		InputTokens:     in,
		CachedTokens:    cached,
		OutputTokens:    out,
		ReasoningTokens: reasoning,
		TotalTokens:     total,
	}, true
}

func codexSnapshotSignature(s codexUsageSnapshot) string {
	return fmt.Sprintf("%d:%d:%d:%d:%d", s.InputTokens, s.CachedTokens, s.OutputTokens, s.ReasoningTokens, s.TotalTokens)
}

func codexDeltaSignature(d codexUsageDelta) string {
	return fmt.Sprintf("%d:%d:%d:%d:%d", d.InputTokens, d.CacheReadInputTokens, d.OutputTokens, d.ReasoningOutputTokens, d.TotalTokens)
}

func (t *codexUsageTracker) rememberEvent(sig string) {
	for _, prev := range t.RecentEvents {
		if prev == sig {
			return
		}
	}
	t.RecentEvents = append(t.RecentEvents, sig)
	if len(t.RecentEvents) > codexUsageEventLimit {
		t.RecentEvents = t.RecentEvents[len(t.RecentEvents)-codexUsageEventLimit:]
	}
}

func (t *codexUsageTracker) hasRecentEvent(sig string) bool {
	for _, prev := range t.RecentEvents {
		if prev == sig {
			return true
		}
	}
	return false
}

func (t *codexUsageTracker) updateBaseline(oldIdx int, next codexUsageSnapshot) {
	if oldIdx >= 0 && oldIdx < len(t.Baselines) {
		t.Baselines[oldIdx] = next
		return
	}
	t.Baselines = append(t.Baselines, next)
	if len(t.Baselines) > codexUsageStreamLimit {
		t.Baselines = t.Baselines[len(t.Baselines)-codexUsageStreamLimit:]
	}
}

func (t *codexUsageTracker) observe(totalMap, lastMap map[string]any) (codexUsageDelta, bool) {
	totalSnap, hasTotal := normalizeCodexTokenUsage(totalMap)
	lastSnap, hasLast := normalizeCodexTokenUsage(lastMap)
	if !hasTotal && !hasLast {
		return codexUsageDelta{}, false
	}
	if hasTotal {
		sig := "T:" + codexSnapshotSignature(totalSnap)
		if t.hasRecentEvent(sig) {
			return codexUsageDelta{}, false
		}
		if hasLast {
			if matchedIdx := t.findMatchingBaseline(totalSnap, lastSnap); matchedIdx >= 0 {
				t.updateBaseline(matchedIdx, totalSnap)
				t.rememberEvent(sig)
				return codexUsageDelta{
					InputTokens:           lastSnap.InputTokens,
					OutputTokens:          lastSnap.OutputTokens,
					CacheReadInputTokens:  lastSnap.CachedTokens,
					ReasoningOutputTokens: lastSnap.ReasoningTokens,
					TotalTokens:           lastSnap.TotalTokens,
				}, true
			}
			// 检查是否只是某个已有流上的累加增长
			for i, b := range t.Baselines {
				if totalSnap.InputTokens >= b.InputTokens &&
					totalSnap.OutputTokens >= b.OutputTokens &&
					totalSnap.CachedTokens >= b.CachedTokens &&
					totalSnap.ReasoningTokens >= b.ReasoningTokens &&
					totalSnap.TotalTokens >= b.TotalTokens {
					diff := codexUsageDelta{
						InputTokens:           totalSnap.InputTokens - b.InputTokens,
						OutputTokens:          totalSnap.OutputTokens - b.OutputTokens,
						CacheReadInputTokens:  totalSnap.CachedTokens - b.CachedTokens,
						ReasoningOutputTokens: totalSnap.ReasoningTokens - b.ReasoningTokens,
						TotalTokens:           totalSnap.TotalTokens - b.TotalTokens,
					}
					if diff.TotalTokens == 0 && diff.InputTokens == 0 && diff.OutputTokens == 0 {
						return codexUsageDelta{}, false
					}
					t.updateBaseline(i, totalSnap)
					t.rememberEvent(sig)
					return diff, true
				}
			}
			t.updateBaseline(-1, totalSnap)
			t.rememberEvent(sig)
			return codexUsageDelta{
				InputTokens:           lastSnap.InputTokens,
				OutputTokens:          lastSnap.OutputTokens,
				CacheReadInputTokens:  lastSnap.CachedTokens,
				ReasoningOutputTokens: lastSnap.ReasoningTokens,
				TotalTokens:           lastSnap.TotalTokens,
			}, true
		}
		// 仅 total 存在
		for i, b := range t.Baselines {
			if totalSnap.TotalTokens >= b.TotalTokens && totalSnap.InputTokens >= b.InputTokens && totalSnap.OutputTokens >= b.OutputTokens {
				diff := codexUsageDelta{
					InputTokens:           totalSnap.InputTokens - b.InputTokens,
					OutputTokens:          totalSnap.OutputTokens - b.OutputTokens,
					CacheReadInputTokens:  totalSnap.CachedTokens - b.CachedTokens,
					ReasoningOutputTokens: totalSnap.ReasoningTokens - b.ReasoningTokens,
					TotalTokens:           totalSnap.TotalTokens - b.TotalTokens,
				}
				if diff.TotalTokens == 0 && diff.InputTokens == 0 && diff.OutputTokens == 0 {
					return codexUsageDelta{}, false
				}
				t.updateBaseline(i, totalSnap)
				t.rememberEvent(sig)
				return diff, true
			}
		}
		t.updateBaseline(-1, totalSnap)
		t.rememberEvent(sig)
		return codexUsageDelta{
			InputTokens:           totalSnap.InputTokens,
			OutputTokens:          totalSnap.OutputTokens,
			CacheReadInputTokens:  totalSnap.CachedTokens,
			ReasoningOutputTokens: totalSnap.ReasoningTokens,
			TotalTokens:           totalSnap.TotalTokens,
		}, true
	}

	// 仅 last 存在
	sig := "L:" + codexDeltaSignature(codexUsageDelta{
		InputTokens:           lastSnap.InputTokens,
		OutputTokens:          lastSnap.OutputTokens,
		CacheReadInputTokens:  lastSnap.CachedTokens,
		ReasoningOutputTokens: lastSnap.ReasoningTokens,
		TotalTokens:           lastSnap.TotalTokens,
	})
	if t.hasRecentEvent(sig) {
		return codexUsageDelta{}, false
	}
	t.rememberEvent(sig)
	return codexUsageDelta{
		InputTokens:           lastSnap.InputTokens,
		OutputTokens:          lastSnap.OutputTokens,
		CacheReadInputTokens:  lastSnap.CachedTokens,
		ReasoningOutputTokens: lastSnap.ReasoningTokens,
		TotalTokens:           lastSnap.TotalTokens,
	}, true
}

func (t *codexUsageTracker) findMatchingBaseline(total, last codexUsageSnapshot) int {
	for i := len(t.Baselines) - 1; i >= 0; i-- {
		b := t.Baselines[i]
		if b.InputTokens+last.InputTokens == total.InputTokens &&
			b.OutputTokens+last.OutputTokens == total.OutputTokens &&
			b.CachedTokens+last.CachedTokens == total.CachedTokens &&
			b.ReasoningTokens+last.ReasoningTokens == total.ReasoningTokens &&
			b.TotalTokens+last.TotalTokens == total.TotalTokens {
			return i
		}
	}
	return -1
}

func isCodexForkSessionMeta(payload map[string]any) bool {
	if payload == nil {
		return false
	}
	if strVal(payload, "forked_from_id", "forkedFromId") != "" {
		return true
	}
	source := mapVal(payload, "source")
	if source != nil && mapVal(source, "subagent") != nil {
		return true
	}
	return false
}

func isCodexUserPrompt(payload map[string]any) bool {
	if payload == nil {
		return false
	}
	ptype := strVal(payload, "type")
	if ptype == "user_message" {
		return strVal(payload, "message") != ""
	}
	if ptype != "message" || strVal(payload, "role") != "user" {
		return false
	}
	arr, ok := payload["content"].([]any)
	if !ok {
		return false
	}
	for _, item := range arr {
		block, ok := item.(map[string]any)
		if !ok {
			continue
		}
		if strVal(block, "text") != "" {
			return true
		}
	}
	return false
}

func scanCodexFile(
	ctx context.Context,
	store *UsageStore,
	filePath string,
	reindexCodexForkHistory bool,
	maxBytes int64,
	ownership *codexSessionOwnershipIndex,
) (fileScanOutcome, error) {
	stat, err := os.Stat(filePath)
	if err != nil {
		return fileScanOutcome{}, err
	}
	currentState, err := store.GetFileState(ctx, filePath)
	if err != nil {
		return fileScanOutcome{}, err
	}
	storedCtx := currentState.ScanContext
	if storedCtx == nil {
		storedCtx = make(map[string]any)
	}
	storedCtxVer := contextInt64(storedCtx, "codexScanContextVersion")
	deferredCtxVer := contextInt64(storedCtx, "codexForkReindexDeferredVersion")
	hasHistoricalOffset := currentState.Offset > 0
	forkReindexDeferred := hasHistoricalOffset && storedCtxVer != codexScanContextVersion && deferredCtxVer == codexScanContextVersion

	var firstPayload map[string]any
	if storedCtxVer != codexScanContextVersion && !forkReindexDeferred {
		if firstEntry := readFirstJSONLEntry(filePath); firstEntry != nil && strVal(firstEntry, "type") == "session_meta" {
			firstPayload = mapVal(firstEntry, "payload")
		}
	}

	initialSessionID := contextString(storedCtx, "sessionId")
	if initialSessionID == "" && firstPayload != nil {
		initialSessionID = strVal(firstPayload, "id")
	}
	if initialSessionID == "" {
		initialSessionID = basenameWithoutExt(filePath)
	}

	resolvedOwner := ownership.resolve(initialSessionID, filePath)
	requestedAccountRef := resolvedOwner.AccountRef
	storedAccountRef := contextString(storedCtx, "attributedAccountRef")
	rebuildAccountProjection := currentState.Offset > 0 && ((requestedAccountRef != "" && requestedAccountRef != storedAccountRef) || (resolvedOwner.Gateway && storedAccountRef != ""))
	requiresForkRebuild := hasHistoricalOffset && storedCtxVer != codexScanContextVersion && (forkReindexDeferred || isCodexForkSessionMeta(firstPayload))

	if requiresForkRebuild && !reindexCodexForkHistory {
		if !forkReindexDeferred {
			nextCtx := cloneScanContext(storedCtx)
			nextCtx["codexForkReindexDeferredVersion"] = codexScanContextVersion
			_ = store.SetFileState(ctx, filePath, UsageFileState{
				Size:        stat.Size(),
				Offset:      currentState.Offset,
				ScanContext: nextCtx,
			})
		}
		return fileScanOutcome{
			FilesDeferred:   1,
			ReindexRequired: 1,
			Reason:          "codex_fork_reindex_required",
		}, nil
	}

	fullProjectionRebuild := (requiresForkRebuild && reindexCodexForkHistory) || rebuildAccountProjection
	startOffset := currentState.Offset
	if stat.Size() < currentState.Offset || fullProjectionRebuild {
		startOffset = 0
	}
	var activeCtx map[string]any
	if startOffset > 0 {
		activeCtx = storedCtx
	}

	sessionID := contextString(activeCtx, "sessionId")
	scopeKnown := resolvedOwner.Gateway || requestedAccountRef != ""
	currentScopeAccountRef := requestedAccountRef
	if resolvedOwner.Gateway {
		currentScopeAccountRef = ""
	}
	sourceHash := StableHash(filePath)
	var historicalRefs map[string]string
	if fullProjectionRebuild {
		historicalRefs, _ = store.ReadFileUsageAccountRefs(ctx, "codex", sourceHash)
	}
	attributeUsageLine := func(tsMS int64, eventKey string) string {
		if scopeKnown && tsMS >= resolvedOwner.Since {
			return currentScopeAccountRef
		}
		if historicalRefs != nil {
			if ref, ok := historicalRefs[eventKey]; ok {
				return ref
			}
		}
		return storedAccountRef
	}
	attributedAccountRef := storedAccountRef
	if scopeKnown {
		attributedAccountRef = currentScopeAccountRef
	}

	cwd := contextString(activeCtx, "cwd")
	version := contextString(activeCtx, "version")
	model := contextString(activeCtx, "model")
	startedAtMS := contextInt64(activeCtx, "startedAtMs")
	updatedAtMS := contextInt64(activeCtx, "updatedAtMs")
	tracker := newCodexUsageTracker(activeCtx)
	sessionMetaSeen := contextBool(activeCtx, "codexSessionMetaSeen") || sessionID != ""
	forkSession := contextBool(activeCtx, "codexForkSession")
	forkReplayPending := contextBool(activeCtx, "codexForkReplayPending")
	forkStartedAtMS := contextInt64(activeCtx, "codexForkStartedAtMs")
	forkReplayBoundaryOffset := contextInt64(activeCtx, "codexForkReplayBoundaryOffset")
	forkPendingModel := contextString(activeCtx, "codexForkPendingModel")
	promptCount := 0
	var records []UsageRecordInput
	var promptEvents []UsagePromptEventInput

	activateForkChild := func(lineOffset int64, fallbackModel string) {
		forkReplayPending = false
		forkReplayBoundaryOffset = maxInt64Zero(lineOffset)
		model = strings.TrimSpace(fallbackModel)
		forkPendingModel = ""
		tracker.reset()
	}

	budget := maxBytes
	if fullProjectionRebuild {
		budget = -1
	}
	readRes, err := readJSONLFromOffset(filePath, startOffset, budget, func(line string, lineOffset int64) {
		entry := safeParseJSONMap(line)
		if entry == nil {
			return
		}
		tsMS := toTimestampMS(entry["timestamp"])
		payload := mapVal(entry, "payload")
		entryType := strVal(entry, "type")

		if entryType == "session_meta" {
			if sessionMetaSeen {
				return
			}
			if s := strVal(payload, "id"); s != "" {
				sessionID = s
			}
			if c := strVal(payload, "cwd"); c != "" {
				cwd = c
			}
			if v := strVal(payload, "cli_version", "cliVersion"); v != "" {
				version = v
			}
			sessionMetaSeen = true
			forkSession = isCodexForkSessionMeta(payload)
			forkReplayPending = forkSession
			if forkStart := parseUUIDv7Timestamp(sessionID); forkStart > 0 {
				forkStartedAtMS = forkStart
			} else {
				forkStartedAtMS = tsMS
			}
			if tsMS > 0 {
				startedAtMS = tsMS
				updatedAtMS = tsMS
			}
			return
		}

		if forkReplayPending {
			if entryType == "turn_context" {
				if m := strVal(payload, "model"); m != "" {
					forkPendingModel = m
				}
				return
			}
			var taskTurnID string
			if entryType == "event_msg" && strVal(payload, "type") == "task_started" {
				taskTurnID = strVal(payload, "turn_id")
				if taskTurnID == "" {
					taskTurnID = strVal(entry, "turn_id")
				}
			}
			if taskStart := parseUUIDv7Timestamp(taskTurnID); taskStart > 0 && forkStartedAtMS > 0 && taskStart >= forkStartedAtMS {
				activateForkChild(lineOffset, "")
				return
			}
			if entryType == "inter_agent_communication_metadata" {
				if trig, ok := boolVal(payload, "trigger_turn"); ok && trig {
					activateForkChild(lineOffset, forkPendingModel)
				}
			}
			return
		}

		if tsMS > 0 {
			if startedAtMS == 0 || tsMS < startedAtMS {
				startedAtMS = tsMS
			}
			if tsMS > updatedAtMS {
				updatedAtMS = tsMS
			}
		}

		if entryType == "turn_context" {
			if m := strVal(payload, "model"); m != "" {
				model = m
			}
			return
		}

		if entryType == "response_item" && isCodexUserPrompt(payload) {
			promptCount++
			if tsMS > 0 {
				promptEvents = append(promptEvents, UsagePromptEventInput{
					Provider:    "codex",
					SessionID:   sessionID,
					TimestampMS: tsMS,
					EventKey:    buildFileEventKey("codex", filePath, lineOffset, "prompt"),
				})
			}
			return
		}

		if entryType != "event_msg" || strVal(payload, "type") != "token_count" || tsMS <= 0 {
			return
		}
		info := mapVal(payload, "info")
		if info == nil {
			return
		}
		usage, ok := tracker.observe(mapVal(info, "total_token_usage"), mapVal(info, "last_token_usage"))
		if !ok || model == "" {
			return
		}
		ek := buildFileEventKey("codex", filePath, lineOffset, "usage")
		records = append(records, UsageRecordInput{
			EventKey:              ek,
			Provider:              "codex",
			AccountRef:            attributeUsageLine(tsMS, ek),
			SourceKind:            "session_jsonl",
			SessionID:             sessionID,
			Model:                 model,
			InputTokens:           maxInt64Zero(usage.InputTokens - usage.CacheReadInputTokens),
			OutputTokens:          maxInt64Zero(usage.OutputTokens - usage.ReasoningOutputTokens),
			CacheReadInputTokens:  usage.CacheReadInputTokens,
			ReasoningOutputTokens: usage.ReasoningOutputTokens,
			TotalTokens:           usage.TotalTokens,
			TimestampMS:           tsMS,
			CWD:                   cwd,
			Project:               inferProjectFromCwd(cwd, ""),
		})
	})
	if err != nil {
		return fileScanOutcome{}, err
	}

	if sessionID == "" {
		sessionID = basenameWithoutExt(filePath)
	}
	project := inferProjectFromCwd(cwd, "")
	for i := range records {
		if records[i].SessionID == "" {
			records[i].SessionID = sessionID
		}
		if records[i].CWD == "" {
			records[i].CWD = cwd
		}
		if records[i].Project == "" {
			records[i].Project = project
		}
	}
	for i := range promptEvents {
		if promptEvents[i].SessionID == "" {
			promptEvents[i].SessionID = sessionID
		}
	}

	var sessionRecords []UsageSessionInput
	if sessionID != "" && (len(records) > 0 || promptCount > 0 || cwd != "") {
		sessionRecords = []UsageSessionInput{{
			Provider:    "codex",
			SessionID:   sessionID,
			CWD:         cwd,
			Project:     project,
			StartedAtMS: startedAtMS,
			UpdatedAtMS: updatedAtMS,
			PromptCount: promptCount,
		}}
	}

	forkHash := ""
	forkSess := ""
	forkCWD := ""
	forkProj := ""
	if forkSession {
		forkHash = sourceHash
		forkSess = sessionID
		forkCWD = cwd
		forkProj = project
	}
	nextState := UsageFileState{
		Size:   stat.Size(),
		Offset: readRes.Offset,
		ScanContext: map[string]any{
			"sessionId":                     sessionID,
			"cwd":                           cwd,
			"version":                       version,
			"model":                         model,
			"startedAtMs":                   startedAtMS,
			"updatedAtMs":                   updatedAtMS,
			"attributedAccountRef":          attributedAccountRef,
			"codexScanContextVersion":       codexScanContextVersion,
			"codexSessionMetaSeen":          sessionMetaSeen,
			"codexForkSession":              forkSession,
			"codexForkReplayPending":        forkReplayPending,
			"codexForkStartedAtMs":          forkStartedAtMS,
			"codexForkReplayBoundaryOffset": forkReplayBoundaryOffset,
			"codexForkPendingModel":         forkPendingModel,
			"codexForkSourceHash":           forkHash,
			"codexForkCanonicalSessionId":   forkSess,
			"codexForkCanonicalCwd":         forkCWD,
			"codexForkCanonicalProject":     forkProj,
			"codexUsageBaselines":           tracker.Baselines,
			"codexUsageEventSignatures":     tracker.RecentEvents,
		},
	}

	if fullProjectionRebuild {
		ins, pIns, err := store.ReplaceFileProjection(ctx, FileProjectionReplaceInput{
			Provider:       "codex",
			SourceHash:     sourceHash,
			FilePath:       filePath,
			UsageRecords:   records,
			PromptEvents:   promptEvents,
			SessionRecords: sessionRecords,
			FileState:      nextState,
		})
		if err != nil {
			return fileScanOutcome{}, err
		}
		return fileScanOutcome{
			Records:   ins,
			Prompts:   pIns,
			BytesRead: maxInt64Zero(readRes.Offset - startOffset),
		}, nil
	}

	ins, err := store.InsertUsageBatch(ctx, records)
	if err != nil {
		return fileScanOutcome{}, err
	}
	pIns, err := store.InsertPromptEvents(ctx, promptEvents)
	if err != nil {
		return fileScanOutcome{}, err
	}
	if len(sessionRecords) > 0 {
		if _, err := store.UpsertSessions(ctx, sessionRecords); err != nil {
			return fileScanOutcome{}, err
		}
	}
	if err := store.SetFileState(ctx, filePath, nextState); err != nil {
		return fileScanOutcome{}, err
	}
	deferred := 0
	if readRes.Offset < stat.Size() {
		deferred = 1
	}
	return fileScanOutcome{
		Records:       ins,
		Prompts:       pIns,
		BytesRead:     maxInt64Zero(readRes.Offset - startOffset),
		FilesDeferred: deferred,
	}, nil
}

func cloneScanContext(src map[string]any) map[string]any {
	out := make(map[string]any, len(src))
	for k, v := range src {
		out[k] = v
	}
	return out
}

// ---------- Claude scanner ----------

func isClaudeRealUserPrompt(message map[string]any) bool {
	if message == nil {
		return false
	}
	switch c := message["content"].(type) {
	case string:
		return strings.TrimSpace(c) != ""
	case []any:
		if len(c) == 0 {
			return false
		}
		for _, item := range c {
			b, ok := item.(map[string]any)
			if !ok {
				continue
			}
			if strVal(b, "type") == "tool_result" || strVal(b, "tool_use_id") != "" {
				return false
			}
		}
		for _, item := range c {
			b, ok := item.(map[string]any)
			if !ok {
				continue
			}
			if strVal(b, "type") == "text" && strVal(b, "text") != "" {
				return true
			}
		}
	}
	return false
}

func scanClaudeFile(ctx context.Context, store *UsageStore, filePath string) (fileScanOutcome, error) {
	stat, err := os.Stat(filePath)
	if err != nil {
		return fileScanOutcome{}, err
	}
	currentState, err := store.GetFileState(ctx, filePath)
	if err != nil {
		return fileScanOutcome{}, err
	}
	startOffset := currentState.Offset
	if stat.Size() < currentState.Offset {
		startOffset = 0
	}
	projectDir := filepath.Base(filepath.Dir(filePath))
	sessionID := basenameWithoutExt(filePath)
	cwd, gitBranch, version := "", "", ""
	var startedAtMS, updatedAtMS int64
	promptCount := 0
	var records []UsageRecordInput
	var promptEvents []UsagePromptEventInput

	_, err = readJSONLFromOffset(filePath, startOffset, -1, func(line string, lineOffset int64) {
		entry := safeParseJSONMap(line)
		if entry == nil {
			return
		}
		tsMS := toTimestampMS(entry["timestamp"])
		if tsMS > 0 {
			if startedAtMS == 0 || tsMS < startedAtMS {
				startedAtMS = tsMS
			}
			if tsMS > updatedAtMS {
				updatedAtMS = tsMS
			}
		}
		if s := strVal(entry, "sessionId"); s != "" {
			sessionID = s
		}
		if c := strVal(entry, "cwd"); c != "" {
			cwd = c
		}
		if gb := strVal(entry, "gitBranch"); gb != "" {
			gitBranch = gb
		}
		if v := strVal(entry, "version"); v != "" {
			version = v
		}
		msg := mapVal(entry, "message")
		entryType := strVal(entry, "type")

		if entryType == "user" && isClaudeRealUserPrompt(msg) {
			promptCount++
			if tsMS > 0 {
				promptEvents = append(promptEvents, UsagePromptEventInput{
					Provider:    "claude",
					SessionID:   sessionID,
					TimestampMS: tsMS,
					EventKey:    buildFileEventKey("claude", filePath, lineOffset, "prompt"),
				})
			}
			return
		}
		if entryType != "assistant" || tsMS <= 0 {
			return
		}
		usage := mapVal(msg, "usage")
		if usage == nil {
			return
		}
		model := strVal(msg, "model")
		if model == "" || model == "<synthetic>" || model == "delivery-mirror" {
			return
		}
		input := int64FromMap(usage, "input_tokens")
		output := int64FromMap(usage, "output_tokens")
		cacheCreate := int64FromMap(usage, "cache_creation_input_tokens")
		cacheRead := int64FromMap(usage, "cache_read_input_tokens")
		if input == 0 && output == 0 && cacheCreate == 0 && cacheRead == 0 {
			return
		}
		msgID := strVal(msg, "id")
		ek := buildFileEventKey("claude", filePath, lineOffset, "usage")
		if msgID != "" {
			ek = "claude:message:" + msgID
		}
		records = append(records, UsageRecordInput{
			EventKey:                 ek,
			Provider:                 "claude",
			SourceKind:               "session_jsonl",
			SessionID:                sessionID,
			Model:                    model,
			InputTokens:              input,
			OutputTokens:             output,
			CacheReadInputTokens:     cacheRead,
			CacheCreationInputTokens: cacheCreate,
			TotalTokens:              input + output + cacheRead + cacheCreate,
			TimestampMS:              tsMS,
			Project:                  inferProjectFromCwd(cwd, projectDir),
			CWD:                      cwd,
			GitBranch:                gitBranch,
		})
	})
	if err != nil {
		return fileScanOutcome{}, err
	}

	ins, err := store.InsertUsageBatch(ctx, records)
	if err != nil {
		return fileScanOutcome{}, err
	}
	pIns, err := store.InsertPromptEvents(ctx, promptEvents)
	if err != nil {
		return fileScanOutcome{}, err
	}
	if sessionID != "" && (len(records) > 0 || promptCount > 0 || cwd != "") {
		if _, err := store.UpsertSessions(ctx, []UsageSessionInput{{
			Provider:    "claude",
			SessionID:   sessionID,
			Project:     inferProjectFromCwd(cwd, projectDir),
			CWD:         cwd,
			GitBranch:   gitBranch,
			StartedAtMS: startedAtMS,
			UpdatedAtMS: updatedAtMS,
			PromptCount: promptCount,
		}}); err != nil {
			return fileScanOutcome{}, err
		}
	}
	if err := store.SetFileState(ctx, filePath, UsageFileState{
		Size:   stat.Size(),
		Offset: stat.Size(),
		ScanContext: map[string]any{
			"sessionId":   sessionID,
			"cwd":         cwd,
			"gitBranch":   gitBranch,
			"version":     version,
			"startedAtMs": startedAtMS,
			"updatedAtMs": updatedAtMS,
		},
	}); err != nil {
		return fileScanOutcome{}, err
	}
	return fileScanOutcome{Records: ins, Prompts: pIns}, nil
}

// ---------- Cline scanner ----------

func discoverClineUsageFiles(hostHomeDir string) []string {
	root := filepath.Join(hostHomeDir, ".cline", "data", "sessions")
	entries, err := os.ReadDir(root)
	if err != nil {
		return nil
	}
	var out []string
	for _, entry := range entries {
		if !entry.IsDir() {
			continue
		}
		recordPath := filepath.Join(root, entry.Name(), entry.Name()+".json")
		messagesPath := filepath.Join(root, entry.Name(), entry.Name()+".messages.json")
		if pathExists(recordPath) && pathExists(messagesPath) {
			out = append(out, recordPath)
		}
	}
	sort.Strings(out)
	return out
}

func scanClineSessionFile(
	ctx context.Context,
	store *UsageStore,
	filePath string,
	ownership *registryScopeOwnership,
) (fileScanOutcome, error) {
	if !strings.HasSuffix(filePath, ".json") {
		return fileScanOutcome{}, nil
	}
	messagesPath := strings.TrimSuffix(filePath, ".json") + ".messages.json"
	stat, err := os.Stat(messagesPath)
	if err != nil {
		return fileScanOutcome{}, nil
	}
	mtimeMS := float64(stat.ModTime().UnixNano()) / 1e6
	currentState, err := store.GetFileState(ctx, messagesPath)
	if err != nil {
		return fileScanOutcome{}, err
	}
	prevMtime := contextFloat64(currentState.ScanContext, "mtimeMs")
	if stat.Size() <= currentState.Size && mtimeMS <= prevMtime {
		return fileScanOutcome{}, nil
	}
	payload := readJSONFileMap(messagesPath)
	if payload == nil {
		return fileScanOutcome{}, nil
	}
	msgs, ok := payload["messages"].([]any)
	if !ok {
		return fileScanOutcome{}, nil
	}
	recordMeta := readJSONFileMap(filePath)
	sessionID := strVal(recordMeta, "session_id")
	if sessionID == "" {
		sessionID = strVal(payload, "sessionId")
	}
	if sessionID == "" {
		sessionID = basenameWithoutExt(filePath)
	}
	cwd := strVal(recordMeta, "cwd")
	startedAtMS := toTimestampMS(recordMeta["started_at"])
	if startedAtMS == 0 {
		parts := strings.SplitN(sessionID, "_", 2)
		if ts, err := strconv.ParseInt(parts[0], 10, 64); err == nil && ts > 0 {
			startedAtMS = ts
		}
	}
	accountRef := ownership.resolve(cwd, startedAtMS)
	fallbackModel := strVal(recordMeta, "model")
	updatedAtMS := toTimestampMS(recordMeta["ended_at"])
	project := inferProjectFromCwd(cwd, filepath.Base(filepath.Dir(messagesPath)))
	var records []UsageRecordInput
	promptCount := 0

	for idx, item := range msgs {
		m, ok := item.(map[string]any)
		if !ok {
			continue
		}
		if strVal(m, "role") == "user" {
			promptCount++
		}
		metrics := mapVal(m, "metrics")
		if metrics == nil {
			continue
		}
		tsMS := int64Val(m["ts"])
		if tsMS == 0 {
			tsMS = toTimestampMS(m["ts"])
		}
		if tsMS <= 0 {
			continue
		}
		if tsMS > updatedAtMS {
			updatedAtMS = tsMS
		}
		input := int64FromMap(metrics, "inputTokens")
		output := int64FromMap(metrics, "outputTokens")
		cacheRead := int64FromMap(metrics, "cacheReadTokens")
		cacheWrite := int64FromMap(metrics, "cacheWriteTokens")
		if input == 0 && output == 0 && cacheRead == 0 && cacheWrite == 0 {
			continue
		}
		model := strVal(mapVal(m, "modelInfo"), "id")
		if model == "" {
			model = fallbackModel
		}
		if model == "" {
			continue
		}
		msgID := strVal(m, "id")
		ek := buildFileEventKey("cline", messagesPath, int64(idx), "usage")
		if msgID != "" {
			ek = "cline:message:" + msgID
		}
		records = append(records, UsageRecordInput{
			EventKey:                 ek,
			Provider:                 "cline",
			AccountRef:               accountRef,
			SourceKind:               "session_messages_json",
			SessionID:                sessionID,
			Model:                    model,
			InputTokens:              input,
			OutputTokens:             output,
			CacheReadInputTokens:     cacheRead,
			CacheCreationInputTokens: cacheWrite,
			TotalTokens:              input + output + cacheRead + cacheWrite,
			TimestampMS:              tsMS,
			Project:                  project,
			CWD:                      cwd,
		})
	}

	ins, err := store.InsertUsageBatch(ctx, records)
	if err != nil {
		return fileScanOutcome{}, err
	}
	if sessionID != "" && (len(records) > 0 || cwd != "") {
		if _, err := store.UpsertSessions(ctx, []UsageSessionInput{{
			Provider:    "cline",
			SessionID:   sessionID,
			Project:     project,
			CWD:         cwd,
			StartedAtMS: startedAtMS,
			UpdatedAtMS: updatedAtMS,
			PromptCount: promptCount,
		}}); err != nil {
			return fileScanOutcome{}, err
		}
	}
	if err := store.SetFileState(ctx, messagesPath, UsageFileState{
		Size:   stat.Size(),
		Offset: stat.Size(),
		ScanContext: map[string]any{
			"sessionId":   sessionID,
			"cwd":         cwd,
			"startedAtMs": startedAtMS,
			"updatedAtMs": updatedAtMS,
			"mtimeMs":     mtimeMS,
		},
	}); err != nil {
		return fileScanOutcome{}, err
	}
	return fileScanOutcome{Records: ins}, nil
}

// ---------- Qoder / QoderCN scanner ----------

type qoderTarget struct {
	Provider     string
	AccountRef   string
	ProjectsRoot string
}

type qoderFile struct {
	FilePath   string
	Provider   string
	AccountRef string
}

func scanQoderProvider(ctx context.Context, store *UsageStore, hostHomeDir, aiHomeDir, provider string) providerScanCounters {
	dotDir := ".qoder"
	if provider == "qodercn" {
		dotDir = ".qoder-cn"
	}
	targets := []qoderTarget{{
		Provider:     provider,
		AccountRef:   "",
		ProjectsRoot: filepath.Join(hostHomeDir, dotDir, "projects"),
	}}
	if aiHomeDir != "" {
		projRoot := filepath.Join(aiHomeDir, "run", "auth-projections", provider)
		if entries, err := os.ReadDir(projRoot); err == nil {
			for _, entry := range entries {
				if entry.IsDir() && isAccountRefFormat(entry.Name()) {
					targets = append(targets, qoderTarget{
						Provider:     provider,
						AccountRef:   entry.Name(),
						ProjectsRoot: filepath.Join(projRoot, entry.Name(), "projects"),
					})
				}
			}
		}
	}

	var files []qoderFile
	for _, tgt := range targets {
		projDirs, err := os.ReadDir(tgt.ProjectsRoot)
		if err != nil {
			continue
		}
		for _, pd := range projDirs {
			if !pd.IsDir() {
				continue
			}
			pDir := filepath.Join(tgt.ProjectsRoot, pd.Name())
			names, err := os.ReadDir(pDir)
			if err != nil {
				continue
			}
			for _, item := range names {
				if !item.IsDir() && strings.HasSuffix(item.Name(), ".jsonl") {
					files = append(files, qoderFile{
						FilePath:   filepath.Join(pDir, item.Name()),
						Provider:   tgt.Provider,
						AccountRef: tgt.AccountRef,
					})
				}
			}
		}
	}
	sort.Slice(files, func(i, j int) bool { return files[i].FilePath < files[j].FilePath })

	out := providerScanCounters{}
	for _, qf := range files {
		res, err := scanQoderSessionFile(ctx, store, qf)
		if err != nil {
			out.Skipped++
			continue
		}
		out.Files++
		out.Records += res.Records
		out.Prompts += res.Prompts
	}
	return out
}

func isCJKCodePoint(r rune) bool {
	return (r >= 0x3400 && r <= 0x4dbf) ||
		(r >= 0x4e00 && r <= 0x9fff) ||
		(r >= 0xf900 && r <= 0xfaff) ||
		(r >= 0x3000 && r <= 0x303f) ||
		(r >= 0x3040 && r <= 0x30ff) ||
		(r >= 0xac00 && r <= 0xd7af) ||
		(r >= 0xff00 && r <= 0xffef) ||
		(r >= 0x20000 && r <= 0x2fa1f)
}

func estimateQoderTextTokens(text string) int64 {
	if text == "" {
		return 0
	}
	var cjk, other int64
	for _, r := range text {
		if isCJKCodePoint(r) {
			cjk++
		} else {
			other++
		}
	}
	return cjk + (other+3)/4
}

func scanQoderSessionFile(ctx context.Context, store *UsageStore, qf qoderFile) (fileScanOutcome, error) {
	stat, err := os.Stat(qf.FilePath)
	if err != nil {
		return fileScanOutcome{}, err
	}
	currentState, err := store.GetFileState(ctx, qf.FilePath)
	if err != nil {
		return fileScanOutcome{}, err
	}
	startOffset := currentState.Offset
	if stat.Size() < currentState.Offset {
		startOffset = 0
	}
	projectDir := filepath.Base(filepath.Dir(qf.FilePath))
	sessionID := basenameWithoutExt(qf.FilePath)
	cwd, lastUserText := "", ""
	var startedAtMS, updatedAtMS int64
	promptCount := 0
	assistantBufs := make(map[string]*struct{ text, thinking strings.Builder })
	var records []UsageRecordInput
	var promptEvents []UsagePromptEventInput

	_, err = readJSONLFromOffset(qf.FilePath, startOffset, -1, func(line string, lineOffset int64) {
		entry := safeParseJSONMap(line)
		if entry == nil {
			return
		}
		if side, ok := boolVal(entry, "isSidechain"); ok && side {
			return
		}
		tsMS := toTimestampMS(entry["timestamp"])
		if tsMS > 0 {
			if startedAtMS == 0 || tsMS < startedAtMS {
				startedAtMS = tsMS
			}
			if tsMS > updatedAtMS {
				updatedAtMS = tsMS
			}
		}
		if cwd == "" {
			cwd = strVal(entry, "cwd")
		}
		msg := mapVal(entry, "message")
		if s := strVal(entry, "sessionId"); s != "" {
			sessionID = s
		} else if s := strVal(msg, "sessionId"); s != "" {
			sessionID = s
		}
		entryType := strVal(entry, "type")
		if entryType == "user" {
			content := entry["content"]
			if msg != nil && msg["content"] != nil {
				content = msg["content"]
			}
			var text string
			switch c := content.(type) {
			case string:
				text = c
			case []any:
				var parts []string
				for _, item := range c {
					if b, ok := item.(map[string]any); ok && strVal(b, "type") == "text" {
						if t, ok := b["text"].(string); ok {
							parts = append(parts, t)
						}
					}
				}
				text = strings.Join(parts, " ")
			}
			if strings.TrimSpace(text) != "" {
				lastUserText = text
				promptCount++
				if tsMS > 0 {
					promptEvents = append(promptEvents, UsagePromptEventInput{
						Provider:    qf.Provider,
						SessionID:   sessionID,
						TimestampMS: tsMS,
						EventKey:    buildFileEventKey(qf.Provider, qf.FilePath, lineOffset, "prompt"),
					})
				}
			}
			return
		}
		if entryType != "assistant" {
			return
		}
		model := strVal(msg, "model")
		if model == "" {
			model = strVal(entry, "model")
		}
		if model == "" {
			return
		}
		messageID := strVal(msg, "id")
		if messageID == "" {
			messageID = strVal(entry, "uuid", "id")
		}
		bufKey := messageID
		if bufKey == "" {
			bufKey = strconv.FormatInt(lineOffset, 10)
		}
		buf := assistantBufs[bufKey]
		if buf == nil {
			buf = &struct{ text, thinking strings.Builder }{}
			assistantBufs[bufKey] = buf
		}
		if blocks, ok := msg["content"].([]any); ok {
			for _, item := range blocks {
				b, ok := item.(map[string]any)
				if !ok {
					continue
				}
				btype := strVal(b, "type")
				if btype == "text" {
					if t, ok := b["text"].(string); ok {
						buf.text.WriteString(t)
					}
				} else if btype == "thinking" {
					if t, ok := b["thinking"].(string); ok {
						buf.thinking.WriteString(t)
					}
				}
			}
		}
		usage := mapVal(msg, "usage")
		if usage == nil {
			usage = mapVal(entry, "usage")
		}
		if usage == nil || tsMS <= 0 {
			return
		}
		input := int64FromMap(usage, "input_tokens", "inputTokens")
		output := int64FromMap(usage, "output_tokens", "outputTokens")
		cacheRead := int64FromMap(usage, "cache_read_input_tokens", "cacheReadInputTokens", "cacheReadTokens")
		cacheWrite := int64FromMap(usage, "cache_creation_input_tokens", "cacheCreationInputTokens", "cacheWriteTokens")

		ratio, hasRatio := floatValPtr(usage["context_usage_ratio"])
		if !hasRatio {
			ratio, hasRatio = floatValPtr(usage["contextUsageRatio"])
		}
		_, hasCredits := floatValPtr(usage["credits"])
		_, hasOrigCredits := floatValPtr(usage["original_credits"])
		reqID := strVal(usage, "request_id", "requestId")
		_, hasBillable := usage["billable"]

		var total int64
		estimated := false
		if input > 0 || output > 0 || cacheRead > 0 || cacheWrite > 0 {
			total = input + output + cacheRead + cacheWrite
		} else if (hasRatio && ratio > 0) || hasCredits || hasOrigCredits || reqID != "" || hasBillable {
			estimated = true
			if ratio > 0 {
				inEst := int64(math.Round(ratio * qoderContextWindowTokens))
				if inEst < 1 {
					inEst = 1
				}
				input = inEst
			} else {
				input = estimateQoderTextTokens(lastUserText)
			}
			output = estimateQoderTextTokens(buf.text.String() + buf.thinking.String())
			cacheRead, cacheWrite = 0, 0
			total = input + output
		} else {
			return
		}

		if input == 0 && output == 0 && cacheRead == 0 && cacheWrite == 0 {
			return
		}
		ek := buildFileEventKey(qf.Provider, qf.FilePath, lineOffset, "usage")
		if messageID != "" {
			ek = qf.Provider + ":message:" + messageID
		}
		sk := "session_jsonl"
		if estimated {
			sk = "session_jsonl_estimated"
		}
		records = append(records, UsageRecordInput{
			EventKey:                 ek,
			Provider:                 qf.Provider,
			AccountRef:               qf.AccountRef,
			SourceKind:               sk,
			SessionID:                sessionID,
			Model:                    model,
			InputTokens:              input,
			OutputTokens:             output,
			CacheReadInputTokens:     cacheRead,
			CacheCreationInputTokens: cacheWrite,
			TotalTokens:              total,
			TimestampMS:              tsMS,
			Project:                  inferProjectFromCwd(cwd, projectDir),
			CWD:                      cwd,
		})
	})
	if err != nil {
		return fileScanOutcome{}, err
	}

	ins, err := store.InsertUsageBatch(ctx, records)
	if err != nil {
		return fileScanOutcome{}, err
	}
	pIns, err := store.InsertPromptEvents(ctx, promptEvents)
	if err != nil {
		return fileScanOutcome{}, err
	}
	if sessionID != "" && (len(records) > 0 || promptCount > 0 || cwd != "") {
		if _, err := store.UpsertSessions(ctx, []UsageSessionInput{{
			Provider:    qf.Provider,
			SessionID:   sessionID,
			Project:     inferProjectFromCwd(cwd, projectDir),
			CWD:         cwd,
			StartedAtMS: startedAtMS,
			UpdatedAtMS: updatedAtMS,
			PromptCount: promptCount,
		}}); err != nil {
			return fileScanOutcome{}, err
		}
	}
	if err := store.SetFileState(ctx, qf.FilePath, UsageFileState{
		Size:   stat.Size(),
		Offset: stat.Size(),
		ScanContext: map[string]any{
			"sessionId":   sessionID,
			"cwd":         cwd,
			"startedAtMs": startedAtMS,
			"updatedAtMs": updatedAtMS,
		},
	}); err != nil {
		return fileScanOutcome{}, err
	}
	return fileScanOutcome{Records: ins, Prompts: pIns}, nil
}

// ---------- Gemini scanner ----------

func scanGeminiFile(ctx context.Context, store *UsageStore, filePath, geminiDir string) (fileScanOutcome, error) {
	stat, err := os.Stat(filePath)
	if err != nil {
		return fileScanOutcome{}, err
	}
	mtimeMS := float64(stat.ModTime().UnixNano()) / 1e6
	currentState, err := store.GetFileState(ctx, filePath)
	if err != nil {
		return fileScanOutcome{}, err
	}
	if stat.Size() <= currentState.Size && mtimeMS <= contextFloat64(currentState.ScanContext, "mtimeMs") {
		return fileScanOutcome{}, nil
	}
	payload := readJSONFileMap(filePath)
	var msgs []any
	if payload != nil {
		msgs, _ = payload["messages"].([]any)
	}
	if len(msgs) == 0 {
		_ = store.SetFileState(ctx, filePath, UsageFileState{
			Size:        stat.Size(),
			Offset:      stat.Size(),
			ScanContext: map[string]any{"mtimeMs": mtimeMS},
		})
		return fileScanOutcome{}, nil
	}

	sessionID := strVal(payload, "sessionId")
	if sessionID == "" {
		sessionID = basenameWithoutExt(filePath)
	}
	parts := strings.Split(filePath, string(filepath.Separator))
	projectName := ""
	for i := len(parts) - 1; i >= 0; i-- {
		if parts[i] == "tmp" && i+1 < len(parts) {
			projectName = parts[i+1]
			break
		}
	}
	cwd := ""
	if projectName != "" {
		if b, err := os.ReadFile(filepath.Join(geminiDir, "history", projectName, ".project_root")); err == nil {
			cwd = strings.TrimSpace(string(b))
		}
	}
	project := inferProjectFromCwd(cwd, projectName)
	startedAtMS := toTimestampMS(payload["startTime"])
	updatedAtMS := toTimestampMS(payload["lastUpdated"])
	promptCount := 0
	var records []UsageRecordInput
	var promptEvents []UsagePromptEventInput

	for idx, item := range msgs {
		m, ok := item.(map[string]any)
		if !ok {
			continue
		}
		tsMS := toTimestampMS(m["timestamp"])
		if tsMS > 0 {
			if startedAtMS == 0 || tsMS < startedAtMS {
				startedAtMS = tsMS
			}
			if tsMS > updatedAtMS {
				updatedAtMS = tsMS
			}
		}
		idPart := strVal(m, "id")
		if idPart == "" {
			idPart = strconv.FormatInt(tsMS, 10)
		}
		mtype := strVal(m, "type")
		if mtype == "user" {
			promptCount++
			if tsMS > 0 {
				promptEvents = append(promptEvents, UsagePromptEventInput{
					Provider:    "gemini",
					SessionID:   sessionID,
					TimestampMS: tsMS,
					EventKey:    fmt.Sprintf("gemini:file:%s:%d:prompt:%s", StableHash(filePath), idx, StableHash(idPart)),
				})
			}
			continue
		}
		if mtype != "gemini" || tsMS <= 0 {
			continue
		}
		tokens := mapVal(m, "tokens")
		if tokens == nil {
			continue
		}
		input := int64FromMap(tokens, "input")
		output := int64FromMap(tokens, "output")
		cached := int64FromMap(tokens, "cached")
		thoughts := int64FromMap(tokens, "thoughts")
		tool := int64FromMap(tokens, "tool")
		total := int64FromMap(tokens, "total")
		if total == 0 {
			total = input + output + cached + thoughts + tool
		}
		if input == 0 && output == 0 && cached == 0 && thoughts == 0 && total == 0 {
			continue
		}
		records = append(records, UsageRecordInput{
			EventKey:              fmt.Sprintf("gemini:file:%s:%d:usage:%s", StableHash(filePath), idx, StableHash(idPart)),
			Provider:              "gemini",
			SourceKind:            "session_json",
			SessionID:             sessionID,
			Model:                 strVal(m, "model"),
			InputTokens:           maxInt64Zero(input - cached),
			OutputTokens:          output,
			CacheReadInputTokens:  cached,
			ReasoningOutputTokens: thoughts,
			TotalTokens:           total,
			TimestampMS:           tsMS,
			Project:               project,
			CWD:                   cwd,
		})
	}

	ins, err := store.InsertUsageBatch(ctx, records)
	if err != nil {
		return fileScanOutcome{}, err
	}
	pIns, err := store.InsertPromptEvents(ctx, promptEvents)
	if err != nil {
		return fileScanOutcome{}, err
	}
	if sessionID != "" && (len(records) > 0 || promptCount > 0 || cwd != "") {
		if _, err := store.UpsertSessions(ctx, []UsageSessionInput{{
			Provider:    "gemini",
			SessionID:   sessionID,
			Project:     project,
			CWD:         cwd,
			StartedAtMS: startedAtMS,
			UpdatedAtMS: updatedAtMS,
			PromptCount: promptCount,
		}}); err != nil {
			return fileScanOutcome{}, err
		}
	}
	if err := store.SetFileState(ctx, filePath, UsageFileState{
		Size:   stat.Size(),
		Offset: stat.Size(),
		ScanContext: map[string]any{
			"mtimeMs":     mtimeMS,
			"sessionId":   sessionID,
			"updatedAtMs": updatedAtMS,
		},
	}); err != nil {
		return fileScanOutcome{}, err
	}
	return fileScanOutcome{Records: ins, Prompts: pIns}, nil
}

// ---------- Kimi scanner ----------

type kimiTarget struct {
	AccountRef   string
	SessionsRoot string
	PhysicalRoot string
}

type kimiOwnershipResolved struct {
	AccountRef    string
	Authoritative bool
}

type kimiSessionOwnershipIndex struct {
	SessionOwners     map[string]string
	AmbiguousSessions int
	InvalidEntries    int
	IndexPaths        int
	Trustworthy       bool
	HostSessionsPhys  string
	TrustedRoots      []kimiTarget
}

func scanKimiProvider(ctx context.Context, store *UsageStore, hostHomeDir, aiHomeDir string) providerScanCounters {
	targets := []kimiTarget{{
		AccountRef:   "",
		SessionsRoot: filepath.Join(hostHomeDir, ".kimi-code", "sessions"),
	}}
	discErrors := 0
	if aiHomeDir != "" {
		projRoot := filepath.Join(aiHomeDir, "run", "auth-projections", "kimi")
		if pathExists(projRoot) {
			entries, err := os.ReadDir(projRoot)
			if err != nil {
				discErrors++
			} else {
				for _, entry := range entries {
					if entry.IsDir() && isAccountRefFormat(entry.Name()) {
						targets = append(targets, kimiTarget{
							AccountRef:   entry.Name(),
							SessionsRoot: filepath.Join(projRoot, entry.Name(), ".kimi-code", "sessions"),
						})
					}
				}
			}
		}
	}

	var physicalHostRoot string
	var trustedTargets []kimiTarget
	rootsByPhysical := make(map[string][]kimiTarget)

	for _, tgt := range targets {
		if tgt.SessionsRoot == "" || !pathExists(tgt.SessionsRoot) {
			discErrors++
			continue
		}
		physRoot := resolvePhysicalPath(tgt.SessionsRoot)
		st, err := os.Stat(physRoot)
		if err != nil || !st.IsDir() {
			discErrors++
			continue
		}
		if tgt.AccountRef == "" {
			physicalHostRoot = physRoot
		} else {
			runtimeRoot := filepath.Dir(tgt.SessionsRoot)
			lst, err := os.Lstat(runtimeRoot)
			if err != nil || lst.Mode()&os.ModeSymlink != 0 || !lst.IsDir() {
				discErrors++
				continue
			}
		}
		lst, err := os.Lstat(tgt.SessionsRoot)
		if err != nil {
			discErrors++
			continue
		}
		isSym := lst.Mode()&os.ModeSymlink != 0
		if tgt.AccountRef != "" && isSym && physRoot != physicalHostRoot {
			discErrors++
			continue
		}
		tt := kimiTarget{AccountRef: tgt.AccountRef, SessionsRoot: tgt.SessionsRoot, PhysicalRoot: physRoot}
		trustedTargets = append(trustedTargets, tt)
		rootsByPhysical[physRoot] = append(rootsByPhysical[physRoot], tt)
	}

	filesByPhysical := make(map[string]struct{})
	for physRoot := range rootsByPhysical {
		stack := []string{physRoot}
		for len(stack) > 0 {
			dir := stack[len(stack)-1]
			stack = stack[:len(stack)-1]
			entries, err := os.ReadDir(dir)
			if err != nil {
				discErrors++
				continue
			}
			for _, entry := range entries {
				full := filepath.Join(dir, entry.Name())
				if entry.IsDir() {
					stack = append(stack, full)
					continue
				}
				if entry.Type()&os.ModeSymlink != 0 {
					discErrors++
					continue
				}
				if entry.Type().IsRegular() && entry.Name() == "wire.jsonl" {
					physFile := resolvePhysicalPath(full)
					if !isPathWithinRoot(physFile, physRoot) {
						discErrors++
						continue
					}
					filesByPhysical[physFile] = struct{}{}
				}
			}
		}
	}

	files := make([]string, 0, len(filesByPhysical))
	for f := range filesByPhysical {
		files = append(files, f)
	}
	sort.Strings(files)

	ownership := readKimiSessionOwnershipIndex(hostHomeDir, aiHomeDir, physicalHostRoot, trustedTargets)
	res := scanProviderFiles(files, -1, func(filePath string, _ int64) (fileScanOutcome, error) {
		attr := ownership.resolveAttribution(filePath)
		return scanKimiFile(ctx, store, filePath, attr.AccountRef, attr.Authoritative)
	})
	res.Errors = discErrors + ownership.AmbiguousSessions + ownership.InvalidEntries
	return res
}

func readKimiSessionOwnershipIndex(hostHomeDir, aiHomeDir, physicalHostRoot string, trustedTargets []kimiTarget) *kimiSessionOwnershipIndex {
	idx := &kimiSessionOwnershipIndex{
		SessionOwners:    make(map[string]string),
		Trustworthy:      true,
		HostSessionsPhys: physicalHostRoot,
		TrustedRoots:     trustedTargets,
	}
	seenPhysical := make(map[string]struct{})
	sessionSet := make(map[string]map[string]struct{})
	ambiguousSet := make(map[string]struct{})

	loadIndexFile := func(expectedDir, candidatePath string, enforcedAccountRef string) {
		if !pathExists(candidatePath) {
			return
		}
		if lst, err := os.Lstat(candidatePath); err != nil || lst.Mode()&os.ModeSymlink != 0 || !lst.Mode().IsRegular() {
			idx.InvalidEntries++
			idx.Trustworthy = false
			return
		}
		phys := resolvePhysicalPath(candidatePath)
		if !isPathWithinRoot(phys, expectedDir) {
			idx.InvalidEntries++
			idx.Trustworthy = false
			return
		}
		if _, dup := seenPhysical[phys]; dup {
			return
		}
		seenPhysical[phys] = struct{}{}
		raw, err := os.ReadFile(phys)
		if err != nil {
			idx.InvalidEntries++
			idx.Trustworthy = false
			return
		}
		idx.IndexPaths++
		for _, line := range strings.Split(string(raw), "\n") {
			trimmed := strings.TrimSpace(line)
			if trimmed == "" {
				continue
			}
			entry := safeParseJSONMap(trimmed)
			if entry == nil {
				idx.InvalidEntries++
				idx.Trustworthy = false
				continue
			}
			sid := strVal(entry, "sessionId", "session_id")
			ref := strVal(entry, "accountRef", "account_ref")
			if sid == "" || !isAccountRefFormat(ref) || (enforcedAccountRef != "" && ref != enforcedAccountRef) {
				idx.InvalidEntries++
				idx.Trustworthy = false
				continue
			}
			owners := sessionSet[sid]
			if owners == nil {
				owners = make(map[string]struct{})
				sessionSet[sid] = owners
			}
			owners[ref] = struct{}{}
			if len(owners) > 1 {
				ambiguousSet[sid] = struct{}{}
			}
		}
	}

	hostKimi := filepath.Join(hostHomeDir, ".kimi-code")
	loadIndexFile(resolvePhysicalPath(hostKimi), filepath.Join(hostKimi, "session_index.jsonl"), "")
	if aiHomeDir != "" {
		for _, tgt := range trustedTargets {
			if tgt.AccountRef == "" {
				continue
			}
			runtimeKimi := filepath.Dir(tgt.SessionsRoot)
			loadIndexFile(resolvePhysicalPath(runtimeKimi), filepath.Join(runtimeKimi, "session_index.jsonl"), tgt.AccountRef)
		}
	}

	idx.AmbiguousSessions = len(ambiguousSet)
	if idx.AmbiguousSessions > 0 {
		idx.Trustworthy = false
	}
	for sid, owners := range sessionSet {
		if _, amb := ambiguousSet[sid]; amb || len(owners) != 1 {
			continue
		}
		for ref := range owners {
			idx.SessionOwners[sid] = ref
		}
	}
	return idx
}

func inferKimiSessionID(filePath string) string {
	parts := strings.Split(filePath, string(filepath.Separator))
	for i := len(parts) - 1; i >= 1; i-- {
		if parts[i] == "agents" && i+2 < len(parts) && parts[i+2] == "wire.jsonl" {
			return strings.TrimSpace(parts[i-1])
		}
	}
	return basenameWithoutExt(filePath)
}

func (idx *kimiSessionOwnershipIndex) resolveAttribution(filePath string) kimiOwnershipResolved {
	if idx == nil || !idx.Trustworthy {
		return kimiOwnershipResolved{Authoritative: false}
	}
	sid := inferKimiSessionID(filePath)
	if sid == "" {
		return kimiOwnershipResolved{Authoritative: false}
	}
	if owner, ok := idx.SessionOwners[sid]; ok {
		return kimiOwnershipResolved{AccountRef: owner, Authoritative: true}
	}
	// 如果非共享、且落在某个独立 account target 根下
	phys := resolvePhysicalPath(filePath)
	if idx.HostSessionsPhys == "" || !isPathWithinRoot(phys, idx.HostSessionsPhys) {
		for _, tgt := range idx.TrustedRoots {
			if tgt.AccountRef != "" && isPathWithinRoot(phys, tgt.PhysicalRoot) {
				return kimiOwnershipResolved{AccountRef: tgt.AccountRef, Authoritative: true}
			}
		}
	}
	return kimiOwnershipResolved{AccountRef: "", Authoritative: true}
}

func scanKimiFile(
	ctx context.Context,
	store *UsageStore,
	filePath, accountRef string,
	ownerAuthoritative bool,
) (fileScanOutcome, error) {
	currentState, err := store.GetFileState(ctx, filePath)
	if err != nil {
		return fileScanOutcome{}, err
	}
	prevCtx := currentState.ScanContext
	prevRef := contextString(prevCtx, "attributedAccountRef")
	hasStored := len(prevCtx) > 0 || currentState.Size > 0 || currentState.Offset > 0
	reqRef := strings.TrimSpace(accountRef)
	effectiveRef := reqRef
	if hasStored && !ownerAuthoritative {
		effectiveRef = prevRef
	}
	ownerChanged := ownerAuthoritative && hasStored && prevRef != effectiveRef

	stat, err := os.Stat(filePath)
	if err != nil {
		return fileScanOutcome{}, err
	}
	devStr, inoStr := statDevIno(stat)
	hasCursor := currentState.Offset > 0
	sourceTruncated := !ownerChanged && hasCursor && stat.Size() < currentState.Offset
	prevDev := contextString(prevCtx, "sourceDev")
	prevIno := contextString(prevCtx, "sourceIno")
	sourceRotated := !ownerChanged && hasCursor && prevDev != "" && prevIno != "" && (prevDev != devStr || prevIno != inoStr)
	sourceReset := sourceTruncated || sourceRotated

	startOffset := currentState.Offset
	if ownerChanged || sourceReset {
		startOffset = 0
	}
	var activeCtx map[string]any
	if startOffset > 0 {
		activeCtx = prevCtx
	}
	sessionID := contextString(activeCtx, "sessionId")
	if sessionID == "" {
		sessionID = inferKimiSessionID(filePath)
	}
	cwd := contextString(activeCtx, "cwd")
	startedAtMS := contextInt64(activeCtx, "startedAtMs")
	updatedAtMS := contextInt64(activeCtx, "updatedAtMs")
	promptCount := 0
	var records []UsageRecordInput
	var promptEvents []UsagePromptEventInput
	invalidOffsets := make(map[int64]struct{})

	readRes, err := readJSONLFromOffset(filePath, startOffset, -1, func(line string, lineOffset int64) {
		entry := safeParseJSONMap(line)
		if entry == nil {
			invalidOffsets[lineOffset] = struct{}{}
			return
		}
		entryType := strVal(entry, "type")
		if entryType == "metadata" {
			if created := toTimestampMS(entry["created_at"]); created > 0 && (startedAtMS == 0 || created < startedAtMS) {
				startedAtMS = created
			}
			return
		}
		tsMS := toTimestampMS(entry["time"])
		if tsMS > 0 {
			if startedAtMS == 0 || tsMS < startedAtMS {
				startedAtMS = tsMS
			}
			if tsMS > updatedAtMS {
				updatedAtMS = tsMS
			}
		}
		if entryType == "profile.bind" {
			if c := strVal(mapVal(entry, "environmentDisclosure"), "cwd"); c != "" {
				cwd = c
			}
			return
		}
		if entryType == "turn.prompt" {
			if strVal(mapVal(entry, "origin"), "kind") != "user" {
				return
			}
			promptCount++
			if tsMS > 0 {
				promptEvents = append(promptEvents, UsagePromptEventInput{
					Provider:    "kimi",
					SessionID:   sessionID,
					TimestampMS: tsMS,
					EventKey:    buildFileEventKey("kimi", filePath, lineOffset, "prompt"),
				})
			}
			return
		}
		if entryType != "usage.record" || strVal(entry, "usageScope") != "turn" || tsMS <= 0 {
			return
		}
		usage := mapVal(entry, "usage")
		model := strVal(entry, "model")
		if usage == nil || model == "" {
			return
		}
		input := int64FromMap(usage, "inputOther")
		output := int64FromMap(usage, "output")
		cacheRead := int64FromMap(usage, "inputCacheRead")
		cacheCreate := int64FromMap(usage, "inputCacheCreation")
		if input == 0 && output == 0 && cacheRead == 0 && cacheCreate == 0 {
			return
		}
		records = append(records, UsageRecordInput{
			EventKey:                 buildFileEventKey("kimi", filePath, lineOffset, "usage"),
			Provider:                 "kimi",
			AccountRef:               effectiveRef,
			SourceKind:               "session_jsonl",
			SessionID:                sessionID,
			Model:                    model,
			InputTokens:              input,
			OutputTokens:             output,
			CacheReadInputTokens:     cacheRead,
			CacheCreationInputTokens: cacheCreate,
			TotalTokens:              input + output + cacheRead + cacheCreate,
			TimestampMS:              tsMS,
			Project:                  inferProjectFromCwd(cwd, ""),
			CWD:                      cwd,
		})
	})
	if err != nil {
		return fileScanOutcome{}, err
	}

	finalStat, err := os.Stat(filePath)
	if err != nil {
		return fileScanOutcome{}, err
	}
	fDev, fIno := statDevIno(finalStat)
	safeOffset := readRes.Offset
	if readRes.HadTrailingLine {
		if _, inv := invalidOffsets[readRes.TrailingLineStart]; inv {
			safeOffset = readRes.TrailingLineStart
		}
	}
	var sessionRecords []UsageSessionInput
	if sessionID != "" && (len(records) > 0 || promptCount > 0 || cwd != "") {
		sessionRecords = []UsageSessionInput{{
			Provider:    "kimi",
			SessionID:   sessionID,
			Project:     inferProjectFromCwd(cwd, ""),
			CWD:         cwd,
			StartedAtMS: startedAtMS,
			UpdatedAtMS: updatedAtMS,
			PromptCount: promptCount,
		}}
	}
	nextState := UsageFileState{
		FilePath: filePath,
		Size:     finalStat.Size(),
		Offset:   safeOffset,
		ScanContext: map[string]any{
			"sessionId":            sessionID,
			"cwd":                  cwd,
			"startedAtMs":          startedAtMS,
			"updatedAtMs":          updatedAtMS,
			"attributedAccountRef": effectiveRef,
			"sourceDev":            fDev,
			"sourceIno":            fIno,
		},
	}

	projInput := KimiFileProjectionInput{
		SourceHash:        StableHash(filePath),
		FilePath:          filePath,
		SessionID:         sessionID,
		ExpectedFileState: &currentState,
		UsageRecords:      records,
		PromptEvents:      promptEvents,
		SessionRecords:    sessionRecords,
		FileState:         nextState,
	}
	if ownerChanged || sourceReset {
		ins, pIns, err := store.ReplaceKimiFileProjection(ctx, projInput)
		return fileScanOutcome{Records: ins, Prompts: pIns}, err
	}
	ins, pIns, err := store.AppendKimiFileProjection(ctx, projInput)
	return fileScanOutcome{Records: ins, Prompts: pIns}, err
}

// ---------- OpenCode SQLite dual-layout scanner ----------

type opencodeLayout struct {
	ID           string
	SessionTable string
	MessageTable string
	TypeColumn   string
}

var opencodeLayouts = []opencodeLayout{
	{ID: "session_v2", SessionTable: "session_v2", MessageTable: "session_message", TypeColumn: "type"},
	{ID: "session_legacy", SessionTable: "session", MessageTable: "message", TypeColumn: ""},
}

type opencodeMessageRow struct {
	LayoutPriority   int
	MessageID        string
	SessionID        string
	MessageType      string
	MessageCreatedAt int64
	MessageUpdatedAt int64
	MessageData      string
	SessionDirectory string
	SessionPath      string
	SessionTitle     string
	SessionModel     string
	SessionVersion   string
	SessionStartedAt int64
	SessionUpdatedAt int64
	ProjectWorktree  string
	ProjectName      string
}

func discoverOpenCodeUsageFiles(hostHomeDir, aiHomeDir string) []string {
	var files []string
	seen := make(map[string]struct{})
	addCandidate := func(cand string) {
		if cand == "" || !pathExists(cand) {
			return
		}
		real := resolvePhysicalPath(cand)
		if _, ok := seen[real]; ok {
			return
		}
		st, err := os.Stat(cand)
		if err != nil || !st.Mode().IsRegular() {
			return
		}
		seen[real] = struct{}{}
		files = append(files, cand)
	}
	addCandidate(filepath.Join(hostHomeDir, ".local", "share", "opencode", "opencode.db"))
	if aiHomeDir != "" {
		projRoot := filepath.Join(aiHomeDir, "run", "auth-projections", "opencode")
		for _, f := range listFilesRecursive(projRoot, func(_ string, name string) bool {
			return opencodeDBPatternRe.MatchString(name)
		}) {
			addCandidate(f)
		}
	}
	return files
}

func readSQLiteDBChangeFingerprint(dbPath string) (size int64, mtimeMS float64) {
	for _, cand := range []string{dbPath, dbPath + "-wal"} {
		st, err := os.Stat(cand)
		if err != nil || !st.Mode().IsRegular() {
			continue
		}
		size += st.Size()
		ms := float64(st.ModTime().UnixNano()) / 1e6
		if ms > mtimeMS {
			mtimeMS = ms
		}
	}
	return size, mtimeMS
}

func sqliteHasTable(ctx context.Context, db *sql.DB, tableName string) bool {
	var name string
	err := db.QueryRowContext(ctx, `SELECT name FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1`, tableName).Scan(&name)
	return err == nil && name != ""
}

func scanOpenCodeFile(ctx context.Context, store *UsageStore, filePath string, nowFn func() time.Time) (fileScanOutcome, error) {
	if !pathExists(filePath) {
		return fileScanOutcome{}, nil
	}
	fpSize, fpMtime := readSQLiteDBChangeFingerprint(filePath)
	currentState, err := store.GetFileState(ctx, filePath)
	if err != nil {
		return fileScanOutcome{}, err
	}
	if fpSize <= currentState.Size && fpMtime <= contextFloat64(currentState.ScanContext, "mtimeMs") {
		return fileScanOutcome{}, nil
	}

	dsn := buildReadOnlySQLiteDSN(filePath)
	db, err := sql.Open("sqlite", dsn)
	if err != nil {
		return fileScanOutcome{}, err
	}
	defer func() { _ = db.Close() }()
	_, _ = db.ExecContext(ctx, `PRAGMA query_only = ON`)

	hasProj := sqliteHasTable(ctx, db, "project")
	mergedRows := make(map[string]opencodeMessageRow)
	var anonymousRows []opencodeMessageRow

	for layoutIdx, layout := range opencodeLayouts {
		if !sqliteHasTable(ctx, db, layout.SessionTable) || !sqliteHasTable(ctx, db, layout.MessageTable) {
			continue
		}
		typeCol := "NULL AS message_type"
		if layout.TypeColumn != "" {
			typeCol = layout.MessageTable + "." + layout.TypeColumn + " AS message_type"
		}
		projSelect := "NULL AS project_worktree, NULL AS project_name"
		projJoin := ""
		if hasProj {
			projSelect = "project.worktree AS project_worktree, project.name AS project_name"
			projJoin = " LEFT JOIN project ON project.id = " + layout.SessionTable + ".project_id"
		}
		q := fmt.Sprintf(`
			SELECT
				%s.id AS message_id,
				%s.session_id AS session_id,
				%s,
				%s.time_created AS message_time_created,
				%s.time_updated AS message_time_updated,
				%s.data AS message_data,
				%s.directory AS session_directory,
				%s.path AS session_path,
				%s.title AS session_title,
				%s.model AS session_model,
				%s.version AS session_version,
				%s.time_created AS session_time_created,
				%s.time_updated AS session_time_updated,
				%s
			FROM %s
			LEFT JOIN %s ON %s.id = %s.session_id%s
			ORDER BY %s.time_created ASC, %s.id ASC`,
			layout.MessageTable, layout.MessageTable, typeCol,
			layout.MessageTable, layout.MessageTable, layout.MessageTable,
			layout.SessionTable, layout.SessionTable, layout.SessionTable,
			layout.SessionTable, layout.SessionTable, layout.SessionTable,
			layout.SessionTable, projSelect,
			layout.MessageTable, layout.SessionTable, layout.SessionTable,
			layout.MessageTable, projJoin,
			layout.MessageTable, layout.MessageTable,
		)
		rows, qErr := db.QueryContext(ctx, q)
		if qErr != nil {
			continue
		}
		for rows.Next() {
			var msgID, sessID, msgType, msgData, sessDir, sessPath, sessTitle, sessModel, sessVer, projWorktree, projName sql.NullString
			var msgCreated, msgUpdated, sessCreated, sessUpdated sql.NullInt64
			if sErr := rows.Scan(
				&msgID, &sessID, &msgType, &msgCreated, &msgUpdated, &msgData,
				&sessDir, &sessPath, &sessTitle, &sessModel, &sessVer, &sessCreated, &sessUpdated,
				&projWorktree, &projName,
			); sErr != nil {
				continue
			}
			row := opencodeMessageRow{
				LayoutPriority:   layoutIdx,
				MessageID:        strings.TrimSpace(msgID.String),
				SessionID:        strings.TrimSpace(sessID.String),
				MessageType:      strings.TrimSpace(msgType.String),
				MessageCreatedAt: msgCreated.Int64,
				MessageUpdatedAt: msgUpdated.Int64,
				MessageData:      msgData.String,
				SessionDirectory: strings.TrimSpace(sessDir.String),
				SessionPath:      strings.TrimSpace(sessPath.String),
				SessionTitle:     strings.TrimSpace(sessTitle.String),
				SessionModel:     strings.TrimSpace(sessModel.String),
				SessionVersion:   strings.TrimSpace(sessVer.String),
				SessionStartedAt: sessCreated.Int64,
				SessionUpdatedAt: sessUpdated.Int64,
				ProjectWorktree:  strings.TrimSpace(projWorktree.String),
				ProjectName:      strings.TrimSpace(projName.String),
			}
			if row.MessageID == "" {
				anonymousRows = append(anonymousRows, row)
				continue
			}
			prev, exists := mergedRows[row.MessageID]
			if !exists {
				mergedRows[row.MessageID] = row
				continue
			}
			wNew := openCodeRowWeight(row.MessageData)
			wPrev := openCodeRowWeight(prev.MessageData)
			if wNew > wPrev || (wNew == wPrev && row.LayoutPriority < prev.LayoutPriority) {
				mergedRows[row.MessageID] = row
			}
		}
		_ = rows.Close()
	}

	allRows := make([]opencodeMessageRow, 0, len(mergedRows)+len(anonymousRows))
	for _, r := range mergedRows {
		allRows = append(allRows, r)
	}
	allRows = append(allRows, anonymousRows...)
	sort.Slice(allRows, func(i, j int) bool {
		if allRows[i].MessageCreatedAt != allRows[j].MessageCreatedAt {
			return allRows[i].MessageCreatedAt < allRows[j].MessageCreatedAt
		}
		return allRows[i].MessageID < allRows[j].MessageID
	})

	sessionsByID := make(map[string]*UsageSessionInput)
	var records []UsageRecordInput
	var promptEvents []UsagePromptEventInput

	for idx, row := range allRows {
		sid := row.SessionID
		if sid == "" {
			continue
		}
		data := safeParseJSONMap(row.MessageData)
		tsMS := toTimestampMS(row.MessageCreatedAt)
		if tsMS == 0 {
			tsMS = toTimestampMS(row.MessageUpdatedAt)
		}
		cwd := row.SessionDirectory
		if cwd == "" {
			cwd = row.SessionPath
		}
		if cwd == "" {
			cwd = row.ProjectWorktree
		}
		projFallback := row.ProjectName
		if projFallback == "" {
			projFallback = row.SessionTitle
		}
		sess := sessionsByID[sid]
		if sess == nil {
			sess = &UsageSessionInput{
				Provider:    "opencode",
				SessionID:   sid,
				CWD:         cwd,
				Project:     inferProjectFromCwd(cwd, projFallback),
				StartedAtMS: toTimestampMS(row.SessionStartedAt),
				UpdatedAtMS: toTimestampMS(row.SessionUpdatedAt),
			}
			sessionsByID[sid] = sess
		}
		if tsMS > 0 {
			if sess.StartedAtMS == 0 || tsMS < sess.StartedAtMS {
				sess.StartedAtMS = tsMS
			}
			if tsMS > sess.UpdatedAtMS {
				sess.UpdatedAtMS = tsMS
			}
		}

		role := strings.ToLower(row.MessageType)
		if role == "" {
			role = strings.ToLower(strVal(data, "role"))
		}
		if role == "user" {
			sess.PromptCount++
			if tsMS > 0 {
				ek := fmt.Sprintf("opencode:file:%s:%d:prompt:%s", StableHash(filePath), idx, StableHash(strconv.FormatInt(row.MessageCreatedAt, 10)))
				if row.MessageID != "" {
					ek = "opencode:prompt:" + row.MessageID
				}
				promptEvents = append(promptEvents, UsagePromptEventInput{
					Provider:    "opencode",
					SessionID:   sid,
					TimestampMS: tsMS,
					EventKey:    ek,
				})
			}
			continue
		}
		if role != "assistant" && role != "compaction" {
			continue
		}
		inTok, outTok, reasTok, crTok, cwTok, totalTok := extractOpenCodeTokens(data)
		if inTok == 0 && outTok == 0 && reasTok == 0 && crTok == 0 && cwTok == 0 && totalTok == 0 {
			continue
		}
		model := parseOpenCodeMessageModel(data, row.SessionModel)
		if model == "" || model == "<synthetic>" || model == "delivery-mirror" {
			continue
		}
		ek := fmt.Sprintf("opencode:file:%s:%d:usage:%s", StableHash(filePath), idx, StableHash(strconv.FormatInt(tsMS, 10)))
		if row.MessageID != "" {
			ek = "opencode:message:" + row.MessageID
		}
		records = append(records, UsageRecordInput{
			EventKey:                 ek,
			Provider:                 "opencode",
			SourceKind:               "session_db",
			SessionID:                sid,
			Model:                    model,
			InputTokens:              maxInt64Zero(inTok - crTok),
			OutputTokens:             outTok,
			CacheReadInputTokens:     crTok,
			CacheCreationInputTokens: cwTok,
			ReasoningOutputTokens:    reasTok,
			TotalTokens:              totalTok,
			TimestampMS:              tsMS,
			Project:                  sess.Project,
			CWD:                      sess.CWD,
		})
	}

	ins, err := store.InsertUsageBatch(ctx, records)
	if err != nil {
		return fileScanOutcome{}, err
	}
	pIns, err := store.InsertPromptEvents(ctx, promptEvents)
	if err != nil {
		return fileScanOutcome{}, err
	}
	if len(sessionsByID) > 0 {
		sessList := make([]UsageSessionInput, 0, len(sessionsByID))
		for _, s := range sessionsByID {
			sessList = append(sessList, *s)
		}
		if _, err := store.UpsertSessions(ctx, sessList); err != nil {
			return fileScanOutcome{}, err
		}
	}
	if err := store.SetFileState(ctx, filePath, UsageFileState{
		Size:   fpSize,
		Offset: fpSize,
		ScanContext: map[string]any{
			"mtimeMs":      fpMtime,
			"recordsCount": len(records),
			"updatedAtMs":  nowFn().UnixMilli(),
		},
	}); err != nil {
		return fileScanOutcome{}, err
	}
	return fileScanOutcome{Records: ins, Prompts: pIns}, nil
}

func openCodeRowWeight(rawData string) int64 {
	_, _, _, _, _, tot := extractOpenCodeTokens(safeParseJSONMap(rawData))
	return tot
}

func extractOpenCodeTokens(data map[string]any) (in, out, reason, cacheRead, cacheWrite, total int64) {
	if data == nil {
		return
	}
	tokens := mapVal(data, "tokens")
	cache := mapVal(tokens, "cache")
	in = int64FromMap(tokens, "input", "prompt_tokens", "input_tokens")
	if in == 0 {
		in = int64FromMap(data, "input_tokens")
	}
	out = int64FromMap(tokens, "output", "completion_tokens", "output_tokens")
	if out == 0 {
		out = int64FromMap(data, "output_tokens")
	}
	reason = int64FromMap(tokens, "reasoning", "reasoning_tokens")
	if reason == 0 {
		reason = int64FromMap(data, "reasoning_tokens")
	}
	cacheRead = int64FromMap(cache, "read")
	if cacheRead == 0 {
		cacheRead = int64FromMap(tokens, "cache_read", "cache_read_tokens")
	}
	if cacheRead == 0 {
		cacheRead = int64FromMap(data, "cache_read_tokens")
	}
	cacheWrite = int64FromMap(cache, "write")
	if cacheWrite == 0 {
		cacheWrite = int64FromMap(tokens, "cache_write", "cache_write_tokens")
	}
	if cacheWrite == 0 {
		cacheWrite = int64FromMap(data, "cache_write_tokens")
	}
	total = int64FromMap(tokens, "total", "total_tokens")
	if total == 0 {
		total = int64FromMap(data, "total_tokens")
	}
	if total == 0 {
		total = in + out + reason + cacheRead + cacheWrite
	}
	return
}

func parseOpenCodeMessageModel(data map[string]any, sessionModelRaw string) string {
	joinProvModel := func(prov, model string) string {
		if prov != "" && model != "" && !strings.HasPrefix(model, prov+"/") {
			return prov + "/" + model
		}
		return model
	}
	if mid := strVal(data, "modelID"); mid != "" {
		return joinProvModel(strVal(data, "providerID"), mid)
	}
	if data != nil {
		if mStr, ok := data["model"].(string); ok && strings.TrimSpace(mStr) != "" {
			return strings.TrimSpace(mStr)
		}
		if mMap := mapVal(data, "model"); mMap != nil {
			if mid := strVal(mMap, "id", "modelID", "modelId"); mid != "" {
				return joinProvModel(strVal(mMap, "providerID", "providerId"), mid)
			}
		}
	}
	if sessionModelRaw != "" {
		if smMap := safeParseJSONMap(sessionModelRaw); smMap != nil {
			if mid := strVal(smMap, "id", "modelID"); mid != "" {
				return joinProvModel(strVal(smMap, "providerID", "providerId"), mid)
			}
		}
		return strings.TrimSpace(sessionModelRaw)
	}
	return ""
}

// ---------- Zcode scanner ----------

func scanZcodeProvider(ctx context.Context, opts ScanUsageOptions, hostHomeDir, aiHomeDir string, nowFn func() time.Time) providerScanCounters {
	accountRef := resolveSingleZcodeOAuthAccountRef(ctx, opts.AccountStore, opts.Store)
	ownershipMap := readZcodeNativeUsageOwnership(ctx, opts.Store, aiHomeDir)
	reconciled := 0
	if len(ownershipMap.reconcileInputs) > 0 {
		if n, err := opts.Store.ReconcileZcodeUsageOwnershipBatch(ctx, ownershipMap.reconcileInputs); err == nil {
			reconciled = n
		}
	}

	dbPath := filepath.Join(hostHomeDir, ".zcode", "cli", "db", "db.sqlite")
	if !pathExists(dbPath) {
		return providerScanCounters{Records: reconciled}
	}
	res := scanProviderFiles([]string{dbPath}, -1, func(fp string, _ int64) (fileScanOutcome, error) {
		return scanZcodeUsageFile(ctx, opts.Store, fp, accountRef, ownershipMap, nowFn)
	})
	res.Records += reconciled
	return res
}

func resolveSingleZcodeOAuthAccountRef(ctx context.Context, acctStore *sqliteaccount.Store, usageStore *UsageStore) string {
	if acctStore != nil {
		cursor := accountcore.AccountRef("")
		var oauthRefs []string
		for {
			q, err := accountapp.NewOverviewQuery(cursor, accountapp.MaxOverviewLimit)
			if err != nil {
				break
			}
			page, err := acctStore.ListAccountOverviews(ctx, q)
			if err != nil {
				break
			}
			for _, ov := range page {
				acct := ov.Account()
				if strings.ToLower(strings.TrimSpace(acct.ProviderID())) != "zcode" {
					continue
				}
				isAPIKey, err := acctStore.IsAPIKeyAccount(ctx, acct.Ref())
				if err != nil || isAPIKey {
					continue
				}
				oauthRefs = append(oauthRefs, acct.Ref().String())
			}
			if len(page) < accountapp.MaxOverviewLimit {
				break
			}
			last := page[len(page)-1].Account().Ref()
			if last == cursor {
				break
			}
			cursor = last
		}
		if len(oauthRefs) == 1 {
			return oauthRefs[0]
		}
		if len(oauthRefs) > 1 {
			return ""
		}
	}
	if usageStore != nil && usageStore.db != nil {
		rows, err := usageStore.db.QueryContext(ctx, `
			SELECT a.account_ref, COALESCE(c.auth_kind, '')
			FROM accounts a
			LEFT JOIN account_credentials c ON c.account_ref = a.account_ref
			WHERE lower(a.provider_id) = 'zcode'`)
		if err == nil {
			defer func() { _ = rows.Close() }()
			var oauthRefs []string
			for rows.Next() {
				var ref, kind string
				if rows.Scan(&ref, &kind) == nil {
					if strings.ToLower(strings.TrimSpace(kind)) != "api_key" && isAccountRefFormat(ref) {
						oauthRefs = append(oauthRefs, strings.TrimSpace(ref))
					}
				}
			}
			if len(oauthRefs) == 1 {
				return oauthRefs[0]
			}
		}
	}
	return ""
}

type zcodeOwnershipLookup struct {
	byUsageID       map[string]string
	windows         []zcodeSessionWindow
	reconcileInputs []ZcodeUsageOwnerInput
}

type zcodeSessionWindow struct {
	AccountRef string
	SessionID  string
	StartedMS  int64
	UpdatedMS  int64
}

func readZcodeNativeUsageOwnership(ctx context.Context, store *UsageStore, aiHomeDir string) *zcodeOwnershipLookup {
	out := &zcodeOwnershipLookup{
		byUsageID: make(map[string]string),
	}
	if aiHomeDir == "" || store == nil {
		return out
	}
	root := filepath.Join(aiHomeDir, "run", "auth-projections", "zcode")
	entries, err := os.ReadDir(root)
	if err != nil {
		return out
	}
	for _, entry := range entries {
		if !entry.IsDir() || !isAccountRefFormat(entry.Name()) {
			continue
		}
		acctRef := entry.Name()
		logPath := filepath.Join(root, acctRef, "zcode-native", ".aih-runtime", "zcode-model-usage-owners.jsonl")
		stat, err := os.Stat(logPath)
		if err != nil || !stat.Mode().IsRegular() {
			continue
		}
		curState, err := store.GetFileState(ctx, logPath)
		if err != nil {
			continue
		}
		startOffset := curState.Offset
		if stat.Size() < curState.Offset {
			startOffset = 0
		}
		readRes, rErr := readJSONLFromOffset(logPath, startOffset, -1, func(line string, _ int64) {
			rec := safeParseJSONMap(line)
			if rec == nil {
				return
			}
			uid := strVal(rec, "usageId")
			sid := strVal(rec, "sessionId")
			tsMS := toTimestampMS(rec["timestampMs"])
			startMS := toTimestampMS(rec["startedAtMs"])
			if uid != "" {
				out.byUsageID[uid] = acctRef
			}
			if sid != "" {
				out.windows = append(out.windows, zcodeSessionWindow{
					AccountRef: acctRef,
					SessionID:  sid,
					StartedMS:  startMS,
					UpdatedMS:  tsMS,
				})
			}
			if uid != "" {
				out.reconcileInputs = append(out.reconcileInputs, ZcodeUsageOwnerInput{
					UsageID:     uid,
					AccountRef:  acctRef,
					SessionID:   sid,
					TimestampMS: tsMS,
				})
			}
		})
		if rErr == nil {
			_ = store.SetFileState(ctx, logPath, UsageFileState{
				Size:   stat.Size(),
				Offset: readRes.Offset,
			})
		}
	}
	return out
}

func (z *zcodeOwnershipLookup) resolve(usageID, sessionID string, startedAtMS, timestampMS int64) (string, bool) {
	if z == nil {
		return "", false
	}
	if usageID != "" {
		if ref, ok := z.byUsageID[usageID]; ok {
			return ref, true
		}
	}
	if sessionID != "" {
		matches := make(map[string]struct{})
		at := timestampMS
		if at == 0 {
			at = startedAtMS
		}
		for _, w := range z.windows {
			if w.SessionID == sessionID && (at == 0 || (at >= w.StartedMS-scopeGraceMS && at <= maxInt64(w.StartedMS, w.UpdatedMS)+scopeGraceMS)) {
				matches[w.AccountRef] = struct{}{}
			}
		}
		if len(matches) == 1 {
			for ref := range matches {
				return ref, true
			}
		}
	}
	return "", false
}

func scanZcodeUsageFile(
	ctx context.Context,
	store *UsageStore,
	filePath, accountRef string,
	ownership *zcodeOwnershipLookup,
	nowFn func() time.Time,
) (fileScanOutcome, error) {
	if !pathExists(filePath) {
		return fileScanOutcome{}, nil
	}
	fpSize, fpMtime := readSQLiteDBChangeFingerprint(filePath)
	curState, err := store.GetFileState(ctx, filePath)
	if err != nil {
		return fileScanOutcome{}, err
	}
	if fpSize <= curState.Size && fpMtime <= contextFloat64(curState.ScanContext, "mtimeMs") {
		return fileScanOutcome{}, nil
	}

	db, err := sql.Open("sqlite", buildReadOnlySQLiteDSN(filePath))
	if err != nil {
		return fileScanOutcome{}, err
	}
	defer func() { _ = db.Close() }()
	_, _ = db.ExecContext(ctx, `PRAGMA query_only = ON`)

	if !sqliteHasTable(ctx, db, "model_usage") {
		_ = store.SetFileState(ctx, filePath, UsageFileState{
			Size:        fpSize,
			Offset:      fpSize,
			ScanContext: map[string]any{"mtimeMs": fpMtime},
		})
		return fileScanOutcome{}, nil
	}

	cursorStartedAt := contextInt64(curState.ScanContext, "lastStartedAt")
	baseSQL := `
		SELECT
			mu.id AS usage_id,
			mu.session_id AS session_id,
			mu.model_id AS model_id,
			mu.started_at AS started_at,
			mu.completed_at AS completed_at,
			mu.input_tokens AS input_tokens,
			mu.output_tokens AS output_tokens,
			mu.reasoning_tokens AS reasoning_tokens,
			mu.cache_creation_input_tokens AS cache_creation_input_tokens,
			mu.cache_read_input_tokens AS cache_read_input_tokens,
			mu.provider_total_tokens AS provider_total_tokens,
			mu.computed_total_tokens AS computed_total_tokens,
			mu.parent_user_message_id AS parent_user_message_id,
			s.directory AS session_directory,
			s.path AS session_path,
			s.title AS session_title,
			s.time_created AS session_time_created,
			s.time_updated AS session_time_updated
		FROM model_usage mu
		LEFT JOIN session s ON s.id = mu.session_id`

	var rows *sql.Rows
	if cursorStartedAt > 0 {
		rows, err = db.QueryContext(ctx, baseSQL+` WHERE mu.started_at >= ? ORDER BY mu.started_at ASC, mu.id ASC`, cursorStartedAt)
	} else {
		rows, err = db.QueryContext(ctx, baseSQL+` ORDER BY mu.started_at ASC, mu.id ASC`)
	}
	if err != nil {
		return fileScanOutcome{}, err
	}
	defer func() { _ = rows.Close() }()

	normAcct := ""
	if isAccountRefFormat(accountRef) {
		normAcct = accountRef
	}
	nextCursor := cursorStartedAt
	var records []UsageRecordInput
	var promptEvents []UsagePromptEventInput
	seenPrompt := make(map[string]struct{})
	sessionsByID := make(map[string]*UsageSessionInput)

	for rows.Next() {
		var usageID, sessID, modelID, parentMsgID, sessDir, sessPath, sessTitle sql.NullString
		var startedRaw, completedRaw, inTok, outTok, reasTok, cwTok, crTok, provTot, compTot, sessCreated, sessUpdated sql.NullInt64
		if sErr := rows.Scan(
			&usageID, &sessID, &modelID, &startedRaw, &completedRaw,
			&inTok, &outTok, &reasTok, &cwTok, &crTok, &provTot, &compTot,
			&parentMsgID, &sessDir, &sessPath, &sessTitle, &sessCreated, &sessUpdated,
		); sErr != nil {
			continue
		}
		uid := strings.TrimSpace(usageID.String)
		sid := strings.TrimSpace(sessID.String)
		if uid == "" {
			continue
		}
		tot := compTot.Int64
		if tot <= 0 {
			tot = provTot.Int64
		}
		if tot <= 0 {
			tot = inTok.Int64 + outTok.Int64 + reasTok.Int64 + crTok.Int64 + cwTok.Int64
		}
		if inTok.Int64 == 0 && outTok.Int64 == 0 && reasTok.Int64 == 0 && crTok.Int64 == 0 && cwTok.Int64 == 0 && tot == 0 {
			continue
		}
		model := strings.ToLower(strings.TrimSpace(modelID.String))
		if model == "" {
			continue
		}
		tsMS := toTimestampMS(completedRaw.Int64)
		rowStartMS := toTimestampMS(startedRaw.Int64)
		if tsMS == 0 {
			tsMS = rowStartMS
		}
		if rowStartMS > nextCursor {
			nextCursor = rowStartMS
		}
		rowAcct := normAcct
		if writer, ok := ownership.resolve(uid, sid, rowStartMS, tsMS); ok {
			rowAcct = writer
		}
		cwd := strings.TrimSpace(sessDir.String)
		if cwd == "" {
			cwd = strings.TrimSpace(sessPath.String)
		}
		sess := sessionsByID[sid]
		if sess == nil {
			sess = &UsageSessionInput{
				Provider:    "zcode",
				SessionID:   sid,
				CWD:         cwd,
				Project:     inferProjectFromCwd(cwd, strings.TrimSpace(sessTitle.String)),
				StartedAtMS: firstPosInt64(toTimestampMS(sessCreated.Int64), tsMS),
				UpdatedAtMS: firstPosInt64(toTimestampMS(sessUpdated.Int64), tsMS),
			}
			sessionsByID[sid] = sess
		}
		if tsMS > 0 {
			if sess.StartedAtMS == 0 || tsMS < sess.StartedAtMS {
				sess.StartedAtMS = tsMS
			}
			if tsMS > sess.UpdatedAtMS {
				sess.UpdatedAtMS = tsMS
			}
		}
		pmID := strings.TrimSpace(parentMsgID.String)
		if pmID != "" {
			pk := sid + "\x00" + pmID
			if _, ok := seenPrompt[pk]; !ok {
				seenPrompt[pk] = struct{}{}
				sess.PromptCount++
				if tsMS > 0 {
					promptEvents = append(promptEvents, UsagePromptEventInput{
						Provider:    "zcode",
						SessionID:   sid,
						TimestampMS: tsMS,
						EventKey:    "zcode:prompt:" + pmID,
					})
				}
			}
		}
		records = append(records, UsageRecordInput{
			EventKey:                 "zcode:model_usage:" + uid,
			Provider:                 "zcode",
			AccountRef:               rowAcct,
			SourceKind:               "session_db",
			SessionID:                sid,
			Model:                    model,
			InputTokens:              maxInt64Zero(inTok.Int64),
			OutputTokens:             maxInt64Zero(outTok.Int64),
			CacheReadInputTokens:     maxInt64Zero(crTok.Int64),
			CacheCreationInputTokens: maxInt64Zero(cwTok.Int64),
			ReasoningOutputTokens:    maxInt64Zero(reasTok.Int64),
			TotalTokens:              maxInt64Zero(tot),
			TimestampMS:              tsMS,
			Project:                  sess.Project,
			CWD:                      sess.CWD,
		})
	}

	ins, err := store.InsertUsageBatch(ctx, records)
	if err != nil {
		return fileScanOutcome{}, err
	}
	pIns, err := store.InsertPromptEvents(ctx, promptEvents)
	if err != nil {
		return fileScanOutcome{}, err
	}
	if len(sessionsByID) > 0 {
		sessList := make([]UsageSessionInput, 0, len(sessionsByID))
		for _, s := range sessionsByID {
			sessList = append(sessList, *s)
		}
		if _, err := store.UpsertSessions(ctx, sessList); err != nil {
			return fileScanOutcome{}, err
		}
	}
	if err := store.SetFileState(ctx, filePath, UsageFileState{
		Size:   fpSize,
		Offset: fpSize,
		ScanContext: map[string]any{
			"mtimeMs":       fpMtime,
			"lastStartedAt": nextCursor,
			"recordsCount":  len(records),
			"accountRef":    normAcct,
			"updatedAtMs":   nowFn().UnixMilli(),
		},
	}); err != nil {
		return fileScanOutcome{}, err
	}
	return fileScanOutcome{Records: ins, Prompts: pIns}, nil
}

func firstPosInt64(a, b int64) int64 {
	if a > 0 {
		return a
	}
	return b
}

// ---------- Kiro scanner ----------

func discoverKiroSessionFiles(hostHomeDir string) []string {
	root := filepath.Join(strings.TrimSpace(hostHomeDir), ".kiro", "sessions")
	groups, err := os.ReadDir(root)
	if err != nil {
		return nil
	}
	var out []string
	for _, g := range groups {
		if !g.IsDir() || !kiroHexHash16Re.MatchString(g.Name()) {
			continue
		}
		sessions, err := os.ReadDir(filepath.Join(root, g.Name()))
		if err != nil {
			continue
		}
		for _, s := range sessions {
			if !s.IsDir() || !strings.HasPrefix(s.Name(), "sess_") {
				continue
			}
			msgPath := filepath.Join(root, g.Name(), s.Name(), "messages.jsonl")
			if pathExists(msgPath) {
				out = append(out, msgPath)
			}
		}
	}
	sort.Strings(out)
	return out
}

func estimateKiroTokensFromChars(text string) int64 {
	if text == "" {
		return 0
	}
	var cjk int64
	totalRunes := int64(utf8.RuneCountInString(text))
	for _, r := range text {
		if (r >= 0x3000 && r <= 0x9fff) || (r >= 0xf900 && r <= 0xfaff) {
			cjk++
		}
	}
	other := totalRunes - cjk
	if other < 0 {
		other = 0
	}
	return cjk + (other+3)/4
}

func scanKiroSessionFile(
	ctx context.Context,
	store *UsageStore,
	filePath string,
	ownership *registryScopeOwnership,
) (fileScanOutcome, error) {
	stat, err := os.Stat(filePath)
	if err != nil {
		return fileScanOutcome{}, err
	}
	curState, err := store.GetFileState(ctx, filePath)
	if err != nil {
		return fileScanOutcome{}, err
	}
	startOffset := curState.Offset
	if stat.Size() < startOffset {
		startOffset = 0
	}
	if startOffset >= stat.Size() {
		return fileScanOutcome{}, nil
	}

	sessDir := filepath.Dir(filePath)
	meta := readJSONFileMap(filepath.Join(sessDir, "session.json"))
	sessionID := strVal(meta, "id")
	if sessionID == "" {
		sessionID = filepath.Base(sessDir)
	}
	model := strVal(meta, "modelId")
	cwd := ""
	if ws, ok := meta["workspacePaths"].([]any); ok && len(ws) > 0 {
		if s, ok := ws[0].(string); ok {
			cwd = strings.TrimSpace(s)
		}
	}
	startedAtMS := toTimestampMS(meta["createdAt"])
	maxInputTokens := kiroModelMaxInputTokens[strings.ToLower(model)]

	var activeCtx map[string]any
	if startOffset > 0 {
		activeCtx = curState.ScanContext
	}
	pendingOut := contextInt64(activeCtx, "pendingOutputTokens")
	lastCtxTokens := contextInt64(activeCtx, "lastContextTokens")
	lastCtxAt := contextInt64(activeCtx, "lastContextAtMs")
	snapBeforeLast := [3]int64{pendingOut, lastCtxTokens, lastCtxAt}
	var records []UsageRecordInput

	readRes, err := readJSONLFromOffset(filePath, startOffset, -1, func(line string, lineOffset int64) {
		snapBeforeLast = [3]int64{pendingOut, lastCtxTokens, lastCtxAt}
		entry := safeParseJSONMap(line)
		if entry == nil {
			return
		}
		payload := mapVal(entry, "payload")
		if payload == nil {
			return
		}
		tsMS := toTimestampMS(entry["timestamp"])
		id := strVal(entry, "id")
		if id == "" {
			id = fmt.Sprintf("offset:%d", lineOffset)
		}
		ptype := strVal(payload, "type")
		if ptype == "assistant" {
			if content, ok := payload["content"].(string); ok {
				pendingOut += estimateKiroTokensFromChars(content)
			}
			return
		}
		if ptype == "tool_call" && strVal(payload, "modelToolUseId") != "" && payload["args"] != nil {
			if rawArgs, err := json.Marshal(payload["args"]); err == nil {
				pendingOut += estimateKiroTokensFromChars(string(rawArgs))
			}
			return
		}
		if ptype == "session_metadata" && strVal(payload, "key") == "contextUsage" && tsMS > 0 {
			pct, ok := floatValPtr(mapVal(payload, "value")["usagePercentage"])
			if !ok || pct < 0 {
				return
			}
			var ctxTok int64
			if maxInputTokens > 0 {
				ctxTok = int64(math.Round((pct / 100.0) * float64(maxInputTokens)))
			}
			warm := lastCtxAt > 0 && tsMS-lastCtxAt <= kiroPromptCacheTTLMS
			cacheRead := int64(0)
			if warm {
				if lastCtxTokens < ctxTok {
					cacheRead = lastCtxTokens
				} else {
					cacheRead = ctxTok
				}
			}
			outTok := pendingOut
			pendingOut = 0
			lastCtxTokens = ctxTok
			lastCtxAt = tsMS
			if ctxTok == 0 && outTok == 0 {
				return
			}
			modelOut := model
			if modelOut == "" {
				modelOut = "kiro"
			}
			acctRef := ownership.resolve(cwd, tsMS)
			records = append(records, UsageRecordInput{
				EventKey:             "kiro:context:" + id,
				Provider:             "kiro",
				AccountRef:           acctRef,
				SourceKind:           kiroSessionUsageSourceKind,
				SessionID:            sessionID,
				Model:                modelOut,
				InputTokens:          maxInt64Zero(ctxTok - cacheRead),
				OutputTokens:         outTok,
				CacheReadInputTokens: cacheRead,
				TotalTokens:          ctxTok + outTok,
				TimestampMS:          tsMS,
				Project:              inferProjectFromCwd(cwd, sessionID),
				CWD:                  cwd,
			})
		}
	})
	if err != nil {
		return fileScanOutcome{}, err
	}

	ins, err := store.InsertUsageBatch(ctx, records)
	if err != nil {
		return fileScanOutcome{}, err
	}
	updatedAtMS := startedAtMS
	if len(records) > 0 {
		updatedAtMS = records[len(records)-1].TimestampMS
	}
	if sessionID != "" {
		if _, err := store.UpsertSessions(ctx, []UsageSessionInput{{
			Provider:    "kiro",
			SessionID:   sessionID,
			Project:     inferProjectFromCwd(cwd, sessionID),
			CWD:         cwd,
			StartedAtMS: startedAtMS,
			UpdatedAtMS: updatedAtMS,
		}}); err != nil {
			return fileScanOutcome{}, err
		}
	}
	saveOffset := readRes.Offset
	saveSnap := [3]int64{pendingOut, lastCtxTokens, lastCtxAt}
	if readRes.HadTrailingLine {
		saveOffset = readRes.TrailingLineStart
		saveSnap = snapBeforeLast
	}
	if err := store.SetFileState(ctx, filePath, UsageFileState{
		Size:   stat.Size(),
		Offset: saveOffset,
		ScanContext: map[string]any{
			"sessionId":           sessionID,
			"pendingOutputTokens": saveSnap[0],
			"lastContextTokens":   saveSnap[1],
			"lastContextAtMs":     saveSnap[2],
		},
	}); err != nil {
		return fileScanOutcome{}, err
	}
	return fileScanOutcome{Records: ins}, nil
}

// ---------- Grok scanner ----------

func discoverGrokUsageFiles(hostHomeDir, aiHomeDir, sessionID string) []string {
	sid := strings.TrimSpace(sessionID)
	if sid != "" && !grokSessionIDRe.MatchString(sid) {
		return nil
	}
	roots := []string{
		filepath.Join(hostHomeDir, ".grok", "sessions"),
		filepath.Join(hostHomeDir, ".grok", ".aih-runtime-home", "sessions"),
	}
	if aiHomeDir != "" {
		projRoot := filepath.Join(aiHomeDir, "run", "auth-projections", "grok")
		if entries, err := os.ReadDir(projRoot); err == nil {
			for _, entry := range entries {
				if !isAccountRefFormat(entry.Name()) {
					continue
				}
				roots = append(roots,
					filepath.Join(projRoot, entry.Name(), ".grok", "sessions"),
					filepath.Join(projRoot, entry.Name(), "sessions"),
				)
			}
		}
	}

	physRoots := make(map[string]struct{})
	var uniqueRoots []string
	for _, r := range roots {
		p := resolvePhysicalPath(r)
		if _, ok := physRoots[p]; !ok {
			physRoots[p] = struct{}{}
			uniqueRoots = append(uniqueRoots, p)
		}
	}
	files := make(map[string]struct{})
	for _, root := range uniqueRoots {
		if sid != "" {
			projects, err := os.ReadDir(root)
			if err != nil {
				continue
			}
			for _, p := range projects {
				if !p.IsDir() {
					continue
				}
				cand := filepath.Join(root, p.Name(), sid, "updates.jsonl")
				if st, err := os.Stat(cand); err == nil && st.Mode().IsRegular() {
					files[resolvePhysicalPath(cand)] = struct{}{}
				}
			}
		} else {
			for _, cand := range listFilesRecursive(root, func(_ string, name string) bool {
				return name == "updates.jsonl"
			}) {
				files[resolvePhysicalPath(cand)] = struct{}{}
			}
		}
	}
	out := make([]string, 0, len(files))
	for f := range files {
		out = append(out, f)
	}
	sort.Strings(out)
	return out
}

func accountRefFromGrokProjectionPath(aiHomeDir, candidate string) string {
	if aiHomeDir == "" || strings.TrimSpace(candidate) == "" {
		return ""
	}
	root := filepath.Join(aiHomeDir, "run", "auth-projections", "grok")
	rel, err := filepath.Rel(filepath.Clean(root), filepath.Clean(candidate))
	if err != nil {
		return ""
	}
	parts := strings.Split(rel, string(filepath.Separator))
	if len(parts) >= 2 && isAccountRefFormat(parts[0]) && (parts[1] == ".grok" || parts[1] == "sessions") {
		return parts[0]
	}
	return ""
}

func scanGrokUsageFile(ctx context.Context, store *UsageStore, filePath, aiHomeDir string) (fileScanOutcome, error) {
	stat, err := os.Stat(filePath)
	if err != nil {
		return fileScanOutcome{}, err
	}
	curState, err := store.GetFileState(ctx, filePath)
	if err != nil {
		return fileScanOutcome{}, err
	}
	curCtx := curState.ScanContext
	sessDir := filepath.Dir(filePath)
	summary := readJSONFileMap(filepath.Join(sessDir, "summary.json"))
	sessionID := filepath.Base(sessDir)
	cwd := strVal(mapVal(summary, "info"), "cwd")
	if cwd == "" {
		if decoded, err := url.PathUnescape(filepath.Base(filepath.Dir(sessDir))); err == nil {
			cwd = decoded
		}
	}
	accountRef := accountRefFromGrokProjectionPath(aiHomeDir, strVal(summary, "grok_home"))
	if accountRef == "" {
		accountRef = accountRefFromGrokProjectionPath(aiHomeDir, filePath)
	}
	needsRebuild := contextInt64(curCtx, "grokUsageProjectionVersion") != grokUsageProjectionVersion ||
		contextString(curCtx, "attributedAccountRef") != accountRef ||
		stat.Size() < curState.Offset
	startOffset := curState.Offset
	if stat.Size() < curState.Offset || needsRebuild {
		startOffset = 0
	}

	project := filepath.Base(cwd)
	fileHash := StableHash(filePath)
	startedAtMS := toTimestampMS(summary["created_at"])
	updatedAtMS := toTimestampMS(summary["updated_at"])
	promptIDs := make(map[string]struct{})
	var records []UsageRecordInput
	var prompts []UsagePromptEventInput

	readRes, err := readJSONLFromOffset(filePath, startOffset, -1, func(line string, lineOffset int64) {
		entry := safeParseJSONMap(line)
		if entry == nil {
			return
		}
		params := mapVal(entry, "params")
		update := mapVal(params, "update")
		if update == nil || strVal(update, "sessionUpdate") != "turn_completed" {
			return
		}
		usage := mapVal(update, "usage")
		meta := mapVal(params, "_meta")
		at := toTimestampMS(meta["agentTimestampMs"])
		if at == 0 {
			at = toTimestampMS(entry["timestamp"])
		}
		if usage == nil || at <= 0 {
			return
		}
		promptID := strVal(update, "prompt_id")
		evID := promptID
		if evID == "" {
			evID = strVal(meta, "eventId")
		}
		if evID == "" {
			evID = strconv.FormatInt(lineOffset, 10)
		}

		usagePartial, _ := boolVal(usage, "costIsPartial")
		usageIncomplete, _ := boolVal(usage, "usageIsIncomplete")
		modelUsage := mapVal(usage, "modelUsage")
		for modelName, rawTok := range modelUsage {
			if strings.TrimSpace(modelName) == "" {
				continue
			}
			tok, ok := rawTok.(map[string]any)
			if !ok {
				continue
			}
			input := int64FromMap(tok, "inputTokens")
			output := int64FromMap(tok, "outputTokens")
			cacheRead := minInt64Val(input, int64FromMap(tok, "cachedReadTokens"))
			cacheCreation := minInt64Val(input-cacheRead, int64FromMap(tok, "cacheCreationTokens"))
			reasoning := minInt64Val(output, int64FromMap(tok, "reasoningTokens"))
			if input == 0 && output == 0 {
				continue
			}
			tokPartial, _ := boolVal(tok, "costIsPartial")
			var costPtr *float64
			if ticks, ok := floatValPtr(tok["costUsdTicks"]); ok && ticks >= 0 && !tokPartial && !usagePartial && !usageIncomplete {
				v := ticks / 1e10
				costPtr = &v
			}
			records = append(records, UsageRecordInput{
				EventKey:                 fmt.Sprintf("grok:file:%s:%s:%s:usage", fileHash, StableHash(evID), StableHash(modelName)),
				Provider:                 "grok",
				SourceKind:               "session_jsonl",
				AccountRef:               accountRef,
				SessionID:                sessionID,
				Model:                    modelName,
				InputTokens:              input - cacheRead - cacheCreation,
				OutputTokens:             output - reasoning,
				CacheReadInputTokens:     cacheRead,
				CacheCreationInputTokens: cacheCreation,
				ReasoningOutputTokens:    reasoning,
				TotalTokens:              input + output,
				CostUSD:                  costPtr,
				TimestampMS:              at,
				CWD:                      cwd,
				Project:                  project,
			})
		}
		if promptID != "" {
			if _, seen := promptIDs[promptID]; !seen {
				promptIDs[promptID] = struct{}{}
				prompts = append(prompts, UsagePromptEventInput{
					EventKey:    fmt.Sprintf("grok:file:%s:%s:prompt", fileHash, StableHash(promptID)),
					Provider:    "grok",
					SessionID:   sessionID,
					TimestampMS: at,
				})
			}
		}
		if startedAtMS == 0 || at < startedAtMS {
			startedAtMS = at
		}
		if at > updatedAtMS {
			updatedAtMS = at
		}
	})
	if err != nil {
		return fileScanOutcome{}, err
	}

	saveOffset := readRes.Offset
	if readRes.HadTrailingLine {
		saveOffset = readRes.TrailingLineStart
	}
	nextState := UsageFileState{
		Size:   stat.Size(),
		Offset: saveOffset,
		ScanContext: map[string]any{
			"grokUsageProjectionVersion": grokUsageProjectionVersion,
			"attributedAccountRef":       accountRef,
		},
	}
	sessionRecords := []UsageSessionInput{{
		Provider:    "grok",
		SessionID:   sessionID,
		CWD:         cwd,
		Project:     project,
		StartedAtMS: startedAtMS,
		UpdatedAtMS: updatedAtMS,
		PromptCount: len(prompts),
	}}

	if needsRebuild {
		ins, pIns, err := store.ReplaceFileProjection(ctx, FileProjectionReplaceInput{
			Provider:       "grok",
			SourceHash:     fileHash,
			FilePath:       filePath,
			UsageRecords:   records,
			PromptEvents:   prompts,
			SessionRecords: sessionRecords,
			FileState:      nextState,
		})
		return fileScanOutcome{Records: ins, Prompts: pIns}, err
	}

	ins, err := store.InsertUsageBatch(ctx, records)
	if err != nil {
		return fileScanOutcome{}, err
	}
	pIns, err := store.InsertPromptEvents(ctx, prompts)
	if err != nil {
		return fileScanOutcome{}, err
	}
	if len(records) > 0 || len(prompts) > 0 {
		sessionRecords[0].PromptCount = pIns
		if _, err := store.UpsertSessions(ctx, sessionRecords); err != nil {
			return fileScanOutcome{}, err
		}
	}
	if err := store.SetFileState(ctx, filePath, nextState); err != nil {
		return fileScanOutcome{}, err
	}
	return fileScanOutcome{Records: ins, Prompts: pIns}, nil
}

func minInt64Val(a, b int64) int64 {
	if a < b {
		return a
	}
	return b
}

func buildReadOnlySQLiteDSN(dbPath string) string {
	u := sqlitefile.URL(dbPath)
	q := u.Query()
	q.Set("mode", "ro")
	q.Set("_pragma", "busy_timeout(2000)")
	u.RawQuery = q.Encode()
	return u.String()
}
