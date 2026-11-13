// Package aihloginjob 是 CodeBuddy / WorkBuddy 家族登录作业的 Go 引擎。
//
// 职责：在后台用临时投影跑官方 CLI 登录（复用 internal/host/aihlogin），把日志、
// 授权链接、状态与最终账号收敛成可轮询的快照。站点选择菜单按 provider 自动回答。
// HTTP 路由不在本包：路由层只做鉴权与快照序列化。
package aihloginjob

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"io"
	"regexp"
	"strings"
	"sync"
	"time"

	accountcore "github.com/madou1217/ai_home/core/accounts"
	codebuddyfamilystorage "github.com/madou1217/ai_home/internal/adapters/providerstorage/codebuddyfamily"
	"github.com/madou1217/ai_home/internal/host/aihlogin"
	"github.com/madou1217/ai_home/internal/host/clilogin"
)

// Status 是作业生命周期状态。
type Status string

const (
	StatusRunning   Status = "running"
	StatusSucceeded Status = "succeeded"
	StatusFailed    Status = "failed"
	StatusCancelled Status = "cancelled"
)

const (
	logLimitBytes = 64 * 1024
)

// ErrInvalidRequest 表示作业参数无效。
var ErrInvalidRequest = errors.New("invalid login job request")

var (
	loginURLPattern   = regexp.MustCompile("https://(?:www\\.)?(?:codebuddy|workbuddy)\\.(?:ai|cn)/login\\?[^\\s\"'\x60\x1b]+")
	siteMenuPattern   = regexp.MustCompile("(?i)Select login method")
	siteMenuAdvance   = regexp.MustCompile("(?i)Waiting for auth|Successfully|Logged in|登录成功")
	ansiEscapePattern = regexp.MustCompile("\x1b\\[[0-9;?]*[ -/]*[@-~]")
)

// Snapshot 是给轮询方的最小作业视图。
type Snapshot struct {
	ID           string
	Provider     string
	Status       Status
	Logs         string
	AuthURL      string
	AccountRef   string
	CLIAccountID int64
	Error        string
	StartedAt    time.Time
	UpdatedAt    time.Time
}

// RunFunc 与 aihlogin.Run 同签名，便于测试注入。
type RunFunc func(context.Context, aihlogin.Options) (accountcore.Account, error)

// PromptRule 是静态提示自动回答：日志命中 Pattern 且规则未触发过时写 Response。
type PromptRule struct {
	ID       string
	Pattern  *regexp.Regexp
	Response string
}

// defaultPromptRules 返回 Provider 的默认提示规则（与 Node 登录策略同语义）。
func defaultPromptRules(provider string) []PromptRule {
	switch provider {
	case "gemini":
		// Node: 文件夹信任自动选择 2. Trust parent folder。
		return []PromptRule{{
			ID:       "gemini-folder-trust",
			Pattern:  regexp.MustCompile("(?is)Do you trust the files in this folder.*Trust parent folder"),
			Response: "2\r",
		}}
	case "agy":
		// Node: 登录方式菜单自动选择 1. Google OAuth。三个条目必须同时出现，
		// 否则「恢复上次会话」这类同形菜单会被误答。
		return []PromptRule{{
			ID:       "agy-login-method",
			Pattern:  regexp.MustCompile("(?is)Select login method.*Google OAuth.*Google Cloud project"),
			Response: "1\r",
		}}
	default:
		return nil
	}
}

// Options 是 Manager 的依赖。
type Options struct {
	AIHomeDir   string
	HostHomeDir string
	Run         RunFunc
	Clock       func() time.Time
	// SiteMenuDownDelay 是站点菜单下移与回车之间的等待；默认 900ms（真机标定）。
	SiteMenuDownDelay time.Duration
	// PromptRules 覆盖默认提示规则（测试注入）。
	PromptRules []PromptRule
}

type job struct {
	id       string
	provider string
	status   Status
	logs     strings.Builder
	authURL  string
	account  accountcore.Account
	err      error
	started  time.Time
	updated  time.Time
	cancel   context.CancelFunc
	answered bool
	input    *io.PipeWriter
	rules    []PromptRule
	fired    map[string]bool
	mu       *sync.Mutex
}

// Manager 管理内存中的登录作业（进程重启即失效，与 Node 的内存作业一致）。
type Manager struct {
	options Options
	mu      sync.Mutex
	jobs    map[string]*job
}

// NewManager 创建作业管理器。
func NewManager(options Options) *Manager {
	if options.Run == nil {
		options.Run = runDefault
	}
	if options.Clock == nil {
		options.Clock = time.Now
	}
	if options.SiteMenuDownDelay <= 0 {
		options.SiteMenuDownDelay = 900 * time.Millisecond
	}
	return &Manager{options: options, jobs: make(map[string]*job)}
}

// runDefault 按 Provider 分派登录 Runner：CodeBuddy 家族走临时投影登录，
// 已迁移的原生 CLI（agy）走通用 CLI 登录。未迁移的 Provider 由 clilogin
// 明确报错，不回退 Node。
func runDefault(ctx context.Context, options aihlogin.Options) (accountcore.Account, error) {
	if codebuddyfamilystorage.IsFamilyProvider(options.ProviderID) {
		return aihlogin.Run(ctx, options)
	}
	return clilogin.Run(ctx, clilogin.Options{
		AIHomeDir:   options.AIHomeDir,
		HostHomeDir: options.HostHomeDir,
		ProviderID:  options.ProviderID,
		Stdin:       options.Stdin,
		Stdout:      options.Stdout,
		Stderr:      options.Stderr,
	})
}

// Start 启动一次登录作业并立即返回快照。
func (manager *Manager) Start(ctx context.Context, providerID string) (Snapshot, error) {
	if manager == nil || strings.TrimSpace(providerID) == "" {
		return Snapshot{}, ErrInvalidRequest
	}
	id, err := newJobID()
	if err != nil {
		return Snapshot{}, err
	}
	// HTTP 请求返回后 request ctx 会取消；作业必须脱离请求生命周期，只能用
	// Manager.Cancel 显式终止，否则数据库/PTY 会在启动阶段被取消。
	jobCtx, cancel := context.WithCancel(context.WithoutCancel(ctx))
	now := manager.options.Clock()
	entry := &job{
		id:       id,
		provider: strings.ToLower(strings.TrimSpace(providerID)),
		status:   StatusRunning,
		started:  now,
		updated:  now,
		cancel:   cancel,
		mu:       &manager.mu,
	}
	entry.rules = manager.options.PromptRules
	if len(entry.rules) == 0 {
		entry.rules = defaultPromptRules(entry.provider)
	}
	entry.fired = make(map[string]bool)
	manager.mu.Lock()
	manager.jobs[id] = entry
	manager.mu.Unlock()
	reader, writer := io.Pipe()
	entry.input = writer
	go manager.run(jobCtx, entry, reader, writer)
	return manager.snapshot(entry), nil
}

// Get 返回作业快照。
func (manager *Manager) Get(id string) (Snapshot, bool) {
	if manager == nil {
		return Snapshot{}, false
	}
	manager.mu.Lock()
	entry, ok := manager.jobs[id]
	manager.mu.Unlock()
	if !ok {
		return Snapshot{}, false
	}
	return manager.snapshot(entry), true
}

// SubmitCode 把用户粘贴的授权码写回 CLI（agy 等 code-paste 登录）。
// 返回 false 表示作业不存在或已不在运行。
func (manager *Manager) SubmitCode(id string, code string) bool {
	if manager == nil {
		return false
	}
	text := strings.TrimSpace(code)
	if text == "" {
		return false
	}
	manager.mu.Lock()
	entry, ok := manager.jobs[id]
	manager.mu.Unlock()
	if !ok {
		return false
	}
	entry.mu.Lock()
	running := entry.status == StatusRunning
	input := entry.input
	entry.updated = manager.options.Clock()
	entry.mu.Unlock()
	if !running || input == nil {
		return false
	}
	_, err := input.Write([]byte(text + "\r"))
	return err == nil
}

// Cancel 取消运行中的作业。
func (manager *Manager) Cancel(id string) bool {
	if manager == nil {
		return false
	}
	manager.mu.Lock()
	entry, ok := manager.jobs[id]
	manager.mu.Unlock()
	if !ok {
		return false
	}
	entry.mu.Lock()
	if entry.status == StatusRunning {
		entry.status = StatusCancelled
		entry.updated = manager.options.Clock()
	}
	cancel := entry.cancel
	entry.mu.Unlock()
	cancel()
	return true
}

func (manager *Manager) run(ctx context.Context, entry *job, stdinReader *io.PipeReader, stdinWriter *io.PipeWriter) {
	defer stdinWriter.Close()
	writer := &logWriter{manager: manager, entry: entry, input: stdinWriter}
	account, err := manager.options.Run(ctx, aihlogin.Options{
		AIHomeDir:   manager.options.AIHomeDir,
		HostHomeDir: manager.options.HostHomeDir,
		ProviderID:  entry.provider,
		Stdin:       stdinReader,
		Stdout:      writer,
		Stderr:      writer,
	})
	entry.mu.Lock()
	defer entry.mu.Unlock()
	entry.updated = manager.options.Clock()
	switch {
	case entry.status == StatusCancelled:
		entry.err = err
	case err != nil:
		entry.status = StatusFailed
		entry.err = err
	default:
		entry.status = StatusSucceeded
		entry.account = account
	}
}

func (manager *Manager) snapshot(entry *job) Snapshot {
	entry.mu.Lock()
	defer entry.mu.Unlock()
	snapshot := Snapshot{
		ID:        entry.id,
		Provider:  entry.provider,
		Status:    entry.status,
		Logs:      entry.logs.String(),
		AuthURL:   entry.authURL,
		StartedAt: entry.started,
		UpdatedAt: entry.updated,
	}
	if entry.err != nil {
		snapshot.Error = entry.err.Error()
	}
	if entry.account.ProviderID() != "" {
		snapshot.AccountRef = entry.account.Ref().String()
		snapshot.CLIAccountID = entry.account.CLIAccountID().Int64()
	}
	return snapshot
}

// logWriter 把 CLI 输出写进作业日志、提取授权链接，并自动回答站点菜单。
type logWriter struct {
	manager *Manager
	entry   *job
	input   *io.PipeWriter
}

func (writer *logWriter) Write(data []byte) (int, error) {
	text := ansiEscapePattern.ReplaceAllString(string(data), "")
	writer.entry.mu.Lock()
	writer.entry.updated = writer.manager.options.Clock()
	if writer.entry.logs.Len()+len(text) <= logLimitBytes {
		writer.entry.logs.WriteString(text)
	}
	if writer.entry.authURL == "" {
		if match := loginURLPattern.FindString(text); match != "" {
			writer.entry.authURL = match
		}
	}
	// 站点菜单只属于 CodeBuddy 家族登录：其它 Provider（agy 的登录方式菜单）
	// 由各自的 PromptRule 回答，这里再按一次回车会把选择打乱。
	shouldAnswer := !writer.entry.answered &&
		codebuddyfamilystorage.IsFamilyProvider(writer.entry.provider) &&
		siteMenuPattern.MatchString(writer.entry.logs.String()) &&
		!siteMenuAdvance.MatchString(writer.entry.logs.String())
	if shouldAnswer {
		writer.entry.answered = true
	}
	provider := writer.entry.provider
	rules := append([]PromptRule(nil), writer.entry.rules...)
	logs := writer.entry.logs.String()
	pending := make([]PromptRule, 0, len(rules))
	for _, rule := range rules {
		if rule.Pattern == nil || writer.entry.fired[rule.ID] {
			continue
		}
		if rule.Pattern.MatchString(logs) {
			writer.entry.fired[rule.ID] = true
			pending = append(pending, rule)
		}
	}
	writer.entry.mu.Unlock()
	if shouldAnswer {
		go writer.answerSiteMenu(provider)
	}
	for _, rule := range pending {
		// 异步写：Stdout.Write 的调用方可能还没回到 Stdin.Read，同步写会死锁。
		response := []byte(rule.Response)
		go func() { _, _ = writer.input.Write(response) }()
	}
	return len(data), nil
}

// answerSiteMenu 选择站点：国内站默认第一项（直接回车），国际站下移一项再回车。
func (writer *logWriter) answerSiteMenu(provider string) {
	international := provider == "codebuddy" || provider == "workbuddy"
	if !international {
		_, _ = writer.input.Write([]byte("\r"))
		return
	}
	_, _ = writer.input.Write([]byte("\x1b[B"))
	time.Sleep(writer.manager.options.SiteMenuDownDelay)
	_, _ = writer.input.Write([]byte("\r"))
}

func newJobID() (string, error) {
	buffer := make([]byte, 8)
	if _, err := rand.Read(buffer); err != nil {
		return "", err
	}
	return "login-" + hex.EncodeToString(buffer), nil
}
