//go:build !no_builtin_renderers

// Command aih-render-subscriptions 是 profile.render 进程插件：订阅渲染。
//
// 协议：行分隔 JSON-RPC（describe/render/supports/relay_compile/
// relay_supports/shutdown）。插件只做纯编译，不启动内核、不监听端口。
package main

import (
	"bufio"
	"encoding/json"
	"fmt"
	"os"

	"github.com/madou1217/ai_home/application/profilerender"
	"github.com/madou1217/ai_home/internal/runtime/subaggregator"
)

type request struct {
	ID      int64           `json:"id"`
	Op      string          `json:"op"`
	Request json.RawMessage `json:"request,omitempty"`
}

type response struct {
	ID     int64 `json:"id"`
	Result any   `json:"result,omitempty"`
	Error  *struct {
		Code    string `json:"code"`
		Message string `json:"message"`
	} `json:"error,omitempty"`
}

func main() {
	scanner := bufio.NewScanner(os.Stdin)
	scanner.Buffer(make([]byte, 64*1024), 64*1024*1024)
	encoder := json.NewEncoder(os.Stdout)
	for scanner.Scan() {
		var req request
		if err := json.Unmarshal(scanner.Bytes(), &req); err != nil {
			continue
		}
		reply := response{ID: req.ID}
		result, err := dispatch(req)
		if err != nil {
			reply.Error = &struct {
				Code    string `json:"code"`
				Message string `json:"message"`
			}{Code: "render_failed", Message: err.Error()}
		} else {
			reply.Result = result
		}
		if req.Op == "shutdown" {
			_ = encoder.Encode(reply)
			return
		}
		if err := encoder.Encode(reply); err != nil {
			return
		}
	}
}

func dispatch(req request) (any, error) {
	switch req.Op {
	case "describe":
		return subaggregator.DescribeRendererPlugins(), nil
	case "render":
		return render(req.Request)
	case "supports":
		return supports(req.Request)
	case "relay_supports":
		return relaySupports(req.Request)
	case "relay_compile":
		return relayCompile(req.Request)
	case "shutdown":
		return nil, nil
	default:
		return nil, fmt.Errorf("未知操作：%s", req.Op)
	}
}

func render(raw json.RawMessage) (profilerender.RenderResult, error) {
	var input profilerender.RenderRequest
	if err := json.Unmarshal(raw, &input); err != nil {
		return profilerender.RenderResult{}, err
	}
	renderer, ok := subaggregator.GetRenderer(input.Target)
	if !ok {
		return profilerender.RenderResult{}, fmt.Errorf("unsupported_aggregator_format")
	}
	var profile subaggregator.AggregatorProfile
	var subs []subaggregator.Subscription
	var nodes []subaggregator.ProxyNode
	var renderCtx subaggregator.RenderContext
	if err := json.Unmarshal(input.Profile, &profile); err != nil {
		return profilerender.RenderResult{}, err
	}
	if err := json.Unmarshal(input.Subscriptions, &subs); err != nil {
		return profilerender.RenderResult{}, err
	}
	if err := json.Unmarshal(input.Nodes, &nodes); err != nil {
		return profilerender.RenderResult{}, err
	}
	if err := json.Unmarshal(input.Context, &renderCtx); err != nil {
		return profilerender.RenderResult{}, err
	}
	rendered := subaggregator.RenderWithPlan(profile, renderer, subs, nodes, renderCtx)
	stats, err := json.Marshal(rendered.Stats)
	if err != nil {
		return profilerender.RenderResult{}, err
	}
	skipped, err := json.Marshal(rendered.SkippedNodes)
	if err != nil {
		return profilerender.RenderResult{}, err
	}
	userInfo := json.RawMessage(nil)
	if rendered.UserInfo != nil {
		rawInfo, marshalErr := json.Marshal(rendered.UserInfo)
		if marshalErr != nil {
			return profilerender.RenderResult{}, marshalErr
		}
		userInfo = rawInfo
	}
	return profilerender.RenderResult{
		Content:      rendered.Content,
		Format:       rendered.Format,
		ContentType:  rendered.ContentType,
		Stats:        stats,
		SkippedNodes: skipped,
		Warnings:     rendered.Warnings,
		UserInfo:     userInfo,
	}, nil
}

func supports(raw json.RawMessage) (profilerender.SupportsResult, error) {
	var input profilerender.SupportsRequest
	if err := json.Unmarshal(raw, &input); err != nil {
		return profilerender.SupportsResult{}, err
	}
	renderer, ok := subaggregator.GetRenderer(input.Target)
	if !ok {
		return profilerender.SupportsResult{}, fmt.Errorf("unsupported_aggregator_format")
	}
	var entries []subaggregator.PlannedNode
	if err := json.Unmarshal(input.Entries, &entries); err != nil {
		return profilerender.SupportsResult{}, err
	}
	out := make([]bool, len(entries))
	for index, entry := range entries {
		_, err := renderer.CompileNode(entry, "", subaggregator.RenderContext{})
		out[index] = err == nil
	}
	return profilerender.SupportsResult{Supported: out}, nil
}

func relaySupports(raw json.RawMessage) (profilerender.RelaySupportResult, error) {
	var input profilerender.RelaySupportRequest
	if err := json.Unmarshal(raw, &input); err != nil {
		return profilerender.RelaySupportResult{}, err
	}
	var node subaggregator.ProxyNode
	if err := json.Unmarshal(input.Node, &node); err != nil {
		return profilerender.RelaySupportResult{}, err
	}
	switch input.Kernel {
	case "sing-box":
		_, err := subaggregator.CompileSingBoxOutbound(node, "relay-probe", input.Version, true)
		return profilerender.RelaySupportResult{Supported: err == nil}, nil
	case "mihomo":
		_, err := subaggregator.CompileMihomoProxy(node, "relay-probe", "mihomo")
		return profilerender.RelaySupportResult{Supported: err == nil}, nil
	default:
		return profilerender.RelaySupportResult{Supported: false}, nil
	}
}

func relayCompile(raw json.RawMessage) (profilerender.RelayCompileResult, error) {
	var input profilerender.RelayCompileRequest
	if err := json.Unmarshal(raw, &input); err != nil {
		return profilerender.RelayCompileResult{}, err
	}
	var nodes []subaggregator.ProxyNode
	if err := json.Unmarshal(input.Nodes, &nodes); err != nil {
		return profilerender.RelayCompileResult{}, err
	}
	opts := subaggregator.RelayCompileOptions{
		ListenHost:  input.ListenHost,
		MaxPorts:    input.MaxPorts,
		OnlyIDs:     input.OnlyIDs,
		BasePort:    input.BasePort,
		LogPath:     input.LogPath,
		Version:     input.Version,
		OfficialApp: input.OfficialApp,
	}
	if input.Auth != nil {
		opts.Auth = &subaggregator.RelayCredentials{
			Username: input.Auth.Username, Password: input.Auth.Password, Source: input.Auth.Source,
		}
	}
	if len(input.PortByNode) > 0 {
		portByNode := input.PortByNode
		opts.AssignPort = func(nodeID string, _ int) int { return portByNode[nodeID] }
	}
	var compiled subaggregator.RelayCompiledOutput
	switch input.Kernel {
	case "sing-box":
		compiled = subaggregator.CompileSingBoxRelayConfig(nodes, opts)
	case "mihomo":
		compiled = subaggregator.CompileMihomoRelayConfigText(nodes, opts)
	default:
		return profilerender.RelayCompileResult{}, fmt.Errorf("unsupported_relay_kernel")
	}
	endpoints := make(map[string]profilerender.RelayEndpoint, len(compiled.Endpoints))
	for id, endpoint := range compiled.Endpoints {
		endpoints[id] = profilerender.RelayEndpoint{
			Host: endpoint.Host, Port: endpoint.Port,
			Username: endpoint.Username, Password: endpoint.Password, UDP: endpoint.UDP,
		}
	}
	skipped := make([]profilerender.RelaySkipped, 0, len(compiled.Skipped))
	for _, item := range compiled.Skipped {
		skipped = append(skipped, profilerender.RelaySkipped{NodeID: item.NodeID, Reason: item.Reason})
	}
	return profilerender.RelayCompileResult{Text: compiled.Text, Endpoints: endpoints, Skipped: skipped}, nil
}
