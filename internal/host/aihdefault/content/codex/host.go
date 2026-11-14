package codex

import (
	"encoding/json"
	"fmt"
	"net/url"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"unicode"

	"github.com/madou1217/ai_home/internal/runtime/providerconfigs"
)

const nativeAPIEndpointMarker = "# AI Home managed API endpoint for native openai sessions"

// HostSpec defines the explicit host login and the independent managed gateway
// provider kept callable by historical threads. No secret is written to TOML.
type HostSpec struct {
	GatewayURL   string
	AccountRef   string
	AuthCommand  string
	AIHomeDir    string
	Gateway      bool
	NativeAPIURL string
}

type hostEdit struct {
	start, end int
	text       string
}

// PatchHost uses parsed statement spans; multiline strings/arrays and quoted
// table names cannot be mistaken for root assignments or managed namespaces.
func PatchHost(current string, spec HostSpec) (string, error) {
	if !validHostPath(spec.AuthCommand) || !validHostPath(spec.AIHomeDir) {
		return "", fmt.Errorf("codex_host_auth_command_requires_absolute_paths")
	}
	if !validHostEndpoint(spec.GatewayURL) || (spec.NativeAPIURL != "" && !validHostEndpoint(spec.NativeAPIURL)) {
		return "", fmt.Errorf("codex_host_endpoint_invalid")
	}
	if spec.AccountRef != "" && !validHostAccountRef(spec.AccountRef) {
		return "", fmt.Errorf("codex_host_account_ref_invalid")
	}
	if spec.Gateway && spec.NativeAPIURL != "" {
		return "", fmt.Errorf("codex_host_conflicting_modes")
	}
	statements, err := providerconfigs.ScanTOMLStatements(current)
	if err != nil {
		return "", err
	}
	provider := "openai"
	endpoint := spec.NativeAPIURL
	if spec.Gateway {
		provider = DefaultProviderID
		endpoint = spec.GatewayURL
	}
	settings := []entry{
		{"model_provider", tomlQuote(provider)},
		{"suppress_unstable_features_warning", "true"},
		{"check_for_update_on_startup", "false"},
	}
	if endpoint != "" {
		settings = append(settings, entry{"openai_base_url", tomlQuote(endpoint)})
	}
	seen := make(map[string]bool)
	var edits []hostEdit
	for _, item := range statements {
		if item.Table {
			if ownedHostProvider(item.Keys) {
				if item.ArrayTable {
					return "", fmt.Errorf("codex_host_provider_array_unsupported")
				}
				edits = append(edits, hostEdit{item.Start, item.End, ""})
			}
			continue
		}
		fullPath := append(append([]string(nil), item.TablePath...), item.Keys...)
		if ownedHostProvider(item.TablePath) {
			edits = append(edits, hostEdit{item.Start, item.End, ""})
			continue
		}
		if ownedHostProvider(fullPath) || (len(fullPath) == 1 && fullPath[0] == "model_providers") {
			// Inline/dotted owned definitions need a dedicated edit strategy. Fail
			// before producing output instead of appending a conflicting namespace.
			return "", fmt.Errorf("codex_host_inline_provider_layout_unsupported")
		}
		if len(item.TablePath) != 0 || len(item.Keys) != 1 {
			continue
		}
		key := item.Keys[0]
		if key == "preferred_auth_method" {
			edits = append(edits, hostEdit{item.Start, item.End, ""})
			continue
		}
		if key == "openai_base_url" && endpoint == "" {
			if markerStart, found := precedingEndpointMarker(current, item.Start); found {
				edits = append(edits, hostEdit{markerStart, item.End, ""})
			}
			continue
		}
		for _, setting := range settings {
			if key != setting.key {
				continue
			}
			seen[key] = true
			edits = append(edits, hostEdit{item.ValueStart, item.ValueEnd, setting.value})
			if key == "openai_base_url" {
				if _, found := precedingEndpointMarker(current, item.Start); !found {
					edits = append(edits, hostEdit{item.Start, item.Start, nativeAPIEndpointMarker + newlineOf(current)})
				}
			}
		}
	}
	next := applyHostEdits(current, edits)
	var rootLines []string
	for _, setting := range settings {
		if seen[setting.key] {
			continue
		}
		if setting.key == "openai_base_url" {
			rootLines = append(rootLines, nativeAPIEndpointMarker)
		}
		rootLines = append(rootLines, setting.key+" = "+setting.value)
	}
	doc := parseDocument(next)
	if len(rootLines) > 0 {
		at := leadingCommentEnd(doc.lines)
		// Keep our endpoint ownership comment adjacent to the endpoint even when
		// it is the first setting in an otherwise sparse config.
		if at > 0 && strings.TrimSpace(doc.lines[at-1]) == nativeAPIEndpointMarker {
			at--
		}
		doc.lines = applyEdits(doc.lines, []edit{{at: at, insert: rootLines}})
	}
	// Replacing only statement spans left the owned namespace's blank lines.
	// Trim only the append boundary so repeated runs remain idempotent.
	next = doc.render()
	eol := newlineOf(current)
	next = strings.TrimRight(next, "\r\n")
	if next != "" {
		next += eol + eol
	}
	next += strings.Join(hostProviderLines(spec), eol)
	if doc.trailing {
		next += eol
	}
	if _, err := providerconfigs.ScanTOMLStatements(next); err != nil {
		return "", fmt.Errorf("codex_host_output_invalid")
	}
	return next, nil
}

func hostProviderLines(spec HostSpec) []string {
	lines := []string{
		"[model_providers." + DefaultProviderID + "]",
		"name = " + tomlQuote(DefaultLabel),
		"base_url = " + tomlQuote(spec.GatewayURL),
		`wire_api = "responses"`,
		"supports_websockets = true",
	}
	if spec.AccountRef != "" {
		lines = append(lines, `http_headers = { "X-Account-Ref" = `+tomlQuote(spec.AccountRef)+" }")
	}
	return append(lines, "", "[model_providers."+DefaultProviderID+".auth]",
		"command = "+tomlQuote(spec.AuthCommand),
		"args = [\"codex\", \"gateway-auth\", \"--ai-home\", "+tomlQuote(spec.AIHomeDir)+"]",
		"refresh_interval_ms = 300000", "timeout_ms = 10000")
}

func tomlQuote(value string) string {
	encoded, _ := json.Marshal(value)
	return string(encoded)
}

func newlineOf(content string) string {
	if strings.Contains(content, "\r\n") {
		return "\r\n"
	}
	return "\n"
}

func precedingEndpointMarker(content string, start int) (int, bool) {
	if start <= 0 {
		return 0, false
	}
	priorEnd := start - 1
	priorStart := strings.LastIndex(content[:priorEnd], "\n") + 1
	return priorStart, strings.TrimSpace(content[priorStart:start]) == nativeAPIEndpointMarker
}

func applyHostEdits(content string, edits []hostEdit) string {
	sort.SliceStable(edits, func(i, j int) bool {
		if edits[i].start != edits[j].start {
			return edits[i].start > edits[j].start
		}
		return edits[i].end > edits[j].end
	})
	for _, change := range edits {
		content = content[:change.start] + change.text + content[change.end:]
	}
	return content
}

func ownedHostProvider(parts []string) bool {
	return len(parts) >= 2 && parts[0] == "model_providers" && parts[1] == DefaultProviderID
}

func validHostPath(value string) bool {
	if !filepath.IsAbs(value) {
		return false
	}
	for _, char := range value {
		if unicode.IsControl(char) {
			return false
		}
	}
	return true
}

func validHostEndpoint(value string) bool {
	parsed, err := url.Parse(value)
	if err != nil || parsed.Hostname() == "" || parsed.User != nil || (parsed.Scheme != "http" && parsed.Scheme != "https") || parsed.Fragment != "" || parsed.RawQuery != "" {
		return false
	}
	if port := parsed.Port(); port != "" {
		number, err := strconv.Atoi(port)
		if err != nil || number < 1 || number > 65535 {
			return false
		}
	}
	return !strings.HasSuffix(parsed.Host, ":")
}

func validHostAccountRef(value string) bool {
	if len(value) != 25 || !strings.HasPrefix(value, "acct_") {
		return false
	}
	for _, char := range value[5:] {
		if !strings.ContainsRune("0123456789abcdef", char) {
			return false
		}
	}
	return true
}
