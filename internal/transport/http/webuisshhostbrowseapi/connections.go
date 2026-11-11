package webuisshhostbrowseapi

import (
	"encoding/json"
	"strings"
)

// findConnection 在 ssh_connections 原文里按 id 找连接；找不到时 ok=false。
func findConnection(raw string, found bool, connectionID string) (Conn, bool, error) {
	if !found || strings.TrimSpace(raw) == "" {
		return Conn{}, false, nil
	}
	var decoded any
	if err := json.Unmarshal([]byte(raw), &decoded); err != nil {
		return Conn{}, false, err
	}
	list, ok := decoded.([]any)
	if !ok {
		return Conn{}, false, nil
	}
	byID := make(map[string]map[string]any, len(list))
	var target map[string]any
	for _, item := range list {
		object, ok := item.(map[string]any)
		if !ok {
			continue
		}
		id := stringField(object, "id")
		if id != "" {
			byID[id] = object
		}
		if id == connectionID {
			target = object
		}
	}
	if target == nil {
		return Conn{}, false, nil
	}
	connection := connectionFromObject(target)
	connection = resolveJump(connection, byID, map[string]bool{connectionID: true}, 0)
	return connection, true, nil
}

// resolveJump 递归建立跳板链；缺失/成环/超过 5 跳时返回原连接（Jump 保持 nil）。
// 调用方会因此失败关闭，不会把不完整链当成直连。
func resolveJump(connection Conn, byID map[string]map[string]any, seen map[string]bool, depth int) Conn {
	resolved, ok := resolveJumpChain(connection, byID, seen, depth)
	if !ok {
		return connection
	}
	return resolved
}

func resolveJumpChain(connection Conn, byID map[string]map[string]any, seen map[string]bool, depth int) (Conn, bool) {
	if connection.EgressConnectionID == "" {
		return connection, true
	}
	if depth >= 5 || seen[connection.EgressConnectionID] {
		return connection, false
	}
	object, ok := byID[connection.EgressConnectionID]
	if !ok {
		return connection, false
	}
	seen[connection.EgressConnectionID] = true
	jump := connectionFromObject(object)
	resolvedJump, ok := resolveJumpChain(jump, byID, seen, depth+1)
	if !ok {
		return connection, false
	}
	connection.Jump = &resolvedJump
	return connection, true
}

// connectionFromObject 展开一条连接记录；端口缺省或越界时回落 22。
func connectionFromObject(object map[string]any) Conn {
	port := int(numberField(object, "port"))
	if port <= 0 || port > 65535 {
		port = 22
	}
	tunnel, _ := object["reverseTunnel"].(map[string]any)
	return Conn{
		ID:                 stringField(object, "id"),
		Label:              stringField(object, "label"),
		Host:               stringField(object, "host"),
		User:               stringField(object, "user"),
		Port:               port,
		AuthType:           stringField(object, "authType"),
		Password:           rawStringField(object, "password"),
		PrivateKey:         rawStringField(object, "privateKey"),
		IdentityFile:       stringField(object, "identityFile"),
		EgressConnectionID: stringField(object, "egressConnectionId"),
		ReverseTunnel:      tunnel,
		Raw:                object,
	}
}

func stringField(object map[string]any, key string) string {
	value, _ := object[key].(string)
	return strings.TrimSpace(value)
}

// rawStringField 不裁剪密钥类字段，避免改动 PEM 的空白。
func rawStringField(object map[string]any, key string) string {
	value, _ := object[key].(string)
	return value
}

func numberField(object map[string]any, key string) float64 {
	value, _ := object[key].(float64)
	return value
}
