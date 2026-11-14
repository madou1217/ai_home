package peer

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"strconv"
	"strings"
	"time"

	"github.com/madou1217/ai_home/internal/runtime/platform"
)

const (
	// DefaultQuietPeriod 是 inject 通道注入前的默认窗口静默期（与 idle.js 对齐）。
	DefaultQuietPeriod = 1200 * time.Millisecond
	// DefaultQuietPollInterval 是显式启用等待安静期时的轮询间隔。
	DefaultQuietPollInterval = 250 * time.Millisecond
	// ActivityProbeTimeout 限制单次 tmux 探测或 send-keys 调用的阻塞上限。
	ActivityProbeTimeout = 1500 * time.Millisecond
	// DefaultWebuiChatTimeout 是投递 webui-chat 会话命令的单次 HTTP 超时。
	DefaultWebuiChatTimeout = 2 * time.Second
	// DefaultNativeTimeout 是 Claude UDS 直投的连接与写入超时。
	DefaultNativeTimeout = 5 * time.Second
	// DefaultNativeFlushWait 是 macOS UDS 写入后的半关闭等待时长。
	DefaultNativeFlushWait = 150 * time.Millisecond
	// SocketPrefix 是 aih 持久 tmux 会话 socket 的统一前缀。
	SocketPrefix = "aih"
	// GatewayRuntimeScope 表示网关公共运行域的 runtimeScope。
	GatewayRuntimeScope = "gateway"
)

var (
	runtimeScopePattern = regexp.MustCompile(`^acct_[a-f0-9]{20}$`)
	safeSessionPattern  = regexp.MustCompile(`^[A-Za-z0-9._-]+$`)
	sanitizeKeyPattern  = regexp.MustCompile(`[^A-Za-z0-9._-]+`)
	hexTokenPattern     = regexp.MustCompile(`^[0-9a-fA-F]{32}$`)
	attrSanitizePattern = regexp.MustCompile(`["<>]`)
)

// TmuxCommandRunner 抽象单次 tmux 命令执行，便于测试注入假输出或记录调用参数。
type TmuxCommandRunner func(ctx context.Context, command string, args []string) (stdout string, exitCode int, err error)

// NativeSendRequest 描述 native（Claude UDS）通道的单次投递输入。
type NativeSendRequest struct {
	PID         int
	SocketPath  string
	Name        string
	SessionID   string
	Body        string
	FromAddress string
	Mode        string
	Token       string
}

// NativeSendResult 返回 native 通道生成的协议消息 ID。
type NativeSendResult struct {
	MsgID string
}

// DeliveryOptions 配置单条消息单点投递所需的环境与可注入端口。
type DeliveryOptions struct {
	AIHomeDir         string
	HostHomeDir       string
	Getenv            func(string) string
	Now               func() time.Time
	QuietPeriod       time.Duration
	Timeout           time.Duration
	PollInterval      time.Duration
	MaxBodyChars      int
	NoEnvelope        bool
	Mode              string
	WaitForQuiet      *bool
	DryRun            bool
	ClaudeConfigDirs  []string
	TmuxPath          string
	TmuxRunner        TmuxCommandRunner
	ProbeProcessAlive func(pid int) bool
	SendNative        func(ctx context.Context, req NativeSendRequest) (NativeSendResult, error)
	NativeFlushWait   time.Duration
	HTTPClient        *http.Client
	ServerBaseURL     func() string
	ManagementKey     func() string
	ReadActivityAt    func(ctx context.Context, target DeliveryTarget) (int64, error)
}

// DeliveryResult 表示单条消息投递的结果与失败分类错误码。
type DeliveryResult struct {
	OK               bool   `json:"ok"`
	Channel          string `json:"channel,omitempty"`
	ChannelMessageID string `json:"channelMessageId,omitempty"`
	Error            string `json:"error,omitempty"`
	Message          string `json:"message,omitempty"`
	LastActivityAtMs int64  `json:"lastActivityAtMs,omitempty"`
	Queued           bool   `json:"queued,omitempty"`
	Steered          bool   `json:"steered,omitempty"`
}

// FlushOptions 控制 FlushPending 的批大小、过期阈值与单点投递配置。
type FlushOptions struct {
	Delivery  DeliveryOptions
	Limit     int
	ExpireAge time.Duration
	Now       func() time.Time
}

// FlushSummary 记录一轮补投的计数汇总。
type FlushSummary struct {
	Attempted int `json:"attempted"`
	Delivered int `json:"delivered"`
	Pending   int `json:"pending"`
	Failed    int `json:"failed"`
}

// SanitizeKeyPart 将 provider/session 标签清洗为安全的 tmux 标识符片段。
func SanitizeKeyPart(value string) string {
	cleaned := sanitizeKeyPattern.ReplaceAllString(strings.TrimSpace(value), "-")
	cleaned = strings.Trim(cleaned, "-")
	if len(cleaned) > 60 {
		cleaned = cleaned[:60]
	}
	if cleaned == "" {
		return "default"
	}
	return cleaned
}

// NormalizeRuntimeScope 校验并返回合法的 gateway 或 acct_<20hex> scope。
func NormalizeRuntimeScope(value string) string {
	scope := strings.TrimSpace(value)
	if scope == GatewayRuntimeScope || runtimeScopePattern.MatchString(scope) {
		return scope
	}
	return ""
}

// IsSafeSessionName 检查 tmux session 名是否只含安全字符集。
func IsSafeSessionName(value string) bool {
	return safeSessionPattern.MatchString(strings.TrimSpace(value))
}

// DeriveSocket 根据 cliName 与 runtimeScope 派生唯一 tmux socket 名。
func DeriveSocket(cliName, runtimeScope string) (string, error) {
	scope := NormalizeRuntimeScope(runtimeScope)
	if scope == "" {
		return "", errors.New("invalid_persistent_runtime_scope")
	}
	return fmt.Sprintf("%s-%s-%s", SocketPrefix, SanitizeKeyPart(cliName), scope), nil
}

// IsQuiet 判断单个会话最后输出时刻距离 nowMs 是否已达到安静期阈值。
func IsQuiet(lastActivityAtMs, nowMs int64, quietPeriod time.Duration) bool {
	if lastActivityAtMs <= 0 {
		return true
	}
	if quietPeriod < 0 {
		quietPeriod = DefaultQuietPeriod
	} else if quietPeriod == 0 {
		quietPeriod = DefaultQuietPeriod
	}
	return nowMs-lastActivityAtMs >= quietPeriod.Milliseconds()
}

// DeliverRecord 按记录内已持久化的 target descriptor 执行单点投递（不扫全量会话）。
func DeliverRecord(ctx context.Context, rec Record, opts DeliveryOptions) DeliveryResult {
	text := renderMessageText(rec, opts)
	channel := strings.TrimSpace(rec.To.Channel)
	switch channel {
	case "native":
		return deliverNative(ctx, rec, text, opts)
	case "webui-chat":
		return deliverWebuiChat(ctx, rec, text, opts)
	default:
		return deliverInject(ctx, rec, text, opts)
	}
}

// FlushPending 恢复崩溃遗留的 inflight 孤儿、清理过期消息，并按退避时刻补投到点消息。
func FlushPending(ctx context.Context, store *DispatchStore, opts FlushOptions) (FlushSummary, error) {
	var summary FlushSummary
	if store == nil {
		return summary, ErrStoreUnavailable
	}
	if _, err := store.RecoverStaleInflight(); err != nil {
		return summary, err
	}
	expireAge := opts.ExpireAge
	if expireAge <= 0 {
		expireAge = DefaultExpireAge
	}
	if _, err := store.ExpireStale(expireAge); err != nil {
		return summary, err
	}

	pending, err := store.ListPending()
	if err != nil {
		return summary, err
	}
	nowFn := opts.Now
	if nowFn == nil {
		nowFn = store.now
	}
	if nowFn == nil {
		nowFn = time.Now
	}
	nowMs := nowFn().UnixMilli()
	limit := opts.Limit
	if limit <= 0 {
		limit = 20
	}

	// 先过滤退避到期再截取 limit，防止前排退避中的消息把后排已到期消息饿死。
	candidates := make([]Record, 0, limit)
	for _, rec := range pending {
		if rec.NextAttemptAt > nowMs {
			continue
		}
		candidates = append(candidates, rec)
		if len(candidates) >= limit {
			break
		}
	}

	deliveryOpts := opts.Delivery
	if deliveryOpts.Now == nil {
		deliveryOpts.Now = nowFn
	}
	for _, rec := range candidates {
		if ctx.Err() != nil {
			break
		}
		claimed, ok, err := store.Claim(rec.ID)
		if err != nil || !ok || claimed == nil {
			continue
		}
		summary.Attempted++
		res := DeliverRecord(ctx, *claimed, deliveryOpts)
		if res.OK {
			if _, err := store.SettleDelivered(claimed, res.ChannelMessageID); err == nil {
				summary.Delivered++
			}
			continue
		}
		if IsTerminalDeliveryError(res.Error) {
			if _, err := store.SettleFailed(claimed, res.Error); err == nil {
				summary.Failed++
			}
			continue
		}
		retryAfter := BackoffFor(AttemptCountOf(*claimed) + 1)
		if _, err := store.SettlePending(claimed, res.Error, retryAfter); err == nil {
			summary.Pending++
		}
	}
	return summary, nil
}

func renderMessageText(rec Record, opts DeliveryOptions) string {
	if opts.NoEnvelope {
		return rec.Body
	}
	return FormatPeerEnvelope(ShortMessageID(rec.ID), rec.From, rec.Body, opts.MaxBodyChars)
}

func deliverNative(ctx context.Context, rec Record, text string, opts DeliveryOptions) DeliveryResult {
	var socket string
	if rec.To.Delivery != nil {
		socket = strings.TrimSpace(rec.To.Delivery.Socket)
	}
	pid, _ := strconv.Atoi(strings.TrimSpace(rec.To.Address))
	if socket == "" || pid <= 0 {
		return DeliveryResult{OK: false, Error: "session_gone"}
	}
	aliveFn := opts.ProbeProcessAlive
	if aliveFn == nil {
		aliveFn = defaultProcessAlive
	}
	if !opts.DryRun && !aliveFn(pid) {
		return DeliveryResult{OK: false, Error: "session_gone"}
	}
	req := NativeSendRequest{
		PID:         pid,
		SocketPath:  socket,
		Name:        rec.To.Name,
		SessionID:   rec.To.SessionID,
		Body:        text,
		FromAddress: strings.TrimSpace(rec.From.Address),
		Mode:        strings.TrimSpace(opts.Mode),
	}
	if opts.DryRun {
		return DeliveryResult{OK: true, Channel: "native"}
	}
	sender := opts.SendNative
	if sender == nil {
		sender = func(sendCtx context.Context, r NativeSendRequest) (NativeSendResult, error) {
			return defaultSendNative(sendCtx, r, opts)
		}
	}
	res, err := sender(ctx, req)
	if err != nil {
		return DeliveryResult{
			OK:      false,
			Error:   "native_send_failed",
			Message: err.Error(),
		}
	}
	return DeliveryResult{
		OK:               true,
		Channel:          "native",
		ChannelMessageID: strings.TrimSpace(res.MsgID),
	}
}

func defaultProcessAlive(pid int) bool {
	return platform.ProcessAlive(pid)
}

// ListClaudeConfigDirs 枚举 CLAUDE_CONFIG_DIR、宿主 ~/.claude 以及账号沙箱下的 .claude。
func ListClaudeConfigDirs(hostHomeDir, aiHomeDir string, getenv func(string) string) []string {
	if getenv == nil {
		getenv = os.Getenv
	}
	var dirs []string
	seen := make(map[string]struct{})
	push := func(dir string) {
		trimmed := strings.TrimSpace(dir)
		if trimmed == "" {
			return
		}
		if _, ok := seen[trimmed]; ok {
			return
		}
		seen[trimmed] = struct{}{}
		dirs = append(dirs, trimmed)
	}
	push(getenv("CLAUDE_CONFIG_DIR"))
	host := strings.TrimSpace(hostHomeDir)
	if host == "" {
		host = ResolveUnprojectedHostHomeDir(getenv)
	}
	if host != "" {
		push(filepath.Join(host, ".claude"))
	}
	aiHome := ResolvePeerAIHomeDir(aiHomeDir, host, getenv)
	if aiHome != "" {
		for _, rootName := range []string{"auth-projections", "login"} {
			claudeRoot := filepath.Join(aiHome, "run", rootName, "claude")
			entries, err := os.ReadDir(claudeRoot)
			if err != nil {
				continue
			}
			for _, entry := range entries {
				if !entry.IsDir() {
					continue
				}
				push(filepath.Join(claudeRoot, entry.Name(), ".claude"))
			}
		}
	}
	return dirs
}

func readPeerToken(pid int, socketPath string, opts DeliveryOptions) (string, error) {
	sum := sha256.Sum256([]byte(socketPath))
	keyFile := fmt.Sprintf("%d.%s.key", pid, hex.EncodeToString(sum[:]))
	dirs := opts.ClaudeConfigDirs
	if len(dirs) == 0 {
		dirs = ListClaudeConfigDirs(opts.HostHomeDir, opts.AIHomeDir, opts.Getenv)
	}
	for _, configDir := range dirs {
		keyPath := filepath.Join(configDir, "sessions", keyFile)
		raw, err := os.ReadFile(keyPath)
		if err != nil {
			continue
		}
		var parsed struct {
			PeerToken string `json:"peerToken"`
		}
		if err := json.Unmarshal(raw, &parsed); err != nil {
			continue
		}
		token := strings.TrimSpace(parsed.PeerToken)
		if hexTokenPattern.MatchString(token) {
			return token, nil
		}
	}
	return "", fmt.Errorf("未找到 pid %d 的 peerToken（已检查: %s）", pid, strings.Join(dirs, ", "))
}

func formatCrossSessionEnvelope(body, fromAddress, fromName, mode string) string {
	var attrs []string
	if from := strings.TrimSpace(fromAddress); from != "" {
		attrs = append(attrs, fmt.Sprintf(`from="%s"`, attrSanitizePattern.ReplaceAllString(from, "")))
	}
	if name := strings.TrimSpace(fromName); name != "" {
		attrs = append(attrs, fmt.Sprintf(`from-name="%s"`, attrSanitizePattern.ReplaceAllString(name, "")))
	}
	if m := strings.TrimSpace(mode); m != "" {
		attrs = append(attrs, fmt.Sprintf(`from-mode="%s"`, attrSanitizePattern.ReplaceAllString(m, "")))
	}
	head := "<cross-session-message>"
	if len(attrs) > 0 {
		head = "<cross-session-message " + strings.Join(attrs, " ") + ">"
	}
	normalized := strings.ReplaceAll(body, "\r\n", "\n")
	return head + "\n" + normalized + "\n</cross-session-message>"
}

func defaultSendNative(ctx context.Context, req NativeSendRequest, opts DeliveryOptions) (NativeSendResult, error) {
	token := strings.TrimSpace(req.Token)
	if token == "" {
		var err error
		token, err = readPeerToken(req.PID, req.SocketPath, opts)
		if err != nil {
			return NativeSendResult{}, err
		}
	}
	var rnd [16]byte
	if _, err := rand.Read(rnd[:]); err != nil {
		return NativeSendResult{}, err
	}
	msgID := "cc-msg-" + hex.EncodeToString(rnd[:])
	authFrame, err := json.Marshal(map[string]string{
		"type":  "auth",
		"token": token,
	})
	if err != nil {
		return NativeSendResult{}, err
	}
	payloadMap := map[string]any{
		"msgV":   1,
		"msg_id": msgID,
		"type":   "user",
		"message": map[string]string{
			"role":    "user",
			"content": formatCrossSessionEnvelope(req.Body, req.FromAddress, "", req.Mode),
		},
		"priority": "next",
	}
	if strings.TrimSpace(req.FromAddress) != "" {
		payloadMap["from"] = strings.TrimSpace(req.FromAddress)
	}
	controlFrame, err := json.Marshal(payloadMap)
	if err != nil {
		return NativeSendResult{}, err
	}

	dialCtx, cancel := context.WithTimeout(ctx, DefaultNativeTimeout)
	defer cancel()
	var dialer net.Dialer
	conn, err := dialer.DialContext(dialCtx, "unix", req.SocketPath)
	if err != nil {
		return NativeSendResult{}, err
	}
	defer conn.Close()
	_ = conn.SetDeadline(time.Now().Add(DefaultNativeTimeout))

	wire := make([]byte, 0, len(authFrame)+len(controlFrame)+2)
	wire = append(wire, authFrame...)
	wire = append(wire, '\n')
	wire = append(wire, controlFrame...)
	wire = append(wire, '\n')
	if _, err := conn.Write(wire); err != nil {
		return NativeSendResult{}, err
	}
	flushWait := opts.NativeFlushWait
	if flushWait <= 0 {
		flushWait = DefaultNativeFlushWait
	}
	timer := time.NewTimer(flushWait)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return NativeSendResult{}, ctx.Err()
	case <-timer.C:
	}
	return NativeSendResult{MsgID: msgID}, nil
}

func deliverWebuiChat(ctx context.Context, rec Record, text string, opts DeliveryOptions) DeliveryResult {
	baseURL := ""
	if opts.ServerBaseURL != nil {
		baseURL = strings.TrimRight(strings.TrimSpace(opts.ServerBaseURL()), "/")
	}
	mgmtKey := ""
	if opts.ManagementKey != nil {
		mgmtKey = strings.TrimSpace(opts.ManagementKey())
	}
	if baseURL == "" || mgmtKey == "" {
		return DeliveryResult{
			OK:      false,
			Error:   "chat_runtime_unavailable",
			Message: "WebUI chat runtime 没在跑或没配 Management Key；消息先留在收件箱。",
		}
	}
	sessionID := strings.TrimSpace(rec.To.SessionID)
	if sessionID == "" {
		sessionID = strings.TrimSpace(rec.To.Address)
	}
	if sessionID == "" {
		return DeliveryResult{OK: false, Error: "missing_session_target"}
	}
	if opts.DryRun {
		return DeliveryResult{OK: true, Channel: "webui-chat"}
	}

	client := opts.HTTPClient
	if client == nil {
		client = &http.Client{Timeout: DefaultWebuiChatTimeout}
	}
	base := strings.TrimSpace(rec.ID)
	if base == "" {
		base = fmt.Sprintf("peer-%d", time.Now().UnixMilli())
	}

	sendCmd := func(cmdID, cmdType string, payload map[string]any) bool {
		bodyMap := map[string]any{
			"commandId": cmdID,
			"type":      cmdType,
			"payload":   payload,
		}
		raw, err := json.Marshal(bodyMap)
		if err != nil {
			return false
		}
		reqCtx, cancel := context.WithTimeout(ctx, DefaultWebuiChatTimeout)
		defer cancel()
		endpoint := fmt.Sprintf("%s/v0/webui/chat/sessions/%s/commands", baseURL, url.PathEscape(sessionID))
		req, err := http.NewRequestWithContext(reqCtx, http.MethodPost, endpoint, bytes.NewReader(raw))
		if err != nil {
			return false
		}
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Authorization", "Bearer "+mgmtKey)
		resp, err := client.Do(req)
		if err != nil {
			return false
		}
		_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 4096))
		_ = resp.Body.Close()
		return resp.StatusCode >= 200 && resp.StatusCode < 300
	}

	if sendCmd(base+"-submit", "turn.submit", map[string]any{"content": text}) {
		return DeliveryResult{OK: true, Channel: "webui-chat", ChannelMessageID: base + "-submit"}
	}
	if sendCmd(base+"-queue", "queue.add", map[string]any{"content": text, "policy": "after_turn"}) {
		return DeliveryResult{OK: true, Channel: "webui-chat", ChannelMessageID: base + "-queue", Queued: true}
	}
	if sendCmd(base+"-steer", "turn.intervene", map[string]any{"mode": "steer_current", "content": text}) {
		return DeliveryResult{OK: true, Channel: "webui-chat", ChannelMessageID: base + "-steer", Steered: true}
	}
	return DeliveryResult{
		OK:      false,
		Error:   "chat_target_busy",
		Message: "chat 会话现在不接受新轮次；消息先留在收件箱，空闲后自动投递。",
	}
}

func deliverInject(ctx context.Context, rec Record, text string, opts DeliveryOptions) DeliveryResult {
	var target DeliveryTarget
	if rec.To.Delivery != nil {
		target = *rec.To.Delivery
	}
	cliName := strings.TrimSpace(target.CLIName)
	runtimeScope := strings.TrimSpace(target.RuntimeScope)
	sessionName := strings.TrimSpace(target.SessionName)
	if cliName == "" || runtimeScope == "" || sessionName == "" {
		return DeliveryResult{OK: false, Error: "missing_session_target", Message: "缺少可注入的会话目标。"}
	}
	socket, err := DeriveSocket(cliName, runtimeScope)
	if err != nil || !IsSafeSessionName(sessionName) {
		return DeliveryResult{OK: false, Error: "unsafe_session_target", Message: "会话目标参数不合法，已拒绝注入。"}
	}

	runner := opts.TmuxRunner
	tmuxCmd := strings.TrimSpace(opts.TmuxPath)
	if runner == nil {
		if tmuxCmd == "" {
			tmuxCmd = detectTmuxCommand()
		}
		if tmuxCmd == "" {
			return DeliveryResult{OK: false, Error: "tmux_unavailable", Message: "注入需要 tmux：未在 PATH 中找到 tmux。"}
		}
		runner = defaultTmuxRunner
	} else if tmuxCmd == "" {
		tmuxCmd = "tmux"
	}

	waitQuiet := true
	if opts.WaitForQuiet != nil && !*opts.WaitForQuiet {
		waitQuiet = false
	}
	if opts.DryRun {
		waitQuiet = false
	}

	if waitQuiet {
		nowFn := opts.Now
		if nowFn == nil {
			nowFn = time.Now
		}
		quietPeriod := opts.QuietPeriod
		if quietPeriod <= 0 {
			quietPeriod = DefaultQuietPeriod
		}
		readActivity := opts.ReadActivityAt
		if readActivity == nil {
			readActivity = func(probeCtx context.Context, t DeliveryTarget) (int64, error) {
				return readSingleWindowActivity(probeCtx, runner, tmuxCmd, socket, t.SessionName)
			}
		}
		quiet, lastActivityAtMs := checkQuietWithTimeout(ctx, target, opts.Timeout, opts.PollInterval, quietPeriod, nowFn, readActivity)
		if !quiet {
			return DeliveryResult{
				OK:               false,
				Error:            "target_busy",
				LastActivityAtMs: lastActivityAtMs,
				Message:          fmt.Sprintf("会话 %s 正在跑回合（pane 持续有输出），消息先留在收件箱，空闲后自动投递。", sessionName),
			}
		}
	}

	if opts.DryRun {
		return DeliveryResult{OK: true, Channel: "inject"}
	}

	if text != "" {
		cmdCtx, cancel := context.WithTimeout(ctx, ActivityProbeTimeout)
		_, code, err := runner(cmdCtx, tmuxCmd, []string{"-u", "-L", socket, "send-keys", "-t", sessionName, "-l", "--", text})
		cancel()
		if err != nil || code != 0 {
			return DeliveryResult{
				OK:      false,
				Error:   "send_keys_failed",
				Message: formatSendKeysError(sessionName, code, err),
			}
		}
	}
	cmdCtx, cancel := context.WithTimeout(ctx, ActivityProbeTimeout)
	_, code, err := runner(cmdCtx, tmuxCmd, []string{"-u", "-L", socket, "send-keys", "-t", sessionName, "Enter"})
	cancel()
	if err != nil || code != 0 {
		return DeliveryResult{
			OK:      false,
			Error:   "send_keys_failed",
			Message: formatSendKeysError(sessionName, code, err),
		}
	}
	return DeliveryResult{OK: true, Channel: "inject"}
}

func checkQuietWithTimeout(
	ctx context.Context,
	target DeliveryTarget,
	timeout time.Duration,
	pollInterval time.Duration,
	quietPeriod time.Duration,
	nowFn func() time.Time,
	readActivity func(context.Context, DeliveryTarget) (int64, error),
) (bool, int64) {
	if timeout <= 0 {
		lastActivity, err := readActivity(ctx, target)
		if err != nil {
			lastActivity = 0
		}
		return IsQuiet(lastActivity, nowFn().UnixMilli(), quietPeriod), lastActivity
	}
	if pollInterval <= 0 {
		pollInterval = DefaultQuietPollInterval
	}
	started := nowFn()
	var lastActivity int64
	for {
		var err error
		lastActivity, err = readActivity(ctx, target)
		if err != nil {
			lastActivity = 0
		}
		now := nowFn()
		if IsQuiet(lastActivity, now.UnixMilli(), quietPeriod) {
			return true, lastActivity
		}
		elapsed := now.Sub(started)
		if elapsed >= timeout {
			return false, lastActivity
		}
		sleepDur := timeout - elapsed
		if pollInterval < sleepDur {
			sleepDur = pollInterval
		}
		if sleepDur < time.Millisecond {
			sleepDur = time.Millisecond
		}
		timer := time.NewTimer(sleepDur)
		select {
		case <-ctx.Done():
			timer.Stop()
			return false, lastActivity
		case <-timer.C:
		}
	}
}

func readSingleWindowActivity(ctx context.Context, runner TmuxCommandRunner, tmuxCmd, socket, sessionName string) (int64, error) {
	probeCtx, cancel := context.WithTimeout(ctx, ActivityProbeTimeout)
	defer cancel()
	stdout, code, err := runner(probeCtx, tmuxCmd, []string{"-u", "-L", socket, "display-message", "-p", "-t", sessionName, "#{window_activity}"})
	if err != nil || code != 0 {
		return 0, err
	}
	return parsePositiveMillis(stdout), nil
}

func detectTmuxCommand() string {
	candidates := []string{"tmux"}
	if runtime.GOOS == "windows" {
		candidates = []string{"psmux", "tmux"}
	}
	for _, name := range candidates {
		if resolved, err := exec.LookPath(name); err == nil && resolved != "" {
			return resolved
		}
	}
	return ""
}

func defaultTmuxRunner(ctx context.Context, command string, args []string) (string, int, error) {
	cmd := exec.CommandContext(ctx, command, args...)
	cmd.Env = ensureUTF8Env(os.Environ())
	var stdout bytes.Buffer
	cmd.Stdout = &stdout
	err := cmd.Run()
	if err == nil {
		return stdout.String(), 0, nil
	}
	var exitErr *exec.ExitError
	if errors.As(err, &exitErr) {
		return stdout.String(), exitErr.ExitCode(), err
	}
	return stdout.String(), -1, err
}

func ensureUTF8Env(env []string) []string {
	hasUTF8 := false
	for _, entry := range env {
		if strings.HasPrefix(entry, "LANG=") || strings.HasPrefix(entry, "LC_ALL=") || strings.HasPrefix(entry, "LC_CTYPE=") {
			if strings.Contains(strings.ToUpper(entry), "UTF-8") || strings.Contains(strings.ToUpper(entry), "UTF8") {
				hasUTF8 = true
				break
			}
		}
	}
	if hasUTF8 {
		return env
	}
	out := make([]string, 0, len(env)+2)
	out = append(out, env...)
	out = append(out, "LANG=en_US.UTF-8", "LC_CTYPE=en_US.UTF-8")
	return out
}

func formatSendKeysError(sessionName string, code int, err error) string {
	if err != nil && code < 0 {
		return fmt.Sprintf("注入 %s 失败：%s", sessionName, err.Error())
	}
	return fmt.Sprintf("注入 %s 失败（exit %d）。", sessionName, code)
}
