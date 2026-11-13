package peer

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/user"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"
)

const (
	// RecordVersion 是持久化 peer 消息的文件格式版本号。
	RecordVersion = 1
	// DefaultInflightStale 是 inflight 孤儿消息自动退回 pending 的默认阈值。
	DefaultInflightStale = 60 * time.Second
	// DefaultMaxAttemptLog 限制 attempts 明细数组保留的最近条数；总次数仍以 attemptCount 为准。
	DefaultMaxAttemptLog = 20
	// DefaultExpireAge 是 pending 消息超时转 failed 的默认期限。
	DefaultExpireAge = 24 * time.Hour
	// DefaultMaxBodyChars 是单行投递信封允许的最大正文字符数。
	DefaultMaxBodyChars = 4000
	// BackoffBase 与 BackoffCap 对齐 Node peer 指数退避策略（3s 起步，60s 封顶）。
	BackoffBase = 3 * time.Second
	BackoffCap  = 60 * time.Second
)

var (
	projectedHomePattern = regexp.MustCompile(`[\\/]run[\\/](login|auth-projections)[\\/]`)
	controlCharPattern   = regexp.MustCompile("[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]")
	terminalDeliveryErrs = map[string]struct{}{
		"session_completed":      {},
		"session_gone":           {},
		"session_not_found":      {},
		"missing_session_target": {},
		"unsafe_session_target":  {},
	}
)

// ErrInvalidRecord 表示消息记录缺少必填标识，无法落盘或迁移状态。
var ErrInvalidRecord = errors.New("peer_record_invalid")

// DeliveryTarget 保存目标会话单点重投所需寻址信息，避免后台 tick 全量扫描会话。
type DeliveryTarget struct {
	CLIName      string `json:"cliName,omitempty"`
	RuntimeScope string `json:"runtimeScope,omitempty"`
	SessionName  string `json:"sessionName,omitempty"`
	Socket       string `json:"socket,omitempty"`
}

// RecordParty 描述落盘记录中的发件方或收件方元数据。
type RecordParty struct {
	Channel   string          `json:"channel"`
	Provider  string          `json:"provider"`
	Name      string          `json:"name"`
	Address   string          `json:"address"`
	SessionID string          `json:"sessionId"`
	Delivery  *DeliveryTarget `json:"delivery,omitempty"`
}

// AttemptRecord 记录单次投递尝试的摘要结果。
type AttemptRecord struct {
	At      int64  `json:"at"`
	Channel string `json:"channel"`
	OK      bool   `json:"ok"`
	Error   string `json:"error"`
}

// Record 对应 <aiHome>/run/peer/{pending,inflight,archive}/pm-<hex>.json 的完整结构。
type Record struct {
	V                int             `json:"v"`
	ID               string          `json:"id"`
	From             RecordParty     `json:"from"`
	To               RecordParty     `json:"to"`
	ReplyTo          string          `json:"replyTo"`
	Body             string          `json:"body"`
	CreatedAt        int64           `json:"createdAt"`
	State            string          `json:"state"`
	Attempts         []AttemptRecord `json:"attempts"`
	AttemptCount     int             `json:"attemptCount"`
	NextAttemptAt    int64           `json:"nextAttemptAt"`
	DeliveredAt      int64           `json:"deliveredAt"`
	ReadAt           int64           `json:"readAt"`
	ChannelMessageID string          `json:"channelMessageId"`
	Error            string          `json:"error,omitempty"`
}

// CreateMessageInput 定义写入 pending 收件箱的新消息参数。
type CreateMessageInput struct {
	ID      string
	From    RecordParty
	To      RecordParty
	ReplyTo string
	Body    string
}

// StoreOptions 配置 DispatchStore 的时钟与阈值参数。
type StoreOptions struct {
	Now           func() time.Time
	InflightStale time.Duration
	MaxAttemptLog int
}

// DispatchStore 提供与 Node peer/store.js 兼容的原子 rename 收件箱操作。
type DispatchStore struct {
	aiHomeDir     string
	root          string
	now           func() time.Time
	inflightStale time.Duration
	maxAttemptLog int
}

// NewDispatchStore 构造基于目录原子迁移的 peer 收件箱存储实例。
func NewDispatchStore(aiHomeDir string, opts StoreOptions) *DispatchStore {
	home := strings.TrimSpace(aiHomeDir)
	root := ""
	if home != "" {
		root = filepath.Join(home, "run", "peer")
	}
	nowFn := opts.Now
	if nowFn == nil {
		nowFn = time.Now
	}
	stale := opts.InflightStale
	if stale <= 0 {
		stale = DefaultInflightStale
	} else if stale < time.Second {
		stale = time.Second
	}
	maxLog := opts.MaxAttemptLog
	if maxLog <= 0 {
		maxLog = DefaultMaxAttemptLog
	}
	return &DispatchStore{
		aiHomeDir:     home,
		root:          root,
		now:           nowFn,
		inflightStale: stale,
		maxAttemptLog: maxLog,
	}
}

// AIHomeDir 返回当前存储绑定的 AIHome 根目录。
func (s *DispatchStore) AIHomeDir() string {
	return s.aiHomeDir
}

// Root 返回 <aiHome>/run/peer 目录路径。
func (s *DispatchStore) Root() string {
	return s.root
}

// LooksProjectedHome 判断路径是否落在账号投影沙箱（run/login 或 run/auth-projections）下。
func LooksProjectedHome(dir string) bool {
	return projectedHomePattern.MatchString(strings.TrimSpace(dir))
}

func normalizeHostHomeCandidate(dir string) string {
	trimmed := strings.TrimSpace(dir)
	if trimmed == "" {
		return ""
	}
	slashed := strings.TrimRight(strings.ReplaceAll(trimmed, "\\", "/"), "/")
	if strings.HasSuffix(strings.ToLower(slashed), "/.codex") {
		prefix := slashed[:len(slashed)-len("/.codex")]
		if prefix != "" {
			return filepath.FromSlash(prefix)
		}
	}
	return trimmed
}

// ResolveUnprojectedHostHomeDir 解析非账号投影的宿主用户目录（与 runtime/host-home.js 对齐）。
func ResolveUnprojectedHostHomeDir(getenv func(string) string) string {
	if getenv == nil {
		getenv = os.Getenv
	}
	if explicit := strings.TrimSpace(getenv("AIH_HOST_HOME")); explicit != "" {
		return normalizeHostHomeCandidate(explicit)
	}
	for _, key := range []string{"HOME", "USERPROFILE"} {
		candidate := strings.TrimSpace(getenv(key))
		if candidate != "" && !LooksProjectedHome(candidate) {
			return normalizeHostHomeCandidate(candidate)
		}
	}
	if current, err := user.Current(); err == nil && strings.TrimSpace(current.HomeDir) != "" {
		return normalizeHostHomeCandidate(current.HomeDir)
	}
	if home, err := os.UserHomeDir(); err == nil && strings.TrimSpace(home) != "" {
		return normalizeHostHomeCandidate(home)
	}
	return normalizeHostHomeCandidate(getenv("HOME"))
}

// ResolvePeerAIHomeDir 解析宿主级 peer 收件箱使用的 AIHome 目录，屏蔽账号投影内空壳目录。
func ResolvePeerAIHomeDir(explicitAIHomeDir, hostHomeDir string, getenv func(string) string) string {
	if getenv == nil {
		getenv = os.Getenv
	}
	if explicit := strings.TrimSpace(explicitAIHomeDir); explicit != "" && !LooksProjectedHome(explicit) {
		return explicit
	}
	for _, key := range []string{"AIH_HOME_DIR", "AI_HOME"} {
		if envHome := strings.TrimSpace(getenv(key)); envHome != "" && !LooksProjectedHome(envHome) {
			return envHome
		}
	}
	host := strings.TrimSpace(hostHomeDir)
	if host != "" && !LooksProjectedHome(host) {
		return filepath.Join(normalizeHostHomeCandidate(host), ".ai_home")
	}
	resolvedHost := ResolveUnprojectedHostHomeDir(getenv)
	if resolvedHost == "" {
		return ""
	}
	return filepath.Join(resolvedHost, ".ai_home")
}

// NormalizeID 规范化消息 ID，去掉前导 # 与首尾空白。
func NormalizeID(value string) string {
	trimmed := strings.TrimSpace(value)
	return strings.TrimPrefix(trimmed, "#")
}

// NewMessageID 生成与 Node store.js 一致的 pm-<32hex> 消息 ID。
func NewMessageID() string {
	var buf [16]byte
	if _, err := rand.Read(buf[:]); err != nil {
		return fmt.Sprintf("%s%016x", MessagePrefix, time.Now().UnixNano())
	}
	return MessagePrefix + hex.EncodeToString(buf[:])
}

// AttemptCountOf 返回消息累计尝试次数；对旧格式记录回退读取 attempts 长度。
func AttemptCountOf(rec Record) int {
	if rec.AttemptCount > 0 {
		return rec.AttemptCount
	}
	return len(rec.Attempts)
}

// BackoffFor 计算下次重试的指数退避时长（3s 起步，60s 封顶）。
func BackoffFor(attempts int) time.Duration {
	if attempts < 1 {
		attempts = 1
	}
	backoff := BackoffBase
	for i := 1; i < attempts; i++ {
		if backoff >= BackoffCap {
			return BackoffCap
		}
		backoff *= 2
	}
	if backoff > BackoffCap {
		return BackoffCap
	}
	return backoff
}

// IsTerminalDeliveryError 判断投递错误是否属于目标永久不可达的终态错误。
func IsTerminalDeliveryError(errCode string) bool {
	_, ok := terminalDeliveryErrs[strings.TrimSpace(errCode)]
	return ok
}

// CollapseBody 将消息正文压成单行，转义换行为字面 \n 并清理终端控制字符。
func CollapseBody(body, shortID string, maxChars int) string {
	if maxChars <= 0 {
		maxChars = DefaultMaxBodyChars
	}
	text := strings.ReplaceAll(body, "\r\n", "\n")
	text = strings.ReplaceAll(text, "\r", "\n")
	text = controlCharPattern.ReplaceAllString(text, "")
	text = strings.ReplaceAll(text, "\n", `\n`)
	runes := []rune(text)
	if len(runes) <= maxChars {
		return text
	}
	short := strings.TrimSpace(shortID)
	hint := " …"
	if short != "" {
		hint = fmt.Sprintf(" … (完整内容: aih peer read %s)", short)
	}
	hintRunes := []rune(hint)
	keep := maxChars - len(hintRunes)
	if keep < 0 {
		keep = 0
	}
	return string(runes[:keep]) + hint
}

// FormatPeerEnvelope 生成 inject/native 通道共用的单行消息信封。
func FormatPeerEnvelope(shortID string, from RecordParty, body string, maxChars int) string {
	short := strings.TrimSpace(shortID)
	collapsed := CollapseBody(body, short, maxChars)
	if short == "" {
		return collapsed
	}
	sender := strings.TrimSpace(from.Name)
	if sender == "" {
		sender = strings.TrimSpace(from.Address)
	}
	if sender == "" {
		sender = strings.TrimSpace(from.SessionID)
	}
	if sender == "" {
		sender = "unknown"
	}
	header := fmt.Sprintf("[aih-peer #%s from %s | reply: aih peer reply %s]", short, sender, short)
	if collapsed == "" {
		return header
	}
	return header + " " + collapsed
}

// EnsureLayout 确保 run/peer/{pending,inflight,archive} 为私有非符号链接目录。
func (s *DispatchStore) EnsureLayout() error {
	if s == nil || s.root == "" {
		return ErrStoreUnavailable
	}
	if err := ensurePrivateDir(s.root); err != nil {
		return err
	}
	for _, sub := range []string{"pending", "inflight", "archive"} {
		if err := ensurePrivateDir(filepath.Join(s.root, sub)); err != nil {
			return err
		}
	}
	return nil
}

func ensurePrivateDir(dir string) error {
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	info, err := os.Lstat(dir)
	if err != nil {
		return err
	}
	if info.Mode()&os.ModeSymlink != 0 || !info.IsDir() {
		return fmt.Errorf("peer 目录路径异常（非真实目录）: %s", dir)
	}
	return nil
}

func (s *DispatchStore) fileIn(dirName, id string) string {
	return filepath.Join(s.root, dirName, id+".json")
}

func (s *DispatchStore) appendAttempt(rec *Record, entry AttemptRecord) {
	prev := append([]AttemptRecord(nil), rec.Attempts...)
	next := append(prev, entry)
	if len(next) > s.maxAttemptLog {
		next = next[len(next)-s.maxAttemptLog:]
	}
	rec.AttemptCount = AttemptCountOf(*rec) + 1
	rec.Attempts = next
}

func normalizeRecordParty(p RecordParty) RecordParty {
	out := RecordParty{
		Channel:   strings.TrimSpace(p.Channel),
		Provider:  strings.TrimSpace(p.Provider),
		Name:      strings.TrimSpace(p.Name),
		Address:   strings.TrimSpace(p.Address),
		SessionID: strings.TrimSpace(p.SessionID),
	}
	if p.Delivery != nil {
		dt := DeliveryTarget{
			CLIName:      strings.TrimSpace(p.Delivery.CLIName),
			RuntimeScope: strings.TrimSpace(p.Delivery.RuntimeScope),
			SessionName:  strings.TrimSpace(p.Delivery.SessionName),
			Socket:       strings.TrimSpace(p.Delivery.Socket),
		}
		if dt != (DeliveryTarget{}) {
			out.Delivery = &dt
		}
	}
	return out
}

func normalizeRecordFromDisk(dirName string, rec *Record) {
	if rec.Attempts == nil {
		rec.Attempts = []AttemptRecord{}
	}
	if rec.V == 0 {
		rec.V = RecordVersion
	}
	rec.State = stateFromDirectory(dirName, rec.State)
}

func (s *DispatchStore) readRecord(dirName, id string) (*Record, error) {
	data, err := os.ReadFile(s.fileIn(dirName, id))
	if err != nil {
		return nil, err
	}
	var rec Record
	if err := json.Unmarshal(data, &rec); err != nil {
		return nil, err
	}
	if strings.TrimSpace(rec.ID) == "" {
		rec.ID = id
	}
	normalizeRecordFromDisk(dirName, &rec)
	return &rec, nil
}

func (s *DispatchStore) writeRecord(dirName string, rec Record) error {
	if rec.Attempts == nil {
		rec.Attempts = []AttemptRecord{}
	}
	if rec.V == 0 {
		rec.V = RecordVersion
	}
	payload, err := json.MarshalIndent(rec, "", "  ")
	if err != nil {
		return err
	}
	payload = append(payload, '\n')
	return writeFileAtomic(s.fileIn(dirName, rec.ID), payload)
}

func writeFileAtomic(targetPath string, content []byte) error {
	dir := filepath.Dir(targetPath)
	base := filepath.Base(targetPath)
	tmpFile, err := os.CreateTemp(dir, base+".tmp-*")
	if err != nil {
		return err
	}
	tmpPath := tmpFile.Name()
	cleanup := true
	defer func() {
		if cleanup {
			_ = os.Remove(tmpPath)
		}
	}()
	if _, err := tmpFile.Write(content); err != nil {
		_ = tmpFile.Close()
		return err
	}
	if err := tmpFile.Chmod(0o600); err != nil {
		_ = tmpFile.Close()
		return err
	}
	if err := tmpFile.Close(); err != nil {
		return err
	}
	if err := os.Rename(tmpPath, targetPath); err != nil {
		return err
	}
	cleanup = false
	return nil
}

// CreateMessage 在 pending 目录原子落盘一条新的待投递消息。
func (s *DispatchStore) CreateMessage(input CreateMessageInput) (*Record, error) {
	if err := s.EnsureLayout(); err != nil {
		return nil, err
	}
	id := NormalizeID(input.ID)
	if id == "" {
		id = NewMessageID()
	}
	rec := Record{
		V:            RecordVersion,
		ID:           id,
		From:         normalizeRecordParty(input.From),
		To:           normalizeRecordParty(input.To),
		ReplyTo:      NormalizeID(input.ReplyTo),
		Body:         input.Body,
		CreatedAt:    s.now().UnixMilli(),
		State:        "pending",
		Attempts:     []AttemptRecord{},
		AttemptCount: 0,
	}
	if err := s.writeRecord("pending", rec); err != nil {
		return nil, err
	}
	return &rec, nil
}

// ListPending 读取 pending 目录下全部待投递记录并按 createdAt 升序排列。
func (s *DispatchStore) ListPending() ([]Record, error) {
	if s == nil || s.root == "" {
		return nil, ErrStoreUnavailable
	}
	dir := filepath.Join(s.root, "pending")
	entries, err := os.ReadDir(dir)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return nil, nil
		}
		return nil, err
	}
	records := make([]Record, 0, len(entries))
	for _, entry := range entries {
		if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".json") {
			continue
		}
		id := strings.TrimSuffix(entry.Name(), ".json")
		rec, err := s.readRecord("pending", id)
		if err != nil {
			continue
		}
		records = append(records, *rec)
	}
	sort.SliceStable(records, func(i, j int) bool {
		if records[i].CreatedAt != records[j].CreatedAt {
			return records[i].CreatedAt < records[j].CreatedAt
		}
		return records[i].ID < records[j].ID
	})
	return records, nil
}

// Claim 通过同文件系统原子 rename 从 pending 抢占一条消息进入 inflight。
func (s *DispatchStore) Claim(id string) (*Record, bool, error) {
	key := NormalizeID(id)
	if key == "" {
		return nil, false, nil
	}
	if err := s.EnsureLayout(); err != nil {
		return nil, false, err
	}
	if err := os.Rename(s.fileIn("pending", key), s.fileIn("inflight", key)); err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return nil, false, nil
		}
		return nil, false, nil
	}
	rec, err := s.readRecord("inflight", key)
	if err != nil {
		return nil, false, err
	}
	return rec, true, nil
}

// SettleDelivered 将 inflight 消息标记为已送达并归档到 archive 目录。
func (s *DispatchStore) SettleDelivered(rec *Record, channelMessageID string) (*Record, error) {
	if rec == nil || strings.TrimSpace(rec.ID) == "" {
		return nil, ErrInvalidRecord
	}
	at := s.now().UnixMilli()
	next := *rec
	next.State = "delivered"
	next.DeliveredAt = at
	next.NextAttemptAt = 0
	next.ChannelMessageID = strings.TrimSpace(channelMessageID)
	s.appendAttempt(&next, AttemptRecord{
		At:      at,
		Channel: strings.TrimSpace(rec.To.Channel),
		OK:      true,
		Error:   "",
	})
	if err := s.writeRecord("inflight", next); err != nil {
		return nil, err
	}
	if err := os.Rename(s.fileIn("inflight", next.ID), s.fileIn("archive", next.ID)); err != nil {
		return nil, err
	}
	return &next, nil
}

// SettlePending 将暂时未能投递的消息写回 pending 并记录下次退避重试时刻。
func (s *DispatchStore) SettlePending(rec *Record, errCode string, retryAfter time.Duration) (*Record, error) {
	if rec == nil || strings.TrimSpace(rec.ID) == "" {
		return nil, ErrInvalidRecord
	}
	at := s.now().UnixMilli()
	retryMs := retryAfter.Milliseconds()
	if retryMs < 0 {
		retryMs = 0
	}
	next := *rec
	next.State = "pending"
	next.NextAttemptAt = at + retryMs
	s.appendAttempt(&next, AttemptRecord{
		At:      at,
		Channel: strings.TrimSpace(rec.To.Channel),
		OK:      false,
		Error:   strings.TrimSpace(errCode),
	})
	if err := s.writeRecord("inflight", next); err != nil {
		return nil, err
	}
	if err := os.Rename(s.fileIn("inflight", next.ID), s.fileIn("pending", next.ID)); err != nil {
		return nil, err
	}
	return &next, nil
}

// SettleFailed 将遭遇终态错误或过期的消息标记为 failed 并移入 archive 目录。
func (s *DispatchStore) SettleFailed(rec *Record, errCode string) (*Record, error) {
	if rec == nil || strings.TrimSpace(rec.ID) == "" {
		return nil, ErrInvalidRecord
	}
	at := s.now().UnixMilli()
	reason := strings.TrimSpace(errCode)
	next := *rec
	next.State = "failed"
	next.Error = reason
	s.appendAttempt(&next, AttemptRecord{
		At:      at,
		Channel: strings.TrimSpace(rec.To.Channel),
		OK:      false,
		Error:   reason,
	})
	if err := s.writeRecord("inflight", next); err != nil {
		return nil, err
	}
	if err := os.Rename(s.fileIn("inflight", next.ID), s.fileIn("archive", next.ID)); err != nil {
		return nil, err
	}
	return &next, nil
}

// RecoverStaleInflight 将遗留在 inflight 且 mtime 超过阈值的孤儿消息退回 pending。
func (s *DispatchStore) RecoverStaleInflight() (int, error) {
	if s == nil || s.root == "" {
		return 0, ErrStoreUnavailable
	}
	inflightDir := filepath.Join(s.root, "inflight")
	entries, err := os.ReadDir(inflightDir)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return 0, nil
		}
		return 0, err
	}
	now := s.now()
	recovered := 0
	for _, entry := range entries {
		if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".json") {
			continue
		}
		src := filepath.Join(inflightDir, entry.Name())
		info, err := os.Stat(src)
		if err != nil {
			continue
		}
		if now.Sub(info.ModTime()) < s.inflightStale {
			continue
		}
		dst := filepath.Join(s.root, "pending", entry.Name())
		if err := os.Rename(src, dst); err == nil {
			recovered++
		}
	}
	return recovered, nil
}

// ExpireStale 把超时未投出的 pending 消息抢占后按 expired 归档失败。
func (s *DispatchStore) ExpireStale(maxAge time.Duration) (int, error) {
	if maxAge <= 0 {
		return 0, nil
	}
	pending, err := s.ListPending()
	if err != nil {
		return 0, err
	}
	nowMs := s.now().UnixMilli()
	maxAgeMs := maxAge.Milliseconds()
	expired := 0
	for _, rec := range pending {
		if nowMs-rec.CreatedAt < maxAgeMs {
			continue
		}
		claimed, ok, err := s.Claim(rec.ID)
		if err != nil || !ok || claimed == nil {
			continue
		}
		if _, err := s.SettleFailed(claimed, "expired"); err == nil {
			expired++
		}
	}
	return expired, nil
}

// parsePositiveMillis parses millisecond values defensively for callers reading optional metadata.
func parsePositiveMillis(raw string) int64 {
	seconds, err := strconv.ParseFloat(strings.TrimSpace(raw), 64)
	if err != nil || seconds <= 0 {
		return 0
	}
	return int64(seconds * 1000)
}
