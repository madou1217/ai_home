package sshtunnel

import (
	"encoding/json"
	"fmt"
	"math"
	"net"
	"strconv"
	"strings"

	"golang.org/x/crypto/ssh"

	"github.com/madou1217/ai_home/internal/adapters/sshremote"
)

// ApplyHostKeys 保留 app-state 指纹校验与所有跳板的算法顺序。
func ApplyHostKeys(config sshremote.Config, known map[string]string) sshremote.Config {
	if known == nil {
		return config
	}
	config.HostKeyCallback = hostKeyCallback(config.Host, config.Port, known)
	// app-state 的存量指纹按 Node/ssh2 的 ED25519 优先口径记录；固定顺序避免
	// 服务端同时提供 ECDSA 时 Go 选了另一把 key 导致“指纹变了”的假告警。
	config.HostKeyAlgorithms = []string{
		ssh.KeyAlgoED25519,
		ssh.KeyAlgoRSASHA512,
		ssh.KeyAlgoRSASHA256,
		ssh.KeyAlgoRSA,
		ssh.KeyAlgoECDSA256,
		ssh.KeyAlgoECDSA384,
		ssh.KeyAlgoECDSA521,
	}
	if config.Jump != nil {
		jump := ApplyHostKeys(*config.Jump, known)
		config.Jump = &jump
	}
	return config
}

func hostKeyCallback(host string, port int, known map[string]string) ssh.HostKeyCallback {
	if port == 0 {
		port = 22
	}
	id := strings.ToLower(strings.TrimSpace(host)) + ":" + strconv.Itoa(port)
	expected := strings.TrimSpace(known[id])
	return func(_ string, _ net.Addr, key ssh.PublicKey) error {
		if expected == "" {
			return nil
		}
		actual := ssh.FingerprintSHA256(key)
		if actual != expected {
			return fmt.Errorf("远端 %s 主机指纹变了（expected %s actual %s）", id, expected, actual)
		}
		return nil
	}
}

// ParseSpecs 解析 ssh_connections 原文；egress 链与端口校验失败时保留 Error 状态。
func ParseSpecs(raw []byte, homeDir string) ([]Spec, error) {
	if len(strings.TrimSpace(string(raw))) == 0 {
		return nil, nil
	}
	var records []map[string]any
	if err := json.Unmarshal(raw, &records); err != nil {
		return nil, fmt.Errorf("ssh_connections 不是合法 JSON: %w", err)
	}
	byID := make(map[string]map[string]any, len(records))
	for _, record := range records {
		if id := stringValue(record["id"]); id != "" {
			byID[id] = record
		}
	}
	specs := make([]Spec, 0)
	for _, record := range records {
		id := stringValue(record["id"])
		tunnel, _ := record["reverseTunnel"].(map[string]any)
		if id == "" || tunnel == nil {
			continue
		}
		if enabled, exists := tunnel["enabled"]; exists {
			value, ok := enabled.(bool)
			if !ok {
				specs = append(specs, Spec{ConnectionID: id, Error: "反向隧道 enabled 必须是布尔值"})
				continue
			}
			if !value {
				continue
			}
		}
		remotePort, remoteErr := tunnelPort(tunnel, "remotePort", 0)
		localPort, localErr := tunnelPort(tunnel, "localPort", 22)
		if _, explicit := tunnel["enabled"]; !explicit && remotePort == 0 && remoteErr == nil {
			continue // 旧记录的空端口仍表示关闭；自动模式需 enabled:true。
		}
		spec := Spec{ConnectionID: id, RemotePort: remotePort, LocalPort: localPort}
		switch {
		case remoteErr != nil:
			spec.Error = remoteErr.Error()
		case remotePort != 0 && (remotePort < 1024 || remotePort > 65535):
			spec.Error = "反向隧道远端端口必须为 0（自动分配）或在 1024-65535"
		case localErr != nil:
			spec.Error = localErr.Error()
		case localPort < 1 || localPort > 65535:
			spec.Error = "反向隧道本机端口必须在 1-65535"
		}
		if spec.Error != "" {
			specs = append(specs, spec)
			continue
		}
		config, err := ConfigFromRecord(record, byID, homeDir)
		if err != nil {
			spec.Error = err.Error()
			specs = append(specs, spec)
			continue
		}
		spec.Config = config
		specs = append(specs, spec)
	}
	return specs, nil
}

// ConfigFromRecord 展开 SSH 记录与 egress 跳板，不读取存储、不导出凭据。
func ConfigFromRecord(record map[string]any, byID map[string]map[string]any, homeDir string) (sshremote.Config, error) {
	return configFromRecord(record, byID, map[string]bool{stringValue(record["id"]): true}, 0, homeDir)
}

func configFromRecord(record map[string]any, byID map[string]map[string]any, seen map[string]bool, depth int, homeDir string) (sshremote.Config, error) {
	config := sshremote.Config{
		HomeDir:      homeDir,
		Host:         stringValue(record["host"]),
		Port:         intValue(record["port"]),
		User:         stringValue(record["user"]),
		AuthType:     stringValue(record["authType"]),
		Password:     rawStringValue(record["password"]),
		PrivateKey:   rawStringValue(record["privateKey"]),
		IdentityFile: stringValue(record["identityFile"]),
	}
	egress := stringValue(record["egressConnectionId"])
	if egress == "" {
		return config, nil
	}
	if depth >= 5 || seen[egress] {
		return sshremote.Config{}, fmt.Errorf("egress 链成环或超过 5 跳")
	}
	next, ok := byID[egress]
	if !ok {
		return sshremote.Config{}, fmt.Errorf("egress 连接 %s 不存在", egress)
	}
	seen[egress] = true
	jump, err := configFromRecord(next, byID, seen, depth+1, homeDir)
	if err != nil {
		return sshremote.Config{}, err
	}
	config.Jump = &jump
	return config, nil
}

func stringValue(value any) string {
	text, _ := value.(string)
	return strings.TrimSpace(text)
}

func rawStringValue(value any) string {
	text, _ := value.(string)
	return text
}

func intValue(value any) int {
	switch number := value.(type) {
	case float64:
		return int(number)
	case int:
		return number
	case string:
		parsed, _ := strconv.Atoi(strings.TrimSpace(number))
		return parsed
	default:
		return 0
	}
}

// tunnelPort 不把小数或非法类型截断成合法端口；兼容旧记录里的数字字符串。
func tunnelPort(fields map[string]any, key string, fallback int) (int, error) {
	value, exists := fields[key]
	if !exists || value == nil {
		return fallback, nil
	}
	switch number := value.(type) {
	case float64:
		if math.Trunc(number) == number && number >= 0 && number <= 65535 {
			return int(number), nil
		}
	case int:
		if number >= 0 && number <= 65535 {
			return number, nil
		}
	case string:
		parsed, err := strconv.Atoi(strings.TrimSpace(number))
		if err == nil && parsed >= 0 && parsed <= 65535 {
			return parsed, nil
		}
	}
	return 0, fmt.Errorf("反向隧道 %s 必须是 0-65535 的整数", key)
}
