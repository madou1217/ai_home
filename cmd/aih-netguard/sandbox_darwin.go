//go:build darwin

package main

import (
	"context"
	"flag"
	"fmt"
	"os"
	"os/exec"

	"github.com/madou1217/ai_home/internal/runtime/netguard"
)

func runSandboxExec(arguments []string) int {
	flags := flag.NewFlagSet("exec", flag.ContinueOnError)
	flags.SetOutput(os.Stderr)
	proxyURL := flags.String("proxy-url", "", "已解析的本机代理入口")
	dns := flags.String("dns", string(netguard.DNSProxy), "proxy|doh_bridge|local")
	if err := flags.Parse(arguments); err != nil {
		return 2
	}
	command := flags.Args()
	if len(command) == 0 {
		fmt.Fprintln(os.Stderr, "用法: aih-netguard exec --proxy-url <url> -- <command> [args...]")
		return 2
	}
	cmd, cleanup, err := netguard.NewSandboxCommand(context.Background(), netguard.SandboxConfig{
		ProxyURL: *proxyURL,
		DNS:      netguard.DNSMode(*dns),
	}, command[0], command[1:]...)
	if err != nil {
		fmt.Fprintln(os.Stderr, "aih-netguard exec:", err)
		return 1
	}
	defer cleanup()
	cmd.Stdin = os.Stdin
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	if err := cmd.Run(); err != nil {
		if exitError, ok := err.(*exec.ExitError); ok {
			return exitError.ExitCode()
		}
		fmt.Fprintln(os.Stderr, "aih-netguard exec:", err)
		return 1
	}
	return 0
}
