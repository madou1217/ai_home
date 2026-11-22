// Package renderplugin 发现并驱动 profile.render 进程插件。
//
// 主体只依赖 subaggregator.RenderingEngine；插件负责节点协议编译、客户端
// 格式渲染与本机中转配置编译，不启动内核、不监听端口。
package renderplugin

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"github.com/madou1217/ai_home/application/profilerender"
	"github.com/madou1217/ai_home/internal/runtime/pluginrpc"
	"github.com/madou1217/ai_home/internal/runtime/subaggregator"
)

const (
	manifestDirName = "plugins/renderers"
	binaryPrefix    = "aih-render-"
	callTimeout     = 60 * time.Second
)

// Manifest 是 <aiHome>/plugins/renderers/*.json 的插件声明。
type Manifest = pluginrpc.Manifest

// Client 是一个已启动的渲染插件进程。
type Client struct {
	manifest   Manifest
	descriptor profilerender.Descriptor
	process    *pluginrpc.Process
}

type formatEntry struct {
	client *Client
	format profilerender.Format
}

// Catalog 把多个渲染插件的格式/内核能力合并成一个宿主引擎。
type Catalog struct {
	formats map[string]formatEntry
	kernels map[string]*Client
	clients []*Client
}

// Load 扫描插件目录并启动可用插件；单个插件失败只跳过，不影响其它插件。
func Load(aiHomeDir string) *Catalog {
	root := strings.TrimSpace(aiHomeDir)
	catalog := &Catalog{formats: map[string]formatEntry{}, kernels: map[string]*Client{}}
	if root == "" {
		return catalog
	}
	seenPlugins := map[string]struct{}{}
	start := func(manifest Manifest) {
		client, err := NewClient(manifest)
		if err != nil {
			return
		}
		id := strings.ToLower(strings.TrimSpace(client.descriptor.ID))
		if id == "" {
			_ = client.Close()
			return
		}
		if _, exists := seenPlugins[id]; exists {
			_ = client.Close()
			return
		}
		seenPlugins[id] = struct{}{}
		used := false
		for _, format := range client.descriptor.Formats {
			formatID := subaggregator.NormalizeTarget(format.ID)
			if formatID == "" {
				continue
			}
			if _, exists := catalog.formats[formatID]; exists {
				continue
			}
			catalog.formats[formatID] = formatEntry{client: client, format: format}
			used = true
		}
		for _, kernel := range client.descriptor.RelayKernels {
			kernelID := strings.ToLower(strings.TrimSpace(kernel))
			if kernelID == "" {
				continue
			}
			if _, exists := catalog.kernels[kernelID]; exists {
				continue
			}
			catalog.kernels[kernelID] = client
			used = true
		}
		if used {
			catalog.clients = append(catalog.clients, client)
			return
		}
		_ = client.Close()
	}
	for _, binDir := range pluginrpc.SearchDirs(root) {
		entries, err := os.ReadDir(binDir)
		if err != nil {
			continue
		}
		for _, entry := range entries {
			if entry.IsDir() || !strings.HasPrefix(strings.ToLower(entry.Name()), binaryPrefix) {
				continue
			}
			id := strings.TrimPrefix(strings.ToLower(entry.Name()), binaryPrefix)
			if strings.HasSuffix(id, ".exe") {
				id = strings.TrimSuffix(id, ".exe")
			}
			start(Manifest{ID: id, Command: filepath.Join(binDir, entry.Name())})
		}
	}
	manifestDir := filepath.Join(root, manifestDirName)
	entries, err := os.ReadDir(manifestDir)
	if err != nil {
		return catalog
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
			manifest.Command = filepath.Join(root, "bin", "aih-render-"+manifest.ID)
		} else if !filepath.IsAbs(manifest.Command) {
			manifest.Command = filepath.Join(manifestDir, manifest.Command)
		}
		start(manifest)
	}
	return catalog
}

// Available 只回答是否发现至少一个可用格式，不启动额外进程。
func (c *Catalog) Available() bool {
	return c != nil && len(c.formats) > 0
}

func (c *Catalog) Renderers() []subaggregator.RendererInfo {
	if c == nil {
		return nil
	}
	out := make([]subaggregator.RendererInfo, 0, len(c.formats))
	for _, entry := range c.formats {
		out = append(out, rendererInfo(entry.format))
	}
	sort.SliceStable(out, func(i, j int) bool { return out[i].ID < out[j].ID })
	return out
}

func (c *Catalog) Lookup(target string) (subaggregator.RendererInfo, bool) {
	if c == nil {
		return subaggregator.RendererInfo{}, false
	}
	entry, ok := c.formats[subaggregator.NormalizeTarget(target)]
	if !ok {
		return subaggregator.RendererInfo{}, false
	}
	return rendererInfo(entry.format), true
}

func (c *Catalog) Render(ctx context.Context, target string, profile subaggregator.AggregatorProfile, subs []subaggregator.Subscription, nodes []subaggregator.ProxyNode, renderCtx subaggregator.RenderContext) (subaggregator.RenderResult, error) {
	entry, ok := c.formats[subaggregator.NormalizeTarget(target)]
	if !ok {
		return subaggregator.RenderResult{}, errors.New("unsupported_aggregator_format")
	}
	client := entry.client
	profileRaw, err := json.Marshal(profile)
	if err != nil {
		return subaggregator.RenderResult{}, err
	}
	// 渲染只读取订阅的 ID/启用状态/UserInfo；原始订阅正文（可能数 MB）
	// 不跨进程传输，避免每次渲染都复制整份订阅内容。
	lightSubs := make([]subaggregator.Subscription, 0, len(subs))
	for _, sub := range subs {
		lightSubs = append(lightSubs, subaggregator.Subscription{
			ID: sub.ID, Name: sub.Name, Enabled: sub.Enabled, UserInfo: sub.UserInfo,
		})
	}
	subsRaw, err := json.Marshal(lightSubs)
	if err != nil {
		return subaggregator.RenderResult{}, err
	}
	nodesRaw, err := json.Marshal(nodes)
	if err != nil {
		return subaggregator.RenderResult{}, err
	}
	ctxRaw, err := json.Marshal(renderCtx)
	if err != nil {
		return subaggregator.RenderResult{}, err
	}
	var result profilerender.RenderResult
	if err := client.process.Call(ctx, "render", profilerender.RenderRequest{
		Target: target, Profile: profileRaw, Subscriptions: subsRaw, Nodes: nodesRaw, Context: ctxRaw,
	}, &result); err != nil {
		return subaggregator.RenderResult{}, err
	}
	out := subaggregator.RenderResult{
		Content: result.Content, Format: result.Format, ContentType: result.ContentType,
		Warnings: result.Warnings,
	}
	if len(result.Stats) > 0 {
		if err := json.Unmarshal(result.Stats, &out.Stats); err != nil {
			return subaggregator.RenderResult{}, err
		}
	}
	if len(result.SkippedNodes) > 0 {
		if err := json.Unmarshal(result.SkippedNodes, &out.SkippedNodes); err != nil {
			return subaggregator.RenderResult{}, err
		}
	}
	if len(result.UserInfo) > 0 && string(result.UserInfo) != "null" {
		var info subaggregator.SubscriptionUserInfo
		if err := json.Unmarshal(result.UserInfo, &info); err != nil {
			return subaggregator.RenderResult{}, err
		}
		out.UserInfo = &info
	}
	return out, nil
}

func (c *Catalog) Supports(ctx context.Context, target string, entries []subaggregator.PlannedNode) ([]bool, error) {
	entry, ok := c.formats[subaggregator.NormalizeTarget(target)]
	if !ok {
		return nil, errors.New("unsupported_aggregator_format")
	}
	client := entry.client
	raw, err := json.Marshal(entries)
	if err != nil {
		return nil, err
	}
	var result profilerender.SupportsResult
	if err := client.process.Call(ctx, "supports", profilerender.SupportsRequest{Target: target, Entries: raw}, &result); err != nil {
		return nil, err
	}
	return result.Supported, nil
}

func (c *Catalog) SupportsRelayNode(ctx context.Context, kernel string, node subaggregator.ProxyNode, version string) bool {
	client, ok := c.kernels[strings.ToLower(strings.TrimSpace(kernel))]
	if !ok {
		return false
	}
	raw, err := json.Marshal(node)
	if err != nil {
		return false
	}
	var result profilerender.RelaySupportResult
	if err := client.process.Call(ctx, "relay_supports", profilerender.RelaySupportRequest{Kernel: kernel, Node: raw, Version: version}, &result); err != nil {
		return false
	}
	return result.Supported
}

func (c *Catalog) CompileRelay(ctx context.Context, request subaggregator.RelayCompileRequest) (subaggregator.RelayCompiledOutput, error) {
	client, ok := c.kernels[strings.ToLower(strings.TrimSpace(request.Kernel))]
	if !ok {
		return subaggregator.RelayCompiledOutput{}, errors.New("relay_kernel_unavailable")
	}
	nodesRaw, err := json.Marshal(request.Nodes)
	if err != nil {
		return subaggregator.RelayCompiledOutput{}, err
	}
	var auth *profilerender.RelayCredentials
	if request.Auth != nil {
		auth = &profilerender.RelayCredentials{Username: request.Auth.Username, Password: request.Auth.Password, Source: request.Auth.Source}
	}
	var result profilerender.RelayCompileResult
	if err := client.process.Call(ctx, "relay_compile", profilerender.RelayCompileRequest{
		Kernel: request.Kernel, Nodes: nodesRaw, ListenHost: request.ListenHost, Auth: auth,
		MaxPorts: request.MaxPorts, OnlyIDs: request.OnlyIDs, BasePort: request.BasePort,
		LogPath: request.LogPath, Version: request.Version, OfficialApp: request.OfficialApp,
		PortByNode: request.PortByNode,
	}, &result); err != nil {
		return subaggregator.RelayCompiledOutput{}, err
	}
	out := subaggregator.RelayCompiledOutput{
		Text:      result.Text,
		Endpoints: make(map[string]subaggregator.RelayEndpoint, len(result.Endpoints)),
		Skipped:   make([]subaggregator.RelaySkippedItem, 0, len(result.Skipped)),
	}
	for id, endpoint := range result.Endpoints {
		out.Endpoints[id] = subaggregator.RelayEndpoint{
			Host: endpoint.Host, Port: endpoint.Port,
			Username: endpoint.Username, Password: endpoint.Password, UDP: endpoint.UDP,
		}
	}
	for _, item := range result.Skipped {
		out.Skipped = append(out.Skipped, subaggregator.RelaySkippedItem{NodeID: item.NodeID, Reason: item.Reason})
	}
	return out, nil
}

func (c *Catalog) Close() error {
	if c == nil {
		return nil
	}
	var firstErr error
	for _, client := range c.clients {
		if err := client.Close(); err != nil && firstErr == nil {
			firstErr = err
		}
	}
	return firstErr
}

func rendererInfo(format profilerender.Format) subaggregator.RendererInfo {
	return subaggregator.RendererInfo{
		ID: format.ID, Name: format.Name, Note: format.Note,
		ContentType: format.ContentType, Extension: format.Extension,
		Capabilities: capabilitiesFromContract(format.Capabilities),
	}
}

func capabilitiesFromContract(capabilities profilerender.Capabilities) subaggregator.RendererCapabilities {
	out := subaggregator.RendererCapabilities{
		RejectInGroups: capabilities.RejectInGroups,
		Groups:         capabilities.Groups,
		GroupTypes:     append([]string(nil), capabilities.GroupTypes...),
		Protocols:      append([]string(nil), capabilities.Protocols...),
		ProxyChain:     capabilities.ProxyChain,
		RuleSetFormat:  capabilities.RuleSetFormat,
		RelayFallback:  capabilities.RelayFallback,
		CoreProtocols:  append([]string(nil), capabilities.CoreProtocols...),
	}
	if strings.EqualFold(strings.TrimSpace(capabilities.SanitizeName), "surge") {
		out.SanitizeName = subaggregator.SanitizeSurgeName
	}
	return out
}

// NewClient 启动插件并读取 describe 描述符。
func NewClient(manifest Manifest) (*Client, error) {
	process, err := pluginrpc.Start(manifest, callTimeout)
	if err != nil {
		if strings.TrimSpace(manifest.ID) == "" || strings.TrimSpace(manifest.Command) == "" {
			return nil, errors.New("render_plugin_manifest_invalid")
		}
		return nil, err
	}
	client := &Client{manifest: manifest, process: process}
	var descriptor profilerender.Descriptor
	if err := process.Call(context.Background(), "describe", nil, &descriptor); err != nil {
		_ = client.Close()
		return nil, err
	}
	if strings.TrimSpace(descriptor.ID) == "" || len(descriptor.Formats) == 0 {
		_ = client.Close()
		return nil, errors.New("render_plugin_descriptor_invalid")
	}
	client.descriptor = descriptor
	return client, nil
}

// Close 关闭插件进程；幂等。
func (client *Client) Close() error {
	if client == nil {
		return nil
	}
	return client.process.Close()
}
