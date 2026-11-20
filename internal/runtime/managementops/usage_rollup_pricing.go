package managementops

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"github.com/madou1217/ai_home/internal/adapters/appstate"
	"github.com/madou1217/ai_home/internal/adapters/modelcatalogsettings"
	"github.com/madou1217/ai_home/internal/adapters/usagepricing"
	"strings"
)

// readActivePricingSourceStrictConn 在当前连接/事务快照内严格读取 active:model_usage_pricing。
// 仅对键缺失或表缺失返回空源，其余数据库/上下文错误显式上抛，不走 TTL 缓存也不另开连接。
func readActivePricingSourceStrictConn(ctx context.Context, conn *sql.Conn) (string, error) {
	raw, found, err := appstate.ReadRawKV(ctx, conn, pricingActiveCatalogKVKey)
	if err != nil {
		return "", fmt.Errorf("读取当前定价源配置失败: %w", err)
	}
	if !found || strings.TrimSpace(raw) == "" {
		return "", nil
	}
	var payload struct {
		Source string `json:"source"`
	}
	if json.Unmarshal([]byte(raw), &payload) != nil {
		return "", nil
	}
	return strings.TrimSpace(payload.Source), nil
}

// readCustomPricingIndexStrictConn 在当前连接/事务快照内严格读取 app_kv 中的自定义定价配置。
// 不回退到 modelcatalogsettings.Load 另开连接，避免打破快照一致性与 4 连接池死锁；
// 真正的数据库或上下文错误显式返回，防止将损坏/失败读取静默当作无自定义定价持久化。
func readCustomPricingIndexStrictConn(ctx context.Context, conn *sql.Conn) (map[string]modelcatalogsettings.CustomPricing, error) {
	raw, found, err := appstate.ReadRawKV(ctx, conn, modelcatalogsettings.DatabaseKey)
	if err != nil {
		return nil, fmt.Errorf("读取自定义模型定价配置失败: %w", err)
	}
	if !found || strings.TrimSpace(raw) == "" {
		return map[string]modelcatalogsettings.CustomPricing{}, nil
	}
	settings := modelcatalogsettings.Normalize(raw)
	out := make(map[string]modelcatalogsettings.CustomPricing)
	for _, am := range settings.AccountModels {
		if am.CustomPricing == nil {
			continue
		}
		accountRef := strings.TrimSpace(am.AccountRef)
		modelID := strings.ToLower(strings.TrimSpace(am.ID))
		if accountRef == "" || modelID == "" {
			continue
		}
		out[accountRef+"\x00"+modelID] = *am.CustomPricing
	}
	return out, nil
}

// loadStrictPricingSnapshotConn 在当前连接/事务快照内严格现读完整定价目录与自定义定价，
// 绕过 UsageStore.loadPricingSnapshot 的 3s TTL 缓存，确保定价数据与同快照读取的 pricing_rev 严格一致。
func loadStrictPricingSnapshotConn(ctx context.Context, conn *sql.Conn) (pricingResolverSnapshot, error) {
	activeSource, err := readActivePricingSourceStrictConn(ctx, conn)
	if err != nil {
		return pricingResolverSnapshot{}, err
	}
	pricingMap, err := readPricingTableConn(ctx, nil, conn, activeSource)
	if err != nil {
		return pricingResolverSnapshot{}, err
	}
	customIndex, err := readCustomPricingIndexStrictConn(ctx, conn)
	if err != nil {
		return pricingResolverSnapshot{}, err
	}
	return pricingResolverSnapshot{
		catalog:     usagepricing.NewCatalog(pricingMap),
		customIndex: customIndex,
	}, nil
}
