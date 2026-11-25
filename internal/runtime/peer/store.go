// Package peer provides durable peer scheduling and read-only inbox projections.
// ListMessages never claims, renames or rewrites message or target state.
package peer

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

const (
	// MessagePrefix 与 Node peer/store.js 生成的消息 ID 前缀保持一致。
	MessagePrefix = "pm-"
	// DefaultLimit 是未指定 limit 时的默认返回条数。
	DefaultLimit = 500
	// MaxLimit 是单次查询允许返回的最大消息数。
	MaxLimit = 1000
)

// ErrStoreUnavailable 表示未配置 AIHomeDir，无法定位 peer 收件箱目录。
var ErrStoreUnavailable = errors.New("peer_store_unavailable")

// Party 描述发送方或接收方的地址投影。
type Party struct {
	Delivery  *DeliveryTarget `json:"delivery,omitempty"`
	Channel   string          `json:"channel"`
	Provider  string          `json:"provider"`
	Name      string          `json:"name"`
	Address   string          `json:"address"`
	SessionID string          `json:"sessionId"`
}

// Message 是 WebUI 收件箱单条消息的只读投影。
type Message struct {
	NativeStatus string `json:"nativeStatus,omitempty"`
	Subject      string `json:"subject,omitempty"`
	Summary      string `json:"summary,omitempty"`
	Purpose      string `json:"purpose,omitempty"`
	Action       string `json:"action,omitempty"`
	ReplyPolicy  string `json:"replyPolicy,omitempty"`
	// Priority 是 -1/0/1 的发送优先级；旧记录缺省为 0。
	Priority          int    `json:"priority,omitempty"`
	AutoDeliverUntil  int64  `json:"autoDeliverUntil"`
	ExpiresAt         int64  `json:"expiresAt,omitempty"`
	CanceledAt        int64  `json:"canceledAt,omitempty"`
	Supersedes        string `json:"supersedes,omitempty"`
	NotificationState string `json:"notificationState"`
	WaitingReason     string `json:"waitingReason,omitempty"`
	BusySince         int64  `json:"busySince,omitempty"`
	ProbeCount        int    `json:"probeCount,omitempty"`
	FailureResetAt    int64  `json:"failureResetAt,omitempty"`
	TargetKey         string `json:"targetKey"`
	ID                string `json:"id"`
	ShortID           string `json:"shortId"`
	From              Party  `json:"from"`
	To                Party  `json:"to"`
	ReplyTo           string `json:"replyTo"`
	ReplyToShort      string `json:"replyToShort"`
	Body              string `json:"body"`
	// Model / ReasoningEffort 是 webui-chat 投递的回合设置，其它通道为空。
	Model            string `json:"model,omitempty"`
	ReasoningEffort  string `json:"reasoningEffort,omitempty"`
	State            string `json:"state"`
	CreatedAt        int64  `json:"createdAt"`
	DeliveredAt      int64  `json:"deliveredAt"`
	ReadAt           int64  `json:"readAt"`
	NextAttemptAt    int64  `json:"nextAttemptAt"`
	AttemptCount     int    `json:"attemptCount"`
	Error            string `json:"error"`
	LastAttemptError string `json:"lastAttemptError"`
	ReceiptError     string `json:"receiptError,omitempty"`
}

// Counts 统计本次返回列表里各状态的消息数。
type Counts struct {
	Waiting   int `json:"waiting"`
	Ready     int `json:"ready"`
	Manual    int `json:"manual"`
	Canceled  int `json:"canceled"`
	Expired   int `json:"expired"`
	Total     int `json:"total"`
	Pending   int `json:"pending"`
	Delivered int `json:"delivered"`
	Read      int `json:"read"`
	Failed    int `json:"failed"`
}

// StoreSummary 回显本次查询生效的过滤条件。
type StoreSummary struct {
	State string `json:"state"`
	Limit int    `json:"limit"`
}

// ListResult 是 peer 消息列表查询的完整结果。
type ListResult struct {
	Messages []Message    `json:"messages"`
	Counts   Counts       `json:"counts"`
	Store    StoreSummary `json:"store"`
}

type rawParty struct {
	Delivery  *DeliveryTarget `json:"delivery,omitempty"`
	Channel   string          `json:"channel"`
	Provider  string          `json:"provider"`
	Name      string          `json:"name"`
	Address   string          `json:"address"`
	SessionID string          `json:"sessionId"`
}

type rawAttempt struct {
	OK    *bool  `json:"ok"`
	Error string `json:"error"`
}

type rawRecord struct {
	Subject           string       `json:"subject,omitempty"`
	Summary           string       `json:"summary,omitempty"`
	Purpose           string       `json:"purpose,omitempty"`
	Action            string       `json:"action,omitempty"`
	ReplyPolicy       string       `json:"replyPolicy,omitempty"`
	AutoDeliverUntil  int64        `json:"autoDeliverUntil"`
	ExpiresAt         int64        `json:"expiresAt,omitempty"`
	CanceledAt        int64        `json:"canceledAt,omitempty"`
	Supersedes        string       `json:"supersedes,omitempty"`
	NotificationState string       `json:"notificationState"`
	WaitingReason     string       `json:"waitingReason,omitempty"`
	BusySince         int64        `json:"busySince,omitempty"`
	ProbeCount        int          `json:"probeCount,omitempty"`
	FailureResetAt    int64        `json:"failureResetAt,omitempty"`
	ID                string       `json:"id"`
	From              *rawParty    `json:"from"`
	To                *rawParty    `json:"to"`
	ReplyTo           string       `json:"replyTo"`
	Body              string       `json:"body"`
	Model             string       `json:"model,omitempty"`
	ReasoningEffort   string       `json:"reasoningEffort,omitempty"`
	State             string       `json:"state"`
	CreatedAt         float64      `json:"createdAt"`
	DeliveredAt       float64      `json:"deliveredAt"`
	ReadAt            float64      `json:"readAt"`
	NextAttemptAt     float64      `json:"nextAttemptAt"`
	AttemptCount      float64      `json:"attemptCount"`
	Error             string       `json:"error"`
	Attempts          []rawAttempt `json:"attempts"`
}

// NormalizeState 将查询状态归一到 WebUI 支持的闭集；不认识的值回落为 all。
func NormalizeState(raw string) string {
	switch strings.ToLower(strings.TrimSpace(raw)) {
	case "pending", "delivered", "read", "failed":
		return strings.ToLower(strings.TrimSpace(raw))
	default:
		return "all"
	}
}

// ClampLimit 限制查询条数上限；非正数取默认值。
func ClampLimit(limit int) int {
	if limit <= 0 {
		return DefaultLimit
	}
	if limit > MaxLimit {
		return MaxLimit
	}
	return limit
}

// ShortMessageID 返回消息 ID 的紧凑前缀（与 Node shortMessageId 对齐）。
func ShortMessageID(id string) string {
	maxLen := len(MessagePrefix) + 8
	if len(id) <= maxLen {
		return id
	}
	return id[:maxLen]
}

// ListMessages 只读扫描 <aiHomeDir>/run/peer/{pending,inflight,archive} 并按最新在前返回。
func ListMessages(aiHomeDir string, state string, limit int) (ListResult, error) {
	home := strings.TrimSpace(aiHomeDir)
	if home == "" {
		return ListResult{}, ErrStoreUnavailable
	}
	normalizedState := NormalizeState(state)
	normalizedLimit := ClampLimit(limit)
	peerRoot := filepath.Join(home, "run", "peer")

	var directories []string
	switch normalizedState {
	case "pending":
		directories = []string{"pending", "inflight"}
	case "all":
		directories = []string{"pending", "inflight", "archive"}
	default:
		directories = []string{"pending", "inflight", "archive"}
	}

	var records []Message
	for _, dirName := range directories {
		dirRecords := readDirectory(filepath.Join(peerRoot, dirName), dirName)
		for _, msg := range dirRecords {
			if normalizedState != "all" && msg.State != normalizedState {
				continue
			}
			records = append(records, msg)
		}
	}

	// 先按 (CreatedAt, ID) 升序排列，保留尾部最新的 limit 条消息，再反转为最新在前展示。
	sort.SliceStable(records, func(i, j int) bool {
		if records[i].CreatedAt != records[j].CreatedAt {
			return records[i].CreatedAt < records[j].CreatedAt
		}
		return records[i].ID < records[j].ID
	})
	if len(records) > normalizedLimit {
		records = records[len(records)-normalizedLimit:]
	}

	messages := make([]Message, len(records))
	var counts Counts
	counts.Total = len(records)
	for i := range records {
		msg := records[len(records)-1-i]
		messages[i] = msg
		switch msg.NotificationState {
		case "waiting":
			counts.Waiting++
		case "ready":
			counts.Ready++
		case "manual":
			counts.Manual++
		case "canceled":
			counts.Canceled++
		case "expired":
			counts.Expired++
		}
		switch msg.State {
		case "pending":
			counts.Pending++
		case "delivered":
			counts.Delivered++
		case "read":
			counts.Read++
		case "failed":
			counts.Failed++
		}
	}

	return ListResult{
		Messages: messages,
		Counts:   counts,
		Store: StoreSummary{
			State: normalizedState,
			Limit: normalizedLimit,
		},
	}, nil
}

func readDirectory(directory string, dirName string) []Message {
	entries, err := os.ReadDir(directory)
	if err != nil {
		return nil
	}
	records := make([]Message, 0, len(entries))
	for _, entry := range entries {
		if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".json") {
			continue
		}
		data, err := os.ReadFile(filepath.Join(directory, entry.Name()))
		if err != nil {
			continue
		}
		var raw rawRecord
		if err := json.Unmarshal(data, &raw); err != nil {
			continue
		}
		if strings.TrimSpace(raw.ID) == "" {
			raw.ID = strings.TrimSuffix(entry.Name(), ".json")
		}
		// Decode the full raw scheduling metadata too; a minimal ID/readAt
		// snapshot would lose explicit zero, target identity and retry budget.
		var rec Record
		if err := json.Unmarshal(data, &rec); err != nil {
			continue
		}
		rec.ID = raw.ID
		rec.State = stateFromDirectory(dirName, raw.State)
		projectReadReceipt(filepath.Dir(directory), &rec)
		store := &DispatchStore{root: filepath.Dir(directory), now: time.Now}
		store.projectNotification(&rec)
		raw.State, raw.ReadAt, raw.Error = rec.State, float64(rec.ReadAt), rec.Error
		if rec.State == "read" && rec.ReceiptError == "" {
			raw.NextAttemptAt = 0
		}
		msg := projectMessage(raw, stateFromDirectory(dirName, raw.State))
		msg.ReceiptError = rec.ReceiptError
		msg.NativeStatus = rec.NativeStatus
		msg.Subject, msg.Summary, msg.Purpose, msg.Action, msg.ReplyPolicy = rec.Subject, rec.Summary, rec.Purpose, rec.Action, rec.ReplyPolicy
		msg.Priority = rec.Priority
		msg.AutoDeliverUntil, msg.ExpiresAt, msg.CanceledAt, msg.Supersedes = rec.AutoDeliverUntil, rec.ExpiresAt, rec.CanceledAt, rec.Supersedes
		msg.NotificationState, msg.WaitingReason, msg.BusySince, msg.ProbeCount = rec.NotificationState, rec.WaitingReason, rec.BusySince, rec.ProbeCount
		msg.NextAttemptAt, msg.FailureResetAt, msg.TargetKey = rec.NextAttemptAt, rec.FailureResetAt, TargetKey(rec.To)
		records = append(records, msg)
	}
	return records
}

func stateFromDirectory(dirName string, rawState string) string {
	// 目录是状态的权威来源；archive 下只认 read/failed，其余归为 delivered。
	if strings.TrimSpace(rawState) == "read" {
		return "read"
	}
	if dirName == "pending" || dirName == "inflight" {
		return "pending"
	}
	trimmed := strings.TrimSpace(rawState)
	if trimmed == "read" || trimmed == "failed" {
		return trimmed
	}
	return "delivered"
}

func describeParty(party *rawParty) Party {
	if party == nil {
		return Party{}
	}
	var delivery *DeliveryTarget
	if party.Delivery != nil {
		copy := *party.Delivery
		copy.CLIName, copy.RuntimeScope, copy.SessionName, copy.Socket = strings.TrimSpace(copy.CLIName), strings.TrimSpace(copy.RuntimeScope), strings.TrimSpace(copy.SessionName), strings.TrimSpace(copy.Socket)
		delivery = &copy
	}
	return Party{
		Delivery:  delivery,
		Channel:   strings.TrimSpace(party.Channel),
		Provider:  strings.TrimSpace(party.Provider),
		Name:      strings.TrimSpace(party.Name),
		Address:   strings.TrimSpace(party.Address),
		SessionID: strings.TrimSpace(party.SessionID),
	}
}

func projectMessage(raw rawRecord, state string) Message {
	lastErr := ""
	for _, attempt := range raw.Attempts {
		if attempt.OK != nil && !*attempt.OK {
			lastErr = attempt.Error
		}
	}
	replyToShort := ""
	if raw.ReplyTo != "" {
		replyToShort = ShortMessageID(raw.ReplyTo)
	}
	return Message{
		ID:               raw.ID,
		ShortID:          ShortMessageID(raw.ID),
		From:             describeParty(raw.From),
		To:               describeParty(raw.To),
		ReplyTo:          raw.ReplyTo,
		ReplyToShort:     replyToShort,
		Body:             raw.Body,
		Model:            raw.Model,
		ReasoningEffort:  raw.ReasoningEffort,
		State:            state,
		CreatedAt:        int64(raw.CreatedAt),
		DeliveredAt:      int64(raw.DeliveredAt),
		ReadAt:           int64(raw.ReadAt),
		NextAttemptAt:    int64(raw.NextAttemptAt),
		AttemptCount:     int(raw.AttemptCount),
		Error:            raw.Error,
		LastAttemptError: lastErr,
	}
}
