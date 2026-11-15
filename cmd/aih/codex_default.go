package main

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/madou1217/ai_home/internal/host/codexdefault"
)

// codexDefaultResult separates state selection from optional host UI effects.
// The Node front-door adapter performs the existing Desktop reload/restart only
// after this Go transaction reports success; it never implements account writes.
type codexDefaultResult struct {
	OK            bool   `json:"ok"`
	Gateway       bool   `json:"gateway"`
	AccountRef    string `json:"accountRef,omitempty"`
	CLIAccountID  string `json:"cliAccountId,omitempty"`
	ConfigPath    string `json:"configPath"`
	RestartClient bool   `json:"restartClient"`
	ForceQuit     bool   `json:"forceQuit"`
}

func runCodexDefaultCommand(ctx context.Context, arguments []string, runtime commandRuntime) error {
	const usage = "用法: aih codex set-default [<id>|.aih-server] [--restart-client|--force-quit-client] / aih codex unset-default [--restart-client|--force-quit-client]"
	if len(arguments) == 0 {
		return fmt.Errorf("%w: %s", errInvalidCommand, usage)
	}
	verb := strings.ToLower(arguments[0])
	if verb != "set-default" && verb != "unset-default" {
		return errInvalidCommand
	}
	var selector string
	var jsonOutput, restart, force bool
	for _, arg := range arguments[1:] {
		switch arg {
		case "--help", "-h":
			fmt.Fprintln(runtime.stdout, usage)
			return nil
		case "--json":
			if jsonOutput {
				return errInvalidCommand
			}
			jsonOutput = true
		case "--restart-client":
			restart = true
		case "--force-quit-client":
			restart = true
			force = true
		default:
			if verb == "unset-default" || selector != "" || strings.HasPrefix(arg, "-") {
				return fmt.Errorf("%w: %s", errInvalidCommand, usage)
			}
			selector = arg
		}
	}
	// Direct Go CLI has no UI process adapter; do not apply half of an explicit
	// restart command. The public aih entry uses the JSON effect contract.
	if restart && !jsonOutput {
		return fmt.Errorf("%w: Desktop restart uses the public aih command", errInvalidCommand)
	}
	aiHome, err := resolveAIHomeDir(runtime)
	if err != nil {
		return err
	}
	host := lookupOrDefault(runtime.lookupEnv, "AIH_HOST_HOME", "")
	if host == "" {
		host, err = runtime.userHomeDir()
		if err != nil {
			return err
		}
	}
	host, err = filepath.Abs(host)
	if err != nil {
		return err
	}
	executable, err := os.Executable()
	if err != nil {
		return err
	}
	out, err := codexdefault.Apply(ctx, codexdefault.Options{AIHomeDir: aiHome, HostHomeDir: host, AuthCommand: executable, Selector: selector, LookupEnv: runtime.lookupEnv})
	if err != nil {
		return err
	}
	if jsonOutput {
		return json.NewEncoder(runtime.stdout).Encode(codexDefaultResult{OK: true, Gateway: out.Gateway, AccountRef: out.AccountRef, CLIAccountID: out.CLIAccountID, ConfigPath: out.ConfigPath, RestartClient: restart, ForceQuit: force})
	}
	if out.Gateway {
		fmt.Fprintln(runtime.stdout, "[Success] Set AIH Server as the default provider for codex.")
	} else {
		fmt.Fprintf(runtime.stdout, "[Success] Set Account ID %s as default for codex in ai-home and synced host config.\n", out.CLIAccountID)
	}
	fmt.Fprintln(runtime.stdout, "[aih] Codex host configuration saved; restart an already-running Desktop client to load it.")
	return nil
}
