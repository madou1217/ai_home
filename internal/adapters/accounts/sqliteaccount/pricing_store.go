package sqliteaccount

import (
	"context"
	"database/sql"
	"encoding/json"
	"strings"

	"github.com/madou1217/ai_home/internal/adapters/usagepricing"
)

// LoadModelPricing 读取 Node 维护的 model_usage_pricing 表，转成定价引擎的原始行。
//
// 为什么 fail-soft 而不是报错：这张表由 Node 在首次写用量时惰性创建，全新安装或
// 只跑 Go 的环境里它不存在。定价缺失只意味着「成本未知」，不该让用量统计整体 500。
//
// 为什么 reasoning_output_token_cost 的 0 要当「未声明」：表定义是
// NOT NULL DEFAULT 0，无法表达 null；而引擎的语义是「未声明时按输出单价计费」。
// 若把 0 当成明确免费，所有带推理 token 的请求都会被算成 0 元。
func (store *Store) LoadModelPricing(ctx context.Context) (map[string]usagepricing.RawRecord, error) {
	if store == nil || store.db == nil || ctx == nil {
		return map[string]usagepricing.RawRecord{}, nil
	}
	const query = `
		SELECT model, input_cost_per_token, output_cost_per_token,
		       cache_read_input_token_cost, cache_creation_input_token_cost,
		       reasoning_output_token_cost, context_cost_tiers_json
		FROM model_usage_pricing`
	rows, err := store.db.QueryContext(ctx, query)
	if err != nil {
		if isMissingTable(err) {
			return map[string]usagepricing.RawRecord{}, nil
		}
		return nil, err
	}
	defer func() {
		_ = rows.Close()
	}()
	records := make(map[string]usagepricing.RawRecord)
	for rows.Next() {
		var (
			model                                         string
			input, output, cacheRead, cacheCreate, reason float64
			tiersJSON                                     sql.NullString
		)
		if err := rows.Scan(&model, &input, &output, &cacheRead, &cacheCreate, &reason, &tiersJSON); err != nil {
			return nil, err
		}
		record, ok := newPricingRecord(pricingRow{
			model:        model,
			input:        input,
			output:       output,
			cacheRead:    cacheRead,
			cacheCreate:  cacheCreate,
			reasoning:    reason,
			contextTiers: tiersJSON,
		})
		if !ok {
			continue
		}
		records[record.model] = record.raw
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return records, nil
}

// pricingRow 是 model_usage_pricing 的一行原始取值。
type pricingRow struct {
	model        string
	input        float64
	output       float64
	cacheRead    float64
	cacheCreate  float64
	reasoning    float64
	contextTiers sql.NullString
}

// normalizedPricingRow 是规整后的行：模型名 + 定价引擎的原始记录。
type normalizedPricingRow struct {
	model string
	raw   usagepricing.RawRecord
}

// newPricingRecord 把表行转成定价引擎的原始记录；模型名为空时返回 false。
//
// 单独抽出来是为了能测「表里存不下 null」这条规则：reasoning 列是
// NOT NULL DEFAULT 0，0 必须还原成「未声明」，否则推理 token 会被算成免费。
func newPricingRecord(row pricingRow) (normalizedPricingRow, bool) {
	model := strings.TrimSpace(row.model)
	if model == "" {
		return normalizedPricingRow{}, false
	}
	record := usagepricing.RawRecord{
		Model:                       &model,
		InputCostPerToken:           floatPointer(row.input),
		OutputCostPerToken:          floatPointer(row.output),
		CacheReadInputTokenCost:     floatPointer(row.cacheRead),
		CacheCreationInputTokenCost: floatPointer(row.cacheCreate),
	}
	if row.reasoning > 0 {
		record.ReasoningOutputTokenCost = floatPointer(row.reasoning)
	}
	record.ContextCostTiers = decodePricingTiers(row.contextTiers)
	return normalizedPricingRow{model: model, raw: record}, true
}

// decodePricingTiers 解析分档 JSON；坏数据按「没有分档」处理，不影响其余定价。
func decodePricingTiers(raw sql.NullString) []usagepricing.RawTier {
	if !raw.Valid {
		return nil
	}
	trimmed := strings.TrimSpace(raw.String)
	if trimmed == "" || trimmed == "[]" {
		return nil
	}
	var tiers []usagepricing.RawTier
	if err := json.Unmarshal([]byte(trimmed), &tiers); err != nil {
		return nil
	}
	return tiers
}

// isMissingTable 判断错误是不是「表不存在」。SQLite 的驱动文案不统一，按关键字判。
func isMissingTable(err error) bool {
	if err == nil {
		return false
	}
	message := strings.ToLower(err.Error())
	return strings.Contains(message, "no such table")
}

func floatPointer(value float64) *float64 {
	copied := value
	return &copied
}
