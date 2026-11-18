package accountusage

import (
	"context"
	"encoding/json"
	"errors"
	"math"
	"sort"
	"strconv"
	"strings"

	"github.com/madou1217/ai_home/core/providers"
)

// QuotaDescriptor is a read-only projection of the existing registry, in its
// original iteration order. It is metadata input, not Go catalog authority.
// Later declarations of the same kind overwrite earlier ones, as Map.set did.
type QuotaDescriptor struct {
	Kind       string `json:"kind"`
	EntryShape string `json:"entryShape"`
}

// UsageFacts is exactly the existing second-phase management PUT body. It is a
// pure plan: compiling it neither opens a database nor writes either phase.
type UsageFacts struct {
	Source     string           `json:"source"`
	PlanType   usageJSString    `json:"plan_type"`
	CapturedAt string           `json:"captured_at"`
	Collected  bool             `json:"collected"`
	Entries    []UsageFactEntry `json:"entries"`
}
type UsageFactEntry struct {
	LimitID              string          `json:"limit_id"`
	LimitName            usageJSString   `json:"limit_name"`
	Bucket               string          `json:"bucket"`
	Kind                 string          `json:"kind"`
	Scope                string          `json:"scope"`
	ScopeKey             string          `json:"scope_key"`
	HasRemaining         bool            `json:"has_remaining"`
	RemainingBasisPoints usageJSONNumber `json:"remaining_basis_points"`
	WindowSeconds        usageJSONNumber `json:"window_seconds"`
	ResetAt              string          `json:"reset_at"`
	Availability         string          `json:"availability"`
}

// CompileUsageFacts preserves the former buildUsageFacts(snapshot,{provider})
// semantics, including null for an unusable snapshot and unknown for a view
// that cannot render. Transport/JSON/cancellation errors are never empty facts.
func CompileUsageFacts(ctx context.Context, raw, providerRaw json.RawMessage, descriptors []QuotaDescriptor) (*UsageFacts, error) {
	if ctx == nil {
		return nil, errors.New("usage_facts_context_required")
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	snapshot, err := usageDecode(raw, 0)
	if err != nil {
		return nil, errors.New("usage_facts_snapshot_invalid")
	}
	if _, ok := snapshot.(map[string]any); !ok {
		return nil, nil
	}
	capturedAt, err := usageNumber(usageGet(snapshot, "capturedAt"))
	if err != nil {
		return nil, err
	}
	if !usageFinite(capturedAt) || capturedAt <= 0 {
		return nil, nil
	}
	source, err := usageSanitize(usageGet(snapshot, "source"), "")
	if err != nil {
		return nil, err
	}
	if source == "" {
		return nil, nil
	}
	providerValue, err := usageDecode(providerRaw, 0)
	if err != nil {
		return nil, errors.New("usage_facts_provider_invalid")
	}
	provider, err := usageSanitize(providerValue, "")
	if err != nil {
		return nil, err
	}
	plan := usagePlan(provider, usageText(usageGet(usageGet(snapshot, "account"), "planType")))
	scopes, viewErr := usageScopes(ctx, snapshot, descriptors)
	if ctx.Err() != nil {
		return nil, ctx.Err()
	}
	if viewErr != nil {
		scopes = nil
	} // the old buildQuotaView try/catch
	entries := make([]UsageFactEntry, 0, 64)
	used := make(map[string]bool)
	for _, scope := range scopes {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		if len(entries) >= 64 {
			break
		}
		if scope.scope != "model_family" && scope.category != "primary" {
			continue
		}
		entry, ok, err := usageEntry(scope, len(entries), used)
		if err != nil {
			return nil, err
		}
		if !ok {
			continue
		}
		if entry.LimitName == "" && !entry.HasRemaining {
			continue
		}
		entries = append(entries, entry)
	}
	if len(entries) == 0 {
		entries = append(entries, UsageFactEntry{Bucket: "usage_unknown", Kind: "window", Scope: "account", Availability: "unknown"})
	}
	return &UsageFacts{Source: source, PlanType: usageJSString(plan), CapturedAt: usageNumberString(math.Floor(capturedAt)), Collected: true, Entries: entries}, nil
}

func usagePlan(provider, raw string) string {
	if provider == "" || raw == "" {
		return ""
	}
	lower := usageLower(usageTrim(raw))
	if usageNonPlan(lower) {
		return ""
	}
	// The old registry registered reset policy for these exact canonical IDs,
	// not all providers that happen to share a product family. Unknown plugins
	// keep the old default lower-case/display-name policy rather than rejection.
	registered := false
	agy := false
	for _, definition := range providers.BuiltinManifest().Providers {
		if definition.ID != provider {
			continue
		}
		switch definition.ID {
		case "codex", "claude", "agy", "kimi", "zcode":
			registered = true
		}
		agy = definition.ID == "agy"
		break
	}
	plan := lower
	if registered {
		plan = usagePlanSeparators(lower)
		if usageNonPlan(plan) {
			return ""
		}
	}
	if agy {
		switch {
		case strings.Contains(plan, "ultra"):
			plan = "ultra"
		case strings.Contains(plan, "pro"):
			plan = "pro"
		case strings.Contains(plan, "starter") || strings.Contains(plan, "free") || strings.Contains(plan, "default"):
			plan = "free"
		}
	}
	if len(usageUTF16(plan)) > 64 {
		return ""
	}
	for _, r := range usageRunes(plan) {
		if r <= 0x1f || r == 0x7f {
			return ""
		}
	}
	return usageTrim(plan)
}
func usagePlanSeparators(value string) string {
	var out strings.Builder
	separator := false
	for _, r := range usageRunes(value) {
		if usageSpace(r) || r == '-' {
			if !separator {
				out.WriteByte('_')
			}
			separator = true
		} else {
			usageWriteRune(&out, r)
			separator = false
		}
	}
	return out.String()
}
func usageNonPlan(value string) bool {
	// Preserve the actual old set, including its distinction between a dash
	// alias (oauth-browser) and an underscore token (oauth_browser). Do not
	// substitute core.IsPlanToken: that would silently change this contract.
	reserved := func(value string) bool {
		switch value {
		case "", "oauth", "oauth-browser", "oauth-device", "api-key", "api_key", "apikey", "pending", "unknown":
			return true
		}
		return false
	}
	return reserved(usagePlanSeparators(value)) || reserved(value)
}

type usageScope struct {
	index                                                      int
	shape, label, bucket, model, category, scope, scopeKey, id string
	window, reset, pct                                         float64
	hasPct, nonStringLabel                                     bool
}

func usageShape(snapshot any, descriptors []QuotaDescriptor) (string, error) {
	kind, err := usageStringField(usageGet(snapshot, "kind"))
	if err != nil {
		return "", err
	}
	shape := ""
	if kind != "" {
		for _, descriptor := range descriptors {
			if descriptor.Kind == kind && descriptor.Kind != "" && descriptor.EntryShape != "" {
				shape = descriptor.EntryShape
			}
		}
	}
	if shape != "" {
		return shape, nil
	}
	if _, ok := usageGet(snapshot, "models").([]any); ok {
		return "models", nil
	}
	if _, ok := usageGet(snapshot, "entries").([]any); ok {
		return "bucket", nil
	}
	return "account", nil
}
func usageScopes(ctx context.Context, snapshot any, descriptors []QuotaDescriptor) ([]usageScope, error) {
	shape, err := usageShape(snapshot, descriptors)
	if err != nil {
		return nil, err
	}
	field := ""
	switch shape {
	case "models":
		field = "models"
	case "window", "bucket":
		field = "entries"
	}
	var items []any
	if field != "" {
		items, _ = usageGet(snapshot, field).([]any)
	}
	scopes := make([]usageScope, 0, len(items))
	for index, item := range items {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		scope, err := usageNormalizeScope(item, shape, index)
		if err != nil {
			return nil, err
		}
		if scope.label != "" || scope.nonStringLabel {
			scopes = append(scopes, scope)
		}
	}
	pct, hasPct, err := usageNormalizedNumber(usageGet(snapshot, "remainingPct"))
	if err != nil {
		return nil, err
	}
	if len(scopes) == 0 && hasPct {
		scopes = append(scopes, usageScope{shape: "account", label: "Balance", category: "primary", id: "account:balance", pct: math.Max(0, math.Min(100, pct)), hasPct: true})
	}
	sort.SliceStable(scopes, func(i, j int) bool {
		left, right := scopes[i], scopes[j]
		lr, rr := 0, 0
		if left.category != "primary" {
			lr = 1
		}
		if right.category != "primary" {
			rr = 1
		}
		if lr != rr {
			return lr < rr
		}
		if left.category == "primary" && right.category == "primary" {
			lw, rw := math.Inf(1), math.Inf(1)
			if left.window > 0 {
				lw = left.window
			}
			if right.window > 0 {
				rw = right.window
			}
			byWindow := lw - rw
			if usageFinite(byWindow) && byWindow != 0 {
				return byWindow < 0
			}
			if left.shape == "models" && right.shape == "models" {
				lp, rp := math.Inf(1), math.Inf(1)
				if left.hasPct {
					lp = left.pct
				}
				if right.hasPct {
					rp = right.pct
				}
				if lp != rp {
					return lp < rp
				}
			}
		}
		return left.index < right.index
	})
	return scopes, nil
}
func usageNormalizeScope(item any, shape string, index int) (usageScope, error) {
	// JS typeof array === object; named fields of an ordinary JSON array are
	// absent, which is equivalent to the empty object here. Null is also empty.
	if _, ok := item.(map[string]any); !ok {
		item = map[string]any{}
	}
	scope := usageScope{index: index, shape: shape}
	label, nonStringLabel, err := usageLabel(item, shape)
	if err != nil {
		return scope, err
	}
	scope.label = label
	scope.nonStringLabel = nonStringLabel
	for _, field := range []struct {
		key    string
		target *string
	}{{"bucket", &scope.bucket}, {"model", &scope.model}, {"scope", &scope.scope}, {"scopeKey", &scope.scopeKey}, {"category", &scope.category}} {
		value, err := usageStringField(usageGet(item, field.key))
		if err != nil {
			return scope, err
		}
		*field.target = value
	}
	scope.category = usageLower(scope.category)
	if scope.category != "gift" && scope.category != "detail" {
		scope.category = "primary"
	}
	window, hasWindow, err := usageNormalizedNumber(usageGet(item, "windowMinutes"))
	if err != nil {
		return scope, err
	}
	if hasWindow {
		scope.window = window
	}
	reset, hasReset, err := usageNormalizedNumber(usageGet(item, "resetAtMs"))
	if err != nil {
		return scope, err
	}
	if hasReset {
		scope.reset = reset
	}
	pct, hasPct, err := usageNormalizedNumber(usageGet(item, "remainingPct"))
	if err != nil {
		return scope, err
	}
	scope.hasPct = hasPct
	if hasPct {
		scope.pct = math.Max(0, math.Min(100, pct))
	}
	// The source view converts these fields even though facts do not consume
	// them. Preserve its failure -> unknown behavior for malformed JSON objects.
	group := usageGet(item, "group")
	if !usageTruthy(group) {
		group = usageGet(item, "groupLabel")
	}
	if _, err := usageStringField(group); err != nil {
		return scope, err
	}
	for _, key := range []string{"window", "resetIn", "unitType", "displayName"} {
		if _, err := usageStringField(usageGet(item, key)); err != nil {
			return scope, err
		}
	}
	for _, key := range []string{"totalUnits", "usedUnits", "remainingUnits"} {
		if _, _, err := usageNormalizedNumber(usageGet(item, key)); err != nil {
			return scope, err
		}
	}
	identity := scope.bucket
	if shape == "models" {
		identity = scope.model
	}
	if identity == "" {
		identity = scope.label
	}
	if identity == "" {
		identity = strconv.Itoa(index)
	}
	scope.id = shape + ":" + identity
	return scope, nil
}
func usageLabel(item any, shape string) (string, bool, error) {
	label, err := usageStringField(usageGet(item, "label"))
	if err != nil || label != "" {
		return label, false, err
	}
	if shape == "models" {
		model := usageGet(item, "model")
		if !usageTruthy(model) {
			model = usageGet(item, "displayName")
		}
		label, err := usageStringField(model)
		return label, false, err
	}
	window, err := usageStringField(usageGet(item, "window"))
	if err != nil {
		return "", false, err
	}
	if strings.HasSuffix(window, "m") && usageDigits(strings.TrimSuffix(window, "m")) {
		n, _ := usageNumber(strings.TrimSuffix(window, "m"))
		converted := usageWindowLabel(n, usageFinite(n))
		if converted != "" {
			window = converted
		}
	}
	bucket, err := usageStringField(usageGet(item, "bucket"))
	if err != nil {
		return "", false, err
	}
	bucketLabel, nonStringLabel := usageBucketLabel(bucket)
	if bucket != "" && !usageGenericBucket(usageLower(bucket)) {
		minutesLabel := window
		if minutesLabel == "" {
			minutes, ok, err := usageNormalizedNumber(usageGet(item, "windowMinutes"))
			if err != nil {
				return "", false, err
			}
			minutesLabel = usageWindowLabel(minutes, ok)
		}
		if shape == "bucket" && minutesLabel != "" {
			return bucketLabel + " " + minutesLabel, false, nil
		}
		return bucketLabel, nonStringLabel, nil
	}
	if window != "" {
		return window, false, nil
	}
	if bucketLabel != "" || nonStringLabel {
		return bucketLabel, nonStringLabel, nil
	}
	minutes, ok, err := usageNormalizedNumber(usageGet(item, "windowMinutes"))
	if err != nil {
		return "", false, err
	}
	if label := usageWindowLabel(minutes, ok); label != "" {
		return label, false, nil
	}
	return "Balance", false, nil
}
func usageDigits(value string) bool { return value != "" && strings.Trim(value, "0123456789") == "" }
func usageGenericBucket(value string) bool {
	switch value {
	case "primary", "secondary", "credit", "credits", "balance", "monthly", "monthly_quota", "daily", "weekly", "gift", "five_hour", "five_hour_window", "seven_day", "seven_day_window":
		return true
	}
	return strings.HasPrefix(value, "rolling_") && strings.HasSuffix(value, "m") && usageDigits(strings.TrimSuffix(strings.TrimPrefix(value, "rolling_"), "m"))
}

// The old plain-object BUCKET_LABELS lookup inherits these two truthy values.
// Keep their type through scope filtering/text(); use the text below only when
// the bucket+window template coerces the value to a string.
func usageBucketLabel(value string) (string, bool) {
	switch usageLower(value) {
	case "constructor":
		return "function Object() { [native code] }", true
	case "__proto__":
		return "[object Object]", true
	case "credits", "credit":
		return "Credits", false
	case "balance":
		return "Balance", false
	case "monthly", "monthly_quota":
		return "Monthly", false
	case "five_hour", "five_hour_window":
		return "5h", false
	case "seven_day", "seven_day_window":
		return "7days", false
	case "daily":
		return "Daily", false
	case "weekly":
		return "Weekly", false
	case "gift":
		return "Gift", false
	}
	lower := usageLower(value)
	if strings.HasPrefix(lower, "rolling_") && strings.HasSuffix(lower, "m") {
		digits := strings.TrimSuffix(strings.TrimPrefix(lower, "rolling_"), "m")
		if usageDigits(digits) {
			minutes, _ := usageNumber(digits)
			if minutes > 0 && math.Mod(minutes, 60) == 0 {
				return usageNumberString(minutes/60) + "h", false
			}
			return usageNumberString(minutes) + "m", false
		}
	}
	for _, prefix := range []string{"gift:", "detail:"} {
		if strings.HasPrefix(value, prefix) && len(value) > len(prefix) {
			rest := strings.TrimPrefix(value, prefix)
			if !strings.ContainsAny(rest, "\n\r\u2028\u2029") {
				return usageTrim(rest), false
			}
		}
	}
	return value, false
}
func usageWindowLabel(minutes float64, ok bool) string {
	if !ok || minutes <= 0 {
		return ""
	}
	if math.Mod(minutes, 1440) == 0 {
		return usageNumberString(minutes/1440) + "days"
	}
	if math.Mod(minutes, 60) == 0 {
		return usageNumberString(minutes/60) + "h"
	}
	days, hours, rest := math.Floor(minutes/1440), math.Floor(math.Mod(minutes, 1440)/60), math.Mod(minutes, 60)
	label := ""
	if days > 0 {
		label += usageNumberString(days) + "d"
	}
	if hours > 0 {
		label += usageNumberString(hours) + "h"
	}
	if rest > 0 {
		label += usageNumberString(rest) + "m"
	}
	if label == "" {
		label = usageNumberString(minutes) + "m"
	}
	return label
}
func usageEntry(scope usageScope, index int, used map[string]bool) (UsageFactEntry, bool, error) {
	entry := UsageFactEntry{Kind: "window", Scope: "account", Availability: "exhausted", HasRemaining: true}
	// buildEntry applies Number() to the normalized view: null becomes zero.
	pct := 0.0
	if scope.hasPct {
		pct = scope.pct
	}
	entry.RemainingBasisPoints = usageJSONNumber(usageRound(pct * 100))
	if pct > 0 {
		entry.Availability = "available"
	}
	family := ""
	var err error
	if scope.scope == "model_family" {
		family, err = usageSanitize(scope.scopeKey, "")
		if err != nil {
			return entry, false, err
		}
		if family == "" {
			return entry, false, nil
		}
	}
	modelScoped := family != "" || scope.shape == "models" && scope.model != ""
	bucket, err := usageSanitize(scope.bucket, "")
	if err != nil {
		return entry, false, err
	}
	if bucket == "" && modelScoped {
		bucket, err = usageSanitize(scope.model, "")
		if err != nil {
			return entry, false, err
		}
	}
	if bucket == "" {
		bucket, err = usageSanitize(scope.id, "")
		if err != nil {
			return entry, false, err
		}
	}
	if bucket == "" {
		bucket = "scope_" + strconv.Itoa(index)
	}
	candidate := bucket
	for suffix := 2; used[candidate]; suffix++ {
		base := bucket
		if len(base) > 120 {
			base = base[:120]
		}
		candidate = base + "_" + strconv.Itoa(suffix)
	}
	used[candidate] = true
	entry.Bucket = candidate
	if modelScoped {
		entry.Scope = "model_family"
		entry.ScopeKey = family
		if family == "" {
			entry.ScopeKey, err = usageSanitize(scope.model, "model_"+strconv.Itoa(index))
			if err != nil {
				return entry, false, err
			}
		}
	}
	// The old bridge's text() accepts strings only, after the view has kept
	// truthy inherited labels. A template-coerced bucket+window is a string.
	if !scope.nonStringLabel {
		entry.LimitName = usageJSString(usageSlice(usageTrim(scope.label), 256))
	}
	if usageFinite(scope.window) && scope.window > 0 {
		entry.WindowSeconds = usageJSONNumber(usageRound(scope.window * 60))
	}
	if usageFinite(scope.reset) && scope.reset > 0 {
		entry.ResetAt = usageNumberString(math.Floor(scope.reset))
	}
	return entry, true, nil
}
