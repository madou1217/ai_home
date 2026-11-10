package webuicontrolplaneapi

import (
	"net"
	"net/http"
	"net/url"
	"sort"
	"strconv"
	"strings"
)

type endpointHint struct {
	Endpoint    string `json:"endpoint"`
	Source      string `json:"source"`
	Label       string `json:"label"`
	Warning     string `json:"warning"`
	Recommended bool   `json:"recommended"`
}

type lanCandidate struct {
	address string
	name    string
}

// handleEndpoints 复刻 Node buildControlPlaneEndpointHints；请求地址与绑定 host
// 由 Node 通过查询参数传入（Go 不猜反向代理头）。
func (handler *Handler) handleEndpoints(response http.ResponseWriter, request *http.Request) {
	if request.Method != http.MethodGet {
		response.Header().Set("Allow", http.MethodGet)
		writeError(response, http.StatusMethodNotAllowed, "method_not_allowed", "")
		return
	}
	query := request.URL.Query()
	requestEndpoint := strings.TrimRight(strings.TrimSpace(query.Get("endpoint")), "/")
	bindHost := normalizeHost(query.Get("host"))
	port := resolvePort(requestEndpoint, query.Get("port"))

	requestURL, _ := url.Parse(requestEndpoint)
	requestHost := ""
	if requestURL != nil {
		requestHost = normalizeHost(requestURL.Hostname())
	}
	requestIsLoopback := isLoopbackHost(requestHost)
	lanReachableBind := canLanReachBindHost(bindHost)
	protocol := "http"
	if requestURL != nil && requestURL.Scheme == "https" {
		protocol = "https"
	}

	hints := []endpointHint{}
	warnings := []string{}
	if requestEndpoint != "" {
		warning := ""
		if requestIsLoopback {
			addWarning(&warnings, "当前浏览器地址是 localhost，只适合同机访问，手机不能直接使用。")
			warning = "localhost 只适合同机访问。"
		}
		addHint(&hints, endpointHint{
			Endpoint: requestEndpoint, Source: "request", Label: "当前浏览器地址",
			Warning: warning, Recommended: !requestIsLoopback,
		})
	}

	includeLAN := requestIsLoopback || lanReachableBind
	candidates := []lanCandidate{}
	if includeLAN {
		candidates = listLanIPv4Candidates()
	}
	if requestIsLoopback && len(candidates) == 0 {
		addWarning(&warnings, "没有发现可用于手机访问的局域网 IPv4 地址。")
	}
	if len(candidates) > 0 && !lanReachableBind {
		addWarning(&warnings, "当前服务可能只监听本机地址；手机使用局域网候选前需要开启开放网络或接入隧道。")
	}
	limit := len(candidates)
	if limit > 8 {
		limit = 8
	}
	for _, candidate := range candidates[:limit] {
		label := "局域网候选"
		if candidate.name != "" {
			label = "局域网候选 " + candidate.name
		}
		warning := "当前服务可能只监听本机地址。"
		if lanReachableBind {
			warning = "需要手机与 Server 在同一网络，并允许防火墙访问。"
		}
		addHint(&hints, endpointHint{
			Endpoint: formatEndpoint(protocol, candidate.address, port),
			Source:   "lan", Label: label, Warning: warning,
			Recommended: requestIsLoopback && lanReachableBind,
		})
	}

	writeJSON(response, http.StatusOK, map[string]any{"ok": true, "endpoints": hints, "warnings": warnings})
}

func normalizeHost(value string) string {
	return strings.ToLower(strings.Trim(strings.TrimSpace(value), "[]"))
}

func isLoopbackHost(value string) bool {
	host := normalizeHost(value)
	if host == "" {
		return false
	}
	if host == "localhost" {
		return true
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}

func isWildcardHost(value string) bool {
	host := normalizeHost(value)
	return host == "0.0.0.0" || host == "::" || host == "[::]"
}

func isUsableLanIPv4(value string) bool {
	address := strings.TrimSpace(value)
	if address == "" || address == "0.0.0.0" || isLoopbackHost(address) {
		return false
	}
	ip := net.ParseIP(address)
	if ip == nil || ip.To4() == nil || ip.IsLinkLocalUnicast() || ip.IsUnspecified() || ip.IsMulticast() {
		return false
	}
	octets := ip.To4()
	if octets[0] == 0 || octets[0] >= 224 {
		return false
	}
	if octets[0] == 198 && (octets[1] == 18 || octets[1] == 19) {
		return false
	}
	if octets[0] == 192 && octets[1] == 0 && octets[2] == 2 {
		return false
	}
	if octets[0] == 198 && octets[1] == 51 && octets[2] == 100 {
		return false
	}
	if octets[0] == 203 && octets[1] == 0 && octets[2] == 113 {
		return false
	}
	return true
}

func listLanIPv4Candidates() []lanCandidate {
	interfaces, err := net.Interfaces()
	if err != nil {
		return nil
	}
	seen := map[string]struct{}{}
	candidates := []lanCandidate{}
	for _, networkInterface := range interfaces {
		addresses, err := networkInterface.Addrs()
		if err != nil {
			continue
		}
		for _, address := range addresses {
			ip, _, err := net.ParseCIDR(address.String())
			if err != nil || ip.To4() == nil {
				continue
			}
			text := ip.String()
			if _, exists := seen[text]; exists || !isUsableLanIPv4(text) {
				continue
			}
			seen[text] = struct{}{}
			candidates = append(candidates, lanCandidate{address: text, name: networkInterface.Name})
		}
	}
	sort.SliceStable(candidates, func(left, right int) bool {
		return candidates[left].address < candidates[right].address
	})
	return candidates
}

func canLanReachBindHost(host string) bool {
	normalized := normalizeHost(host)
	if normalized == "" {
		return false
	}
	return isWildcardHost(normalized) || isUsableLanIPv4(normalized)
}

func resolvePort(endpoint string, fallback string) int {
	if parsed, err := url.Parse(endpoint); err == nil && parsed.Port() != "" {
		if value, err := strconv.Atoi(parsed.Port()); err == nil && value > 0 && value <= 65535 {
			return value
		}
	}
	if value, err := strconv.Atoi(strings.TrimSpace(fallback)); err == nil && value > 0 && value <= 65535 {
		return value
	}
	return 0
}

func formatEndpoint(protocol string, host string, port int) string {
	if protocol != "https" {
		protocol = "http"
	}
	if port > 0 {
		return protocol + "://" + host + ":" + strconv.Itoa(port)
	}
	return protocol + "://" + host
}

func addWarning(warnings *[]string, value string) {
	trimmed := strings.TrimSpace(value)
	if trimmed == "" {
		return
	}
	for _, existing := range *warnings {
		if existing == trimmed {
			return
		}
	}
	*warnings = append(*warnings, trimmed)
}

func addHint(hints *[]endpointHint, hint endpointHint) {
	hint.Endpoint = strings.TrimRight(strings.TrimSpace(hint.Endpoint), "/")
	if hint.Endpoint == "" {
		return
	}
	for _, existing := range *hints {
		if existing.Endpoint == hint.Endpoint {
			return
		}
	}
	*hints = append(*hints, hint)
}
