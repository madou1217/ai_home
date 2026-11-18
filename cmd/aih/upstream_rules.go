package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"io"
	"strings"
	"time"

	rulesapp "github.com/madou1217/ai_home/application/upstreamrules"
	"github.com/madou1217/ai_home/internal/host/upstreamrulesadmin"
)

// This private recovery command never starts HTTP/Node, discovers a server or
// reads rules/credentials from stdin. Confirmation uses only low-sensitivity
// source/version/revision/digest arguments from an explicitly requested plan.
func runUpstreamRules(ctx context.Context, args []string, runtime commandRuntime) error {
	if len(args) == 0 || (args[0] != "plan" && args[0] != "confirm-legacy") {
		return errors.New("upstream_rule_admin_action_invalid")
	}
	explicit, found := runtime.lookupEnv("AIH_HOME_DIR")
	if !found || strings.TrimSpace(explicit) == "" {
		return errors.New("upstream_rule_explicit_home_required")
	}
	home, err := resolveAIHomeDir(runtime)
	if err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	if args[0] == "plan" {
		if len(args) != 1 {
			return errors.New("upstream_rule_admin_arguments_invalid")
		}
		plan, err := upstreamrulesadmin.Plan(ctx, home)
		if err != nil {
			return err
		}
		return json.NewEncoder(runtime.stdout).Encode(plan)
	}
	flags := flag.NewFlagSet("confirm-legacy", flag.ContinueOnError)
	flags.SetOutput(io.Discard)
	var confirmation rulesapp.LegacyConfirmation
	flags.StringVar(&confirmation.Source, "source", "", "")
	flags.IntVar(&confirmation.SelectorVersion, "selector-version", 0, "")
	flags.Int64Var(&confirmation.AuthorityRevision, "authority-revision", -1, "")
	flags.StringVar(&confirmation.Digest, "digest", "", "")
	consent := flags.Bool("confirm-legacy-source", false, "")
	if err := flags.Parse(args[1:]); err != nil || flags.NArg() != 0 {
		return errors.New("upstream_rule_admin_arguments_invalid")
	}
	supplied := map[string]bool{}
	flags.Visit(func(item *flag.Flag) { supplied[item.Name] = true })
	if len(supplied) != 5 || !*consent {
		return upstreamrulesadmin.ErrInvalidConfirmation
	}
	result, err := upstreamrulesadmin.ConfirmLegacy(ctx, home, confirmation)
	if err != nil {
		return err
	}
	return json.NewEncoder(runtime.stdout).Encode(result)
}
