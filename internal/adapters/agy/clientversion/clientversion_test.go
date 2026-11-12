package clientversion

import (
	"os"
	"path/filepath"
	"testing"
)

func writePlist(t *testing.T, version string) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "Info.plist")
	content := `<?xml version="1.0"?>
<plist><dict>
<key>CFBundleShortVersionString</key>
<string>` + version + `</string>
</dict></plist>`
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}
	return path
}

func TestDetectFromPrefersEndpointEnv(t *testing.T) {
	plist := writePlist(t, "1.18.0")
	if got := DetectFrom("clientVersion=1.17.2,other=1", plist); got != "1.17.2" {
		t.Fatalf("DetectFrom() = %q, want env version", got)
	}
}

func TestDetectFromFallsBackToPlist(t *testing.T) {
	plist := writePlist(t, "1.18.0")
	if got := DetectFrom("", plist); got != "1.18.0" {
		t.Fatalf("DetectFrom() = %q, want plist version", got)
	}
}

func TestDetectFromFallsBackToDefault(t *testing.T) {
	if got := DetectFrom("clientVersion=not-a-version", filepath.Join(t.TempDir(), "missing.plist")); got != Default {
		t.Fatalf("DetectFrom() = %q, want default %q", got, Default)
	}
}

func TestEndpointFieldDecodesValue(t *testing.T) {
	if got := endpointField("clientVersion=1.16.3%2B2", "clientVersion"); got != "1.16.3+2" {
		t.Fatalf("endpointField() = %q", got)
	}
}

func TestParseVersionRejectsNonSemver(t *testing.T) {
	for _, value := range []string{"", "abc", "1.2"} {
		if got := parseVersion(value); got != "" {
			t.Fatalf("parseVersion(%q) = %q, want empty", value, got)
		}
	}
}
