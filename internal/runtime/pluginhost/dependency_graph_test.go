package pluginhost

import (
	"reflect"
	"strings"
	"testing"
)

func TestPlanGenerationTopologicalOrderAndTieBreaking(t *testing.T) {
	plugins := []PluginSpec{
		{
			InstanceID: "c-consumer",
			Manifest: map[string]any{
				"pluginId": "plugin-c",
				"requires": []any{
					map[string]any{"name": "svc.mid", "versionRange": "^1.0.0"},
					map[string]any{"name": "aih", "versionRange": "^1.0.0"},
				},
			},
		},
		{
			InstanceID: "z-independent",
			Manifest: map[string]any{
				"pluginId": "plugin-z",
			},
		},
		{
			InstanceID: "b-mid",
			Manifest: map[string]any{
				"pluginId": "plugin-b",
				"provides": []any{map[string]any{"name": "svc.mid", "version": "1.2.0"}},
				"requires": []any{map[string]any{"name": "svc.base", "versionRange": ">=1.0.0"}},
			},
		},
		{
			InstanceID: "a-base",
			Manifest: map[string]any{
				"pluginId": "plugin-a",
				"provides": []any{map[string]any{"name": "svc.base", "version": "1.0.0"}},
			},
		},
	}

	plan := PlanGeneration(plugins)
	if !plan.OK {
		t.Fatalf("expected valid plan, got diagnostics: %+v", plan.Diagnostics)
	}
	want := []string{"a-base", "b-mid", "c-consumer", "z-independent"}
	if !reflect.DeepEqual(plan.Order, want) {
		t.Fatalf("unexpected load order: got %v, want %v", plan.Order, want)
	}
}

func TestPlanGenerationCycleRejection(t *testing.T) {
	plugins := []PluginSpec{
		{
			InstanceID: "alpha",
			Manifest: map[string]any{
				"pluginId": "p-alpha",
				"provides": []any{map[string]any{"name": "svc.a", "version": "1.0.0"}},
				"requires": []any{map[string]any{"name": "svc.b", "versionRange": "^1.0.0"}},
			},
		},
		{
			InstanceID: "beta",
			Manifest: map[string]any{
				"pluginId": "p-beta",
				"provides": []any{map[string]any{"name": "svc.b", "version": "1.0.0"}},
				"requires": []any{map[string]any{"name": "svc.a", "versionRange": "^1.0.0"}},
			},
		},
	}
	plan := PlanGeneration(plugins)
	if plan.OK {
		t.Fatalf("expected cycle failure, got ok")
	}
	if len(plan.Diagnostics) != 1 || plan.Diagnostics[0].Code != CodeDependencyCycle {
		t.Fatalf("expected cycle diagnostic, got %+v", plan.Diagnostics)
	}
	if !strings.Contains(plan.Diagnostics[0].Detail, "alpha → beta → alpha") {
		t.Fatalf("unexpected cycle detail: %s", plan.Diagnostics[0].Detail)
	}
}

func TestPlanGenerationConflictsMissingAndHostServiceMismatch(t *testing.T) {
	cases := []struct {
		name     string
		plugins  []PluginSpec
		wantCode string
	}{
		{
			name: "duplicate_instance",
			plugins: []PluginSpec{
				{InstanceID: "dup", Manifest: map[string]any{"pluginId": "p1"}},
				{InstanceID: "dup", Manifest: map[string]any{"pluginId": "p2"}},
			},
			wantCode: CodeInstanceDuplicate,
		},
		{
			name: "duplicate_plugin_id",
			plugins: []PluginSpec{
				{InstanceID: "inst-1", Manifest: map[string]any{"pluginId": "same"}},
				{InstanceID: "inst-2", Manifest: map[string]any{"pluginId": "same"}},
			},
			wantCode: CodePluginIDDuplicate,
		},
		{
			name: "duplicate_contribution",
			plugins: []PluginSpec{
				{InstanceID: "i1", Manifest: map[string]any{"pluginId": "p1", "contributes": []any{map[string]any{"id": "c.dup"}}}},
				{InstanceID: "i2", Manifest: map[string]any{"pluginId": "p2", "contributes": []any{map[string]any{"id": "c.dup"}}}},
			},
			wantCode: CodeContributionDuplicate,
		},
		{
			name: "reserved_host_service",
			plugins: []PluginSpec{
				{InstanceID: "i1", Manifest: map[string]any{"pluginId": "p1", "provides": []any{map[string]any{"name": "aih", "version": "1.0.0"}}}},
			},
			wantCode: CodeServiceReserved,
		},
		{
			name: "service_conflict",
			plugins: []PluginSpec{
				{InstanceID: "i1", Manifest: map[string]any{"pluginId": "p1", "provides": []any{map[string]any{"name": "svc.x", "version": "1.0.0"}}}},
				{InstanceID: "i2", Manifest: map[string]any{"pluginId": "p2", "provides": []any{map[string]any{"name": "svc.x", "version": "2.0.0"}}}},
			},
			wantCode: CodeServiceConflict,
		},
		{
			name: "service_missing",
			plugins: []PluginSpec{
				{InstanceID: "i1", Manifest: map[string]any{"pluginId": "p1", "requires": []any{map[string]any{"name": "svc.nope", "versionRange": "^1.0.0"}}}},
			},
			wantCode: CodeServiceMissing,
		},
		{
			name: "host_service_mismatch",
			plugins: []PluginSpec{
				{InstanceID: "i1", Manifest: map[string]any{"pluginId": "p1", "requires": []any{map[string]any{"name": "aih", "versionRange": ">=2.0.0"}}}},
			},
			wantCode: CodeServiceVersionMismatch,
		},
		{
			name: "plugin_service_mismatch",
			plugins: []PluginSpec{
				{InstanceID: "i1", Manifest: map[string]any{"pluginId": "p1", "provides": []any{map[string]any{"name": "svc.x", "version": "1.0.0"}}}},
				{InstanceID: "i2", Manifest: map[string]any{"pluginId": "p2", "requires": []any{map[string]any{"name": "svc.x", "versionRange": "^2.0.0"}}}},
			},
			wantCode: CodeServiceVersionMismatch,
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			plan := PlanGeneration(tc.plugins)
			if plan.OK {
				t.Fatalf("expected failure %s, got OK", tc.wantCode)
			}
			found := false
			for _, diag := range plan.Diagnostics {
				if diag.Code == tc.wantCode {
					found = true
					break
				}
			}
			if !found {
				t.Fatalf("expected code %s, got diagnostics: %+v", tc.wantCode, plan.Diagnostics)
			}
		})
	}
}

func TestSemverMatching(t *testing.T) {
	if !ValidSemver("1.2.3-alpha.1+build.9") || ValidSemver("v1.2.3") {
		t.Fatalf("ValidSemver behavior mismatch")
	}
	if !SatisfiesSemverRange("1.4.2", "^1.0.0") || SatisfiesSemverRange("2.0.0", "^1.0.0") {
		t.Fatalf("caret range check failed")
	}
	if !SatisfiesSemverRange("1.2.5", "~1.2.3") || SatisfiesSemverRange("1.3.0", "~1.2.3") {
		t.Fatalf("tilde range check failed")
	}
	if !SatisfiesSemverRange("1.5.0", "1.0.0 - 2.0.0") || SatisfiesSemverRange("2.0.1", "1.0.0 - 2.0.0") {
		t.Fatalf("hyphen range check failed")
	}
	if !SatisfiesSemverRange("3.0.0", "^1.0.0 || >=3.0.0") {
		t.Fatalf("OR range check failed")
	}
}
