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
	// DefaultExpireAge is a legacy stale-review threshold; mail is retained as manual, never age-expired or deleted.
	DefaultExpireAge = 24 * time.Hour
	// DefaultMaxBodyChars 是单行投递信封允许的最大正文字符数。
	DefaultMaxBodyChars = 4000
	// BackoffBase/BackoffCap match Node real-error backoff: 3/6/12/24/48s, capped at48s.
	BackoffBase = 3 * time.Second
	BackoffCap  = 48 * time.Second
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

// 发送优先级只影响同目标消息的投递顺序，不改变公平轮转。
const (
	// PriorityLow 让同目标的消息排到普通消息之后。
	PriorityLow = -1
	// PriorityNormal 是历史记录与默认发送的优先级。
	PriorityNormal = 0
	// PriorityHigh 让同目标的消息优先于普通消息投递。
	PriorityHigh = 1
)

// Record 对应 <aiHome>/run/peer/{pending,inflight,archive}/pm-<hex>.json 的完整结构。
type Record struct {
	SupersededBy        string `json:"supersededBy,omitempty"`
	SupersedesAppliedAt int64  `json:"supersedesAppliedAt,omitempty"`
	FailureResetAt      int64  `json:"failureResetAt,omitempty"`
	autoDeliverUntilSet bool
	NoEnvelope          bool            `json:"noEnvelope,omitempty"`
	NativeStatus        string          `json:"nativeStatus,omitempty"`
	FromMode            string          `json:"fromMode,omitempty"`
	Subject             string          `json:"subject,omitempty"`
	Summary             string          `json:"summary,omitempty"`
	Purpose             string          `json:"purpose,omitempty"`
	Action              string          `json:"action,omitempty"`
	ReplyPolicy         string          `json:"replyPolicy,omitempty"`
	AutoDeliverUntil    int64           `json:"autoDeliverUntil"`
	ExpiresAt           int64           `json:"expiresAt,omitempty"`
	CanceledAt          int64           `json:"canceledAt,omitempty"`
	Supersedes          string          `json:"supersedes,omitempty"`
	NotificationState   string          `json:"notificationState,omitempty"`
	WaitingReason       string          `json:"waitingReason,omitempty"`
	BusySince           int64           `json:"busySince,omitempty"`
	ProbeCount          int             `json:"probeCount,omitempty"`
	V                   int             `json:"v"`
	ID                  string          `json:"id"`
	From                RecordParty     `json:"from"`
	To                  RecordParty     `json:"to"`
	ReplyTo             string          `json:"replyTo"`
	Body                string          `json:"body"`
	CreatedAt           int64           `json:"createdAt"`
	State               string          `json:"state"`
	Attempts            []AttemptRecord `json:"attempts"`
	AttemptCount        int             `json:"attemptCount"`
	NextAttemptAt       int64           `json:"nextAttemptAt"`
	DeliveredAt         int64           `json:"deliveredAt"`
	ReadAt              int64           `json:"readAt"`
	ChannelMessageID    string          `json:"channelMessageId"`
	Error               string          `json:"error,omitempty"`
	Claim               *ClaimLease     `json:"claim,omitempty"`
	ReceiptError        string          `json:"receiptError,omitempty"`
	// Priority 是 -1/0/1 的发送优先级；旧记录缺省为 0。
	Priority int `json:"priority,omitempty"`
}

// CreateMessageInput 定义写入 pending 收件箱的新消息参数。
type CreateMessageInput struct {
	NoEnvelope       bool
	FromMode         string
	Subject          string
	Summary          string
	Purpose          string
	Action           string
	ReplyPolicy      string
	AutoDeliverUntil *int64
	ExpiresAt        int64
	Supersedes       string
	ID               string
	Priority         int
	From             RecordParty
	To               RecordParty
	ReplyTo          string
	Body             string
}

// StoreOptions 配置 DispatchStore 的时钟与阈值参数。
type StoreOptions struct {
	Now           func() time.Time
	InflightStale time.Duration
	MaxAttemptLog int
}

// DispatchStore 与 Node peer/store.js 共用短事务锁和带代次的原子迁移协议。
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

// BackoffFor returns real-error backoff: 3s initially, capped at48s.
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

// EnsureLayout 确保 run/peer/{pending,inflight,archive} 为私有非符号链接目录。
func (s *DispatchStore) EnsureLayout() error {
	if s == nil || s.root == "" {
		return ErrStoreUnavailable
	}
	if err := ensurePrivateDir(s.root); err != nil {
		return err
	}
	for _, sub := range []string{"pending", "inflight", "archive", "receipts", "targets"} {
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

func (s *DispatchStore) readStoredRecord(dirName, id string) (*Record, error) {
	if !recordIDPattern.MatchString(id) {
		return nil, ErrInvalidRecord
	}
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
	if rec.ID != id {
		return nil, ErrIdentityMismatch
	}
	normalizeRecordFromDisk(dirName, &rec)
	return &rec, nil
}

func (s *DispatchStore) readRecord(dirName, id string) (*Record, error) {
	rec, err := s.readStoredRecord(dirName, id)
	if err == nil {
		projectReadReceipt(s.root, rec)
		s.projectNotification(rec)
	}
	return rec, err
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
	return s.createScheduledMessage(input)
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
		if err != nil || rec.ReceiptError != "" {
			// Block only this message. The read-only store keeps its full
			// projection, including ID and receipt error, visible in the UI.
			continue
		}
		records = append(records, *rec)
	}
	sort.SliceStable(records, func(i, j int) bool {
		if records[i].Priority != records[j].Priority {
			return records[i].Priority > records[j].Priority
		}
		if records[i].CreatedAt != records[j].CreatedAt {
			return records[i].CreatedAt < records[j].CreatedAt
		}
		return records[i].ID < records[j].ID
	})
	return records, nil
}

// Claim stamps a fresh generation before the atomic pending -> inflight move.
// Recovery and settlement share the lock, so an old file mtime or stale owner
// cannot recover/overwrite a newly claimed record.
func (s *DispatchStore) Claim(id string) (*Record, bool, error) {
	key := NormalizeID(id)
	if !recordIDPattern.MatchString(key) {
		return nil, false, ErrInvalidRecord
	}
	unlock, err := s.lockRecords()
	if err != nil {
		return nil, false, err
	}
	defer unlock()
	if _, err := s.reconcileSupersedesLocked(); err != nil {
		return nil, false, err
	}
	rec, err := s.readStoredRecord("pending", key)
	if errors.Is(err, os.ErrNotExist) {
		return nil, false, nil
	}
	if err != nil {
		return nil, false, err
	}
	if err := applyReadReceipt(s.root, rec); err != nil {
		// The error is projected in ListMessages; do not abort healthy peers.
		return nil, false, nil
	}
	if rec.State == "read" {
		return nil, false, s.archiveReadLocked("pending", rec)
	}
	gate, err := s.readTargetGate(rec.To)
	if err != nil {
		return nil, false, err
	}
	previousState := rec.NotificationState
	projectNotificationAt(rec, gate, s.now().UnixMilli())
	if rec.NotificationState != "ready" {
		if previousState != rec.NotificationState && (rec.NotificationState == "manual" || rec.NotificationState == "expired" || rec.NotificationState == "canceled") {
			return nil, false, s.writeRecord("pending", *rec)
		}
		return nil, false, nil
	}
	busy, err := s.targetInflightLocked(rec.To)
	if err != nil || busy {
		return nil, false, err
	}
	if _, err := os.Lstat(s.fileIn("inflight", key)); err == nil {
		return nil, false, nil
	} else if !errors.Is(err, os.ErrNotExist) {
		return nil, false, err
	}
	gate.LastProbeAt = s.now().UnixMilli()
	gate.LastMessageID = rec.ID
	gate.LastReason = "target_inflight"
	gate.NextProbeAt = gate.LastProbeAt + ClaimReservation.Milliseconds()
	if err := s.writeTargetGate(gate); err != nil {
		return nil, false, err
	}
	generation := int64(1)
	if rec.Claim != nil && rec.Claim.Generation > 0 {
		generation = rec.Claim.Generation + 1
	}
	rec.Claim = &ClaimLease{Token: NewMessageID(), Generation: generation, ClaimedAt: s.now().UnixMilli()}
	if err := s.writeRecord("pending", *rec); err != nil {
		return nil, false, err
	}
	if err := os.Rename(s.fileIn("pending", key), s.fileIn("inflight", key)); err != nil {
		return nil, false, err
	}
	return rec, true, nil
}

// settle merges into the current generation under lock, rather than writing a
// caller's stale body/target/attempt snapshot. A missing or replaced claim is
// never recreated by settlement.
func (s *DispatchStore) settle(rec *Record, state, errCode, channelMessageID string, retryAfter time.Duration, nativeStatus ...string) (*Record, error) {
	if rec == nil || strings.TrimSpace(rec.ID) == "" {
		return nil, ErrInvalidRecord
	}
	unlock, err := s.lockRecords()
	if err != nil {
		return nil, err
	}
	defer unlock()
	next, err := s.ownedRecord(rec)
	if err != nil {
		return nil, err
	}
	if err := applyReadReceipt(s.root, next); err != nil {
		return nil, err
	}
	if len(nativeStatus) > 0 {
		next.NativeStatus = nativeStatus[0]
	}
	at := s.now().UnixMilli()
	acknowledged := next.State == "read"
	if err := s.settleScheduling(next, state, errCode, channelMessageID, retryAfter, at); err != nil {
		return nil, err
	}
	if acknowledged {
		next.State = "read"
		if err := s.ensureReadReceipt(next); err != nil {
			return nil, err
		}
	}
	if err := applyReadReceipt(s.root, next); err != nil {
		return nil, err
	}
	if err := s.writeRecord("inflight", *next); err != nil {
		return nil, err
	}
	dir := "archive"
	if next.State == "pending" {
		dir = "pending"
	}
	if err := os.Rename(s.fileIn("inflight", next.ID), s.fileIn(dir, next.ID)); err != nil {
		return nil, err
	}
	return next, nil
}

func (s *DispatchStore) SettleDelivered(rec *Record, channelMessageID string) (*Record, error) {
	return s.settle(rec, "delivered", "", channelMessageID, 0)
}

func (s *DispatchStore) SettlePending(rec *Record, errCode string, retryAfter time.Duration) (*Record, error) {
	return s.settle(rec, "pending", errCode, "", retryAfter)
}

func (s *DispatchStore) SettleFailed(rec *Record, errCode string) (*Record, error) {
	return s.settle(rec, "failed", errCode, "", 0)
}

// RecoverStaleInflight uses the claim's birth time, not the pending file mtime.
// Legacy inflight files without a claim retain the old mtime recovery path.
func (s *DispatchStore) RecoverStaleInflight() (int, error) {
	if s == nil || s.root == "" {
		return 0, ErrStoreUnavailable
	}
	entries, err := os.ReadDir(filepath.Join(s.root, "inflight"))
	if errors.Is(err, os.ErrNotExist) {
		return 0, nil
	}
	if err != nil {
		return 0, err
	}
	recovered := 0
	for _, entry := range entries {
		if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".json") {
			continue
		}
		id := strings.TrimSuffix(entry.Name(), ".json")
		unlock, err := s.lockRecords()
		if err != nil {
			return recovered, err
		}
		changed := false
		func() {
			defer unlock()
			rec, err := s.readStoredRecord("inflight", id)
			if err != nil || applyReadReceipt(s.root, rec) != nil {
				return
			}
			claimedAt := int64(0)
			if rec.Claim != nil {
				claimedAt = rec.Claim.ClaimedAt
			} else if info, err := os.Stat(s.fileIn("inflight", id)); err == nil {
				claimedAt = info.ModTime().UnixMilli()
			}
			if claimedAt <= 0 || s.now().UnixMilli()-claimedAt < s.inflightStale.Milliseconds() {
				return
			}
			if rec.State == "read" {
				changed = s.archiveReadLocked("inflight", rec) == nil
				return
			}
			if _, err := os.Lstat(s.fileIn("pending", id)); !errors.Is(err, os.ErrNotExist) {
				return
			}
			gate, err := s.readTargetGate(rec.To)
			if err != nil {
				return
			}
			if gate.LastMessageID == rec.ID && gate.LastReason == "target_inflight" {
				gate.NextProbeAt = s.now().UnixMilli()
				gate.LastReason = "stale_claim_recovered"
				if s.writeTargetGate(gate) != nil {
					return
				}
			}
			changed = os.Rename(s.fileIn("inflight", id), s.fileIn("pending", id)) == nil
		}()
		if changed {
			recovered++
		}
	}
	return recovered, nil
}

// ExpireStale preserves stale mail as manual; only expiresAt is semantic expiry.
func (s *DispatchStore) ExpireStale(maxAge time.Duration) (int, error) {
	return s.refreshScheduling(maxAge)
}

// parsePositiveMillis parses millisecond values defensively for callers reading optional metadata.
func parsePositiveMillis(raw string) int64 {
	seconds, err := strconv.ParseFloat(strings.TrimSpace(raw), 64)
	if err != nil || seconds <= 0 {
		return 0
	}
	return int64(seconds * 1000)
}

func pendingOrArchive(rec Record) string {
	if rec.State == "read" {
		return "archive"
	}
	return "pending"
}

// SettleDeliveryResult archives a successful transport once, preserving its
// independently observed admission status. A hold is never silently retried.
func (s *DispatchStore) SettleDeliveryResult(rec *Record, result DeliveryResult) (*Record, error) {
	return s.settle(rec, "delivered", "", result.ChannelMessageID, 0, result.NativeStatus)
}
