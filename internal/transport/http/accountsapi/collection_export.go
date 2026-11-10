package accountsapi

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	accountapp "github.com/madou1217/ai_home/application/accounts"
	accountcore "github.com/madou1217/ai_home/core/accounts"
)

// ErrInvalidExportFilters 表示导出过滤参数不符合当前合同（未知键或非法取值）。
var ErrInvalidExportFilters = errors.New("账号导出过滤参数无效")

// OverviewLister 是集合导出读取账号列表的最小端口。
//
// 集合导出只依赖「列账号」这一个能力：WebUI 导出入口因此不需要装配整个管理面接口。
type OverviewLister interface {
	ListAccountOverviews(
		ctx context.Context,
		query accountapp.OverviewQuery,
	) ([]accountapp.AccountOverview, error)
}

// ExportFilters 是集合导出的 provider / accountRef 过滤集合。
// 空集合表示不过滤；两个集合之间是 AND，集合内部是 OR。
type ExportFilters struct {
	providers map[string]struct{}
	refs      map[string]struct{}
}

// ParseExportFilters 只接受 provider / account_ref / accountRef 三个键。
//
// 兼容 account_ref 与 accountRef：前者是 CLI 合同的 snake_case，
// 后者是 WebUI 合同的 camelCase，两个入口共用同一份过滤语义。
func ParseExportFilters(values url.Values) (ExportFilters, error) {
	filters := ExportFilters{
		providers: map[string]struct{}{},
		refs:      map[string]struct{}{},
	}
	for key, entries := range values {
		var target map[string]struct{}
		switch key {
		case "provider":
			target = filters.providers
		case "account_ref", "accountRef":
			target = filters.refs
		default:
			return ExportFilters{}, ErrInvalidExportFilters
		}
		for _, value := range entries {
			for _, part := range strings.Split(value, ",") {
				item := strings.TrimSpace(part)
				if item == "" {
					continue
				}
				target[item] = struct{}{}
			}
		}
	}
	return filters, nil
}

// Matches 判断一个账号是否被过滤条件选中。
func (filters ExportFilters) Matches(providerID, accountRef string) bool {
	if len(filters.providers) > 0 {
		if _, ok := filters.providers[providerID]; !ok {
			return false
		}
	}
	if len(filters.refs) > 0 {
		if _, ok := filters.refs[accountRef]; !ok {
			return false
		}
	}
	return true
}

// CollectionExport 是集合级 aih-accounts 导出的结果。
//
// Exported / Skipped 是计数契约的一部分：调用方据此在响应头里说明
// 「导出了多少、因为凭据不可读或形态不支持跳过了多少」。
type CollectionExport struct {
	Document []byte
	Exported int
	Skipped  int
}

// ExportAccountCollection 导出满足过滤条件的全部账号（集合级 aih-accounts）。
//
// 单个账号的凭据不可读或形态未知时跳过并计数，而不是让整次导出失败：
// 导出是迁移动作，部分可迁移比整体拒绝更有用；跳过数量由响应头暴露。
func ExportAccountCollection(
	ctx context.Context,
	lister OverviewLister,
	credentials CredentialSnapshotReader,
	filters ExportFilters,
) (CollectionExport, error) {
	if lister == nil || credentials == nil {
		return CollectionExport{}, accountapp.ErrInvalidExportDependencies
	}
	overviews, err := listAllOverviews(ctx, lister)
	if err != nil {
		return CollectionExport{}, err
	}
	entries := make([]aihAccountEntry, 0, len(overviews))
	skipped := 0
	for _, overview := range overviews {
		account := overview.Account()
		if !filters.Matches(account.ProviderID(), account.Ref().String()) {
			continue
		}
		snapshot, snapshotErr := credentials.GetCredentialSnapshot(ctx, account.Ref())
		if snapshotErr != nil {
			skipped++
			continue
		}
		entry, ok := exportAccountEntry(overview, snapshot)
		if !ok {
			skipped++
			continue
		}
		entries = append(entries, entry)
	}
	document := aihAccountsDocument{
		Kind:       "aih-accounts",
		Version:    1,
		ExportedAt: time.Now().UTC().Format(time.RFC3339),
		Source:     map[string]string{"host": ""},
		Accounts:   entries,
	}
	payload, err := json.MarshalIndent(document, "", "  ")
	if err != nil {
		return CollectionExport{}, err
	}
	return CollectionExport{
		Document: payload,
		Exported: len(entries),
		Skipped:  skipped,
	}, nil
}

// listAllOverviews 按稳定游标读完账号列表；导出是离线动作，数量有界。
func listAllOverviews(
	ctx context.Context,
	lister OverviewLister,
) ([]accountapp.AccountOverview, error) {
	const pageSize = 100
	overviews := make([]accountapp.AccountOverview, 0, pageSize)
	afterRef := accountcore.AccountRef("")
	for {
		query, err := accountapp.NewOverviewQuery(afterRef, pageSize)
		if err != nil {
			return nil, err
		}
		page, err := lister.ListAccountOverviews(ctx, query)
		if err != nil {
			return nil, err
		}
		overviews = append(overviews, page...)
		if len(page) < pageSize {
			break
		}
		last := page[len(page)-1].Account().Ref()
		if last == afterRef {
			break
		}
		afterRef = last
	}
	return overviews, nil
}

// parseExportFilters 返回 provider / accountRef 两个集合的旧视图。
//
// 其它集合端点（模型关系、用量）只关心「某账号是否入选」，
// 直接复用 ParseExportFilters，避免再存一份参数白名单。
func parseExportFilters(
	request *http.Request,
) (map[string]struct{}, map[string]struct{}, error) {
	filters, err := ParseExportFilters(request.URL.Query())
	if err != nil {
		return nil, nil, err
	}
	return filters.providers, filters.refs, nil
}

// listAllOverviews 是 Handler 上的便捷入口，复用同一套稳定游标翻页契约。
func (handler *Handler) listAllOverviews(
	request *http.Request,
) ([]accountapp.AccountOverview, error) {
	return listAllOverviews(request.Context(), handler.management)
}

// 导出计数的响应头名：CLI 与 WebUI 两个入口共用同一份契约。
const (
	exportedCountHeader = "X-AIH-Exported-Accounts"
	skippedCountHeader  = "X-AIH-Skipped-Accounts"
)

// setExportCountHeaders 写入导出计数响应头。
func setExportCountHeaders(header http.Header, result CollectionExport) {
	header.Set(exportedCountHeader, strconv.Itoa(result.Exported))
	header.Set(skippedCountHeader, strconv.Itoa(result.Skipped))
}
