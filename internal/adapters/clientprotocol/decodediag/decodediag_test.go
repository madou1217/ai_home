package decodediag

import (
	"bytes"
	"encoding/json"
	"strings"
	"testing"
)

type probe struct {
	Model string `json:"model"`
	Count int    `json:"count"`
}

func strictDecode(body string) error {
	decoder := json.NewDecoder(bytes.NewReader([]byte(body)))
	decoder.DisallowUnknownFields()
	var output probe
	return decoder.Decode(&output)
}

func TestStrictJSONFieldNamesUnknownAndMistypedFields(t *testing.T) {
	t.Parallel()

	if got := StrictJSONField("$", strictDecode(`{"model":"m","service_tier_v2":"secret-value"}`)); got != "$.service_tier_v2(unknown)" {
		t.Fatalf("unknown field = %q", got)
	}
	if got := StrictJSONField("$", strictDecode(`{"count":"secret-value"}`)); got != "$.count(type)" {
		t.Fatalf("mistyped field = %q", got)
	}
	if got := StrictJSONField("input[3]", strictDecode(`{`)); got != "input[3]" {
		t.Fatalf("syntax error field = %q", got)
	}
}

func TestDiscriminatorSanitizesClientText(t *testing.T) {
	t.Parallel()

	if got := Discriminator("tools[27].type", "web_search_20250305"); got != "tools[27].type=web_search_20250305" {
		t.Fatalf("discriminator = %q", got)
	}
	got := Discriminator("input[0].type", "a b\n<script>"+strings.Repeat("x", 100))
	if strings.ContainsAny(got, " \n<>") || !strings.HasSuffix(got, "…") {
		t.Fatalf("unsanitized discriminator = %q", got)
	}
}
