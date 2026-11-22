package proxytransport

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/madou1217/ai_home/internal/adapters/sshremote"
	"github.com/madou1217/ai_home/internal/runtime/sshtunnel"
)

var (
	// ErrConnectionsInvalid 表示 ssh_connections 原文不是 JSON 记录数组。
	ErrConnectionsInvalid = errors.New("ssh_connections 不是合法 JSON")
	// ErrConnectionIDRequired 表示没有给出连接 ID。
	ErrConnectionIDRequired = errors.New("SSH 连接 ID 不能为空")
	// ErrConnectionNotFound 表示连接 ID 不在 ssh_connections 中。
	ErrConnectionNotFound = errors.New("SSH 连接不存在")
)

// ResolverOptions 是解析已保存 SSH 连接所需的原始输入。
//
// 字段对应 app_kv 的 ssh_connections / ssh_known_hosts，但本包不读取数据库：
// 存储访问由调用方完成，这里只接受原始 JSON 与指纹 map。
type ResolverOptions struct {
	// Connections 是 ssh_connections 的原始 JSON 数组；空值表示没有连接。
	Connections []byte
	// KnownHosts 是 "host:port" -> SHA256 指纹；键会按小写归一，空值忽略。
	KnownHosts map[string]string
	// HomeDir 用于 ~ 展开与身份文件定位；空值交给 sshremote 取当前用户家目录。
	HomeDir string
	// DialTimeout <= 0 时使用 sshremote.DefaultTimeout。
	DialTimeout time.Duration
}

// Resolver 把已保存的 SSH 记录解析成可拨号的 sshremote.Config。
// 构造完成后只读，可并发使用；凭据只保留在内存中，不落盘。
type Resolver struct {
	byID    map[string]map[string]any
	known   map[string]string
	homeDir string
	timeout time.Duration
}

// NewResolver 解析 ssh_connections 原文并按 ID 建立索引。
func NewResolver(options ResolverOptions) (*Resolver, error) {
	byID := map[string]map[string]any{}
	if len(strings.TrimSpace(string(options.Connections))) > 0 {
		var records []map[string]any
		if err := json.Unmarshal(options.Connections, &records); err != nil {
			return nil, fmt.Errorf("%w: %v", ErrConnectionsInvalid, err)
		}
		for _, record := range records {
			if record == nil {
				continue
			}
			id, _ := record["id"].(string)
			if id = strings.TrimSpace(id); id != "" {
				byID[id] = record
			}
		}
	}
	known := make(map[string]string, len(options.KnownHosts))
	for key, value := range options.KnownHosts {
		key = strings.ToLower(strings.TrimSpace(key))
		value = strings.TrimSpace(value)
		if key == "" || value == "" {
			continue
		}
		known[key] = value
	}
	return &Resolver{byID: byID, known: known, homeDir: options.HomeDir, timeout: options.DialTimeout}, nil
}

// Record 返回指定连接 ID 的原始记录，作为只读视图使用。
// egressConnectionId 指向的跳板记录通过同一个 Resolver 展开。
func (resolver *Resolver) Record(connectionID string) (map[string]any, error) {
	if resolver == nil {
		return nil, ErrConnectionNotFound
	}
	connectionID = strings.TrimSpace(connectionID)
	if connectionID == "" {
		return nil, ErrConnectionIDRequired
	}
	record, ok := resolver.byID[connectionID]
	if !ok {
		return nil, fmt.Errorf("%w: %s", ErrConnectionNotFound, connectionID)
	}
	return record, nil
}

// Config 构建连接配置（含 egress 跳板），并套用 ssh_known_hosts 指纹。
func (resolver *Resolver) Config(connectionID string) (sshremote.Config, error) {
	record, err := resolver.Record(connectionID)
	if err != nil {
		return sshremote.Config{}, err
	}
	config, err := sshtunnel.ConfigFromRecord(record, resolver.byID, resolver.homeDir)
	if err != nil {
		return sshremote.Config{}, err
	}
	return sshtunnel.ApplyHostKeys(config, resolver.known), nil
}

// Open 解析并拨号，返回已认证的 SSH 客户端；调用方负责 Close。
func (resolver *Resolver) Open(ctx context.Context, connectionID string) (*sshremote.Client, error) {
	config, err := resolver.Config(connectionID)
	if err != nil {
		return nil, err
	}
	return sshremote.Dial(ctx, config, resolver.timeout)
}

// OpenTransport 打开连接并把它包装成 SSH 传输，供 aih proxy serve 等入口
// 直接使用；任一步失败都会关闭已经建立的 SSH 客户端。
func (resolver *Resolver) OpenTransport(ctx context.Context, connectionID string, options SSHOptions) (*SSH, error) {
	client, err := resolver.Open(ctx, connectionID)
	if err != nil {
		return nil, err
	}
	transport, err := NewSSH(ctx, client, options)
	if err != nil {
		_ = client.Close()
		return nil, err
	}
	return transport, nil
}

// *sshremote.Client 是 Connector 的参考实现：只暴露 DialTCP 与 Close。
var _ Connector = (*sshremote.Client)(nil)
