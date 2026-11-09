package pluginartifact

import "testing"

func TestValidSemver(t *testing.T) {
	cases := map[string]bool{
		"1.2.3":         true,
		"v1.2.3":        true,
		"0.0.0":         true,
		"1.2.3-beta.1":  true,
		"1.2.3+build.5": true,
		"1.2":           false,
		"01.2.3":        false,
		"1.2.3.4":       false,
		"1.2.3-":        false,
		"":              false,
		"not-a-version": false,
	}
	for value, expected := range cases {
		if actual := validSemver(value); actual != expected {
			t.Fatalf("validSemver(%q) = %v, want %v", value, actual, expected)
		}
	}
}

func TestSemverRangeSatisfaction(t *testing.T) {
	cases := []struct {
		version string
		rng     string
		want    bool
	}{
		{"1.0.0", ">=1.0.0", true},
		{"0.9.9", ">=1.0.0", false},
		{"2.0.0", ">=1.0.0 <2.0.0", false},
		{"1.9.9", ">=1.0.0 <2.0.0", true},
		{"1.9.0", "^1.2.3", true},
		{"2.0.0", "^1.2.3", false},
		{"1.2.2", "^1.2.3", false},
		{"0.2.9", "^0.2.3", true},
		{"0.3.0", "^0.2.3", false},
		{"0.0.3", "^0.0.3", true},
		{"0.0.4", "^0.0.3", false},
		{"1.2.9", "~1.2.3", true},
		{"1.3.0", "~1.2.3", false},
		{"1.5.0", "1.x", true},
		{"2.0.0", "1.x", false},
		{"1.2.9", "<=1.2", true},
		{"1.3.0", "<=1.2", false},
		{"1.2.0", "1.2", true},
		{"1.3.0", "1.2", false},
		{"22.14.0", ">=22", true},
		{"21.9.0", ">=22", false},
		{"2.0.0", "1.2.3 - 2.0.0", true},
		{"2.0.1", "1.2.3 - 2.0.0", false},
		{"3.1.0", "^1.0.0 || >=3.0.0", true},
		{"2.5.0", "^1.0.0 || >=3.0.0", false},
		{"1.2.3-beta.1", "^1.2.3", false},
		{"1.3.0-beta.1", "^1.2.3-beta.1", false},
		{"1.2.3-beta.2", "^1.2.3-beta.1", true},
		{"1.2.3", "*", true},
		{"1.2.3-beta.1", "*", false},
	}
	for _, testCase := range cases {
		if actual := satisfiesSemverRange(testCase.version, testCase.rng); actual != testCase.want {
			t.Fatalf("satisfies(%q, %q) = %v, want %v", testCase.version, testCase.rng, actual, testCase.want)
		}
	}
}

func TestInvalidSemverRange(t *testing.T) {
	for _, value := range []string{"not a range", "^", "abc", "1.2.3 - "} {
		if validSemverRange(value) {
			t.Fatalf("validSemverRange(%q) = true, want false", value)
		}
	}
}
