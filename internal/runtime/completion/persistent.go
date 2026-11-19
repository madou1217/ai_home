package completion

import (
	"encoding/json"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"

	"github.com/madou1217/ai_home/internal/runtime/peer"
	"github.com/madou1217/ai_home/internal/runtime/persistent"
	"github.com/madou1217/ai_home/internal/runtime/platform"
	"github.com/madou1217/ai_home/internal/runtime/sessionactivity"
)

var (
	claudeSessionFilePattern  = regexp.MustCompile(`^\d+\.json$`)
	safeEntryKeyPattern       = regexp.MustCompile(`^[A-Za-z0-9._-]+$`)
	registryAccountRefPattern = regexp.MustCompile(`^acct_[a-f0-9]{20}$`)
)

func basenameOf(value string) string {
	text := strings.TrimSpace(value)
	text = strings.TrimRight(text, "/\\")
	if text == "" {
		return ""
	}
	return filepath.Base(text)
}

func trimTrailingSlashes(value string) string {
	return strings.TrimRight(value, "/")
}

// listPersistentSessionNames 读取持久会话注册表与标题缓存（不探测 tmux）。
func listPersistentSessionNames(environment Environment, aiHome, hostHome, cwd string) []persistentChoice {
	if strings.TrimSpace(aiHome) == "" {
		return nil
	}
	entries := sessionactivity.ListPersistentRegistryEntries(aiHome)
	titlesByProvider := make(map[string]map[string]string)
	titleOf := func(provider, sessionID string) string {
		if provider == "" || sessionID == "" {
			return ""
		}
		titles, exists := titlesByProvider[provider]
		if !exists {
			titles = make(map[string]string)
			for _, session := range listProviderSessions(environment, aiHome, hostHome, provider, "", "", 50) {
				titles[session.ID] = session.Title
			}
			titlesByProvider[provider] = titles
		}
		return strings.TrimSpace(titles[sessionID])
	}
	cachedByName := make(map[string]persistent.SessionCacheEntry)
	for _, row := range persistent.ReadSessionCache(aiHome, environment.now()) {
		if row.Name != "" {
			cachedByName[row.Name] = row
		}
	}
	normalizedCwd := trimTrailingSlashes(strings.TrimSpace(cwd))
	rows := make([]persistentChoice, 0, len(entries))
	for _, entry := range entries {
		if entry.Session == "" || entry.Unrecoverable != "" {
			continue
		}
		// 与 Node isUsableEntry 对齐：注册表条目必须能定位到文件名与账号作用域。
		if entry.Provider == "" || !safeEntryKeyPattern.MatchString(entry.Socket) || !safeEntryKeyPattern.MatchString(entry.Session) {
			continue
		}
		if entry.Gateway {
			if entry.RuntimeScope != "gateway" || entry.AccountRef != "" {
				continue
			}
		} else if !registryAccountRefPattern.MatchString(entry.AccountRef) || entry.RuntimeScope != entry.AccountRef {
			continue
		}
		provider := strings.TrimSpace(entry.Provider)
		projectPath := strings.TrimSpace(entry.Cwd)
		nativeID := strings.TrimSpace(entry.NativeSessionID)
		nativeTitle := titleOf(provider, nativeID)
		fallback := strings.TrimSpace(entry.Label)
		if fallback == "" {
			fallback = basenameOf(projectPath)
		}
		if fallback == "" {
			fallback = provider
		}
		createdAt := entry.CreatedAtMS
		updatedAt := entry.UpdatedAtMS
		if updatedAt == 0 {
			updatedAt = createdAt
		}
		name := strings.TrimSpace(entry.Session)
		cached, hasCached := cachedByName[name]
		cachedTitle := ""
		if hasCached {
			cachedTitle = strings.TrimSpace(cached.Title)
		}
		title := nativeTitle
		if title == "" {
			title = cachedTitle
		}
		if title == "" {
			title = fallback
		}
		if hasCached && cached.UpdatedAt != 0 {
			updatedAt = cached.UpdatedAt
		}
		if createdAt == 0 && hasCached {
			createdAt = cached.CreatedAt
		}
		if hasCached && provider == "" {
			provider = strings.TrimSpace(cached.Provider)
		}
		rows = append(rows, persistentChoice{
			Name:      name,
			Title:     clipText(title, 60),
			Provider:  provider,
			CreatedAt: createdAt,
			UpdatedAt: updatedAt,
			Here:      normalizedCwd != "" && trimTrailingSlashes(projectPath) == normalizedCwd,
			Live:      hasCached && cached.Live,
			MatchText: strings.TrimSpace(title),
		})
	}
	known := make(map[string]struct{}, len(rows))
	for _, row := range rows {
		known[row.Name] = struct{}{}
	}
	for _, cached := range cachedByName {
		name := strings.TrimSpace(cached.Name)
		if name == "" {
			continue
		}
		if _, exists := known[name]; exists {
			continue
		}
		projectPath := strings.TrimSpace(cached.ProjectPath)
		title := cached.Title
		if strings.TrimSpace(title) == "" {
			title = basenameOf(projectPath)
		}
		if strings.TrimSpace(title) == "" {
			title = strings.TrimSpace(cached.Provider)
		}
		updatedAt := cached.UpdatedAt
		if updatedAt == 0 {
			updatedAt = cached.CreatedAt
		}
		rows = append(rows, persistentChoice{
			Name:      name,
			Title:     clipText(title, 60),
			Provider:  strings.TrimSpace(cached.Provider),
			CreatedAt: cached.CreatedAt,
			UpdatedAt: updatedAt,
			Here:      normalizedCwd != "" && trimTrailingSlashes(projectPath) == normalizedCwd,
			Live:      cached.Live,
			MatchText: strings.TrimSpace(title),
		})
	}
	sort.SliceStable(rows, func(left, right int) bool {
		if rows[left].Here != rows[right].Here {
			return rows[left].Here
		}
		return rows[left].UpdatedAt > rows[right].UpdatedAt
	})
	return rows
}

type claudePeer struct {
	pid    int
	name   string
	cwd    string
	status string
	socket string
	order  int
	config string
}

// listClaudePeers 读取 claude 本机会话登记（只读 JSON + 进程存活检查，不连 socket）。
func listClaudePeers(environment Environment, hostHome, aiHome string) []claudePeer {
	dirs := peer.ListClaudeConfigDirs(hostHome, aiHome, func(name string) string {
		return environment.env(name)
	})
	peers := make([]claudePeer, 0, 16)
	for _, directory := range dirs {
		entries, err := os.ReadDir(filepath.Join(directory, "sessions"))
		if err != nil {
			continue
		}
		for _, entry := range entries {
			if entry.IsDir() || !claudeSessionFilePattern.MatchString(entry.Name()) {
				continue
			}
			raw, err := os.ReadFile(filepath.Join(directory, "sessions", entry.Name()))
			if err != nil {
				continue
			}
			var record struct {
				PID                 int    `json:"pid"`
				Name                string `json:"name"`
				SessionID           string `json:"sessionId"`
				CWD                 string `json:"cwd"`
				Status              string `json:"status"`
				MessagingSocketPath string `json:"messagingSocketPath"`
			}
			if json.Unmarshal(raw, &record) != nil {
				continue
			}
			if record.MessagingSocketPath == "" || record.PID <= 0 {
				continue
			}
			if !platform.ProcessAlive(record.PID) {
				continue
			}
			name := record.Name
			if name == "" {
				name = strconv.Itoa(record.PID)
			}
			peers = append(peers, claudePeer{
				pid:    record.PID,
				name:   name,
				cwd:    record.CWD,
				status: record.Status,
				socket: record.MessagingSocketPath,
				config: directory,
			})
		}
	}
	sort.SliceStable(peers, func(left, right int) bool { return peers[left].pid < peers[right].pid })
	return peers
}

// listPeerCandidates 生成 `aih peer send <TAB>` 的收件人候选。
func listPeerCandidates(environment Environment, hostHome, hostAIHome, cwd string) []peerChoice {
	choices := make([]peerChoice, 0, 24)
	seen := make(map[string]struct{}, 24)
	push := func(value, detail string) {
		name := strings.TrimSpace(value)
		if name == "" {
			return
		}
		if _, exists := seen[name]; exists {
			return
		}
		seen[name] = struct{}{}
		choices = append(choices, peerChoice{Value: name, Detail: detail})
	}
	for _, row := range listPersistentSessionNames(environment, hostAIHome, hostHome, cwd) {
		detail := make([]string, 0, 3)
		for _, part := range []string{strings.TrimSpace(row.Provider), strings.TrimSpace(row.Title)} {
			if part != "" {
				detail = append(detail, part)
			}
		}
		if row.Live {
			detail = append(detail, "● 运行中")
		}
		push(row.Name, strings.Join(detail, " · "))
	}
	for _, item := range listClaudePeers(environment, hostHome, hostAIHome) {
		detail := make([]string, 0, 3)
		for _, part := range []string{"claude", strings.TrimSpace(item.status), strings.TrimSpace(item.cwd)} {
			if part != "" {
				detail = append(detail, part)
			}
		}
		push(item.name, strings.Join(detail, " · "))
	}
	return choices
}

// listPeerMessageCandidates 读取收件箱消息 id（最新在前）。
func listPeerMessageCandidates(environment Environment, hostAIHome string) []peerChoice {
	result, err := peer.ListMessages(hostAIHome, "all", 50)
	if err != nil {
		return nil
	}
	choices := make([]peerChoice, 0, len(result.Messages))
	for _, message := range result.Messages {
		from := strings.TrimSpace(message.From.Name)
		if from == "" {
			from = "-"
		}
		body := message.Body
		body = whitespaceRunsToSpace(body)
		runes := []rune(body)
		if len(runes) > 40 {
			body = string(runes[:40])
		}
		detail := message.State + " · " + from + " · " + body
		choices = append(choices, peerChoice{Value: peer.ShortMessageID(message.ID), Detail: detail})
	}
	return choices
}

var whitespaceRunPattern = regexp.MustCompile(`\s+`)

func whitespaceRunsToSpace(value string) string {
	return whitespaceRunPattern.ReplaceAllString(value, " ")
}
