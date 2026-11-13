package nativeresources

import (
	"github.com/madou1217/ai_home/core/providers"
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

const (
	maxMCPFrameBytes = 1024 * 1024
	maxMCPDefBytes   = 65536
)

var (
	reMCPName    = regexp.MustCompile(`^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$`)
	reMCPEnvKey  = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_]*$`)
	mcpProtocols = map[string]bool{
		"2024-11-05": true,
		"2025-03-26": true,
		"2025-06-18": true,
		"2025-11-25": true,
	}
)

type mcpConfigAdapter struct {
	format      string
	topKey      string
	isTOML      bool
	supportsCwd bool
}

func newMCPConfigAdapter(format string) (*mcpConfigAdapter, error) {
	switch format {
	case "toml-stdio":
		return &mcpConfigAdapter{format: format, topKey: "mcp_servers", isTOML: true, supportsCwd: true}, nil
	case "json-stdio":
		return &mcpConfigAdapter{format: format, topKey: "mcpServers", supportsCwd: true}, nil
	case "json-command":
		return &mcpConfigAdapter{format: format, topKey: "mcpServers", supportsCwd: true}, nil
	case "json-cline":
		return &mcpConfigAdapter{format: format, topKey: "mcpServers", supportsCwd: true}, nil
	case "json-opencode":
		return &mcpConfigAdapter{format: format, topKey: "mcp", supportsCwd: false}, nil
	default:
		return nil, fail("mcp_config_format_unsupported")
	}
}

func (a *mcpConfigAdapter) encode(server *MCPServerSpec) map[string]any {
	args := append([]string{}, server.Args...)
	if a.format == "json-opencode" {
		cmdList := make([]any, 0, 1+len(args))
		cmdList = append(cmdList, server.Command)
		for _, arg := range args {
			cmdList = append(cmdList, arg)
		}
		m := map[string]any{
			"type":    "local",
			"command": cmdList,
			"enabled": true,
		}
		if len(server.Env) > 0 {
			m["environment"] = cloneStringMapToAny(server.Env)
		}
		return m
	}

	argsAny := make([]any, len(args))
	for i, arg := range args {
		argsAny[i] = arg
	}
	base := map[string]any{
		"command": server.Command,
		"args":    argsAny,
	}
	if len(server.Env) > 0 {
		base["env"] = cloneStringMapToAny(server.Env)
	}
	if server.Cwd != "" {
		base["cwd"] = server.Cwd
	}

	switch a.format {
	case "json-stdio":
		base["type"] = "stdio"
		return base
	case "json-cline":
		return map[string]any{"transport": base}
	default:
		return base
	}
}

func cloneStringMapToAny(in map[string]string) map[string]any {
	out := make(map[string]any, len(in))
	for k, v := range in {
		out[k] = v
	}
	return out
}

func readMCPConfigText(filePath string) (string, error) {
	info, err := lstatMaybe(filePath)
	if err != nil {
		return "", err
	}
	if info == nil {
		return "", nil
	}
	if !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 {
		return "", fail("mcp_config_file_conflict")
	}
	if info.Size() > 4*1024*1024 {
		return "", fail("mcp_config_limit")
	}
	raw, err := os.ReadFile(filePath)
	if err != nil {
		return "", err
	}
	return string(raw), nil
}

func (a *mcpConfigAdapter) read(filePath string) (string, map[string]any, map[string]any, error) {
	text, err := readMCPConfigText(filePath)
	if err != nil {
		return "", nil, nil, err
	}
	var doc map[string]any
	if a.isTOML {
		doc, err = parseSimpleMCPTOML(text)
		if err != nil {
			return "", nil, nil, fail("mcp_config_invalid")
		}
	} else {
		clean := stripJSONCommentsAndTrailingCommas(text)
		if strings.TrimSpace(clean) == "" {
			clean = "{}"
		}
		var parsed any
		if err := json.Unmarshal([]byte(clean), &parsed); err != nil {
			return "", nil, nil, fail("mcp_config_invalid")
		}
		m, ok := parsed.(map[string]any)
		if !ok {
			return "", nil, nil, fail("mcp_config_invalid")
		}
		doc = m
	}

	servers := make(map[string]any)
	if rawSection, exists := doc[a.topKey]; exists && rawSection != nil {
		sec, ok := rawSection.(map[string]any)
		if !ok {
			return "", nil, nil, fail("mcp_config_invalid")
		}
		servers = sec
	}
	return text, doc, servers, nil
}

func (a *mcpConfigAdapter) update(filePath, name string, entry map[string]any, prevEntry map[string]any) error {
	text, doc, servers, err := a.read(filePath)
	if err != nil {
		return err
	}
	current, exists := servers[name]
	if exists {
		if prevEntry == nil {
			return fail("mcp_target_conflict")
		}
		curMap, ok := current.(map[string]any)
		if !ok || !reflect.DeepEqual(normalizeJSONValue(curMap), normalizeJSONValue(prevEntry)) {
			return fail("mcp_target_modified")
		}
	}
	if !exists && entry == nil {
		return nil
	}
	if exists && entry != nil && reflect.DeepEqual(normalizeJSONValue(current), normalizeJSONValue(entry)) {
		return nil
	}

	var next string
	if a.isTOML {
		start, end, found, spanErr := mcpTOMLSpan(text, name)
		if spanErr != nil {
			return spanErr
		}
		if exists && !found {
			return fail("mcp_target_modified")
		}
		retained := text
		if found {
			retained = text[:start] + text[end:]
		}
		if entry == nil {
			next = retained
		} else {
			sep := ""
			if retained != "" && !strings.HasSuffix(retained, "\n") {
				sep = "\n"
			}
			next = retained + sep + "# aih-mcp:" + name + ":begin\n" + formatMCPTOMLBlock(a.topKey, name, entry) + "# aih-mcp:" + name + ":end\n"
		}
	} else {
		if entry == nil {
			delete(servers, name)
		} else {
			servers[name] = entry
			doc[a.topKey] = servers
		}
		encoded, err := json.MarshalIndent(doc, "", "  ")
		if err != nil {
			return err
		}
		next = string(encoded) + "\n"
	}

	if next != text {
		return atomicWriteFile(filePath, []byte(next), 0o600)
	}
	return nil
}

func mcpTOMLSpan(text, name string) (int, int, bool, error) {
	begin := "# aih-mcp:" + name + ":begin"
	end := "# aih-mcp:" + name + ":end"
	start := strings.Index(text, begin)
	finish := strings.Index(text, end)
	if start < 0 && finish < 0 {
		return 0, 0, false, nil
	}
	if start < 0 || finish <= start || strings.Contains(text[start+len(begin):], begin) || strings.Contains(text[finish+len(end):], end) {
		return 0, 0, false, fail("mcp_config_marker_invalid")
	}
	endPos := finish + len(end)
	if endPos < len(text) && text[endPos] == '\n' {
		endPos++
	}
	return start, endPos, true, nil
}

func formatMCPTOMLBlock(topKey, name string, entry map[string]any) string {
	var b strings.Builder
	fmt.Fprintf(&b, "[%s.%s]\n", topKey, formatMCPTOMLKey(name))
	if cmd, ok := entry["command"].(string); ok {
		fmt.Fprintf(&b, "command = %q\n", cmd)
	}
	if args, ok := entry["args"].([]any); ok {
		quoted := make([]string, len(args))
		for i, a := range args {
			quoted[i] = fmt.Sprintf("%q", fmt.Sprint(a))
		}
		fmt.Fprintf(&b, "args = [%s]\n", strings.Join(quoted, ", "))
	}
	if cwd, ok := entry["cwd"].(string); ok && cwd != "" {
		fmt.Fprintf(&b, "cwd = %q\n", cwd)
	}
	if envMap, ok := entry["env"].(map[string]any); ok && len(envMap) > 0 {
		fmt.Fprintf(&b, "\n[%s.%s.env]\n", topKey, formatMCPTOMLKey(name))
		keys := make([]string, 0, len(envMap))
		for k := range envMap {
			keys = append(keys, k)
		}
		sort.Strings(keys)
		for _, k := range keys {
			fmt.Fprintf(&b, "%s = %q\n", formatMCPTOMLKey(k), fmt.Sprint(envMap[k]))
		}
	}
	return b.String()
}

func formatMCPTOMLKey(k string) string {
	if k != "" && reMCPEnvKey.MatchString(k) {
		return k
	}
	return strconv.Quote(k)
}

func parseSimpleMCPTOML(text string) (map[string]any, error) {
	doc := make(map[string]any)
	if strings.TrimSpace(text) == "" {
		return doc, nil
	}
	current := doc
	for _, rawLine := range strings.Split(text, "\n") {
		line := strings.TrimSpace(stripTOMLLineComment(rawLine))
		if line == "" {
			continue
		}
		if strings.HasPrefix(line, "[[") && strings.HasSuffix(line, "]]") {
			// Skip array tables in MCP inspection unless needed
			current = make(map[string]any)
			continue
		}
		if strings.HasPrefix(line, "[") && strings.HasSuffix(line, "]") {
			inner := strings.TrimSpace(line[1 : len(line)-1])
			parts := splitTOMLDottedKey(inner)
			if len(parts) == 0 {
				return nil, fmt.Errorf("bad table")
			}
			curr := doc
			for _, part := range parts {
				next, ok := curr[part].(map[string]any)
				if !ok {
					next = make(map[string]any)
					curr[part] = next
				}
				curr = next
			}
			current = curr
			continue
		}
		eq := strings.IndexByte(line, '=')
		if eq <= 0 {
			return nil, fmt.Errorf("missing =")
		}
		key := unquoteKey(strings.TrimSpace(line[:eq]))
		valRaw := strings.TrimSpace(line[eq+1:])
		val, err := parseTOMLInlineVal(valRaw)
		if err != nil {
			return nil, err
		}
		current[key] = val
	}
	return doc, nil
}

func stripTOMLLineComment(s string) string {
	inQ, inSq := false, false
	for i := 0; i < len(s); i++ {
		c := s[i]
		if c == '"' && !inSq && (i == 0 || s[i-1] != '\\') {
			inQ = !inQ
		} else if c == '\'' && !inQ {
			inSq = !inSq
		} else if c == '#' && !inQ && !inSq {
			return s[:i]
		}
	}
	return s
}

func splitTOMLDottedKey(s string) []string {
	var parts []string
	var buf strings.Builder
	inQ := false
	for i := 0; i < len(s); i++ {
		c := s[i]
		if c == '"' && (i == 0 || s[i-1] != '\\') {
			inQ = !inQ
			continue
		}
		if c == '.' && !inQ {
			parts = append(parts, strings.TrimSpace(buf.String()))
			buf.Reset()
			continue
		}
		buf.WriteByte(c)
	}
	if tail := strings.TrimSpace(buf.String()); tail != "" {
		parts = append(parts, tail)
	}
	return parts
}

func unquoteKey(k string) string {
	if len(k) >= 2 && k[0] == '"' && k[len(k)-1] == '"' {
		if u, err := strconv.Unquote(k); err == nil {
			return u
		}
	}
	if len(k) >= 2 && k[0] == '\'' && k[len(k)-1] == '\'' {
		return k[1 : len(k)-1]
	}
	return k
}

func parseTOMLInlineVal(raw string) (any, error) {
	if raw == "true" {
		return true, nil
	}
	if raw == "false" {
		return false, nil
	}
	if strings.HasPrefix(raw, `"`) {
		return strconv.Unquote(raw)
	}
	if strings.HasPrefix(raw, `'`) && strings.HasSuffix(raw, `'`) && len(raw) >= 2 {
		return raw[1 : len(raw)-1], nil
	}
	if strings.HasPrefix(raw, "[") && strings.HasSuffix(raw, "]") {
		inner := strings.TrimSpace(raw[1 : len(raw)-1])
		if inner == "" {
			return []any{}, nil
		}
		var out []any
		for _, part := range splitTopCommas(inner) {
			v, err := parseTOMLInlineVal(strings.TrimSpace(part))
			if err != nil {
				return nil, err
			}
			out = append(out, v)
		}
		return out, nil
	}
	if strings.HasPrefix(raw, "{") && strings.HasSuffix(raw, "}") {
		inner := strings.TrimSpace(raw[1 : len(raw)-1])
		out := make(map[string]any)
		if inner == "" {
			return out, nil
		}
		for _, part := range splitTopCommas(inner) {
			eq := strings.IndexByte(part, '=')
			if eq <= 0 {
				return nil, fmt.Errorf("bad inline table")
			}
			k := unquoteKey(strings.TrimSpace(part[:eq]))
			v, err := parseTOMLInlineVal(strings.TrimSpace(part[eq+1:]))
			if err != nil {
				return nil, err
			}
			out[k] = v
		}
		return out, nil
	}
	if i, err := strconv.ParseInt(raw, 10, 64); err == nil {
		return i, nil
	}
	if f, err := strconv.ParseFloat(raw, 64); err == nil {
		return f, nil
	}
	return nil, fmt.Errorf("invalid toml value: %s", raw)
}

func splitTopCommas(s string) []string {
	var parts []string
	depth := 0
	inQ := false
	start := 0
	for i := 0; i < len(s); i++ {
		c := s[i]
		if c == '"' && (i == 0 || s[i-1] != '\\') {
			inQ = !inQ
		} else if !inQ {
			switch c {
			case '[', '{':
				depth++
			case ']', '}':
				depth--
			case ',':
				if depth == 0 {
					parts = append(parts, s[start:i])
					start = i + 1
				}
			}
		}
	}
	if tail := strings.TrimSpace(s[start:]); tail != "" {
		parts = append(parts, tail)
	}
	return parts
}

func stripJSONCommentsAndTrailingCommas(src string) string {
	var out strings.Builder
	i, n := 0, len(src)
	for i < n {
		c := src[i]
		if c == '"' {
			out.WriteByte(c)
			i++
			for i < n {
				ch := src[i]
				out.WriteByte(ch)
				i++
				if ch == '\\' && i < n {
					out.WriteByte(src[i])
					i++
					continue
				}
				if ch == '"' {
					break
				}
			}
			continue
		}
		if c == '/' && i+1 < n && src[i+1] == '/' {
			i += 2
			for i < n && src[i] != '\n' {
				i++
			}
			continue
		}
		if c == '/' && i+1 < n && src[i+1] == '*' {
			i += 2
			for i+1 < n && !(src[i] == '*' && src[i+1] == '/') {
				i++
			}
			if i+1 < n {
				i += 2
			} else {
				i = n
			}
			continue
		}
		if c == ',' {
			j := i + 1
			for j < n {
				if src[j] == ' ' || src[j] == '\t' || src[j] == '\r' || src[j] == '\n' {
					j++
					continue
				}
				if src[j] == '/' && j+1 < n && src[j+1] == '/' {
					j += 2
					for j < n && src[j] != '\n' {
						j++
					}
					continue
				}
				if src[j] == '/' && j+1 < n && src[j+1] == '*' {
					j += 2
					for j+1 < n && !(src[j] == '*' && src[j+1] == '/') {
						j++
					}
					if j+1 < n {
						j += 2
					}
					continue
				}
				break
			}
			if j < n && (src[j] == '}' || src[j] == ']') {
				i++
				continue
			}
		}
		out.WriteByte(c)
		i++
	}
	return out.String()
}

func normalizeJSONValue(v any) any {
	b, _ := json.Marshal(v)
	var out any
	_ = json.Unmarshal(b, &out)
	return out
}

// PublicMCPRecord 是返回给 WebUI 的安全 MCP 视图（屏蔽 env 值、命令参数详情）。
type PublicMCPRecord struct {
	Kind        string   `json:"kind"`
	ID          string   `json:"id"`
	Provider    string   `json:"provider"`
	Scope       string   `json:"scope"`
	Command     string   `json:"command"`
	ArgCount    int      `json:"argCount"`
	EnvKeys     []string `json:"envKeys"`
	Enabled     bool     `json:"enabled"`
	Removed     bool     `json:"removed,omitempty"`
	Projections []string `json:"projections"`
	CreatedAt   int64    `json:"createdAt"`
	UpdatedAt   int64    `json:"updatedAt"`
}

func toPublicMCPRecord(rec ManagedRecord) PublicMCPRecord {
	var cmd string
	var argCount int
	envKeys := []string{}
	if rec.Server != nil {
		cmd = rec.Server.Command
		argCount = len(rec.Server.Args)
		for k := range rec.Server.Env {
			envKeys = append(envKeys, k)
		}
		sort.Strings(envKeys)
	}
	projs := append([]string{}, rec.Projections...)
	return PublicMCPRecord{
		Kind:        "mcp",
		ID:          rec.ID,
		Provider:    rec.Provider,
		Scope:       rec.Scope,
		Command:     cmd,
		ArgCount:    argCount,
		EnvKeys:     envKeys,
		Enabled:     rec.Enabled,
		Removed:     rec.Removed,
		Projections: projs,
		CreatedAt:   rec.CreatedAt,
		UpdatedAt:   rec.UpdatedAt,
	}
}

type mcpManager struct {
	aiHomeDir   string
	hostHomeDir string
	registry    map[string]ResourceCapability
	store       *managedStore
}

func newMCPManager(aiHomeDir, hostHomeDir string, registry map[string]ResourceCapability) (*mcpManager, error) {
	if strings.TrimSpace(aiHomeDir) == "" || strings.TrimSpace(hostHomeDir) == "" {
		return nil, fail("mcp_home_required")
	}
	store, err := newManagedStore(aiHomeDir)
	if err != nil {
		return nil, err
	}
	return &mcpManager{
		aiHomeDir:   aiHomeDir,
		hostHomeDir: hostHomeDir,
		registry:    registry,
		store:       store,
	}, nil
}

func validateMCPName(name string) error {
	if !reMCPName.MatchString(name) || name == "constructor" || name == "prototype" {
		return fail("mcp_name_invalid")
	}
	return nil
}

func normalizeMCPServer(in MCPServerSpec) (*MCPServerSpec, error) {
	if strings.TrimSpace(in.Command) == "" || strings.ContainsRune(in.Command, '\x00') {
		return nil, fail("mcp_command_required")
	}
	args := make([]string, len(in.Args))
	for i, arg := range in.Args {
		if strings.ContainsRune(arg, '\x00') {
			return nil, fail("mcp_args_invalid")
		}
		args[i] = arg
	}
	if in.Cwd != "" && !filepath.IsAbs(in.Cwd) {
		return nil, fail("mcp_cwd_invalid")
	}
	var cleanEnv map[string]string
	if len(in.Env) > 0 {
		cleanEnv = make(map[string]string, len(in.Env))
		for k, v := range in.Env {
			if !reMCPEnvKey.MatchString(k) || strings.ContainsRune(v, '\x00') {
				return nil, fail("mcp_env_invalid")
			}
			cleanEnv[k] = v
		}
	}
	out := &MCPServerSpec{
		Command: in.Command,
		Args:    args,
		Cwd:     in.Cwd,
		Env:     cleanEnv,
	}
	raw, _ := json.Marshal(out)
	if len(raw) > maxMCPDefBytes {
		return nil, fail("mcp_definition_limit")
	}
	return out, nil
}

func (m *mcpManager) boundary(provider string) (*providers.NativeMCPProjection, *mcpConfigAdapter, error) {
	capVal, ok := m.registry[strings.ToLower(strings.TrimSpace(provider))]
	if !ok || capVal.Projection == nil {
		return nil, nil, fail("mcp_provider_unsupported")
	}
	adapter, err := newMCPConfigAdapter(capVal.Projection.Format)
	if err != nil {
		return nil, nil, err
	}
	return capVal.Projection, adapter, nil
}

func (m *mcpManager) targetFile(provider, home string) (string, error) {
	proj, _, err := m.boundary(provider)
	if err != nil {
		return "", err
	}
	root := resolveProjectionRoot(home, provider, proj.PathBase)
	if root == "" || filepath.IsAbs(proj.Path) || strings.Contains(proj.Path, "..") {
		return "", fail("mcp_projection_path_invalid")
	}
	rels := append([]string{proj.Path}, proj.Alternatives...)
	var candidates []string
	for _, rel := range rels {
		p := filepath.Join(root, rel)
		candidates = append(candidates, p)
		if _, statErr := os.Stat(p); statErr == nil {
			return p, nil
		}
	}
	return candidates[0], nil
}

func (m *mcpManager) list(ctx context.Context, provider string) ([]PublicMCPRecord, error) {
	st, err := m.store.get(ctx)
	if err != nil {
		return nil, err
	}
	out := make([]PublicMCPRecord, 0)
	for _, rec := range st.Resources {
		if rec.Kind == "mcp" && (provider == "" || rec.Provider == provider) {
			out = append(out, toPublicMCPRecord(rec))
		}
	}
	return out, nil
}

func (m *mcpManager) add(ctx context.Context, name string, input MCPServerSpec, provider string) (PublicMCPRecord, error) {
	if err := validateMCPName(name); err != nil {
		return PublicMCPRecord{}, err
	}
	_, adapter, err := m.boundary(provider)
	if err != nil {
		return PublicMCPRecord{}, err
	}
	server, err := normalizeMCPServer(input)
	if err != nil {
		return PublicMCPRecord{}, err
	}
	if server.Cwd != "" && !adapter.supportsCwd {
		return PublicMCPRecord{}, fail("mcp_cwd_unsupported")
	}

	res, err := m.store.update(ctx, func(st *ManagedState) (any, error) {
		for _, rec := range st.Resources {
			if rec.Kind == "mcp" && rec.ID == name && rec.Provider == provider {
				if !reflect.DeepEqual(normalizeJSONValue(server), normalizeJSONValue(rec.Server)) {
					return nil, fail("mcp_definition_conflict")
				}
				return toPublicMCPRecord(rec), nil
			}
		}
		now := time.Now().UnixMilli()
		rec := ManagedRecord{
			Kind:        "mcp",
			ID:          name,
			Provider:    provider,
			Scope:       "host",
			Server:      server,
			Enabled:     false,
			Projections: []string{},
			CreatedAt:   now,
			UpdatedAt:   now,
		}
		st.Resources = append(st.Resources, rec)
		return toPublicMCPRecord(rec), nil
	})
	if err != nil {
		return PublicMCPRecord{}, err
	}
	return res.(PublicMCPRecord), nil
}

func (m *mcpManager) change(ctx context.Context, name, provider, action string) (PublicMCPRecord, error) {
	if err := validateMCPName(name); err != nil {
		return PublicMCPRecord{}, err
	}
	_, adapter, err := m.boundary(provider)
	if err != nil {
		return PublicMCPRecord{}, err
	}
	tFile, err := m.targetFile(provider, m.hostHomeDir)
	if err != nil {
		return PublicMCPRecord{}, err
	}

	res, err := m.store.update(ctx, func(st *ManagedState) (any, error) {
		idx := -1
		for i, rec := range st.Resources {
			if rec.Kind == "mcp" && rec.ID == name && rec.Provider == provider {
				idx = i
				break
			}
		}
		if idx < 0 {
			return nil, fail("mcp_not_installed")
		}
		rec := &st.Resources[idx]
		entry := adapter.encode(rec.Server)
		projSet := make(map[string]bool, len(rec.Projections))
		var targets []string
		addTarget := func(p string) {
			if !projSet[p] {
				targets = append(targets, p)
			}
		}
		for _, p := range rec.Projections {
			projSet[p] = true
			targets = append(targets, p)
		}
		if action == "enable" {
			addTarget(tFile)
		}
		for _, file := range targets {
			var prev map[string]any
			if projSet[file] {
				prev = entry
			}
			var next map[string]any
			if action == "enable" {
				next = entry
			}
			if err := adapter.update(file, name, next, prev); err != nil {
				return nil, err
			}
		}
		enabled := action == "enable"
		removed := action == "remove"
		outRec := *rec
		outRec.Enabled = enabled
		outRec.Removed = removed
		if removed {
			st.Resources = append(st.Resources[:idx], st.Resources[idx+1:]...)
		} else if rec.Enabled != enabled || (enabled && !projSet[tFile]) {
			rec.Enabled = enabled
			rec.UpdatedAt = time.Now().UnixMilli()
			if enabled {
				all := append([]string{}, targets...)
				rec.Projections = all
				outRec.Projections = all
			}
		}
		return toPublicMCPRecord(outRec), nil
	})
	if err != nil {
		return PublicMCPRecord{}, err
	}
	return res.(PublicMCPRecord), nil
}

func (m *mcpManager) findRecord(ctx context.Context, name, provider string) (*ManagedRecord, error) {
	if err := validateMCPName(name); err != nil {
		return nil, err
	}
	if _, _, err := m.boundary(provider); err != nil {
		return nil, err
	}
	st, err := m.store.get(ctx)
	if err != nil {
		return nil, err
	}
	for _, rec := range st.Resources {
		if rec.Kind == "mcp" && rec.ID == name && rec.Provider == provider {
			cp := rec
			return &cp, nil
		}
	}
	return nil, fail("mcp_not_installed")
}

func (m *mcpManager) test(ctx context.Context, name, provider string) (map[string]any, error) {
	rec, err := m.findRecord(ctx, name, provider)
	if err != nil {
		return nil, err
	}
	client, err := dialMCPStdio(ctx, rec.Server)
	if err != nil {
		return nil, err
	}
	defer client.close()

	initRes, err := client.initialize(ctx)
	if err != nil {
		return nil, err
	}
	tools, err := client.listTools(ctx)
	if err != nil {
		return nil, err
	}
	toolNames := make([]string, 0, len(tools))
	for _, t := range tools {
		if tName, ok := t["name"].(string); ok {
			toolNames = append(toolNames, tName)
		}
	}
	return map[string]any{
		"ok":              true,
		"serverInfo":      initRes["serverInfo"],
		"protocolVersion": initRes["protocolVersion"],
		"tools":           toolNames,
	}, nil
}

func (m *mcpManager) tools(ctx context.Context, name, provider string) ([]map[string]any, error) {
	rec, err := m.findRecord(ctx, name, provider)
	if err != nil {
		return nil, err
	}
	client, err := dialMCPStdio(ctx, rec.Server)
	if err != nil {
		return nil, err
	}
	defer client.close()
	return client.listTools(ctx)
}

func (m *mcpManager) call(ctx context.Context, name, provider, tool string, args map[string]any) (map[string]any, error) {
	rec, err := m.findRecord(ctx, name, provider)
	if err != nil {
		return nil, err
	}
	client, err := dialMCPStdio(ctx, rec.Server)
	if err != nil {
		return nil, err
	}
	defer client.close()
	return client.callTool(ctx, tool, args)
}

// ---------- JSON-RPC 2.0 MCP Stdio 客户端 ----------

type mcpStdioClient struct {
	cmd         *exec.Cmd
	stdin       *os.File
	stdinWriter interface {
		Write([]byte) (int, error)
		Close() error
	}
	mu          sync.Mutex
	nextID      int64
	pending     map[int64]chan rpcResp
	failure     error
	closed      bool
	initialized map[string]any
}

type rpcResp struct {
	result any
	err    error
}

func dialMCPStdio(ctx context.Context, server *MCPServerSpec) (*mcpStdioClient, error) {
	if server == nil || strings.TrimSpace(server.Command) == "" {
		return nil, fail("mcp_command_required")
	}
	envList := make([]string, 0, 12+len(server.Env))
	for _, key := range []string{"PATH", "HOME", "USERPROFILE", "SystemRoot", "WINDIR", "TEMP", "TMP", "LANG", "LC_ALL"} {
		if val, ok := os.LookupEnv(key); ok {
			envList = append(envList, key+"="+val)
		}
	}
	for k, v := range server.Env {
		envList = append(envList, k+"="+v)
	}
	cmd := exec.CommandContext(ctx, server.Command, server.Args...)
	cmd.Dir = server.Cwd
	cmd.Env = envList

	stdinPipe, err := cmd.StdinPipe()
	if err != nil {
		return nil, fail("mcp_spawn_failed")
	}
	stdoutPipe, err := cmd.StdoutPipe()
	if err != nil {
		return nil, fail("mcp_spawn_failed")
	}
	cmd.Stderr = nil // 子进程诊断可能带敏感环境变量，刻意丢弃。

	if err := cmd.Start(); err != nil {
		return nil, fail("mcp_spawn_failed")
	}

	c := &mcpStdioClient{
		cmd:         cmd,
		stdinWriter: stdinPipe,
		pending:     make(map[int64]chan rpcResp),
	}

	go func() {
		scanner := bufio.NewScanner(stdoutPipe)
		scanner.Buffer(make([]byte, 4096), maxMCPFrameBytes)
		for scanner.Scan() {
			line := strings.TrimSpace(scanner.Text())
			if line == "" {
				continue
			}
			var msg map[string]any
			if err := json.Unmarshal([]byte(line), &msg); err != nil || msg == nil || msg["jsonrpc"] != "2.0" {
				c.stop(fail("mcp_response_invalid"))
				return
			}
			if method, ok := msg["method"].(string); ok {
				if id, hasID := msg["id"]; hasID && id != nil {
					if method == "ping" {
						_ = c.writeFrame(map[string]any{"jsonrpc": "2.0", "id": id, "result": map[string]any{}})
					} else {
						_ = c.writeFrame(map[string]any{"jsonrpc": "2.0", "id": id, "error": map[string]any{"code": -32601, "message": "Method not supported"}})
					}
				}
				continue
			}
			idFloat, ok := msg["id"].(float64)
			if !ok {
				c.stop(fail("mcp_response_id_mismatch"))
				return
			}
			id := int64(idFloat)
			c.mu.Lock()
			ch, found := c.pending[id]
			if found {
				delete(c.pending, id)
			}
			c.mu.Unlock()
			if !found {
				c.stop(fail("mcp_response_id_mismatch"))
				return
			}
			_, hasErr := msg["error"]
			_, hasRes := msg["result"]
			if hasErr == hasRes {
				ch <- rpcResp{err: fail("mcp_response_invalid")}
				c.stop(fail("mcp_response_invalid"))
				return
			}
			if hasErr {
				ch <- rpcResp{err: fail("mcp_remote_error")}
			} else {
				ch <- rpcResp{result: msg["result"]}
			}
		}
		if err := scanner.Err(); err != nil && errors.Is(err, bufio.ErrTooLong) {
			c.stop(fail("mcp_response_limit"))
			return
		}
		c.stop(fail("mcp_stdio_closed"))
	}()

	return c, nil
}

func (c *mcpStdioClient) writeFrame(msg any) error {
	frame, err := json.Marshal(msg)
	if err != nil {
		return err
	}
	frame = append(frame, '\n')
	if len(frame) > maxMCPFrameBytes {
		return fail("mcp_request_limit")
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.closed {
		return fail("mcp_stdio_closed")
	}
	_, err = c.stdinWriter.Write(frame)
	if err != nil {
		return fail("mcp_stdio_closed")
	}
	return nil
}

func (c *mcpStdioClient) request(ctx context.Context, method string, params any) (any, error) {
	c.mu.Lock()
	if c.failure != nil || c.closed {
		err := c.failure
		if err == nil {
			err = fail("mcp_stdio_closed")
		}
		c.mu.Unlock()
		return nil, err
	}
	c.nextID++
	reqID := c.nextID
	ch := make(chan rpcResp, 1)
	c.pending[reqID] = ch
	c.mu.Unlock()

	if err := c.writeFrame(map[string]any{"jsonrpc": "2.0", "id": reqID, "method": method, "params": params}); err != nil {
		c.stop(err)
		return nil, err
	}
	timer := time.NewTimer(5 * time.Second)
	defer timer.Stop()
	select {
	case resp := <-ch:
		return resp.result, resp.err
	case <-timer.C:
		c.stop(fail("mcp_request_timeout"))
		return nil, fail("mcp_request_timeout")
	case <-ctx.Done():
		c.stop(fail("mcp_cancelled"))
		return nil, fail("mcp_cancelled")
	}
}

func (c *mcpStdioClient) initialize(ctx context.Context) (map[string]any, error) {
	if c.initialized != nil {
		return c.initialized, nil
	}
	raw, err := c.request(ctx, "initialize", map[string]any{
		"protocolVersion": "2025-03-26",
		"capabilities":    map[string]any{},
		"clientInfo":      map[string]any{"name": "aih-mcp-manager", "version": "1.0.0"},
	})
	if err != nil {
		return nil, err
	}
	resMap, ok := raw.(map[string]any)
	if !ok {
		return nil, fail("mcp_initialize_invalid")
	}
	ver, _ := resMap["protocolVersion"].(string)
	info, _ := resMap["serverInfo"].(map[string]any)
	srvName, _ := info["name"].(string)
	if !mcpProtocols[ver] || srvName == "" {
		return nil, fail("mcp_initialize_invalid")
	}
	if err := c.writeFrame(map[string]any{"jsonrpc": "2.0", "method": "notifications/initialized"}); err != nil {
		return nil, err
	}
	c.initialized = resMap
	return resMap, nil
}

func (c *mcpStdioClient) listTools(ctx context.Context) ([]map[string]any, error) {
	if _, err := c.initialize(ctx); err != nil {
		return nil, err
	}
	tools := make([]map[string]any, 0)
	seenNames := make(map[string]bool)
	cursors := make(map[string]bool)
	var cursor string
	for {
		params := map[string]any{}
		if cursor != "" {
			params["cursor"] = cursor
		}
		raw, err := c.request(ctx, "tools/list", params)
		if err != nil {
			return nil, err
		}
		resMap, ok := raw.(map[string]any)
		if !ok {
			return nil, fail("mcp_tools_invalid")
		}
		rawList, ok := resMap["tools"].([]any)
		if !ok {
			return nil, fail("mcp_tools_invalid")
		}
		for _, item := range rawList {
			toolMap, ok := item.(map[string]any)
			if !ok {
				return nil, fail("mcp_tools_invalid")
			}
			tName, _ := toolMap["name"].(string)
			schema, _ := toolMap["inputSchema"].(map[string]any)
			schemaType, _ := schema["type"].(string)
			if tName == "" || len(tName) > 128 || schemaType != "object" || seenNames[tName] {
				return nil, fail("mcp_tools_invalid")
			}
			seenNames[tName] = true
			tools = append(tools, toolMap)
		}
		if len(tools) > 256 || len(cursors) >= 20 {
			return nil, fail("mcp_tools_limit")
		}
		nextCursorRaw, exists := resMap["nextCursor"]
		if !exists || nextCursorRaw == nil {
			break
		}
		nextCursor, ok := nextCursorRaw.(string)
		if !ok || nextCursor == "" || cursors[nextCursor] {
			return nil, fail("mcp_tools_cursor_invalid")
		}
		cursors[nextCursor] = true
		cursor = nextCursor
	}
	return tools, nil
}

func (c *mcpStdioClient) callTool(ctx context.Context, tool string, args map[string]any) (map[string]any, error) {
	if _, err := c.initialize(ctx); err != nil {
		return nil, err
	}
	if strings.TrimSpace(tool) == "" || args == nil {
		return nil, fail("mcp_tool_arguments_invalid")
	}
	raw, err := c.request(ctx, "tools/call", map[string]any{"name": tool, "arguments": args})
	if err != nil {
		return nil, err
	}
	resMap, ok := raw.(map[string]any)
	if !ok {
		return nil, fail("mcp_tool_result_invalid")
	}
	if _, ok := resMap["content"].([]any); !ok {
		return nil, fail("mcp_tool_result_invalid")
	}
	return resMap, nil
}

func (c *mcpStdioClient) stop(reason error) {
	c.mu.Lock()
	if c.closed {
		c.mu.Unlock()
		return
	}
	c.closed = true
	if c.failure == nil {
		c.failure = reason
	}
	pending := c.pending
	c.pending = make(map[int64]chan rpcResp)
	c.mu.Unlock()

	for _, ch := range pending {
		ch <- rpcResp{err: reason}
	}
	_ = c.stdinWriter.Close()
	if c.cmd.Process != nil {
		_ = c.cmd.Process.Kill()
	}
	_ = c.cmd.Wait()
}

func (c *mcpStdioClient) close() {
	c.stop(fail("mcp_stdio_closed"))
}
