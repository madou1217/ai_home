package codexresetcredit

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"math"
	"sort"
	"strconv"
	"strings"
	"time"
)

// CreditRecord 对应 codex_reset_credits 表记录与 API 返回格式。
type CreditRecord struct {
	AccountRef          string `json:"accountRef"`
	CreditID            string `json:"creditId"`
	Status              string `json:"status"`
	GrantedAt           *int64 `json:"grantedAt"`
	ExpiresAt           *int64 `json:"expiresAt"`
	FirstSeenAt         int64  `json:"firstSeenAt"`
	LastSeenAt          int64  `json:"lastSeenAt"`
	ConsumedAt          *int64 `json:"consumedAt"`
	ConsumedOperationID string `json:"consumedOperationId"`
	StatusSource        string `json:"statusSource"`
}

// OperationRecord 对应 codex_reset_operations 表记录与 API 返回格式。
type OperationRecord struct {
	OperationID      string `json:"operationId"`
	AccountRef       string `json:"accountRef"`
	CreditID         string `json:"creditId"`
	InventoryVersion string `json:"inventoryVersion"`
	Status           string `json:"status"`
	Outcome          string `json:"outcome"`
	RequestedAt      int64  `json:"requestedAt"`
	UpdatedAt        int64  `json:"updatedAt"`
	CompletedAt      *int64 `json:"completedAt"`
	BeforeCount      int    `json:"beforeCount"`
	AfterCount       *int64 `json:"afterCount"`
	ErrorCode        string `json:"errorCode"`
}

// Inventory 是归一化后的上游重置卡库存。
type Inventory struct {
	AvailableCount  int
	DetailsComplete bool
	Credits         []NormalizedCredit
}

// NormalizedCredit 是上游单张重置卡的归一化快照。
type NormalizedCredit struct {
	CreditID        string
	Status          string
	GrantedAt       *int64
	ExpiresAt       *int64
	ExpiryMalformed bool
}

// ListResult 是查询重置卡列表的响应体数据。
type ListResult struct {
	AccountRef       string           `json:"accountRef"`
	Supported        bool             `json:"supported"`
	AvailableCount   int              `json:"availableCount"`
	SelectableCount  int              `json:"selectableCount"`
	SelectionMode    string           `json:"selectionMode"`
	DetailsComplete  bool             `json:"detailsComplete"`
	InventoryVersion string           `json:"inventoryVersion"`
	CapturedAt       int64            `json:"capturedAt"`
	Credits          []CreditRecord   `json:"credits"`
	NextCreditID     string           `json:"nextCreditId"`
	ActiveOperation  *OperationRecord `json:"activeOperation"`
}

// OperationEnvelope 是消费/核对操作返回的响应体数据。
type OperationEnvelope struct {
	Operation              *OperationRecord `json:"operation"`
	ReconciliationRequired bool             `json:"reconciliationRequired"`
}

var upstreamStatusMap = map[string]string{
	"available": "available",
	"redeeming": "consuming",
	"redeemed":  "consumed",
	"unknown":   "unknown",
}

func isValidResetType(raw string) bool {
	return raw == "codexRateLimits" || raw == "codex_rate_limits"
}

func normalizeCount(val any) int {
	switch typed := val.(type) {
	case int:
		if typed >= 0 {
			return typed
		}
	case int64:
		if typed >= 0 {
			return int(typed)
		}
	case float64:
		if !math.IsNaN(typed) && !math.IsInf(typed, 0) && typed >= 0 && typed == math.Trunc(typed) {
			return int(typed)
		}
	case json.Number:
		if i, err := typed.Int64(); err == nil && i >= 0 {
			return int(i)
		}
	}
	return 0
}

// NormalizeTimestamp 解析秒/毫秒数值、数字字符串或 ISO-8601 时间文本为毫秒指针。
func NormalizeTimestamp(value any) *int64 {
	if value == nil {
		return nil
	}
	switch typed := value.(type) {
	case int:
		v := scaleTimestamp(float64(typed))
		return &v
	case int64:
		v := scaleTimestamp(float64(typed))
		return &v
	case float64:
		if math.IsNaN(typed) || math.IsInf(typed, 0) {
			return nil
		}
		v := scaleTimestamp(typed)
		return &v
	case json.Number:
		if f, err := typed.Float64(); err == nil && !math.IsNaN(f) && !math.IsInf(f, 0) {
			v := scaleTimestamp(f)
			return &v
		}
		return nil
	case string:
		text := strings.TrimSpace(typed)
		if text == "" {
			return nil
		}
		if f, err := strconv.ParseFloat(text, 64); err == nil && !math.IsNaN(f) && !math.IsInf(f, 0) {
			v := scaleTimestamp(f)
			return &v
		}
		for _, layout := range []string{time.RFC3339Nano, time.RFC3339, "2006-01-02T15:04:05Z07:00", "2006-01-02 15:04:05"} {
			if parsed, err := time.Parse(layout, text); err == nil {
				ms := parsed.UnixMilli()
				return &ms
			}
		}
		return nil
	default:
		return nil
	}
}

func scaleTimestamp(numeric float64) int64 {
	if numeric < 10_000_000_000 {
		numeric = numeric * 1000
	}
	return int64(math.Trunc(numeric))
}

func firstNonNil(a any, b any) any {
	if a != nil {
		return a
	}
	return b
}

func strField(m map[string]any, keys ...string) string {
	for _, k := range keys {
		if raw, ok := m[k]; ok && raw != nil {
			if s, ok := raw.(string); ok {
				if trimmed := strings.TrimSpace(s); trimmed != "" {
					return trimmed
				}
			}
		}
	}
	return ""
}

func compareExpiryAndGrant(
	leftExpiry *int64, leftGranted *int64, leftID string,
	rightExpiry *int64, rightGranted *int64, rightID string,
) bool {
	if (leftExpiry == nil) != (rightExpiry == nil) {
		return leftExpiry != nil // nil 排最后
	}
	if leftExpiry != nil && *leftExpiry != *rightExpiry {
		return *leftExpiry < *rightExpiry
	}
	if (leftGranted == nil) != (rightGranted == nil) {
		return leftGranted != nil
	}
	if leftGranted != nil && *leftGranted != *rightGranted {
		return *leftGranted < *rightGranted
	}
	return leftID < rightID
}

// NormalizeInventory 将上游 rateLimitResetCredits 对象归一化为确定性库存结构。
func NormalizeInventory(source map[string]any) Inventory {
	if source == nil {
		source = map[string]any{}
	}
	rawCredits, hasArray := source["credits"].([]any)
	credits := make([]NormalizedCredit, 0, len(rawCredits))
	seen := map[string]struct{}{}
	hasDuplicate := false
	hasMalformedAvailableExpiry := false

	for _, item := range rawCredits {
		m, ok := item.(map[string]any)
		if !ok || m == nil {
			continue
		}
		resetType := strField(m, "resetType", "reset_type")
		if !isValidResetType(resetType) {
			continue
		}
		creditID := strField(m, "id", "creditId", "credit_id")
		if creditID == "" {
			continue
		}
		if _, dup := seen[creditID]; dup {
			hasDuplicate = true
			continue
		}
		seen[creditID] = struct{}{}

		rawStatus := strField(m, "status")
		status, known := upstreamStatusMap[rawStatus]
		if !known {
			status = "unknown"
		}
		rawGranted := firstNonNil(m["grantedAt"], m["granted_at"])
		rawExpires, hasExpiresKey := m["expiresAt"]
		if !hasExpiresKey || rawExpires == nil {
			if alt, okAlt := m["expires_at"]; okAlt {
				rawExpires = alt
			}
		}
		expiresAt := NormalizeTimestamp(rawExpires)
		expiryMalformed := rawExpires != nil && expiresAt == nil
		if status == "available" && expiryMalformed {
			hasMalformedAvailableExpiry = true
		}
		credits = append(credits, NormalizedCredit{
			CreditID:        creditID,
			Status:          status,
			GrantedAt:       NormalizeTimestamp(rawGranted),
			ExpiresAt:       expiresAt,
			ExpiryMalformed: expiryMalformed,
		})
	}

	sort.Slice(credits, func(i, j int) bool {
		return compareExpiryAndGrant(
			credits[i].ExpiresAt, credits[i].GrantedAt, credits[i].CreditID,
			credits[j].ExpiresAt, credits[j].GrantedAt, credits[j].CreditID,
		)
	})

	availableCount := normalizeCount(firstNonNil(source["availableCount"], source["available_count"]))
	normalizedAvailable := 0
	for _, c := range credits {
		if c.Status == "available" {
			normalizedAvailable++
		}
	}
	detailsComplete := !hasDuplicate &&
		!hasMalformedAvailableExpiry &&
		normalizedAvailable == availableCount &&
		(availableCount == 0 || hasArray)

	return Inventory{
		AvailableCount:  availableCount,
		DetailsComplete: detailsComplete,
		Credits:         credits,
	}
}

// SelectNextCredit 选出最早到期且未过期的可用重置卡。
func SelectNextCredit(credits []CreditRecord, nowMS int64) *CreditRecord {
	var candidates []CreditRecord
	for _, c := range credits {
		if c.Status != "available" {
			continue
		}
		if c.ExpiresAt != nil && *c.ExpiresAt <= nowMS {
			continue
		}
		candidates = append(candidates, c)
	}
	if len(candidates) == 0 {
		return nil
	}
	sort.Slice(candidates, func(i, j int) bool {
		return compareExpiryAndGrant(
			candidates[i].ExpiresAt, candidates[i].GrantedAt, candidates[i].CreditID,
			candidates[j].ExpiresAt, candidates[j].GrantedAt, candidates[j].CreditID,
		)
	})
	picked := candidates[0]
	return &picked
}

type canonicalCredit struct {
	CreditID  string `json:"creditId"`
	Status    string `json:"status"`
	GrantedAt *int64 `json:"grantedAt"`
	ExpiresAt *int64 `json:"expiresAt"`
}

type canonicalInventory struct {
	AvailableCount int               `json:"availableCount"`
	Credits        []canonicalCredit `json:"credits"`
}

// BuildInventoryVersion 生成与 Node 完全一致的 SHA-256 库存版本摘要。
func BuildInventoryVersion(availableCount int, credits []CreditRecord) string {
	if availableCount < 0 {
		availableCount = 0
	}
	list := make([]canonicalCredit, 0, len(credits))
	for _, c := range credits {
		id := strings.TrimSpace(c.CreditID)
		if id == "" {
			continue
		}
		list = append(list, canonicalCredit{
			CreditID:  id,
			Status:    strings.TrimSpace(c.Status),
			GrantedAt: copyInt64Ptr(c.GrantedAt),
			ExpiresAt: copyInt64Ptr(c.ExpiresAt),
		})
	}
	sort.Slice(list, func(i, j int) bool {
		return compareExpiryAndGrant(
			list[i].ExpiresAt, list[i].GrantedAt, list[i].CreditID,
			list[j].ExpiresAt, list[j].GrantedAt, list[j].CreditID,
		)
	})
	encoded, _ := json.Marshal(canonicalInventory{
		AvailableCount: availableCount,
		Credits:        list,
	})
	sum := sha256.Sum256(encoded)
	return hex.EncodeToString(sum[:])
}

func copyInt64Ptr(p *int64) *int64 {
	if p == nil {
		return nil
	}
	v := *p
	return &v
}
