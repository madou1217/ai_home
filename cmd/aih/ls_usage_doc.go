package main

import (
	"encoding/json"
	"strings"

	"github.com/madou1217/ai_home/internal/adapters/accounts/accountlistread"
)

// lsUsageDocument 是 account_usage_snapshots.payload_json 的最小展示投影。
type lsUsageDocument struct {
	Kind    string
	Account lsUsageDocAccount
	Entries []lsUsageDocEntry
	Models  []lsUsageDocModel
}

type lsUsageDocAccount struct {
	PlanType      string
	RateLimitTier string
}

type lsUsageDocEntry struct {
	Bucket         string   `json:"bucket"`
	Category       string   `json:"category"`
	Window         string   `json:"window"`
	WindowMinutes  int      `json:"windowMinutes"`
	RemainingPct   *float64 `json:"remainingPct"`
	RemainingUnits *float64 `json:"remainingUnits"`
	TotalUnits     *float64 `json:"totalUnits"`
	UnitType       string   `json:"unitType"`
	ResetIn        string   `json:"resetIn"`
	Model          string   `json:"model"`
	DisplayName    string   `json:"displayName"`
}

type lsUsageDocModel struct {
	Model        string   `json:"model"`
	DisplayName  string   `json:"displayName"`
	RemainingPct *float64 `json:"remainingPct"`
	ResetIn      string   `json:"resetIn"`
}

func parseLSUsageDocument(snapshot *accountlistread.UsageSnapshot) lsUsageDocument {
	var document lsUsageDocument
	if snapshot == nil || len(snapshot.Payload) == 0 {
		return document
	}
	var payload struct {
		Kind    string `json:"kind"`
		Account struct {
			PlanType      string `json:"planType"`
			PlanTypeSnake string `json:"plan_type"`
			RateLimitTier string `json:"rateLimitTier"`
			RateTierSnake string `json:"rate_limit_tier"`
		} `json:"account"`
		Entries []lsUsageDocEntry `json:"entries"`
		Models  []lsUsageDocModel `json:"models"`
	}
	if err := json.Unmarshal(snapshot.Payload, &payload); err != nil {
		return document
	}
	document.Kind = strings.TrimSpace(payload.Kind)
	document.Account.PlanType = strings.TrimSpace(payload.Account.PlanType)
	if document.Account.PlanType == "" {
		document.Account.PlanType = strings.TrimSpace(payload.Account.PlanTypeSnake)
	}
	document.Account.RateLimitTier = strings.TrimSpace(payload.Account.RateLimitTier)
	if document.Account.RateLimitTier == "" {
		document.Account.RateLimitTier = strings.TrimSpace(payload.Account.RateTierSnake)
	}
	document.Entries = payload.Entries
	document.Models = payload.Models
	return document
}
