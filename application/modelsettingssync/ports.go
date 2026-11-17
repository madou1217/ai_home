// Package modelsettingssync owns model-settings policy planning, not credential sync.
package modelsettingssync

import (
	"context"
	accountapp "github.com/madou1217/ai_home/application/accounts"
)

// Record is the normalized part of a settings row that affects routing.
type Record struct {
	ID         string `json:"id"`
	Provider   string `json:"provider"`
	AccountRef string `json:"accountRef"`
	Enabled    bool   `json:"enabled"`
	Manual     bool   `json:"manual"`
}

type Settings struct {
	AccountModels []Record `json:"accountModels"`
	LegacyModels  []Record `json:"legacyModels"`
}

// Document retains the complete normalized document, including non-policy fields.
type Document struct {
	Value       string
	UpdatedAtMS int64
}

type Snapshot struct {
	Accounts map[string]string
	Links    map[string]string
	Current  map[string]accountapp.ModelManualPolicy
	Managed  []string
}

type Write struct {
	AccountRef string
	ModelID    string
	Policy     accountapp.ModelManualPolicy
}

type Plan struct {
	Writes            []Write
	Managed           []string
	IgnoredStaleCount int
}

type Result struct {
	AppliedCount      int `json:"applied_count"`
	IgnoredStaleCount int `json:"ignored_stale_count"`
}

// Mutation runs after the existing document is read in the policy transaction.
type Mutation func(current string, found bool) (Document, error)

// Store commits settings, policies and managed ownership together, then publishes routes.
type Store interface {
	SaveModelSettings(context.Context, Document) (Result, error)
	UpdateModelSettings(context.Context, Mutation) (Result, error)
}
