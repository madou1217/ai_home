package usage

import (
	"encoding/json"
	"fmt"

	usagecore "github.com/madou1217/ai_home/core/accountusage"
)

const documentKind = "codex_oauth_status"

// newUsageDocument 只投影已校验的同一份事实，不二次采集、不读取旧展示缓存。
func newUsageDocument(snapshot usagecore.Snapshot) (usagecore.Document, error) {
	entries := make([]map[string]any, 0, len(snapshot.Entries()))
	for _, entry := range snapshot.Entries() {
		var percent any
		if remaining, known := entry.RemainingBasisPoints(); known {
			percent = float64(remaining) / 100
		}
		item := map[string]any{
			"bucket":       entry.Bucket(),
			"limitId":      entry.LimitID(),
			"limitName":    entry.LimitName(),
			"kind":         string(entry.Kind()),
			"scope":        string(entry.Scope()),
			"scopeKey":     entry.ScopeKey(),
			"availability": string(entry.Availability()),
			"window":       usageWindowLabel(entry.WindowSeconds()),
			"remainingPct": percent,
		}
		if seconds := entry.WindowSeconds(); seconds > 0 && seconds%60 == 0 {
			item["windowMinutes"] = seconds / 60
		}
		if entry.LimitID() != "" {
			label := entry.LimitID()
			if name := entry.LimitName(); name != "" && name != label {
				label = name + " (" + label + ")"
			}
			window := usageWindowLabel(entry.WindowSeconds())
			if window == "" {
				window = entry.Bucket()
			}
			item["label"] = label + " " + window
			item["window"] = label + " " + window
		}
		if reset := entry.ResetAt(); !reset.IsZero() {
			item["resetAtMs"] = reset.UnixMilli()
		}
		entries = append(entries, item)
	}
	var remaining any
	if value := snapshot.MinRemaining(); value.Known {
		remaining = float64(value.BasisPoints) / 100
	}
	payload, err := json.Marshal(map[string]any{
		"schemaVersion": 2,
		"kind":          documentKind,
		"provider":      snapshot.ProviderID(),
		"source":        snapshot.Source(),
		"capturedAt":    snapshot.CapturedAt().UnixMilli(),
		"entryShape":    "window",
		"remainingPct":  remaining,
		"account":       map[string]any{"planType": snapshot.PlanType()},
		"entries":       entries,
		"provenance": map[string]any{
			"schemaVersion": 1,
			"id":            snapshot.Source(),
			"kind":          "provider",
			"url":           usageEndpoint,
			"capturedAt":    snapshot.CapturedAt().UnixMilli(),
		},
	})
	if err != nil {
		return usagecore.Document{}, err
	}
	return usagecore.NewDocument(usagecore.DocumentInput{
		AccountRef: snapshot.AccountRef(),
		ProviderID: snapshot.ProviderID(),
		Kind:       documentKind,
		Source:     snapshot.Source(),
		CapturedAt: snapshot.CapturedAt(),
		Payload:    payload,
	})
}

// usageWindowLabel 保留真实窗口长度；primary 不是固定的 5h。
func usageWindowLabel(seconds int64) string {
	switch {
	case seconds <= 0:
		return ""
	case seconds%86400 == 0:
		return fmt.Sprintf("%ddays", seconds/86400)
	case seconds%3600 == 0:
		return fmt.Sprintf("%dh", seconds/3600)
	case seconds%60 == 0:
		return fmt.Sprintf("%dm", seconds/60)
	default:
		return fmt.Sprintf("%ds", seconds)
	}
}
