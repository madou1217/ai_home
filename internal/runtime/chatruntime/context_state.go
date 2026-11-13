package chatruntime

import (
	"context"
	"database/sql"
	"strings"
)

// ContextStatePatch 根据事件更新会话 policy.contextState 投影（含目标及压缩前后 token 对齐）。
func ContextStatePatch(policy map[string]any, projectPath string, event EventEnvelope) map[string]any {
	previous, _ := policy["contextState"].(map[string]any)
	prev := CloneMap(previous)

	switch event.Type {
	case "session.goal.updated":
		out := CloneMap(prev)
		out["goal"] = cloneAny(event.Payload["goal"])
		src := strings.TrimSpace(asString(event.Payload["goalSource"]))
		if src == "" {
			src = "native"
		}
		out["goalSource"] = src
		return out
	case "session.goal.cleared":
		out := CloneMap(prev)
		delete(out, "goal")
		delete(out, "goalSource")
		return out
	}

	if strings.TrimSpace(projectPath) != "" {
		return nil
	}

	if event.Type == "turn.metrics.updated" {
		metrics, _ := event.Payload["metrics"].(map[string]any)
		if metrics == nil || metrics["contextTokens"] == nil {
			return nil
		}
		out := CloneMap(prev)
		if comp, ok := prev["compaction"].(map[string]any); ok && comp != nil {
			stale, _ := prev["stale"].(bool)
			if asString(comp["status"]) == "completed" && stale {
				nextComp := CloneMap(comp)
				nextComp["afterUsedTokens"] = metrics["contextTokens"]
				nextComp["usageResetAt"] = event.At
				out["compaction"] = nextComp
			}
		}
		out["usedTokens"] = metrics["contextTokens"]
		if cw, exists := metrics["contextWindow"]; exists && cw != nil {
			if n, ok := asSafeInt64(cw); !ok || n != 0 {
				out["contextWindow"] = cw
			}
		}
		out["measuredAt"] = event.At
		out["model"] = asString(policy["model"])
		out["stale"] = false
		return out
	}

	if item, ok := event.Payload["item"].(map[string]any); ok && item != nil {
		if asString(item["kind"]) == "notice" {
			detail, _ := item["detail"].(map[string]any)
			code := asString(detail["code"])
			if code == "contextCompaction" || code == "context_compacted" {
				status := asString(item["status"])
				isStarting := status == "running"
				itemID := asString(item["id"])
				var prevComp map[string]any
				if existing, ok := prev["compaction"].(map[string]any); ok && existing != nil && asString(existing["itemId"]) == itemID {
					prevComp = CloneMap(existing)
				} else {
					prevComp = map[string]any{}
				}
				prevComp["itemId"] = itemID
				if event.TurnID != "" {
					prevComp["turnId"] = event.TurnID
				}
				prevComp["status"] = status
				if prevComp["requestedAt"] == nil {
					prevComp["requestedAt"] = event.At
				}
				if isStarting && prev["usedTokens"] != nil {
					prevComp["beforeUsedTokens"] = prev["usedTokens"]
				}
				if isStarting && prev["contextWindow"] != nil {
					prevComp["beforeContextWindow"] = prev["contextWindow"]
				}
				if status == "completed" {
					prevComp["completedAt"] = event.At
				}
				out := CloneMap(prev)
				out["compaction"] = prevComp
				if status == "completed" {
					out["stale"] = true
				}
				return out
			}
		}
	}

	if event.Type == "turn.failed" || event.Type == "turn.interrupted" || event.Type == "run.lost" {
		if comp, ok := prev["compaction"].(map[string]any); ok && comp != nil {
			if asString(comp["turnId"]) == event.TurnID && asString(comp["status"]) == "running" {
				nextComp := CloneMap(comp)
				if event.Type == "turn.interrupted" {
					nextComp["status"] = "cancelled"
				} else {
					nextComp["status"] = "failed"
				}
				nextComp["completedAt"] = event.At
				out := CloneMap(prev)
				out["compaction"] = nextComp
				return out
			}
		}
	}
	return nil
}

func projectChatContextInTx(ctx context.Context, tx *sql.Tx, events *EventRepository, event EventEnvelope) error {
	var projectPath, policyJSON string
	err := tx.QueryRowContext(ctx, `SELECT project_path, policy_json FROM chat_runtime_sessions WHERE session_id = ?`, event.SessionID).Scan(&projectPath, &policyJSON)
	if err == sql.ErrNoRows {
		return nil
	}
	if err != nil {
		return err
	}
	policy := parseJSONObject(policyJSON)
	patch := ContextStatePatch(policy, projectPath, event)
	if patch == nil {
		return nil
	}
	nextPolicy := CloneMap(policy)
	nextPolicy["contextState"] = patch
	encoded, err := CanonicalJSON(nextPolicy)
	if err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, `UPDATE chat_runtime_sessions SET policy_json = ? WHERE session_id = ?`, encoded, event.SessionID); err != nil {
		return err
	}
	_, err = events.appendInTx(ctx, tx, event.SessionID, EventDraft{
		Type:    "session.policy.changed",
		At:      &event.At,
		Source:  event.Source,
		Payload: map[string]any{"policy": nextPolicy},
	}, false, nil)
	return err
}
