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
	for _, item := range list {
		object, ok := item.(map[string]any)
		if !ok {
			continue
		}
		if stringField(object, "id") != connectionID {
			continue
		}
		return connectionFromObject(object), true, nil
	}
	return Conn{}, false, nil
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
