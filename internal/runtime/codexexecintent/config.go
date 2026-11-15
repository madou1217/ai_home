package codexexecintent

import (
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"unicode"

	"github.com/madou1217/ai_home/internal/runtime/providerconfigs"
)

func quote(s string) string { b, _ := json.Marshal(s); return string(b) }
func envValue(env []string, key string) string {
	for i := len(env) - 1; i >= 0; i-- {
		k, v, ok := strings.Cut(env[i], "=")
		if ok && (k == key || os.PathSeparator == '\\' && strings.EqualFold(k, key)) {
			return v
		}
	}
	return ""
}
func codexHome(env []string) (string, error) {
	h := envValue(env, "CODEX_HOME")
	if h == "" {
		h = envValue(env, "HOME")
		if h == "" {
			h = envValue(env, "USERPROFILE")
		}
		if h == "" {
			return "", fmt.Errorf("codex_exec_home_unavailable")
		}
		h = filepath.Join(h, ".codex")
	}
	return filepath.Abs(h)
}

// App-server does not accept -p. Only the service-tier root scalar is projected
// from the selected current profile; all other profile behavior remains native.
// Explicit -c settings come last and therefore remain authoritative.
func (v invocation) profileTier(home string) (*string, error) {
	if v.profile == "" {
		return nil, nil
	}
	if v.profile == "." || v.profile == ".." || strings.ContainsAny(v.profile, "/\\\x00") || filepath.IsAbs(v.profile) {
		return nil, fmt.Errorf("codex_exec_profile_invalid")
	}
	p := filepath.Join(home, v.profile+".config.toml")
	f, err := os.Open(p)
	if err != nil {
		return nil, fmt.Errorf("codex_exec_profile_unavailable")
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil || !info.Mode().IsRegular() || info.Size() > 4<<20 {
		return nil, fmt.Errorf("codex_exec_profile_invalid")
	}
	raw, err := io.ReadAll(io.LimitReader(f, (4<<20)+1))
	if err != nil || len(raw) > 4<<20 {
		return nil, fmt.Errorf("codex_exec_profile_invalid")
	}
	after, statErr := os.Stat(p)
	if statErr != nil || !os.SameFile(info, after) || info.Size() != after.Size() || !info.ModTime().Equal(after.ModTime()) {
		return nil, fmt.Errorf("codex_exec_profile_changed_retry")
	}
	statements, err := providerconfigs.ScanTOMLStatements(string(raw))
	if err != nil {
		return nil, fmt.Errorf("codex_exec_profile_invalid")
	}
	for _, s := range statements {
		if !s.Table && len(s.TablePath) == 0 && len(s.Keys) == 1 && s.Keys[0] == "service_tier" {
			t, ok := s.Value.(string)
			if !ok || !validTier(t) {
				return nil, fmt.Errorf("codex_exec_tier_invalid")
			}
			return &t, nil
		}
	}
	return nil, nil
}
func validTier(s string) bool {
	if s == "" || len(s) > 256 || strings.TrimSpace(s) != s {
		return false
	}
	for _, r := range s {
		if unicode.IsControl(r) || unicode.IsSpace(r) {
			return false
		}
	}
	return true
}

// explicitTier uses the native last--config-wins rule. Bare scalar values are
// accepted by the official CLI as strings; structured/non-string tiers fail.
func (v invocation) explicitTier() (*string, error) {
	var result *string
	for i := 3; i+1 < len(v.appArgs); i++ {
		if v.appArgs[i] != "-c" {
			continue
		}
		i++
		key, value, ok := strings.Cut(v.appArgs[i], "=")
		if !ok || strings.TrimSpace(key) != "service_tier" {
			continue
		}
		value = strings.TrimSpace(value)
		tier := value
		if strings.HasPrefix(value, "\"") || strings.HasPrefix(value, "'") {
			statements, err := providerconfigs.ScanTOMLStatements("service_tier=" + value)
			if err != nil || len(statements) != 1 {
				return nil, fmt.Errorf("codex_exec_tier_invalid")
			}
			var valid bool
			tier, valid = statements[0].Value.(string)
			if !valid {
				return nil, fmt.Errorf("codex_exec_tier_invalid")
			}
		}
		if !validTier(tier) {
			return nil, fmt.Errorf("codex_exec_tier_invalid")
		}
		copy := tier
		result = &copy
	}
	return result, nil
}
