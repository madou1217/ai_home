// Package upstreamretry defines the canonical policy schema, bounds, strict
// validation, defensive sanitization, and precedence resolution for bounded
// upstream HTTP 429 wait-and-retry.
package upstreamretry

import (
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"slices"
	"strings"
	"time"
)

const (
	// DefaultEnabled enables bounded upstream HTTP 429 retry out of the box for
	// pinned or pool-exhausted requests; unpinned pools still fail over first.
	DefaultEnabled = true

	// MinBackoffSteps and MaxBackoffSteps bound the explicit retry schedule length.
	MinBackoffSteps = 1
	MaxBackoffSteps = 10

	// MinBackoffStepSeconds and MaxBackoffStepSeconds bound each step in seconds.
	MinBackoffStepSeconds = 1
	MaxBackoffStepSeconds = 300

	// MaxScheduleSumSeconds caps cumulative scheduled wait seconds per request.
	// 30 minutes: long enough for a concurrency-limited upstream to free a slot while
	// unattended sessions keep retrying; still bounded by MaxBackoffSteps / per-step limits.
	MaxScheduleSumSeconds = 1800

	// MaxSingleWait caps any single wait (including upstream Retry-After).
	MaxSingleWait = MaxBackoffStepSeconds * time.Second

	// MaxTotalWait caps cumulative 429 wait duration across a single request.
	MaxTotalWait = MaxScheduleSumSeconds * time.Second

	// ErrCodeInvalidConfig is the stable HTTP 400 error code for invalid retry config.
	ErrCodeInvalidConfig = "invalid_upstream_429_retry_config"
)

// ErrInvalidConfig marks any schema or guardrail violation for 429 retry settings.
var ErrInvalidConfig = errors.New("invalid upstream 429 retry config")

// ValidationError carries a stable error code and concise operator message.
type ValidationError struct {
	Code    string
	Message string
}

func (err *ValidationError) Error() string {
	if err == nil {
		return ErrInvalidConfig.Error()
	}
	if err.Message != "" {
		return err.Message
	}
	return ErrInvalidConfig.Error()
}

func (err *ValidationError) Unwrap() error {
	return ErrInvalidConfig
}

func newValidationError(message string) error {
	return &ValidationError{
		Code:    ErrCodeInvalidConfig,
		Message: message,
	}
}

// DefaultBackoffSeconds returns a fresh copy of the canonical default schedule [30].
func DefaultBackoffSeconds() []int {
	return []int{30}
}

// GlobalPolicy is the server-wide upstream HTTP 429 wait-and-retry policy.
type GlobalPolicy struct {
	Enabled        bool  `json:"enabled"`
	BackoffSeconds []int `json:"backoffSeconds"`
}

// DefaultGlobalPolicy returns the canonical global default policy.
func DefaultGlobalPolicy() GlobalPolicy {
	return GlobalPolicy{
		Enabled:        DefaultEnabled,
		BackoffSeconds: DefaultBackoffSeconds(),
	}
}

// Clone returns a deep copy with an independent schedule slice.
func (policy GlobalPolicy) Clone() GlobalPolicy {
	return GlobalPolicy{
		Enabled:        policy.Enabled,
		BackoffSeconds: slices.Clone(policy.BackoffSeconds),
	}
}

// OverrideMode expresses how an account interacts with global 429 retry policy.
type OverrideMode string

const (
	// ModeInherit delegates both enabled state and backoff schedule to global config.
	ModeInherit OverrideMode = "inherit"
	// ModeEnabled forces retry enabled for this account with an explicit non-empty backoff schedule.
	ModeEnabled OverrideMode = "enabled"
	// ModeDisabled forces retry disabled for this account regardless of global config.
	ModeDisabled OverrideMode = "disabled"
)

// IsValid reports whether mode is one of the three canonical override modes.
func (mode OverrideMode) IsValid() bool {
	return mode == ModeInherit || mode == ModeEnabled || mode == ModeDisabled
}

// AccountOverride is the persisted per-account upstream 429 retry override.
type AccountOverride struct {
	Mode           OverrideMode `json:"mode"`
	BackoffSeconds []int        `json:"backoffSeconds,omitempty"`
	UpdatedAt      int64        `json:"updatedAt,omitempty"`
}

// DefaultAccountOverride returns the canonical inherit override.
func DefaultAccountOverride() AccountOverride {
	return AccountOverride{Mode: ModeInherit}
}

// Clone returns a deep copy of the account override.
func (override AccountOverride) Clone() AccountOverride {
	return AccountOverride{
		Mode:           override.Mode,
		BackoffSeconds: slices.Clone(override.BackoffSeconds),
		UpdatedAt:      override.UpdatedAt,
	}
}

// PolicySource identifies which config layer determined the effective policy.
type PolicySource string

const (
	SourceGlobal          PolicySource = "global"
	SourceAccountDisabled PolicySource = "account_disabled"
	SourceAccountCustom   PolicySource = "account_custom"
)

// EffectivePolicy is the resolved per-account runtime decision policy.
type EffectivePolicy struct {
	Enabled        bool         `json:"enabled"`
	BackoffSeconds []int        `json:"backoffSeconds"`
	Source         PolicySource `json:"source"`
}

// Clone returns a deep copy of the effective policy.
func (policy EffectivePolicy) Clone() EffectivePolicy {
	return EffectivePolicy{
		Enabled:        policy.Enabled,
		BackoffSeconds: slices.Clone(policy.BackoffSeconds),
		Source:         policy.Source,
	}
}

// ValidateBackoffSeconds strictly validates an ordered non-empty retry schedule.
func ValidateBackoffSeconds(steps []int) ([]int, error) {
	if len(steps) < MinBackoffSteps {
		return nil, newValidationError("backoffSeconds must contain at least 1 step")
	}
	if len(steps) > MaxBackoffSteps {
		return nil, newValidationError(
			fmt.Sprintf("backoffSeconds supports at most %d steps", MaxBackoffSteps),
		)
	}
	sum := 0
	out := make([]int, len(steps))
	for index, seconds := range steps {
		if seconds < MinBackoffStepSeconds || seconds > MaxBackoffStepSeconds {
			return nil, newValidationError(
				fmt.Sprintf(
					"backoffSeconds[%d] must be an integer between %d and %d seconds",
					index,
					MinBackoffStepSeconds,
					MaxBackoffStepSeconds,
				),
			)
		}
		sum += seconds
		if sum > MaxScheduleSumSeconds {
			return nil, newValidationError(
				fmt.Sprintf("backoffSeconds cumulative total must not exceed %d seconds", MaxScheduleSumSeconds),
			)
		}
		out[index] = seconds
	}
	return out, nil
}

// ValidateGlobal strictly validates a typed GlobalPolicy.
func ValidateGlobal(policy GlobalPolicy) (GlobalPolicy, error) {
	steps, err := ValidateBackoffSeconds(policy.BackoffSeconds)
	if err != nil {
		return GlobalPolicy{}, err
	}
	return GlobalPolicy{
		Enabled:        policy.Enabled,
		BackoffSeconds: steps,
	}, nil
}

// ValidateGlobalPatchRaw strictly validates a raw JSON object patch merged
// atomically onto base. Missing fields inherit from base; enabled=false is preserved.
func ValidateGlobalPatchRaw(raw any, base GlobalPolicy) (GlobalPolicy, error) {
	obj, ok := raw.(map[string]any)
	if !ok || obj == nil {
		return GlobalPolicy{}, newValidationError("upstream429Retry must be a JSON object")
	}
	result := SanitizeGlobal(base)
	for key, value := range obj {
		switch key {
		case "enabled":
			enabled, ok := value.(bool)
			if !ok {
				return GlobalPolicy{}, newValidationError("upstream429Retry.enabled must be a boolean")
			}
			result.Enabled = enabled
		case "backoffSeconds":
			steps, err := parseStrictIntSlice(value, false)
			if err != nil {
				return GlobalPolicy{}, err
			}
			validated, err := ValidateBackoffSeconds(steps)
			if err != nil {
				return GlobalPolicy{}, err
			}
			result.BackoffSeconds = validated
		default:
			return GlobalPolicy{}, newValidationError(
				fmt.Sprintf("upstream429Retry contains unsupported field %q", key),
			)
		}
	}
	return ValidateGlobal(result)
}

// ValidateAccountOverride strictly validates a typed AccountOverride.
func ValidateAccountOverride(override AccountOverride) (AccountOverride, error) {
	mode := OverrideMode(strings.TrimSpace(strings.ToLower(string(override.Mode))))
	if !mode.IsValid() {
		return AccountOverride{}, newValidationError("mode must be one of inherit, enabled, or disabled")
	}
	switch mode {
	case ModeInherit, ModeDisabled:
		return AccountOverride{
			Mode:      mode,
			UpdatedAt: override.UpdatedAt,
		}, nil
	case ModeEnabled:
		steps, err := ValidateBackoffSeconds(override.BackoffSeconds)
		if err != nil {
			return AccountOverride{}, err
		}
		return AccountOverride{
			Mode:           ModeEnabled,
			BackoffSeconds: steps,
			UpdatedAt:      override.UpdatedAt,
		}, nil
	default:
		return AccountOverride{}, newValidationError("mode must be one of inherit, enabled, or disabled")
	}
}

// ValidateAccountOverrideRaw strictly validates a raw JSON payload for per-account override writes.
func ValidateAccountOverrideRaw(raw map[string]any) (AccountOverride, error) {
	if raw == nil {
		return AccountOverride{}, newValidationError("request body must be a JSON object")
	}
	modeRaw, hasMode := raw["mode"]
	if !hasMode {
		return AccountOverride{}, newValidationError("mode is required")
	}
	modeStr, ok := modeRaw.(string)
	if !ok {
		return AccountOverride{}, newValidationError("mode must be a string")
	}
	mode := OverrideMode(strings.TrimSpace(strings.ToLower(modeStr)))
	if !mode.IsValid() {
		return AccountOverride{}, newValidationError("mode must be one of inherit, enabled, or disabled")
	}
	var steps []int
	hasBackoff := false
	for key, value := range raw {
		switch key {
		case "mode", "updatedAt":
			continue
		case "backoffSeconds":
			if value == nil {
				continue
			}
			parsed, err := parseStrictIntSlice(value, mode != ModeEnabled)
			if err != nil {
				return AccountOverride{}, err
			}
			steps = parsed
			hasBackoff = true
		default:
			return AccountOverride{}, newValidationError(
				fmt.Sprintf("unsupported field %q", key),
			)
		}
	}
	if mode != ModeEnabled {
		return AccountOverride{Mode: mode}, nil
	}
	if !hasBackoff || len(steps) == 0 {
		return AccountOverride{}, newValidationError("backoffSeconds is required and must contain at least 1 step when mode is enabled")
	}
	validated, err := ValidateBackoffSeconds(steps)
	if err != nil {
		return AccountOverride{}, err
	}
	return AccountOverride{
		Mode:           ModeEnabled,
		BackoffSeconds: validated,
	}, nil
}

// SanitizeGlobal defensively normalizes a typed GlobalPolicy read from storage.
// Explicit Enabled=false is always preserved.
func SanitizeGlobal(policy GlobalPolicy) GlobalPolicy {
	steps, err := ValidateBackoffSeconds(policy.BackoffSeconds)
	if err != nil {
		steps = DefaultBackoffSeconds()
	}
	return GlobalPolicy{
		Enabled:        policy.Enabled,
		BackoffSeconds: steps,
	}
}

// SanitizeGlobalRaw defensively reads upstream429Retry from a raw config:server map.
// Missing or non-object input yields DefaultGlobalPolicy; explicit enabled=false is preserved.
func SanitizeGlobalRaw(raw any) GlobalPolicy {
	obj, ok := raw.(map[string]any)
	if !ok || obj == nil {
		return DefaultGlobalPolicy()
	}
	enabled := DefaultEnabled
	if value, exists := obj["enabled"]; exists {
		if flag, isBool := value.(bool); isBool {
			enabled = flag
		}
	}
	steps := DefaultBackoffSeconds()
	if value, exists := obj["backoffSeconds"]; exists {
		if parsed, err := parseStrictIntSlice(value, false); err == nil {
			if validated, validErr := ValidateBackoffSeconds(parsed); validErr == nil {
				steps = validated
			}
		}
	}
	return GlobalPolicy{
		Enabled:        enabled,
		BackoffSeconds: steps,
	}
}

// SanitizeAccountOverrideJSON defensively parses a persisted per-account override JSON blob.
// Returns (override, true) only when an active non-inherit override is stored.
func SanitizeAccountOverrideJSON(raw string) (AccountOverride, bool) {
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" {
		return DefaultAccountOverride(), false
	}
	var payload map[string]any
	if err := json.Unmarshal([]byte(trimmed), &payload); err != nil || payload == nil {
		return DefaultAccountOverride(), false
	}
	modeStr, ok := payload["mode"].(string)
	if !ok {
		return DefaultAccountOverride(), false
	}
	mode := OverrideMode(strings.TrimSpace(strings.ToLower(modeStr)))
	if !mode.IsValid() || mode == ModeInherit {
		return DefaultAccountOverride(), false
	}
	var updatedAt int64
	if rawUpdated, ok := payload["updatedAt"].(float64); ok && !math.IsNaN(rawUpdated) && !math.IsInf(rawUpdated, 0) && rawUpdated > 0 {
		updatedAt = int64(rawUpdated)
	}
	if mode == ModeDisabled {
		return AccountOverride{
			Mode:      ModeDisabled,
			UpdatedAt: updatedAt,
		}, true
	}
	var steps []int
	if value, exists := payload["backoffSeconds"]; exists && value != nil {
		if parsed, err := parseStrictIntSlice(value, false); err == nil {
			if validated, validErr := ValidateBackoffSeconds(parsed); validErr == nil {
				steps = validated
			}
		}
	}
	if len(steps) == 0 {
		return DefaultAccountOverride(), false
	}
	return AccountOverride{
		Mode:           ModeEnabled,
		BackoffSeconds: steps,
		UpdatedAt:      updatedAt,
	}, true
}

// ResolveEffective applies canonical account > global precedence and returns
// an immutable EffectivePolicy with an independent BackoffSeconds copy.
func ResolveEffective(
	global GlobalPolicy,
	override AccountOverride,
	hasOverride bool,
) EffectivePolicy {
	normalizedGlobal := SanitizeGlobal(global)
	if !hasOverride || override.Mode == "" || override.Mode == ModeInherit {
		return EffectivePolicy{
			Enabled:        normalizedGlobal.Enabled,
			BackoffSeconds: slices.Clone(normalizedGlobal.BackoffSeconds),
			Source:         SourceGlobal,
		}
	}
	switch override.Mode {
	case ModeDisabled:
		return EffectivePolicy{
			Enabled:        false,
			BackoffSeconds: nil,
			Source:         SourceAccountDisabled,
		}
	case ModeEnabled:
		if len(override.BackoffSeconds) > 0 {
			if validated, err := ValidateBackoffSeconds(override.BackoffSeconds); err == nil {
				return EffectivePolicy{
					Enabled:        true,
					BackoffSeconds: validated,
					Source:         SourceAccountCustom,
				}
			}
		}
		return EffectivePolicy{
			Enabled:        normalizedGlobal.Enabled,
			BackoffSeconds: slices.Clone(normalizedGlobal.BackoffSeconds),
			Source:         SourceGlobal,
		}
	default:
		return EffectivePolicy{
			Enabled:        normalizedGlobal.Enabled,
			BackoffSeconds: slices.Clone(normalizedGlobal.BackoffSeconds),
			Source:         SourceGlobal,
		}
	}
}

func parseStrictIntSlice(value any, allowEmpty bool) ([]int, error) {
	items, ok := value.([]any)
	if !ok {
		if typed, isIntSlice := value.([]int); isIntSlice {
			if !allowEmpty && len(typed) == 0 {
				return nil, newValidationError("backoffSeconds must contain at least 1 step")
			}
			return slices.Clone(typed), nil
		}
		return nil, newValidationError("backoffSeconds must be an array of integers")
	}
	if !allowEmpty && len(items) == 0 {
		return nil, newValidationError("backoffSeconds must contain at least 1 step")
	}
	if len(items) > MaxBackoffSteps {
		return nil, newValidationError(
			fmt.Sprintf("backoffSeconds supports at most %d steps", MaxBackoffSteps),
		)
	}
	out := make([]int, len(items))
	for index, item := range items {
		number, ok := parseStrictJSONInt(item)
		if !ok {
			return nil, newValidationError(
				fmt.Sprintf("backoffSeconds[%d] must be a finite integer", index),
			)
		}
		out[index] = number
	}
	return out, nil
}

func parseStrictJSONInt(value any) (int, bool) {
	switch typed := value.(type) {
	case int:
		return typed, true
	case int64:
		if typed < math.MinInt || typed > math.MaxInt {
			return 0, false
		}
		return int(typed), true
	case float64:
		if math.IsNaN(typed) || math.IsInf(typed, 0) || math.Trunc(typed) != typed {
			return 0, false
		}
		if typed < float64(math.MinInt32) || typed > float64(math.MaxInt32) {
			return 0, false
		}
		return int(typed), true
	case json.Number:
		parsed, err := typed.Int64()
		if err != nil || parsed < math.MinInt32 || parsed > math.MaxInt32 {
			return 0, false
		}
		return int(parsed), true
	default:
		return 0, false
	}
}
