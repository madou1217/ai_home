package accounts

import "testing"

func TestNormalizeAccountStatusMatchesNode(t *testing.T) {
	for input, want := range map[string]string{
		"up": "up", "UP": "up", " enabled ": "up",
		"down": "down", "Disabled": "down",
		"": "", "pending": "", "  ": "",
	} {
		if got := NormalizeAccountStatus(input); got != want {
			t.Fatalf("NormalizeAccountStatus(%q) = %q, want %q", input, got, want)
		}
	}
}

func TestResolveEffectiveAccountStatusDefaultsToUp(t *testing.T) {
	for input, want := range map[string]string{
		"down": "down", "disabled": "down", "up": "up", "weird": "up", "": "up",
	} {
		if got := ResolveEffectiveAccountStatus(input); got != want {
			t.Fatalf("ResolveEffectiveAccountStatus(%q) = %q, want %q", input, got, want)
		}
	}
}
