// Package peer 提供 aih peer 持久收件箱的只读查询与目录事件监听。
//
// 只读原则：绝不 claim / rename / 改写状态文件，避免破坏 CLI 与后台补投的抢占语义。
package peer

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"sort"
	"strings"
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
	Channel   string `json:"channel"`
	Provider  string `json:"provider"`
	Name      string `json:"name"`
	Address   string `json:"address"`
	SessionID string `json:"sessionId"`
}

// Message 是 WebUI 收件箱单条消息的只读投影。
type Message struct {
	ID               string `json:"id"`
	ShortID          string `json:"shortId"`
	From             Party  `json:"from"`
	To               Party  `json:"to"`
	ReplyTo          string `json:"replyTo"`
	ReplyToShort     string `json:"replyToShort"`
	Body             string `json:"body"`
	State            string `json:"state"`
	CreatedAt        int64  `json:"createdAt"`
	DeliveredAt      int64  `json:"deliveredAt"`
	ReadAt           int64  `json:"readAt"`
	NextAttemptAt    int64  `json:"nextAttemptAt"`
	AttemptCount     int    `json:"attemptCount"`
	Error            string `json:"error"`
	LastAttemptError string `json:"lastAttemptError"`
}

// Counts 统计本次返回列表里各状态的消息数。
type Counts struct {
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
	Channel   string `json:"channel"`
	Provider  string `json:"provider"`
	Name      string `json:"name"`
	Address   string `json:"address"`
	SessionID string `json:"sessionId"`
}

type rawAttempt struct {
	OK    *bool  `json:"ok"`
	Error string `json:"error"`
}

type rawRecord struct {
	ID            string       `json:"id"`
	From          *rawParty    `json:"from"`
	To            *rawParty    `json:"to"`
	ReplyTo       string       `json:"replyTo"`
	Body          string       `json:"body"`
	State         string       `json:"state"`
	CreatedAt     float64      `json:"createdAt"`
	DeliveredAt   float64      `json:"deliveredAt"`
	ReadAt        float64      `json:"readAt"`
	NextAttemptAt float64      `json:"nextAttemptAt"`
	AttemptCount  float64      `json:"attemptCount"`
	Error         string       `json:"error"`
	Attempts      []rawAttempt `json:"attempts"`
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
		directories = []string{"archive"}
	}

	var records []Message
	for _, dirName := range directories {
		dirRecords := readDirectory(filepath.Join(peerRoot, dirName), dirName)
		for _, msg := range dirRecords {
			if normalizedState != "all" && normalizedState != "pending" && msg.State != normalizedState {
				continue
			}
			records = append(records, msg)
		}
	}

	// 与 Node store.listMessages 对齐：先按时间升序截断 limit 条，再反转为最新在上展示。
	sort.SliceStable(records, func(i, j int) bool {
		if records[i].CreatedAt != records[j].CreatedAt {
			return records[i].CreatedAt < records[j].CreatedAt
		}
		return records[i].ID < records[j].ID
	})
	if len(records) > normalizedLimit {
		records = records[:normalizedLimit]
	}

	messages := make([]Message, len(records))
	var counts Counts
	counts.Total = len(records)
	for i := range records {
		msg := records[len(records)-1-i]
		messages[i] = msg
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
		msg := projectMessage(raw, stateFromDirectory(dirName, raw.State))
		records = append(records, msg)
	}
	return records
}

func stateFromDirectory(dirName string, rawState string) string {
	// 目录是状态的权威来源；archive 下只认 read/failed，其余归为 delivered。
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
	return Party{
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
