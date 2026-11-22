package accountbrowser

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
)

// BindJobProfile records that an OAuth job profile now belongs to the account
// the job created. The browser data is not moved: the account browser resolves
// the job profile at open time, which works even while the login window is open.
func BindJobProfile(homeDir, provider, accountRef, jobID string) error {
	homeDir = strings.TrimSpace(homeDir)
	provider = strings.TrimSpace(provider)
	accountRef = strings.TrimSpace(accountRef)
	jobID = strings.TrimSpace(jobID)
	if homeDir == "" || provider == "" || !validBindingToken(accountRef, 8, 80) || !validBindingToken(jobID, 8, 80) {
		return errors.New("invalid browser job binding")
	}
	dir := filepath.Join(homeDir, "run", "account-browser", "bindings")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	payload, err := json.Marshal(struct {
		Provider   string `json:"provider"`
		AccountRef string `json:"accountRef"`
		JobID      string `json:"jobId"`
	}{provider, accountRef, jobID})
	if err != nil {
		return err
	}
	target := filepath.Join(dir, accountRef+".json")
	temp := target + ".tmp"
	if err := os.WriteFile(temp, payload, 0o600); err != nil {
		return err
	}
	return os.Rename(temp, target)
}

// BoundJobProfile returns the job profile bound to this account identity.
func BoundJobProfile(homeDir, provider, accountRef string) (string, bool) {
	homeDir = strings.TrimSpace(homeDir)
	provider = strings.TrimSpace(provider)
	accountRef = strings.TrimSpace(accountRef)
	if homeDir == "" || provider == "" || !validBindingToken(accountRef, 8, 80) {
		return "", false
	}
	raw, err := os.ReadFile(filepath.Join(homeDir, "run", "account-browser", "bindings", accountRef+".json"))
	if err != nil {
		return "", false
	}
	var binding struct {
		Provider   string `json:"provider"`
		AccountRef string `json:"accountRef"`
		JobID      string `json:"jobId"`
	}
	if json.Unmarshal(raw, &binding) != nil || binding.Provider != provider || binding.AccountRef != accountRef || !validBindingToken(binding.JobID, 8, 80) {
		return "", false
	}
	return binding.JobID, true
}

func validBindingToken(value string, min, max int) bool {
	if len(value) < min || len(value) > max {
		return false
	}
	for _, char := range value {
		if (char < 'a' || char > 'z') && (char < 'A' || char > 'Z') && (char < '0' || char > '9') && char != '-' && char != '_' {
			return false
		}
	}
	return true
}
