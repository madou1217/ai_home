package main

import (
	"context"
	"encoding/json"
	"fmt"
	"sort"
	"strings"
	"time"

	accountcore "github.com/madou1217/ai_home/core/accounts"
	usagecore "github.com/madou1217/ai_home/core/accountusage"
	"github.com/madou1217/ai_home/core/providers"
	"github.com/madou1217/ai_home/internal/adapters/accounts/sqliteaccount"
)

// `aih __usage-probe <cli> <id>`：Node 服务端内部额度探针的 Go 版本。
// 输出形状与 Node buildUsageProbePayload 一致，供旧调用方直接消费。
type usageProbePayload struct {
	CLIName         string   `json:"cliName"`
	ID              string   `json:"id"`
	Status          string   `json:"status"`
	Label           string   `json:"label,omitempty"`
	AgeLabel        string   `json:"ageLabel,omitempty"`
	MinRemainingPct *float64 `json:"minRemainingPct,omitempty"`
	Lines           []string `json:"lines,omitempty"`
	Hint            string   `json:"hint,omitempty"`
}

func runUsageProbe(arguments []string, runtime commandRuntime) error {
	if len(arguments) < 2 {
		_, _ = fmt.Fprint(runtime.stderr, "invalid_usage_probe_args")
		return cliExitCode{code: 1}
	}
	cliName := strings.ToLower(strings.TrimSpace(arguments[0]))
	rawID := strings.TrimSpace(arguments[1])
	if cliName == "" {
		_, _ = fmt.Fprint(runtime.stderr, "invalid_usage_probe_args")
		return cliExitCode{code: 1}
	}
	cliAccountID, idErr := accountcore.ParseCLIAccountID(rawID)
	if idErr != nil {
		_, _ = fmt.Fprint(runtime.stderr, "invalid_usage_probe_args")
		return cliExitCode{code: 1}
	}
	payload := usageProbePayload{CLIName: cliName, ID: rawID, Status: "pending"}
	aiHomeDir, err := resolveAIHomeDir(runtime)
	if err != nil {
		writeUsageProbePayload(runtime, payload)
		return nil
	}
	catalog, catalogErr := providers.NewCatalog(providers.BuiltinManifest())
	if catalogErr != nil {
		writeUsageProbePayload(runtime, payload)
		return nil
	}
	canonicalProvider, found := catalog.CanonicalID(cliName)
	if !found {
		writeUsageProbePayload(runtime, payload)
		return nil
	}
	store, storeErr := sqliteaccount.Open(context.Background(), sqliteaccount.OpenOptions{AIHomeDir: aiHomeDir, Catalog: catalog})
	if storeErr != nil {
		writeUsageProbePayload(runtime, payload)
		return nil
	}
	defer func() { _ = store.Close() }()
	overview, overviewErr := store.GetAccountOverviewByCLIAccountID(context.Background(), canonicalProvider, cliAccountID)
	if overviewErr != nil {
		writeUsageProbePayload(runtime, payload)
		return nil
	}
	label := strings.TrimSpace(overview.DisplayName())
	if label == "" {
		label = "OAuth"
	}
	if strings.Contains(strings.ToLower(overview.AuthKind()), "api") {
		payload.Status = "api_key"
		payload.Label = label
		writeUsageProbePayload(runtime, payload)
		return nil
	}
	snapshot, hasSnapshot := overview.UsageSnapshot()
	if !hasSnapshot || !snapshot.IsValid() {
		payload.Status = "no_snapshot"
		payload.Label = label
		payload.Hint = usageProbeNoSnapshotHint(canonicalProvider)
		writeUsageProbePayload(runtime, payload)
		return nil
	}
	payload.Status = "ok"
	payload.Label = label
	if captured := snapshot.CapturedAt(); !captured.IsZero() {
		age := time.Since(captured)
		if age < 0 {
			age = 0
		}
		payload.AgeLabel = fmt.Sprintf("%ds", int64(age/time.Second))
	}
	if remaining := snapshot.MinRemaining(); remaining.Known {
		value := float64(remaining.BasisPoints) / 100
		payload.MinRemainingPct = &value
	}
	payload.Lines = formatUsageProbeLines(snapshot)
	writeUsageProbePayload(runtime, payload)
	return nil
}

func writeUsageProbePayload(runtime commandRuntime, payload usageProbePayload) {
	encoded, err := json.Marshal(payload)
	if err != nil {
		return
	}
	_, _ = fmt.Fprintln(runtime.stdout, string(encoded))
}

func usageProbeNoSnapshotHint(provider string) string {
	switch provider {
	case "codex":
		return "Run `aih codex <id>` once in this sandbox, then retry."
	case "claude":
		return "Ensure this account is logged in with OAuth (not API key), then retry."
	case "agy":
		return "Ensure this AGY account has a valid Antigravity OAuth access token, then retry."
	default:
		return ""
	}
}

func formatUsageProbeLines(snapshot usagecore.Snapshot) []string {
	entries := snapshot.Entries()
	sorted := append([]usagecore.Entry(nil), entries...)
	sort.SliceStable(sorted, func(left, right int) bool {
		if sorted[left].LimitID() != sorted[right].LimitID() {
			return sorted[left].LimitID() < sorted[right].LimitID()
		}
		return sorted[left].Bucket() < sorted[right].Bucket()
	})
	lines := make([]string, 0, len(sorted))
	for _, entry := range sorted {
		name := strings.TrimSpace(entry.LimitName())
		if name == "" {
			name = strings.TrimSpace(entry.LimitID())
		}
		if name == "" {
			name = entry.Bucket()
		}
		parts := make([]string, 0, 3)
		if basisPoints, known := entry.RemainingBasisPoints(); known {
			parts = append(parts, fmt.Sprintf("%.1f%%", float64(basisPoints)/100))
		} else if entry.Availability() == usagecore.AvailabilityUnlimited {
			parts = append(parts, "unlimited")
		} else if entry.Availability() == usagecore.AvailabilityExhausted {
			parts = append(parts, "exhausted")
		}
		if reset := entry.ResetAt(); !reset.IsZero() {
			remaining := time.Until(reset)
			if remaining > 0 {
				parts = append(parts, "resets in "+formatUsageProbeDuration(remaining))
			} else {
				parts = append(parts, "reset due")
			}
		} else if entry.WindowSeconds() > 0 {
			parts = append(parts, fmt.Sprintf("%dh window", entry.WindowSeconds()/3600))
		}
		lines = append(lines, name+": "+strings.Join(parts, " · "))
	}
	return lines
}

func formatUsageProbeDuration(value time.Duration) string {
	if value < time.Minute {
		return fmt.Sprintf("%ds", int64(value/time.Second))
	}
	if value < time.Hour {
		return fmt.Sprintf("%dm", int64(value/time.Minute))
	}
	if value < 24*time.Hour {
		return fmt.Sprintf("%.1fh", value.Hours())
	}
	return fmt.Sprintf("%.1fd", value.Hours()/24)
}
