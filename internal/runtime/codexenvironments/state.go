package codexenvironments

import (
	"context"
	"encoding/json"
	"strings"

	"github.com/madou1217/ai_home/internal/adapters/appstate"
)

// ConnectionsKey 是 SSH 连接事实在 app_kv 里的固定键。
const ConnectionsKey = "ssh_connections"

// SyncFromState 从 AIH 的 ssh_connections 生成环境条目并写入 codexHome。
//
// 只读取连接事实，不拨号：远端是否可达、是否装了 codex 由 Codex 自己在建连时报错，
// 这里不重复判断，避免把"暂时连不上"误判成"不能同步"。
func SyncFromState(ctx context.Context, aiHomeDir, codexHome string, includeLocal bool) (SyncOutcome, error) {
	entries, rejections := EntriesFromState(ctx, aiHomeDir)
	outcome, err := SyncFile(codexHome, entries, includeLocal)
	if err != nil {
		return outcome, err
	}
	outcome.Rejections = rejections
	return outcome, nil
}

// EntriesFromState 读取 ssh_connections 并渲染条目；不可渲染的连接按原顺序返回原因。
func EntriesFromState(ctx context.Context, aiHomeDir string) ([]Entry, []Rejection) {
	connections := readConnections(ctx, aiHomeDir)
	entries := make([]Entry, 0, len(connections))
	rejections := make([]Rejection, 0)
	for _, connection := range connections {
		entry, rejection := BuildEntry(connection)
		if rejection != nil {
			rejections = append(rejections, *rejection)
			continue
		}
		entries = append(entries, entry)
	}
	return entries, rejections
}

// LoadConnectionsForProbe 暴露完整连接事实（含跳板展开），供探测与同步复用。
func LoadConnectionsForProbe(ctx context.Context, aiHomeDir string) []Connection {
	return readConnections(ctx, aiHomeDir)
}

// readConnections 把 app_kv 的连接记录解析成本包的事实子集。
// 解析失败一律当作"没有连接"，由调用方按空集合处理（不写坏已有文件）。
func readConnections(ctx context.Context, aiHomeDir string) []Connection {
	if strings.TrimSpace(aiHomeDir) == "" {
		return nil
	}
	dbPath, err := appstate.DatabasePath(aiHomeDir)
	if err != nil {
		return nil
	}
	raw, found, err := appstate.ReadKV(ctx, dbPath, ConnectionsKey)
	if err != nil || !found || strings.TrimSpace(raw) == "" {
		return nil
	}
	var decoded any
	if err := json.Unmarshal([]byte(raw), &decoded); err != nil {
		return nil
	}
	list, ok := decoded.([]any)
	if !ok {
		return nil
	}
	byID := make(map[string]Connection, len(list))
	for _, item := range list {
		object, ok := item.(map[string]any)
		if !ok {
			continue
		}
		connection := connectionFromRecord(object)
		if connection.ID != "" {
			byID[connection.ID] = connection
		}
	}
	out := make([]Connection, 0, len(list))
	for _, item := range list {
		object, ok := item.(map[string]any)
		if !ok {
			continue
		}
		connection := connectionFromRecord(object)
		if connection.ID == "" {
			continue
		}
		if jump := resolveJump(connection, byID); jump != nil {
			connection.Jump = jump
		}
		out = append(out, connection)
	}
	return out
}

// resolveJump 展开出口连接链；成环或断链时返回 nil（该连接会被判为不可渲染）。
func resolveJump(connection Connection, byID map[string]Connection) *Connection {
	if strings.TrimSpace(connection.EgressConnectionID) == "" {
		return nil
	}
	seen := map[string]bool{connection.ID: true}
	// chain[0] 是最外层的跳板，依次向内。
	var chain []Connection
	current := connection
	for depth := 0; depth < maxJumpDepth; depth++ {
		egress := strings.TrimSpace(current.EgressConnectionID)
		if egress == "" {
			break
		}
		if seen[egress] {
			return nil
		}
		next, ok := byID[egress]
		if !ok {
			return nil
		}
		seen[egress] = true
		chain = append(chain, next)
		current = next
	}
	if len(chain) == 0 {
		return nil
	}
	// 由内向外组装：最后一跳的 Jump 为空。
	var head *Connection
	for i := len(chain) - 1; i >= 0; i-- {
		hop := chain[i]
		hop.Jump = head
		copied := hop
		head = &copied
	}
	return head
}

func connectionFromRecord(object map[string]any) Connection {
	return Connection{
		ID:                 recordField(object, "id"),
		Label:              recordField(object, "label"),
		Host:               recordField(object, "host"),
		User:               recordField(object, "user"),
		Port:               recordInt(object, "port"),
		AuthType:           recordField(object, "authType"),
		IdentityFile:       recordField(object, "identityFile"),
		Password:           recordRawField(object, "password"),
		PrivateKey:         recordRawField(object, "privateKey"),
		EgressConnectionID: recordField(object, "egressConnectionId"),
		HasReverseTunnel:   recordReverseTunnel(object),
	}
}

func recordField(object map[string]any, key string) string {
	value, _ := object[key].(string)
	return strings.TrimSpace(value)
}

// recordRawField 保留原始空白：密码和私钥内容不能被 TrimSpace 改掉。
func recordRawField(object map[string]any, key string) string {
	value, _ := object[key].(string)
	return value
}

func recordInt(object map[string]any, key string) int {
	switch value := object[key].(type) {
	case float64:
		return int(value)
	case int:
		return value
	case int64:
		return int(value)
	default:
		return 0
	}
}

func recordReverseTunnel(object map[string]any) bool {
	tunnel, ok := object["reverseTunnel"].(map[string]any)
	if !ok || len(tunnel) == 0 {
		return false
	}
	enabled, hasEnabled := tunnel["enabled"].(bool)
	return !hasEnabled || enabled
}
