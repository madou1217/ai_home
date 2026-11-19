package main

import (
	"context"
	"fmt"
	"io"
	"strconv"
	"strings"

	"github.com/madou1217/ai_home/internal/runtime/edgeproxy"
)

type edgeOptions struct {
	positional []string
	remotePort int
	localPort  int
	name       string
	domain     string
	mode       string
	certDir    string
	udp        bool
	udpSet     bool
	dryRun     bool
	reload     bool
	help       bool
}

var edgeKinds = []string{"frp", "nginx", "caddy"}

func runEdge(ctx context.Context, arguments []string, runtime commandRuntime) error {
	options := parseEdgeOptions(arguments)
	if options.help {
		writeEdgeUsage(runtime.stdout)
		return nil
	}
	if len(options.positional) == 0 {
		writeEdgeUsage(runtime.stdout)
		return nil
	}
	action := options.positional[0]
	kind := ""
	if len(options.positional) > 1 {
		kind = options.positional[1]
	}
	home, err := resolveAIHome(runtime)
	if err != nil {
		return err
	}
	aihPort := resolveServerPort(ctx, home, runtime)
	service := edgeproxy.NewService()
	switch action {
	case "status":
		return writeJSONDocument(runtime.stdout, service.Status(ctx, aihPort))
	case "plan", "apply":
		if !stringInSlice(kind, edgeKinds) {
			writeEdgeUsage(runtime.stdout)
			return nil
		}
		planOptions := edgeproxy.PlanOptions{
			Domain: options.domain, Mode: options.mode, Name: options.name,
			LocalPort: options.localPort, RemotePort: options.remotePort,
			UDP: !options.udpSet || options.udp, AIHPort: aihPort,
			CertDir: options.certDir, Reload: options.reload, DryRun: options.dryRun,
		}
		if action == "plan" || options.dryRun {
			plan, edgeErr := service.Plan(kind, planOptions)
			if edgeErr != nil {
				return writeEdgeUsageError(runtime, edgeErr)
			}
			writeEdgePlan(runtime.stdout, plan)
			if action == "apply" {
				_, _ = fmt.Fprintln(runtime.stdout, "\n（dry-run：没有写入任何文件）")
			}
			return nil
		}
		result, edgeErr := service.Apply(ctx, kind, planOptions)
		if edgeErr != nil {
			return writeEdgeUsageError(runtime, edgeErr)
		}
		if err := writeJSONDocument(runtime.stdout, result); err != nil {
			return err
		}
		if !result.OK {
			return fmt.Errorf("失败：%s %s", result.ErrorCode, result.Detail)
		}
		if !result.Reloaded && result.Hint != "" {
			_, _ = fmt.Fprintln(runtime.stdout, "提示："+result.Hint)
		}
		return nil
	case "remove":
		if kind != "frp" {
			writeEdgeUsage(runtime.stdout)
			return nil
		}
		result, edgeErr := service.RemoveFrp(ctx, options.name, options.reload)
		if edgeErr != nil {
			return writeEdgeUsageError(runtime, edgeErr)
		}
		if err := writeJSONDocument(runtime.stdout, result); err != nil {
			return err
		}
		if !result.Reloaded && result.Hint != "" {
			_, _ = fmt.Fprintln(runtime.stdout, "提示："+result.Hint)
		}
		return nil
	default:
		writeEdgeUsage(runtime.stdout)
		return nil
	}
}

func parseEdgeOptions(arguments []string) edgeOptions {
	options := edgeOptions{udp: true, reload: true}
	for index := 0; index < len(arguments); index++ {
		token := strings.TrimSpace(arguments[index])
		next := func() string {
			if index+1 < len(arguments) {
				index++
				return strings.TrimSpace(arguments[index])
			}
			return ""
		}
		switch token {
		case "--remote-port":
			options.remotePort, _ = strconv.Atoi(next())
		case "--local-port":
			options.localPort, _ = strconv.Atoi(next())
		case "--name":
			options.name = next()
		case "--domain":
			options.domain = next()
		case "--mode":
			options.mode = next()
		case "--cert-dir":
			options.certDir = next()
		case "--no-udp":
			options.udp = false
			options.udpSet = true
		case "--udp":
			options.udp = true
			options.udpSet = true
		case "--dry-run":
			options.dryRun = true
		case "--no-reload":
			options.reload = false
		case "--help", "-h":
			options.help = true
		default:
			options.positional = append(options.positional, token)
		}
	}
	return options
}

func writeEdgeUsageError(runtime commandRuntime, edgeErr *edgeproxy.EdgeError) error {
	switch edgeErr.Code {
	case "edge_unknown_provider", "edge_remote_port_required", "edge_domain_required":
		writeEdgeUsage(runtime.stdout)
		return nil
	default:
		return edgeErr
	}
}

func writeEdgeUsage(output io.Writer) {
	_, _ = fmt.Fprintln(output, "用法：")
	_, _ = fmt.Fprintln(output, "  aih edge status")
	_, _ = fmt.Fprintln(output, "  aih edge plan  <frp|nginx|caddy> [...选项]")
	_, _ = fmt.Fprintln(output, "  aih edge apply <frp|nginx|caddy> [...选项] [--dry-run] [--no-reload]")
	_, _ = fmt.Fprintln(output, "  aih edge remove frp --name <名字>")
	_, _ = fmt.Fprintln(output, "选项：")
	_, _ = fmt.Fprintln(output, "  --remote-port <n>   frp 远端端口（必填）")
	_, _ = fmt.Fprintln(output, "  --local-port <n>    frp 本机端口（默认 AIH 端口）")
	_, _ = fmt.Fprintln(output, "  --name <名字>       frp 条目名（默认 aih-server）")
	_, _ = fmt.Fprintln(output, "  --no-udp            不添加 UDP 条目")
	_, _ = fmt.Fprintln(output, "  --domain <域名>     nginx / caddy 必填")
	_, _ = fmt.Fprintln(output, "  --mode <形态>       nginx：split/passthrough/http-only")
	_, _ = fmt.Fprintln(output, "  --cert-dir <目录>   证书目录")
}

func writeEdgePlan(output io.Writer, plan *edgeproxy.Plan) {
	if plan == nil {
		return
	}
	_, _ = fmt.Fprintln(output, plan.Summary)
	for _, note := range plan.Notes {
		_, _ = fmt.Fprintln(output, "  · "+note)
	}
	for _, entry := range plan.Entries {
		_, _ = fmt.Fprintf(output, "  %s 127.0.0.1:%d -> 远端 %d\n", entry.Type, entry.LocalPort, entry.RemotePort)
	}
	for _, file := range plan.Files {
		_, _ = fmt.Fprintf(output, "\n--- %s ---\n%s\n", file.Path, file.Content)
	}
}

func stringInSlice(value string, values []string) bool {
	for _, item := range values {
		if item == value {
			return true
		}
	}
	return false
}
