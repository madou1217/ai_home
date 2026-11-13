package persistent

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/madou1217/ai_home/core/providers"
)

const (
	socketPrefix          = "aih"
	gatewayRuntimeScope   = "gateway"
	sessionListSeparator  = "\x1f"
	defaultTmuxCmdTimeout = 5 * time.Second
)

var nonSafeKeyPartPattern = regexp.MustCompile(`[^A-Za-z0-9._-]+`)
var leadingTrailingDash = regexp.MustCompile(`^-+|-+$`)

var tmuxListSessionFormat = strings.Join([]string{
	"#{session_name}",
	"#{session_attached}",
	"#{session_created}",
	"#{session_path}",
	"#{pane_title}",
	"#{window_name}",
	"#{pane_current_command}",
	"#{pane_pid}",
	"#{E:AIH_PERSISTENT_RUNTIME_MARKER}",
	"#{pane_dead}",
	"#{pane_current_path}",
	"#{E:AIH_CODEX_FLAGS}",
	"#{window_activity}",
	"#{session_activity}",
}, sessionListSeparator)

// SessionCollector 收集所有受管持久会话的实时运行行。
type SessionCollector interface {
	CollectSessions(ctx context.Context) ([]SessionRow, error)
}

// SessionCloser 负责关闭指定持久会话并同步移除注册表元数据。
type SessionCloser interface {
	CloseSession(ctx context.Context, row SessionRow) error
}

// TmuxRunner 抽象 `tmux` / `psmux` 命令执行，便于生产调用和单测注入。
type TmuxRunner interface {
	Run(ctx context.Context, command string, args ...string) (stdout string, stderr string, exitCode int, err error)
}

// RegisteredScopeProvider 枚举某个 Provider 下仍处于可用状态的运行作用域，可选注入。
type RegisteredScopeProvider interface {
	ListProviderAccountRefs(ctx context.Context, provider string) ([]string, error)
}

// TmuxSessionStore 通过 tmux/psmux 与持久会话注册表枚举并关闭全局持久会话。
type TmuxSessionStore struct {
	AIHomeDir string
	Registry  *Registry
	Catalog   *providers.Catalog
	Runner    TmuxRunner
	Scopes    RegisteredScopeProvider
	Platform  string
	Env       func(string) string
}

type sessionTarget struct {
	provider     string
	runtimeScope string
	accountRef   string
	gateway      bool
	socket       string
}

// DeriveSocket 按 Node `persistent-session.js` 同公式推导独立 socket 名。
func DeriveSocket(cliName, runtimeScope string) (string, error) {
	scope := strings.TrimSpace(runtimeScope)
	if scope != gatewayRuntimeScope && !accountRefPattern.MatchString(scope) {
		return "", fmt.Errorf("持久会话 runtime scope 无效: %q", runtimeScope)
	}
	return socketPrefix + "-" + sanitizeKeyPart(cliName) + "-" + scope, nil
}

// ParseSessionList 解析 `tmux list-sessions -F` 输出的多行记录（兼容 14 字段与旧 >=15 字段格式）。
func ParseSessionList(stdout string) []SessionRow {
	lines := strings.Split(stdout, "\n")
	rows := make([]SessionRow, 0, len(lines))
	for _, rawLine := range lines {
		line := strings.TrimSuffix(rawLine, "\r")
		if strings.TrimSpace(line) == "" {
			continue
		}
		parts := strings.Split(line, sessionListSeparator)
		if len(parts) < 1 {
			continue
		}
		var (
			name            string
			attached        string
			created         string
			sessionPath     string
			title           string
			windowName      string
			command         string
			panePID         string
			paneCurrentPath string
			windowActivity  string
			sessionActivity string
		)
		if len(parts) >= 15 {
			name = parts[0]
			attached = parts[1]
			created = parts[2]
			sessionPath = parts[3]
			title = parts[4]
			windowName = parts[5]
			command = parts[6]
			panePID = parts[7]
			if len(parts) > 12 {
				paneCurrentPath = parts[12]
			}
		} else {
			name = fieldAt(parts, 0)
			attached = fieldAt(parts, 1)
			created = fieldAt(parts, 2)
			sessionPath = fieldAt(parts, 3)
			title = fieldAt(parts, 4)
			windowName = fieldAt(parts, 5)
			command = fieldAt(parts, 6)
			panePID = fieldAt(parts, 7)
			paneCurrentPath = fieldAt(parts, 10)
			windowActivity = fieldAt(parts, 12)
			sessionActivity = fieldAt(parts, 13)
		}
		trimmedName := strings.TrimSpace(name)
		if trimmedName == "" {
			continue
		}
		attachedTrim := strings.TrimSpace(attached)
		live := attachedTrim != "" && attachedTrim != "0"
		createdVal, _ := strconv.ParseInt(strings.TrimSpace(created), 10, 64)
		pidVal, _ := strconv.Atoi(strings.TrimSpace(panePID))
		winActSec, _ := strconv.ParseInt(strings.TrimSpace(windowActivity), 10, 64)
		sessActSec, _ := strconv.ParseInt(strings.TrimSpace(sessionActivity), 10, 64)
		if winActSec < 0 {
			winActSec = 0
		}
		if sessActSec < 0 {
			sessActSec = 0
		}
		bestActiveSec := winActSec
		if sessActSec > bestActiveSec {
			bestActiveSec = sessActSec
		}

		pathVal := strings.TrimSpace(paneCurrentPath)
		if pathVal == "" {
			pathVal = strings.TrimSpace(sessionPath)
		}

		rows = append(rows, SessionRow{
			Name:             trimmedName,
			Live:             live,
			CreatedAtMS:      createdVal,
			Path:             pathVal,
			StartPath:        strings.TrimSpace(sessionPath),
			Title:            compactSingleLine(title),
			WindowName:       compactSingleLine(windowName),
			Command:          compactSingleLine(command),
			PanePID:          pidVal,
			LastActivityAtMS: winActSec * 1000,
			LastActiveAtMS:   bestActiveSec * 1000,
		})
	}
	return rows
}

// CollectSessions 枚举所有登记与已知 Provider socket 上的活跃 tmux 持久会话。
func (store *TmuxSessionStore) CollectSessions(ctx context.Context) ([]SessionRow, error) {
	if store == nil || ctx == nil {
		return nil, errors.New("persistent session store 未初始化")
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	runner := store.runner()
	tmuxCmd, available := store.detectTmuxCommand(ctx, runner)
	if !available {
		return nil, nil
	}

	entries := store.readFlexibleRegistryEntries(ctx)
	entryByKey := make(map[string]Entry, len(entries))
	for _, entry := range entries {
		entryByKey[entry.Socket+"\x00"+entry.Session] = entry
	}

	targets := store.discoverTargets(ctx, entries)
	rows := make([]SessionRow, 0, len(targets))
	for _, target := range targets {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		stdout, _, exitCode, runErr := runner.Run(
			ctx,
			tmuxCmd,
			"-u", "-L", target.socket,
			"list-sessions",
			"-F", tmuxListSessionFormat,
		)
		if runErr != nil || exitCode != 0 {
			continue
		}
		parsed := ParseSessionList(stdout)
		for _, row := range parsed {
			row.Provider = target.provider
			row.RuntimeScope = target.runtimeScope
			row.AccountRef = target.accountRef
			row.Gateway = target.gateway
			row.Socket = target.socket
			if meta, ok := entryByKey[target.socket+"\x00"+row.Name]; ok {
				row.Label = meta.Label
				row.ForwardArgs = append([]string(nil), meta.ForwardArgs...)
			}
			rows = append(rows, row)
		}
	}
	return rows, nil
}

// CloseSession 通过 tmux kill-session 关闭指定会话并从持久化注册表删除对应记录。
func (store *TmuxSessionStore) CloseSession(ctx context.Context, row SessionRow) error {
	if store == nil || ctx == nil {
		return errors.New("persistent session store 未初始化")
	}
	socket := strings.TrimSpace(row.Socket)
	if socket == "" && row.Provider != "" {
		scope := row.RuntimeScope
		if scope == "" {
			if row.Gateway {
				scope = gatewayRuntimeScope
			} else {
				scope = row.AccountRef
			}
		}
		derived, err := DeriveSocket(row.Provider, scope)
		if err != nil {
			return err
		}
		socket = derived
	}
	name := strings.TrimSpace(row.Name)
	if !safePart.MatchString(socket) || !safePart.MatchString(name) {
		return errors.New("会话目标名称不安全，已拒绝关闭")
	}

	runner := store.runner()
	tmuxCmd, available := store.detectTmuxCommand(ctx, runner)
	if !available {
		return errors.New("tmux 不可用，无法关闭持久会话")
	}

	_, stderr, exitCode, runErr := runner.Run(
		ctx,
		tmuxCmd,
		"-u", "-L", socket,
		"kill-session", "-t", name,
	)
	if (runErr != nil || exitCode != 0) && exitCode != 0 {
		lowerErr := strings.ToLower(stderr)
		if !strings.Contains(lowerErr, "no server running") &&
			!strings.Contains(lowerErr, "session not found") &&
			!strings.Contains(lowerErr, "find session") {
			return fmt.Errorf("关闭持久会话 %s/%s 失败 (exit %d): %s", socket, name, exitCode, strings.TrimSpace(stderr))
		}
	}

	if store.Registry != nil {
		_ = store.Registry.Remove(ctx, socket, name)
	}
	if strings.TrimSpace(store.AIHomeDir) != "" {
		legacyFile := filepath.Join(filepath.Clean(store.AIHomeDir), "run", "persistent-sessions", socket+"--"+name+".json")
		if removeErr := os.Remove(legacyFile); removeErr != nil && !errors.Is(removeErr, os.ErrNotExist) {
			return removeErr
		}
	}
	return nil
}

func (store *TmuxSessionStore) discoverTargets(ctx context.Context, entries []Entry) []sessionTarget {
	seen := make(map[string]struct{})
	targets := make([]sessionTarget, 0, len(entries)+8)
	appendTarget := func(target sessionTarget) {
		if target.socket == "" || !safePart.MatchString(target.socket) {
			return
		}
		if _, dup := seen[target.socket]; dup {
			return
		}
		seen[target.socket] = struct{}{}
		targets = append(targets, target)
	}

	for _, entry := range entries {
		appendTarget(sessionTarget{
			provider:     entry.Provider,
			runtimeScope: entry.RuntimeScope,
			accountRef:   entry.AccountRef,
			gateway:      entry.Gateway,
			socket:       entry.Socket,
		})
	}

	aiHomeDir := strings.TrimSpace(store.AIHomeDir)
	if aiHomeDir == "" {
		return targets
	}
	projectionsDir := filepath.Join(filepath.Clean(aiHomeDir), "run", "auth-projections")
	providerDirs, err := os.ReadDir(projectionsDir)
	if err == nil {
		for _, pDir := range providerDirs {
			if !pDir.IsDir() {
				continue
			}
			provider := pDir.Name()
			if sock, sockErr := DeriveSocket(provider, gatewayRuntimeScope); sockErr == nil {
				appendTarget(sessionTarget{
					provider:     provider,
					runtimeScope: gatewayRuntimeScope,
					gateway:      true,
					socket:       sock,
				})
			}
			acctEntries, acctErr := os.ReadDir(filepath.Join(projectionsDir, provider))
			if acctErr != nil {
				continue
			}
			for _, acctEntry := range acctEntries {
				if !acctEntry.IsDir() || !accountRefPattern.MatchString(acctEntry.Name()) {
					continue
				}
				if sock, sockErr := DeriveSocket(provider, acctEntry.Name()); sockErr == nil {
					appendTarget(sessionTarget{
						provider:     provider,
						runtimeScope: acctEntry.Name(),
						accountRef:   acctEntry.Name(),
						socket:       sock,
					})
				}
			}
		}
	}

	if store.Scopes != nil {
		for _, provider := range store.knownProviders() {
			if sock, sockErr := DeriveSocket(provider, gatewayRuntimeScope); sockErr == nil {
				appendTarget(sessionTarget{
					provider:     provider,
					runtimeScope: gatewayRuntimeScope,
					gateway:      true,
					socket:       sock,
				})
			}
			refs, refErr := store.Scopes.ListProviderAccountRefs(ctx, provider)
			if refErr != nil {
				continue
			}
			for _, ref := range refs {
				if !accountRefPattern.MatchString(ref) {
					continue
				}
				if sock, sockErr := DeriveSocket(provider, ref); sockErr == nil {
					appendTarget(sessionTarget{
						provider:     provider,
						runtimeScope: ref,
						accountRef:   ref,
						socket:       sock,
					})
				}
			}
		}
	}

	return targets
}

// readFlexibleRegistryEntries 同时兼容 Go snake_case 与 Node camelCase 持久化注册表 JSON。
func (store *TmuxSessionStore) readFlexibleRegistryEntries(ctx context.Context) []Entry {
	var results []Entry
	seen := make(map[string]struct{})
	if store.Registry != nil {
		if list, err := store.Registry.List(ctx); err == nil {
			for _, item := range list {
				seen[item.Socket+"--"+item.Session] = struct{}{}
				results = append(results, item)
			}
		}
	}
	aiHomeDir := strings.TrimSpace(store.AIHomeDir)
	if aiHomeDir == "" {
		return results
	}
	regDir := filepath.Join(filepath.Clean(aiHomeDir), "run", "persistent-sessions")
	files, err := os.ReadDir(regDir)
	if err != nil {
		return results
	}
	for _, file := range files {
		if file.IsDir() || !strings.HasSuffix(file.Name(), ".json") {
			continue
		}
		payload, readErr := os.ReadFile(filepath.Join(regDir, file.Name()))
		if readErr != nil {
			continue
		}
		var doc struct {
			Provider          string   `json:"provider"`
			ProviderLegacy    string   `json:"cliName"`
			RuntimeScopeSnake string   `json:"runtime_scope"`
			RuntimeScopeCamel string   `json:"runtimeScope"`
			AccountRefSnake   string   `json:"account_ref"`
			AccountRefCamel   string   `json:"accountRef"`
			Gateway           bool     `json:"gateway"`
			Socket            string   `json:"socket"`
			Session           string   `json:"session"`
			CWD               string   `json:"cwd"`
			Label             string   `json:"label"`
			ForwardArgsSnake  []string `json:"forward_args"`
			ForwardArgsCamel  []string `json:"forwardArgs"`
		}
		if json.Unmarshal(payload, &doc) != nil {
			continue
		}
		provider := firstNonEmptyStr(doc.Provider, doc.ProviderLegacy)
		scope := firstNonEmptyStr(doc.RuntimeScopeSnake, doc.RuntimeScopeCamel)
		accountRef := firstNonEmptyStr(doc.AccountRefSnake, doc.AccountRefCamel)
		if scope == "" {
			if doc.Gateway {
				scope = gatewayRuntimeScope
			} else {
				scope = accountRef
			}
		}
		if provider == "" || !safePart.MatchString(doc.Socket) || !safePart.MatchString(doc.Session) {
			continue
		}
		key := doc.Socket + "--" + doc.Session
		if _, dup := seen[key]; dup {
			continue
		}
		seen[key] = struct{}{}
		args := doc.ForwardArgsSnake
		if len(args) == 0 {
			args = doc.ForwardArgsCamel
		}
		results = append(results, Entry{
			Provider:     provider,
			RuntimeScope: scope,
			Gateway:      doc.Gateway,
			AccountRef:   accountRef,
			Socket:       doc.Socket,
			Session:      doc.Session,
			CWD:          doc.CWD,
			Label:        doc.Label,
			ForwardArgs:  args,
		})
	}
	return results
}

func (store *TmuxSessionStore) knownProviders() []string {
	catalog := store.Catalog
	if catalog == nil {
		if built, err := providers.NewCatalog(providers.BuiltinManifest()); err == nil {
			catalog = built
		}
	}
	if catalog == nil {
		return nil
	}
	defs := catalog.List()
	ids := make([]string, 0, len(defs))
	for _, def := range defs {
		ids = append(ids, def.ID)
	}
	return ids
}

func (store *TmuxSessionStore) runner() TmuxRunner {
	if store.Runner != nil {
		return store.Runner
	}
	return osTmuxRunner{}
}

func (store *TmuxSessionStore) detectTmuxCommand(ctx context.Context, runner TmuxRunner) (string, bool) {
	getenv := store.Env
	if getenv == nil {
		getenv = os.Getenv
	}
	if strings.TrimSpace(getenv("AIH_NO_PERSIST")) == "1" {
		return "", false
	}
	platform := strings.ToLower(strings.TrimSpace(store.Platform))
	if platform == "" {
		platform = osPlatform()
	}
	candidates := []string{"tmux"}
	if platform == "windows" {
		candidates = []string{
			"psmux",
			"tmux",
			`C:\msys64\usr\bin\tmux.exe`,
			`C:\cygwin64\bin\tmux.exe`,
		}
	}
	for _, candidate := range candidates {
		_, _, code, err := runner.Run(ctx, candidate, "-V")
		if err == nil && code == 0 {
			return candidate, true
		}
	}
	return "", false
}

type osTmuxRunner struct{}

func (osTmuxRunner) Run(ctx context.Context, command string, args ...string) (string, string, int, error) {
	runCtx, cancel := context.WithTimeout(ctx, defaultTmuxCmdTimeout)
	defer cancel()
	cmd := exec.CommandContext(runCtx, command, args...)
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	err := cmd.Run()
	exitCode := 0
	if err != nil {
		var exitErr *exec.ExitError
		if errors.As(err, &exitErr) {
			exitCode = exitErr.ExitCode()
		} else {
			exitCode = -1
		}
	}
	return stdout.String(), stderr.String(), exitCode, err
}

func sanitizeKeyPart(value string) string {
	trimmed := strings.TrimSpace(value)
	cleaned := nonSafeKeyPartPattern.ReplaceAllString(trimmed, "-")
	cleaned = leadingTrailingDash.ReplaceAllString(cleaned, "")
	if len(cleaned) > 60 {
		cleaned = cleaned[:60]
	}
	if cleaned == "" {
		return "default"
	}
	return cleaned
}

func fieldAt(parts []string, index int) string {
	if index < 0 || index >= len(parts) {
		return ""
	}
	return parts[index]
}

func compactSingleLine(value string) string {
	return strings.TrimSpace(strings.ReplaceAll(strings.ReplaceAll(value, "\r", " "), "\n", " "))
}

func firstNonEmptyStr(values ...string) string {
	for _, v := range values {
		if trimmed := strings.TrimSpace(v); trimmed != "" {
			return trimmed
		}
	}
	return ""
}
