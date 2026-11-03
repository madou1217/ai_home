package managementapi

import (
	"context"
	"encoding/json"
	"net/http"
	"net/url"
	"time"

	accountcore "github.com/madou1217/ai_home/core/accounts"
	usagecore "github.com/madou1217/ai_home/core/accountusage"
	accountcontract "github.com/madou1217/ai_home/internal/contracts/accountmanagement"
)

// UsageResult 是 Management API 返回的已校验额度快照和陈旧标记。
type UsageResult struct {
	snapshot usagecore.Snapshot
	stale    bool
}

// Snapshot 返回不可变额度快照的值副本。
func (result UsageResult) Snapshot() usagecore.Snapshot {
	return result.snapshot
}

// Stale 表示快照已经超过 Server 的固定新鲜度。
func (result UsageResult) Stale() bool {
	return result.stale
}

// GetUsage 只读取目标 Server 最近一次成功快照，不触发 Provider 请求。
func (client *Client) GetUsage(
	ctx context.Context,
	accountRef accountcore.AccountRef,
) (UsageResult, error) {
	return client.requestUsage(ctx, http.MethodGet, accountRef, accountcontract.AccountUsageSuffix)
}

// RefreshUsage 显式要求目标 Server 访问 Provider 并持久化新快照。
func (client *Client) RefreshUsage(
	ctx context.Context,
	accountRef accountcore.AccountRef,
) (UsageResult, error) {
	return client.requestUsage(
		ctx,
		http.MethodPost,
		accountRef,
		accountcontract.AccountUsageRefreshSuffix,
	)
}

// requestUsage 复用统一管理认证并拒绝无效账号身份和响应投影。
func (client *Client) requestUsage(
	ctx context.Context,
	method string,
	accountRef accountcore.AccountRef,
	suffix string,
) (UsageResult, error) {
	if !client.isValid() {
		return UsageResult{}, ErrInvalidConfig
	}
	if ctx == nil || !accountRef.IsValid() {
		return UsageResult{}, ErrInvalidRequest
	}
	requestURL := client.baseURL + accountcontract.AccountsPath + "/" +
		url.PathEscape(accountRef.String()) + suffix
	document, err := client.doDocumentRequest(ctx, method, requestURL, nil)
	if err != nil {
		return UsageResult{}, err
	}
	result, err := decodeUsageResult(document)
	if err != nil {
		return UsageResult{}, err
	}
	if result.snapshot.AccountRef() != accountRef {
		return UsageResult{}, ErrInvalidResponse
	}
	return result, nil
}

// decodeUsageResult 把公开 JSON 投影恢复成账号额度领域快照。
func decodeUsageResult(document []byte) (UsageResult, error) {
	var response struct {
		Data struct {
			AccountRef string `json:"account_ref"`
			ProviderID string `json:"provider_id"`
			Source     string `json:"source"`
			CapturedAt string `json:"captured_at"`
			Stale      bool   `json:"stale"`
			Entries    []struct {
				LimitID              string  `json:"limit_id"`
				LimitName            string  `json:"limit_name"`
				Bucket               string  `json:"bucket"`
				Kind                 string  `json:"kind"`
				Scope                string  `json:"scope"`
				ScopeKey             string  `json:"scope_key"`
				RemainingBasisPoints *uint16 `json:"remaining_basis_points"`
				Availability         string  `json:"availability"`
				WindowSeconds        *int64  `json:"window_seconds"`
				ResetAt              *string `json:"reset_at"`
			} `json:"entries"`
		} `json:"data"`
	}
	if err := json.Unmarshal(document, &response); err != nil {
		return UsageResult{}, ErrInvalidResponse
	}
	accountRef, err := accountcore.ParseAccountRef(response.Data.AccountRef)
	if err != nil {
		return UsageResult{}, ErrInvalidResponse
	}
	capturedAt, err := time.Parse(time.RFC3339Nano, response.Data.CapturedAt)
	if err != nil {
		return UsageResult{}, ErrInvalidResponse
	}
	entries := make([]usagecore.EntryInput, 0, len(response.Data.Entries))
	for _, entry := range response.Data.Entries {
		input := usagecore.EntryInput{
			LimitID:      entry.LimitID,
			LimitName:    entry.LimitName,
			Bucket:       entry.Bucket,
			Kind:         usagecore.Kind(entry.Kind),
			Scope:        usagecore.Scope(entry.Scope),
			ScopeKey:     entry.ScopeKey,
			Availability: usagecore.Availability(entry.Availability),
		}
		if entry.RemainingBasisPoints != nil {
			input.HasRemaining = true
			input.RemainingBasisPoints = *entry.RemainingBasisPoints
		}
		if entry.WindowSeconds != nil {
			input.WindowSeconds = *entry.WindowSeconds
		}
		if entry.ResetAt != nil {
			input.ResetAt, err = time.Parse(time.RFC3339Nano, *entry.ResetAt)
			if err != nil {
				return UsageResult{}, ErrInvalidResponse
			}
		}
		entries = append(entries, input)
	}
	snapshot, err := usagecore.NewSnapshot(usagecore.SnapshotInput{
		AccountRef: accountRef,
		ProviderID: response.Data.ProviderID,
		Source:     response.Data.Source,
		CapturedAt: capturedAt,
		Entries:    entries,
	})
	if err != nil {
		return UsageResult{}, ErrInvalidResponse
	}
	return UsageResult{snapshot: snapshot, stale: response.Data.Stale}, nil
}
