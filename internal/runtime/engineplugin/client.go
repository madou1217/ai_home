// Package engineplugin 发现并驱动 egress.engine 进程插件。
//
// 插件是独立可执行文件，通过行分隔 JSON-RPC 提供 describe/resolve/compile；
// 主体不 import 任何具体内核。插件只返回配置与启动事实，进程/控制面/健康
// 仍由 egress PoolSupervisor 负责。
package engineplugin

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/madou1217/ai_home/application/egressengine"
	"github.com/madou1217/ai_home/internal/runtime/pluginrpc"
)

const (
	manifestDirName = "plugins/engines"
	callTimeout     = 30 * time.Second
)

// Manifest 是 <aiHome>/plugins/engines/*.json 的插件声明。
type Manifest = pluginrpc.Manifest

// Client 是一个已启动的进程插件，实现 egressengine.Engine。
type Client struct {
	manifest   Manifest
	descriptor egressengine.Descriptor
	process    *pluginrpc.Process
}

// Load 扫描插件目录并启动可用插件；单个插件失败只跳过，不影响其它插件。
//
// 去重键是插件自报的 descriptor.id，而不是文件名或 manifest.id：
// 同一个插件可能有多种命名（sing-box / singbox），按文件名去重会让一份
// 陈旧副本抢先占位。发现顺序固定为「随主体分发的目录 -> manifest -> aiHome」，
// 打包自带的插件始终优先于运行时目录里的历史副本。
func Load(aiHomeDir string) []*Client {
	root := strings.TrimSpace(aiHomeDir)
	if root == "" {
		return nil
	}
	clients := make([]*Client, 0, 3)
	seen := map[string]struct{}{}
	start := func(manifest Manifest) {
		client, err := NewClient(manifest)
		if err != nil {
			return
		}
		id := strings.ToLower(strings.TrimSpace(client.Descriptor().ID))
		if id == "" {
			_ = client.Close()
			return
		}
		if _, exists := seen[id]; exists {
			_ = client.Close()
			return
		}
		seen[id] = struct{}{}
		clients = append(clients, client)
	}

	// 先扫描与主体同目录/运行目录的 aih-engine-*。
	for _, binDir := range pluginrpc.SearchDirs(root) {
		entries, err := os.ReadDir(binDir)
		if err != nil {
			continue
		}
		for _, entry := range entries {
			if entry.IsDir() || !strings.HasPrefix(strings.ToLower(entry.Name()), "aih-engine-") {
				continue
			}
			id := strings.TrimPrefix(strings.ToLower(entry.Name()), "aih-engine-")
			if strings.HasSuffix(id, ".exe") {
				id = strings.TrimSuffix(id, ".exe")
			}
			start(Manifest{ID: id, Command: filepath.Join(binDir, entry.Name())})
		}
	}

	// manifest 只补位：随包插件已经注册的 ID 不再被外部声明覆盖。
	manifestDir := filepath.Join(root, manifestDirName)
	entries, err := os.ReadDir(manifestDir)
	if err != nil {
		return clients
	}
	for _, entry := range entries {
		if entry.IsDir() || !strings.HasSuffix(strings.ToLower(entry.Name()), ".json") {
			continue
		}
		raw, readErr := os.ReadFile(filepath.Join(manifestDir, entry.Name()))
		if readErr != nil {
			continue
		}
		var manifest Manifest
		if json.Unmarshal(raw, &manifest) != nil || strings.TrimSpace(manifest.ID) == "" {
			continue
		}
		if strings.TrimSpace(manifest.Command) == "" {
			manifest.Command = filepath.Join(root, "bin", "aih-engine-"+manifest.ID)
		} else if !filepath.IsAbs(manifest.Command) {
			manifest.Command = filepath.Join(manifestDir, manifest.Command)
		}
		start(manifest)
	}
	return clients
}

// SearchDirs 返回插件二进制的搜索目录（按优先级去重），供诊断视图与测试注入。
func SearchDirs(aiHomeDir string) []string { return pluginrpc.SearchDirs(aiHomeDir) }

// NewClient 启动插件并读取 describe 描述符。
func NewClient(manifest Manifest) (*Client, error) {
	process, err := pluginrpc.Start(manifest, callTimeout)
	if err != nil {
		if strings.TrimSpace(manifest.ID) == "" || strings.TrimSpace(manifest.Command) == "" {
			return nil, errors.New("engine_plugin_manifest_invalid")
		}
		return nil, err
	}
	client := &Client{manifest: manifest, process: process}
	var descriptor egressengine.Descriptor
	if err := process.Call(context.Background(), "describe", nil, &descriptor); err != nil {
		_ = client.Close()
		return nil, err
	}
	if strings.ToLower(strings.TrimSpace(descriptor.Controller)) != "clash-api" {
		_ = client.Close()
		return nil, errors.New("engine_plugin_controller_unsupported")
	}
	if strings.TrimSpace(descriptor.ID) == "" {
		_ = client.Close()
		return nil, errors.New("engine_plugin_id_required")
	}
	if manifest.Priority != 0 {
		descriptor.Priority = manifest.Priority
	}
	client.descriptor = descriptor
	return client, nil
}

// Descriptor 实现 egressengine.Engine。
func (client *Client) Descriptor() egressengine.Descriptor { return client.descriptor }

// Resolve 实现 egressengine.Engine。
func (client *Client) Resolve(ctx context.Context, request egressengine.ResolveRequest) (egressengine.ResolveResult, error) {
	var result egressengine.ResolveResult
	if err := client.process.Call(ctx, "resolve", request, &result); err != nil {
		return egressengine.ResolveResult{}, err
	}
	if result.UsableNodes > 0 && strings.TrimSpace(result.Binary) == "" {
		return egressengine.ResolveResult{}, errors.New("engine_plugin_binary_required")
	}
	return result, nil
}

// Compile 实现 egressengine.Engine。
func (client *Client) Compile(ctx context.Context, request egressengine.CompileRequest) (egressengine.LaunchSpec, error) {
	var spec egressengine.LaunchSpec
	if err := client.process.Call(ctx, "compile", request, &spec); err != nil {
		return egressengine.LaunchSpec{}, err
	}
	if len(spec.Config) == 0 || strings.TrimSpace(spec.ConfigFileName) == "" || strings.TrimSpace(spec.GlobalGroup) == "" {
		return egressengine.LaunchSpec{}, errors.New("engine_plugin_launch_spec_invalid")
	}
	return spec, nil
}

// Close 关闭插件进程；幂等。
func (client *Client) Close() error {
	if client == nil {
		return nil
	}
	return client.process.Close()
}
