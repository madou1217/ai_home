package codeassist

import (
	"errors"
	"reflect"
	"testing"
)

func TestDecodeModelCatalogOnlyAppliesDeclaredAvailableTargets(t *testing.T) {
	t.Parallel()

	for _, test := range []struct {
		name    string
		payload string
		want    map[string]string
	}{
		{"object", `{"models":{"old":{},"new":{}},"deprecatedModelIds":{"old":{"newModelId":"new","futureField":true}}}`, map[string]string{"old": "new"}},
		{"string", `{"models":{"new":{}},"deprecatedModelIds":{"old":"new"}}`, map[string]string{"old": "new"}},
		{"snake", `{"models":{"new":{}},"deprecated_model_ids":{"old":{"new_model_id":"new"}}}`, map[string]string{"old": "new"}},
		{"chain", `{"models":{"new":{}},"deprecatedModelIds":{"old":"middle","middle":"new"}}`, map[string]string{"old": "new", "middle": "new"}},
		{"unavailable", `{"models":{"old":{}},"deprecatedModelIds":{"old":"missing"}}`, map[string]string{}},
		{"cycle", `{"models":{"old":{},"middle":{}},"deprecatedModelIds":{"old":"middle","middle":"old"}}`, map[string]string{}},
		{"self", `{"models":{"old":{}},"deprecatedModelIds":{"old":"old"}}`, map[string]string{}},
		{"internal", `{"models":{"new":{}},"deprecatedModelIds":{"MODEL_INTERNAL":"new","old":"MODEL_INTERNAL","tab_internal":"new"}}`, map[string]string{}},
		{"absent", `{"models":{"new":{}}}`, map[string]string{}},
		{"null", `{"models":{"new":{}},"deprecatedModelIds":null}`, map[string]string{}},
	} {
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()
			_, wires, err := decodeModelCatalog([]byte(test.payload))
			if err != nil || !reflect.DeepEqual(wires, test.want) {
				t.Fatalf("wires=%v error=%v, want %v", wires, err, test.want)
			}
		})
	}
}

func TestDecodeModelCatalogRejectsAmbiguousForwarding(t *testing.T) {
	t.Parallel()

	for _, payload := range []string{
		`{"models":{"new":{}},"deprecatedModelIds":{"old":"new","old":"other"}}`,
		`{"models":{"new":{}},"deprecatedModelIds":{},"deprecated_model_ids":{}}`,
		`{"models":{"new":{}},"deprecatedModelIds":["old"]}`,
	} {
		if _, _, err := decodeModelCatalog([]byte(payload)); !errors.Is(err, ErrInvalidUpstreamResponse) {
			t.Fatalf("error=%v, want ErrInvalidUpstreamResponse", err)
		}
	}
}
