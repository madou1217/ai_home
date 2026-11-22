package pluginhost

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"time"

	"github.com/madou1217/ai_home/application/egressengine"
	appplugins "github.com/madou1217/ai_home/application/pluginruntime"
)

// EgressEngineCapability 是插件声明出口内核（mihomo/sing-box/其它）的能力名。
//
// 插件 manifest 示例：
//
//	{"id":"engine.singbox","capability":"egress.engine","order":10}
//
// 插件通过 invoke 响应 {"op":"egress.engine.describe"} 与
// {"op":"egress.engine.compile","request":...}；宿主只负责发现、校验与适配，
// 不把任何具体内核编译进主二进制。
const EgressEngineCapability = "egress.engine"

const defaultEgressEngineTimeout = 5 * time.Second

// CollectEgressEngines 在候选代次中收集并校验 egress.engine 描述符。
func CollectEgressEngines(
	ctx context.Context,
	projection appplugins.Projection,
	invoke func(ctx context.Context, generation int64, contributionID string, value any, timeout time.Duration) (json.RawMessage, error),
) ([]egressengine.Descriptor, error) {
	chain := projection.ByCapability(EgressEngineCapability)
	if len(chain) == 0 || invoke == nil {
		return nil, nil
	}
	seen := map[string]string{}
	out := make([]egressengine.Descriptor, 0, len(chain))
	for _, item := range chain {
		raw, err := invoke(ctx, projection.Generation, item.ID, map[string]any{"op": "egress.engine.describe"}, defaultEgressEngineTimeout)
		if err != nil {
			return nil, engineRejected(item, "egress_engine_describe_failed", err.Error())
		}
		var descriptor egressengine.Descriptor
		if err := json.Unmarshal(raw, &descriptor); err != nil {
			return nil, engineRejected(item, "egress_engine_descriptor_invalid", "描述符不是合法 JSON")
		}
		id := strings.ToLower(strings.TrimSpace(descriptor.ID))
		if id == "" {
			return nil, engineRejected(item, "egress_engine_id_invalid", "")
		}
		if controller := strings.ToLower(strings.TrimSpace(descriptor.Controller)); controller != "clash-api" {
			return nil, engineRejected(item, "egress_engine_controller_unsupported", descriptor.Controller)
		}
		if prev, dup := seen[id]; dup {
			return nil, engineRejected(item, "egress_engine_duplicate", fmt.Sprintf("引擎 %s 已由 %s 声明", id, prev))
		}
		seen[id] = item.InstanceID
		descriptor.ID = id
		out = append(out, descriptor)
	}
	return out, nil
}

func engineRejected(item appplugins.Contribution, code, detail string) error {
	return newCandidateRejectedError(
		fmt.Sprintf("插件 %s 的 %s：%s", item.InstanceID, item.ID, detail),
		[]PrepareDiagnostic{{
			Code:           code,
			Detail:         detail,
			InstanceID:     item.InstanceID,
			ContributionID: item.ID,
			Service:        EgressEngineCapability,
		}},
	)
}
