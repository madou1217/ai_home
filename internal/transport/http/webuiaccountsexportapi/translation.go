package webuiaccountsexportapi

import (
	"encoding/json"
	"errors"
	"net/url"
	"strings"

	accountcore "github.com/madou1217/ai_home/core/accounts"
)

// ErrInvalidExportQuery 表示导出过滤参数不符合 WebUI 合同（结构或取值非法）。
var ErrInvalidExportQuery = errors.New("账号导出过滤参数无效")

// NodeOnlyAccountsHeader 是 Node 链接表中存在、Go 侧不存在的账号数。
//
// 语义只覆盖「Node 建过同步链接」的账号：从未同步过的 Node 账号不在 Go 数据里，
// 因此该计数是真实 Node-only 的下界，而不是全量对账结果。
const NodeOnlyAccountsHeader = "X-AIH-Node-Only-Accounts"

// exportQuery 是翻译与校验后的导出作用域。
//
// values 里的 accountRef 已统一成 Go 引用，供 accountsapi.ParseExportFilters 复用；
// hasProviders / hasRefs 记录过滤是否真的收窄了集合，node-only 计数据此决定能否给出。
type exportQuery struct {
	values       url.Values
	hasProviders bool
	hasRefs      bool
}

// translateExportQuery 校验 provider / accountRef 并把 Node 引用翻译成 Go 引用。
//
// 未启用同步映射时 resolver 是恒等函数（Node 与 Go 引用本来就是同一份内容哈希），
// 此时行为与旧实现一致，只是补上格式校验。
func (handler *Handler) translateExportQuery(values url.Values) (exportQuery, error) {
	translated := make(url.Values, len(values))
	result := exportQuery{values: translated}
	for key, entries := range values {
		switch key {
		case "provider":
			for _, entry := range entries {
				for _, part := range strings.Split(entry, ",") {
					provider := strings.ToLower(strings.TrimSpace(part))
					if provider == "" {
						continue
					}
					if !validProviderToken(provider) {
						return exportQuery{}, ErrInvalidExportQuery
					}
					translated["provider"] = append(translated["provider"], provider)
				}
			}
			result.hasProviders = len(translated["provider"]) > 0
		case "account_ref", "accountRef":
			for _, entry := range entries {
				for _, part := range strings.Split(entry, ",") {
					rawRef := strings.TrimSpace(part)
					if rawRef == "" {
						continue
					}
					goRef := handler.resolver.GoRef(rawRef)
					if !accountcore.AccountRef(goRef).IsValid() {
						return exportQuery{}, ErrInvalidExportQuery
					}
					translated[key] = append(translated[key], goRef)
				}
			}
			result.hasRefs = len(translated["account_ref"]) > 0 || len(translated["accountRef"]) > 0
		default:
			// 未知键原样保留，由 ParseExportFilters 统一拒绝，避免两处白名单漂移。
			translated[key] = entries
		}
	}
	return result, nil
}

// validProviderToken 只校验结构，不维护 provider 名单：上游新增 provider 时零改动通过。
func validProviderToken(value string) bool {
	if value == "" || len(value) > 64 {
		return false
	}
	for index, character := range value {
		isLower := character >= 'a' && character <= 'z'
		isDigit := character >= '0' && character <= '9'
		if isLower || isDigit {
			continue
		}
		if index == 0 {
			return false
		}
		if character != '-' && character != '_' && character != '.' {
			return false
		}
	}
	return true
}

// nodeOnlyAccounts 统计链接表里 Go 侧不存在的账号（按 Go 引用去重）。
//
// 只对「不过滤且无跳过」的导出调用：过滤会把其他 provider / 其他引用移出集合，
// 凭据不可读的账号也不在文档里，两者都会把已存在的 Go 账号误算成 Node-only。
func nodeOnlyAccounts(links map[string]string, document []byte) (int, bool) {
	var payload struct {
		Accounts []struct {
			AccountRef string `json:"accountRef"`
		} `json:"accounts"`
	}
	if err := json.Unmarshal(document, &payload); err != nil {
		return 0, false
	}
	exported := make(map[string]struct{}, len(payload.Accounts))
	for _, entry := range payload.Accounts {
		exported[entry.AccountRef] = struct{}{}
	}
	missing := map[string]struct{}{}
	for _, goRef := range links {
		if _, ok := exported[goRef]; ok {
			continue
		}
		missing[goRef] = struct{}{}
	}
	return len(missing), true
}

// resolverLinks 返回当前同步链接表；未启用同步时返回 nil（无需翻译也无需计数）。
func (handler *Handler) resolverLinks() map[string]string {
	if !handler.resolver.Enabled() {
		return nil
	}
	return handler.resolver.Links()
}
