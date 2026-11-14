package subaggregator

import (
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/madou1217/ai_home/internal/runtime/platform"
)

const (
	MaxLocalSubscriptionBytes = 2 * 1024 * 1024
	DefaultLockTimeout        = 2000 * time.Millisecond
	DefaultLockStaleAfter     = 30 * time.Second
)

var userAgentPattern = regexp.MustCompile(`^[^\r\n]{1,256}$`)

var retiredDataKeys = []string{
	"routing",
	"dedicatedPorts",
	"network",
	"core",
	"outboundFailover",
	"groups",
	"manualGroups",
	"groupPolicies",
}

// Store 管理 proxy-pool.json 与 subscription-aggregator.json 的并发安全读写与跨进程锁。
type Store struct {
	aiHomeDir string
	poolPath  string
	aggPath   string
	mu        sync.Mutex
}

// NewStore 创建指向指定 aiHomeDir 的存储实例（为空时回退 AIH_HOME_DIR / ~/.ai_home）。
func NewStore(aiHomeDir string) *Store {
	dir := strings.TrimSpace(aiHomeDir)
	if dir == "" {
		if env := strings.TrimSpace(os.Getenv("AIH_HOME_DIR")); env != "" {
			dir = env
		} else {
			home, _ := os.UserHomeDir()
			dir = filepath.Join(home, ".ai_home")
		}
	}
	return &Store{
		aiHomeDir: dir,
		poolPath:  filepath.Join(dir, "proxy-pool.json"),
		aggPath:   filepath.Join(dir, "subscription-aggregator.json"),
	}
}

func (s *Store) AIHomeDir() string { return s.aiHomeDir }

func (s *Store) ensureDir() error {
	return os.MkdirAll(s.aiHomeDir, 0o700)
}

func writeFileAtomic0600(targetPath string, content []byte) error {
	dir := filepath.Dir(targetPath)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	tmp, err := os.CreateTemp(dir, filepath.Base(targetPath)+".tmp-*")
	if err != nil {
		return err
	}
	tmpPath := tmp.Name()
	if _, err := tmp.Write(content); err != nil {
		_ = tmp.Close()
		_ = os.Remove(tmpPath)
		return err
	}
	if err := tmp.Chmod(0o600); err != nil {
		_ = tmp.Close()
		_ = os.Remove(tmpPath)
		return err
	}
	if err := tmp.Close(); err != nil {
		_ = os.Remove(tmpPath)
		return err
	}
	return os.Rename(tmpPath, targetPath)
}

type fileLockInfo struct {
	PID       int   `json:"pid"`
	CreatedAt int64 `json:"createdAt"`
}

func isProcessAlive(pid int) bool {
	return platform.ProcessAlive(pid)
}

func (s *Store) withFileLock(targetPath string, fn func() error) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.ensureDir(); err != nil {
		return err
	}
	lockPath := targetPath + ".lock"
	deadline := time.Now().Add(DefaultLockTimeout)
	for {
		f, err := os.OpenFile(lockPath, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
		if err == nil {
			info, _ := json.Marshal(fileLockInfo{
				PID:       os.Getpid(),
				CreatedAt: time.Now().UnixMilli(),
			})
			_, _ = f.Write(info)
			_ = f.Close()
			defer func() { _ = os.Remove(lockPath) }()
			return fn()
		}
		if !os.IsExist(err) {
			return err
		}
		if raw, rErr := os.ReadFile(lockPath); rErr == nil {
			var info fileLockInfo
			if json.Unmarshal(raw, &info) == nil {
				age := time.Since(time.UnixMilli(info.CreatedAt))
				if age > DefaultLockStaleAfter || !isProcessAlive(info.PID) {
					_ = os.Remove(lockPath)
					continue
				}
			}
		} else if st, sErr := os.Stat(lockPath); sErr == nil && time.Since(st.ModTime()) > DefaultLockStaleAfter {
			_ = os.Remove(lockPath)
			continue
		}
		if !time.Now().Before(deadline) {
			return errInvalid("proxy_store_busy")
		}
		time.Sleep(15 * time.Millisecond)
	}
}

// ReadProxyPool 读取 proxy-pool.json（不存在时返回默认空结构）。
func (s *Store) ReadProxyPool() (ProxyPoolStoreData, error) {
	return s.readProxyPoolUnlocked()
}

func (s *Store) readProxyPoolUnlocked() (ProxyPoolStoreData, error) {
	out := ProxyPoolStoreData{
		Version:       1,
		Subscriptions: []Subscription{},
		Nodes:         []ProxyNode{},
	}
	raw, err := os.ReadFile(s.poolPath)
	if err != nil {
		if os.IsNotExist(err) {
			return out, nil
		}
		return out, err
	}
	var generic map[string]any
	if err := json.Unmarshal(raw, &generic); err != nil {
		return out, err
	}
	for _, retired := range retiredDataKeys {
		delete(generic, retired)
	}
	cleaned, _ := json.Marshal(generic)
	if err := json.Unmarshal(cleaned, &out); err != nil {
		return out, err
	}
	if out.Version == 0 {
		out.Version = 1
	}
	if out.Subscriptions == nil {
		out.Subscriptions = []Subscription{}
	}
	if rawSubs, ok := generic["subscriptions"].([]any); ok {
		for i := range out.Subscriptions {
			if i < len(rawSubs) {
				if m, ok := rawSubs[i].(map[string]any); ok {
					if _, hasEnabled := m["enabled"]; !hasEnabled {
						out.Subscriptions[i].Enabled = true
					}
				}
			}
		}
	}
	if out.Nodes == nil {
		out.Nodes = []ProxyNode{}
	}
	out.Extra = generic
	return out, nil
}

func (s *Store) writeProxyPoolUnlocked(data ProxyPoolStoreData) error {
	base := map[string]any{}
	if data.Extra != nil {
		for k, v := range data.Extra {
			base[k] = v
		}
	}
	for _, retired := range retiredDataKeys {
		delete(base, retired)
	}
	if data.Version == 0 {
		data.Version = 1
	}
	base["version"] = data.Version
	base["subscriptions"] = data.Subscriptions
	base["nodes"] = data.Nodes
	base["updatedAt"] = time.Now().UnixMilli()
	raw, err := json.MarshalIndent(base, "", "  ")
	if err != nil {
		return err
	}
	return writeFileAtomic0600(s.poolPath, append(raw, '\n'))
}

// MutateProxyPool 在锁保护下读写更新 proxy-pool.json。
func (s *Store) MutateProxyPool(fn func(*ProxyPoolStoreData) error) (ProxyPoolStoreData, error) {
	var data ProxyPoolStoreData
	err := s.withFileLock(s.poolPath, func() error {
		var err error
		data, err = s.readProxyPoolUnlocked()
		if err != nil {
			return err
		}
		if err := fn(&data); err != nil {
			return err
		}
		return s.writeProxyPoolUnlocked(data)
	})
	return data, err
}

// ReadAggregatorStore 读取 subscription-aggregator.json。
func (s *Store) ReadAggregatorStore() (AggregatorStoreData, error) {
	return s.readAggregatorStoreUnlocked()
}

func (s *Store) readAggregatorStoreUnlocked() (AggregatorStoreData, error) {
	out := AggregatorStoreData{
		Version:  1,
		Profiles: []AggregatorProfile{},
	}
	raw, err := os.ReadFile(s.aggPath)
	if err != nil {
		if os.IsNotExist(err) {
			return out, nil
		}
		return out, err
	}
	if err := json.Unmarshal(raw, &out); err != nil {
		return out, err
	}
	if out.Version == 0 {
		out.Version = 1
	}
	if out.Profiles == nil {
		out.Profiles = []AggregatorProfile{}
	}
	return out, nil
}

// MutateAggregatorStore 在锁保护下更新 subscription-aggregator.json。
func (s *Store) MutateAggregatorStore(fn func(*AggregatorStoreData) error) (AggregatorStoreData, error) {
	var data AggregatorStoreData
	err := s.withFileLock(s.aggPath, func() error {
		var err error
		data, err = s.readAggregatorStoreUnlocked()
		if err != nil {
			return err
		}
		if err := fn(&data); err != nil {
			return err
		}
		if data.Version == 0 {
			data.Version = 1
		}
		raw, err := json.MarshalIndent(data, "", "  ")
		if err != nil {
			return err
		}
		return writeFileAtomic0600(s.aggPath, append(raw, '\n'))
	})
	return data, err
}

// GenerateProfileToken 生成 32 字节 Base64URL（无填充）随机令牌。
func GenerateProfileToken() string {
	b := make([]byte, 32)
	_, _ = rand.Read(b)
	return base64.RawURLEncoding.EncodeToString(b)
}

// TokenEqual 执行恒定时间令牌比对，防止计时侧信道。
func TokenEqual(a, b string) bool {
	if a == "" || b == "" {
		return false
	}
	return subtle.ConstantTimeCompare([]byte(a), []byte(b)) == 1
}

// GenerateRandomID 生成 prefix_<12hex> 随机标识（与 Node randomBytes(6) 一致）。
func GenerateRandomID(prefix string) string {
	b := make([]byte, 6)
	_, _ = rand.Read(b)
	return fmt.Sprintf("%s_%s", prefix, hex.EncodeToString(b))
}

// DeterministicNodeID 按与 JS generateNodeId 一致的规则计算稳定 node_<12hex>（若节点已有 id 则直接复用）。
func DeterministicNodeID(node ProxyNode, subID string) string {
	if id := strings.TrimSpace(node.Str("id")); id != "" {
		return id
	}
	secret := firstNonEmpty(node.Str("uuid"), node.Str("password"), node.Str("username"))
	port, _ := node.Int("port")
	seed := fmt.Sprintf("%s:%s:%d:%s:%s",
		NormalizeProtocolAlias(node.Str("protocol")),
		node.Str("server"),
		port,
		secret,
		node.Str("name"),
	)
	sum := sha256.Sum256([]byte(seed))
	return "node_" + hex.EncodeToString(sum[:6])
}

// ReconcileSubscriptionNodes 用最新拉取的节点集合原地对账某订阅下的节点（保留既有 ID、chain、latency 等元数据）。
func ReconcileSubscriptionNodes(data *ProxyPoolStoreData, subID string, parsedNodes []ProxyNode, syncedAt int64) int {
	oldByKey := map[string][]ProxyNode{}
	kept := make([]ProxyNode, 0, len(data.Nodes))
	for _, n := range data.Nodes {
		if n.Str("subscriptionId") == subID {
			k := BuildProxyNodeConnectionKey(n)
			oldByKey[k] = append(oldByKey[k], n)
		} else {
			kept = append(kept, n)
		}
	}

	usedOldIDs := map[string]bool{}
	reconciled := make([]ProxyNode, 0, len(parsedNodes))
	for _, rawNode := range parsedNodes {
		node := rawNode.Clone()
		key := BuildProxyNodeConnectionKey(node)
		var matched ProxyNode
		if queue := oldByKey[key]; len(queue) > 0 {
			matched = queue[0]
			oldByKey[key] = queue[1:]
		}
		if matched != nil {
			if oldID := matched.Str("id"); oldID != "" && !usedOldIDs[oldID] {
				node["id"] = oldID
				usedOldIDs[oldID] = true
			}
			if ch := matched.Str("chain"); ch != "" {
				node["chain"] = ch
			}
			if lm, ok := matched["latencyMs"]; ok {
				node["latencyMs"] = lm
			}
			if la, ok := matched["latencyAt"]; ok {
				node["latencyAt"] = la
			}
		}
		if strings.TrimSpace(node.Str("id")) == "" {
			node["id"] = DeterministicNodeID(node, subID)
		}
		node["subscriptionId"] = subID
		reconciled = append(reconciled, node)
	}
	data.Nodes = append(kept, reconciled...)
	for i := range data.Subscriptions {
		if data.Subscriptions[i].ID == subID {
			data.Subscriptions[i].NodeCount = len(reconciled)
			t := syncedAt
			data.Subscriptions[i].LastSyncedAt = &t
			break
		}
	}
	return len(reconciled)
}

// ValidateSubscriptionSourceInput 校验新建或更新订阅源入参。
func ValidateSubscriptionSourceInput(kind, rawURL, content, userAgent string) (cleanKind string, cleanURL *string, cleanContent string, cleanUA *string, err error) {
	k := strings.ToLower(strings.TrimSpace(kind))
	if k == "" {
		if strings.TrimSpace(rawURL) != "" {
			k = "remote"
		} else if strings.TrimSpace(content) != "" {
			k = "local"
		}
	}
	if k == "local" {
		if strings.TrimSpace(content) == "" {
			return "", nil, "", nil, errInvalid("invalid_subscription_content")
		}
		if len(content) > MaxLocalSubscriptionBytes {
			return "", nil, "", nil, errInvalid("subscription_content_too_large")
		}
		return "local", nil, content, nil, nil
	}
	u, err := ValidateSubscriptionURL(rawURL)
	if err != nil {
		return "", nil, "", nil, err
	}
	ua := strings.TrimSpace(userAgent)
	if ua != "" {
		if !userAgentPattern.MatchString(ua) {
			return "", nil, "", nil, errInvalid("invalid_subscription_user_agent")
		}
		uaCopy := ua
		cleanUA = &uaCopy
	}
	urlStr := u.String()
	return "remote", &urlStr, "", cleanUA, nil
}

// ValidateSubscriptionURL 执行基础 URL 合法性校验。
func ValidateSubscriptionURL(raw string) (*url.URL, error) {
	s := strings.TrimSpace(raw)
	if s == "" {
		return nil, errInvalid("invalid_subscription_url")
	}
	if len(s) > 2048 {
		return nil, errInvalid("subscription_url_too_long")
	}
	u, err := url.Parse(s)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Hostname() == "" {
		return nil, errInvalid("invalid_subscription_url")
	}
	if u.User != nil {
		return nil, errInvalid("subscription_url_credentials_not_allowed")
	}
	return u, nil
}

// FormatNodeSummary 返回给列表接口使用的一致节点视图。
func FormatNodeSummary(node ProxyNode, subID string) map[string]any {
	id := DeterministicNodeID(node, subID)
	name := node.Str("name")
	port, _ := node.Int("port")
	out := map[string]any{
		"id":       id,
		"nodeKey":  BuildProxyNodeConnectionKey(node),
		"name":     name,
		"protocol": NormalizeProtocolAlias(node.Str("protocol")),
		"server":   node.Str("server"),
		"port":     port,
		"flag":     DetectFlag(name),
		"link":     EncodeProxyURI(node),
		"chain":    node.Str("chain"),
	}
	if lm, ok := node.Int("latencyMs"); ok {
		out["latencyMs"] = lm
	}
	if la, ok := toInt64(node["latencyAt"]); ok {
		out["latencyAt"] = la
	}
	return out
}

func toInt64(v any) (int64, bool) {
	switch x := v.(type) {
	case int64:
		return x, true
	case int:
		return int64(x), true
	case float64:
		return int64(x), true
	case string:
		iv, err := strconv.ParseInt(strings.TrimSpace(x), 10, 64)
		return iv, err == nil
	}
	return 0, false
}
