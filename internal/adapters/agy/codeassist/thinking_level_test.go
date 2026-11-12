package codeassist

import "testing"

func TestAgyThinkingLevel(t *testing.T) {
	cases := []struct {
		public string
		wire   string
		want   string
	}{
		{public: "gemini-3.8-flash-high", wire: "gemini-3.8-flash-tiered", want: "HIGH"},
		{public: "gemini-3.8-flash-medium", wire: "gemini-3.8-flash-tiered", want: "MEDIUM"},
		{public: "gemini-3.8-flash-low", wire: "gemini-3.8-flash-tiered", want: "LOW"},
		{public: "gemini-3.8-flash-tiered", wire: "gemini-3.8-flash-tiered", want: ""},
		{public: "claude-opus-5-5-high", wire: "claude-opus-5-5-high", want: ""},
	}
	for _, testCase := range cases {
		if got := agyThinkingLevel(testCase.public, testCase.wire); got != testCase.want {
			t.Fatalf("agyThinkingLevel(%s, %s) = %q, want %q",
				testCase.public, testCase.wire, got, testCase.want)
		}
	}
}
