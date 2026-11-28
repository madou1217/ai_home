// Command aih-netguard is the privileged platform guard used by the launch
// orchestrator. Phase 1/2 exposes the strict Windows WinDivert P0 backend; the
// same command will host the macOS/Linux adapters and the WFP backend later.
package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/madou1217/ai_home/internal/runtime/netguard"
)

func main() {
	if len(os.Args) > 1 && os.Args[1] == "exec" {
		os.Exit(runSandboxExec(os.Args[2:]))
	}
	var (
		rootPIDs    = flag.String("root-pid", "", "实例根进程 PID；可逗号分隔多个，每个进程树都会被保护")
		pidsValue   = flag.String("pids", "", "逗号分隔的额外 PID")
		proxyURL    = flag.String("proxy-url", "", "已解析的本机代理入口")
		instanceID  = flag.String("instance-id", "", "实例 ID（审计用）")
		dnsMode     = flag.String("dns", string(netguard.DNSProxy), "proxy|doh_bridge|local")
		duration    = flag.Duration("duration", 0, "运行时长；0 表示等待 SIGINT/SIGTERM")
		printStatus = flag.Bool("json", false, "以 JSON 输出状态")
	)
	flag.Parse()

	policy := netguard.Policy{
		Mode:  netguard.ModeStrict,
		Proxy: netguard.ProxySpec{Kind: netguard.ProxyURL, URL: *proxyURL},
		DNS:   netguard.DNSMode(*dnsMode),
	}
	if err := policy.Validate(*proxyURL); err != nil {
		fail(err)
	}
	guard, err := netguard.New(netguard.Options{
		InstanceID: strings.TrimSpace(*instanceID),
		Policy:     policy,
		ProxyURL:   strings.TrimSpace(*proxyURL),
	})
	if err != nil {
		fail(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	if err := guard.Start(ctx); err != nil {
		fail(err)
	}
	pids := parsePIDs(*pidsValue)
	roots := parsePIDs(*rootPIDs)
	if len(roots) == 0 && len(pids) == 0 {
		_ = guard.Stop(context.Background())
		fail(errors.New("至少需要一个 --root-pid 或 --pids"))
	}
	if len(roots) == 0 {
		if err := guard.SetProcessTree(ctx, 0, pids); err != nil {
			_ = guard.Stop(context.Background())
			fail(err)
		}
	}
	for _, root := range roots {
		if err := guard.SetProcessTree(ctx, root, pids); err != nil {
			_ = guard.Stop(context.Background())
			fail(err)
		}
	}
	status := guard.Status()
	if *printStatus {
		encoded, _ := json.MarshalIndent(status, "", "  ")
		fmt.Fprintln(os.Stdout, string(encoded))
	} else {
		fmt.Fprintf(os.Stdout, "netguard %s active=%v backend=%s pids=%d blocked=%d\n",
			status.Mode, status.Active, status.Backend, status.ProtectedPIDs, status.Blocked)
	}

	stop := make(chan os.Signal, 1)
	signal.Notify(stop, os.Interrupt, syscall.SIGTERM)
	if *duration > 0 {
		timer := time.NewTimer(*duration)
		defer timer.Stop()
		select {
		case <-timer.C:
		case <-stop:
		}
	} else {
		<-stop
	}
	if err := guard.Stop(context.Background()); err != nil {
		fail(err)
	}
	status = guard.Status()
	if *printStatus {
		encoded, _ := json.MarshalIndent(status, "", "  ")
		fmt.Fprintln(os.Stdout, string(encoded))
	} else {
		fmt.Fprintf(os.Stdout, "netguard stopped pids=%d blocked=%d\n", status.ProtectedPIDs, status.Blocked)
	}
}

func parsePIDs(raw string) []int {
	var out []int
	for _, token := range strings.Split(raw, ",") {
		token = strings.TrimSpace(token)
		if token == "" {
			continue
		}
		pid, err := strconv.Atoi(token)
		if err == nil && pid > 0 {
			out = append(out, pid)
		}
	}
	return out
}

func fail(err error) {
	fmt.Fprintln(os.Stderr, "aih-netguard:", err)
	os.Exit(1)
}
