// Package claudedesktopconfig owns only the native Claude Desktop configuration
// preparation transaction. It never launches apps, reads credentials or manages
// a server. Go Toolkit and legacy Node launch adapters share this boundary.
package claudedesktopconfig

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strings"
)

const (
	stateName       = ".aih-desktop-managed.json"
	journalName     = ".aih-desktop-prepare.json"
	maxJournalBytes = 32 * 1024 * 1024
)

var idPattern = regexp.MustCompile(`^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$`)

type Options struct {
	ProfileDir           string   `json:"profileDir"`
	Mode                 string   `json:"mode"`
	GatewayBaseURL       string   `json:"gatewayBaseUrl"`
	CredentialHelper     string   `json:"credentialHelperPath"`
	CredentialHelperArgs []string `json:"credentialHelperArgs"`
	DryRun               bool     `json:"dryRun"`
}
type Result struct {
	OK               bool   `json:"ok"`
	Status           string `json:"status"`
	Reason           string `json:"reason,omitempty"`
	Mode             string `json:"mode"`
	ProfileDir       string `json:"profileDir"`
	ConfigID         string `json:"configId,omitempty"`
	GatewayBaseURL   string `json:"gatewayBaseUrl,omitempty"`
	Changed          bool   `json:"changed"`
	DryRun           bool   `json:"dryRun,omitempty"`
	RecoveryRequired bool   `json:"recoveryRequired,omitempty"`
	RecoveryPath     string `json:"recoveryPath,omitempty"`
}
type receipt struct {
	ID      string         `json:"id"`
	Managed map[string]any `json:"managed"`
}
type managedState struct {
	Version int                `json:"version"`
	Entries map[string]receipt `json:"entries"`
}
type change struct {
	Relative string `json:"relative"`
	Resolved string `json:"resolved"`
	Existed  bool   `json:"existed"`
	Mode     uint32 `json:"mode"`
	Before   []byte `json:"before"`
	After    []byte `json:"after"`
}
type transaction struct {
	Version       int      `json:"version"`
	Profile       string   `json:"profile"`
	Mode          string   `json:"mode"`
	ConfigID      string   `json:"configId"`
	Changes       []change `json:"changes"`
	Guards        []change `json:"guards"`
	RequestSHA256 string   `json:"requestSha256"`
}

func fail(code string) error          { return errors.New(code) }
func fingerprint(value []byte) string { v := sha256.Sum256(value); return hex.EncodeToString(v[:]) }
func newID() (string, error) {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		return "", err
	}
	b[6] = (b[6] & 0x0f) | 0x40
	b[8] = (b[8] & 0x3f) | 0x80
	return fmt.Sprintf("%08x-%04x-%04x-%04x-%012x", b[:4], b[4:6], b[6:8], b[8:10], b[10:]), nil
}
func validate(options Options) error {
	if !filepath.IsAbs(options.ProfileDir) || strings.ContainsRune(options.ProfileDir, 0) {
		return fail("desktop_profile_invalid")
	}
	if options.Mode != "api" && options.Mode != "web" {
		return fail("invalid_desktop_mode")
	}
	if options.Mode == "api" {
		parsed, err := url.Parse(options.GatewayBaseURL)
		if err != nil || (parsed.Scheme != "http" && parsed.Scheme != "https") || parsed.Host == "" || parsed.User != nil || parsed.RawQuery != "" || parsed.Fragment != "" {
			return fail("desktop_gateway_url_invalid")
		}
		info, err := os.Stat(options.CredentialHelper)
		if err != nil || !info.Mode().IsRegular() {
			return fail("credential_helper_missing")
		}
		for _, arg := range options.CredentialHelperArgs {
			if strings.ContainsRune(arg, 0) {
				return fail("credential_helper_args_invalid")
			}
		}
	}
	return nil
}
func apiConfig(o Options) map[string]any {
	out := map[string]any{"inferenceProvider": "gateway", "inferenceCredentialKind": "helper-script", "inferenceGatewayBaseUrl": o.GatewayBaseURL, "inferenceGatewayAuthScheme": "bearer", "inferenceCredentialHelper": o.CredentialHelper, "modelDiscoveryEnabled": true}
	if len(o.CredentialHelperArgs) > 0 {
		args := make([]any, len(o.CredentialHelperArgs))
		for i, value := range o.CredentialHelperArgs {
			args[i] = value
		}
		out["inferenceCredentialHelperArgs"] = args
	}
	return out
}
