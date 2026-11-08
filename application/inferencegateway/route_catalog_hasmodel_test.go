package inferencegateway

import "testing"

func TestRouteRuleMatchesModel(t *testing.T) {
	exact := RouteRule{pattern: "gpt-5", matchKind: routeMatchExact}
	prefix := RouteRule{pattern: "glm-*", prefix: "glm-", matchKind: routeMatchPrefix}
	for _, tc := range []struct {
		name string
		rule RouteRule
		model string
		want bool
	}{
		{name: "exact hit", rule: exact, model: "gpt-5", want: true},
		{name: "exact miss", rule: exact, model: "gpt-5-mini", want: false},
		{name: "prefix hit", rule: prefix, model: "glm-5.3", want: true},
		{name: "prefix miss", rule: prefix, model: "gpt-5", want: false},
		{name: "empty kind", rule: RouteRule{}, model: "glm-5.3", want: false},
	} {
		if got := tc.rule.matchesModel(tc.model); got != tc.want {
			t.Fatalf("%s: matchesModel(%q) = %v", tc.name, tc.model, got)
		}
	}
}

func TestRouteCatalogHasModel(t *testing.T) {
	catalog := &RouteCatalog{
		exact: map[string][]RouteRule{
			"gpt-5": {{pattern: "gpt-5", matchKind: routeMatchExact}},
		},
		wildcards: []RouteRule{
			{pattern: "glm-*", prefix: "glm-", matchKind: routeMatchPrefix},
		},
	}
	for _, tc := range []struct {
		model string
		want  bool
	}{
		{model: "gpt-5", want: true},
		{model: "glm-5.3", want: true},
		{model: "gemini-2.5-pro", want: false},
		{model: "", want: false},
	} {
		if got := catalog.HasModel(tc.model); got != tc.want {
			t.Fatalf("HasModel(%q) = %v, want %v", tc.model, got, tc.want)
		}
	}
	var nilCatalog *RouteCatalog
	if nilCatalog.HasModel("gpt-5") {
		t.Fatalf("nil catalog must not report models")
	}
}
