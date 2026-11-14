package nativeterminal

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strconv"
	"strings"
)

// Arguments is the native window contract; it never embeds credentials or a shell
// script. The existing Go CLI resolves account/environment/egress in the pane.
func Arguments(home string, spec Spec) []string {
	args := []string{Command, "launch", "--home", home, "--provider", spec.Provider, "--identity-provider", spec.IdentityProvider, "--account-ref", spec.AccountRef, "--account-id", strconv.FormatInt(spec.CLIAccountID, 10), "--cwd", spec.CWD}
	if spec.Model != "" {
		args = append(args, "--model", spec.Model)
	}
	return append(append(args, "--"), spec.Args...)
}

// Execute is called before cmd/aih's generic signal handling. Inner owns SIGHUP
// and waits for the existing Go runtime's credential capture before cleanup.
func Execute(args []string, rt Runtime) int {
	if len(args) == 0 || rt.RunCLI == nil || rt.Stdin == nil || rt.Stdout == nil || rt.Stderr == nil {
		return 1
	}
	action := args[0]
	flags := flag.NewFlagSet("aih "+Command, flag.ContinueOnError)
	flags.SetOutput(rt.Stderr)
	var home, envelope string
	var spec Spec
	var detached bool
	flags.StringVar(&home, "home", "", "AIH state directory")
	flags.StringVar(&envelope, "envelope", "", "private one-shot launch id")
	flags.StringVar(&spec.Provider, "provider", "", "CLI provider")
	flags.StringVar(&spec.IdentityProvider, "identity-provider", "", "account identity provider")
	flags.StringVar(&spec.AccountRef, "account-ref", "", "account reference")
	flags.Int64Var(&spec.CLIAccountID, "account-id", 0, "CLI account id")
	flags.StringVar(&spec.CWD, "cwd", "", "working directory")
	flags.StringVar(&spec.Model, "model", "", "selected model")
	flags.BoolVar(&detached, "detached", false, "create without attaching")
	if err := flags.Parse(args[1:]); err != nil {
		return 2
	}
	if home == "" {
		home = os.Getenv("AIH_HOME_DIR")
	}
	if home == "" {
		if host, err := os.UserHomeDir(); err == nil {
			home = filepath.Join(host, ".ai_home")
		}
	}
	home, err := filepath.Abs(home)
	if err != nil {
		return report(rt.Stderr, err)
	}
	switch action {
	case "launch":
		spec.Args = flags.Args()
		if spec.IdentityProvider == "" {
			spec.IdentityProvider = spec.Provider
		}
		if spec.CWD == "" {
			spec.CWD, _ = os.Getwd()
		}
		if err = validateSpec(spec); err != nil {
			return report(rt.Stderr, err)
		}
		code, err := launch(context.Background(), home, spec, detached, rt)
		if err != nil {
			return report(rt.Stderr, err)
		}
		return code
	case "inner":
		value, readErr := consumeEnvelope(home, envelope)
		if readErr != nil {
			return report(rt.Stderr, readErr)
		}
		if value.Entry.Provider != spec.Provider || value.Entry.AccountRef != spec.AccountRef || value.Entry.CLIAccountID != spec.CLIAccountID {
			return report(rt.Stderr, ErrInvalid)
		}
		return supervise(home, value, rt)
	case "close":
		result, closeErr := CloseAccount(context.Background(), home, spec.Provider, spec.AccountRef)
		_ = json.NewEncoder(rt.Stdout).Encode(result)
		if closeErr != nil {
			return report(rt.Stderr, closeErr)
		}
		return 0
	default:
		return report(rt.Stderr, ErrInvalid)
	}
}
func validateSpec(spec Spec) error {
	if !safePart.MatchString(spec.Provider) || !safePart.MatchString(spec.IdentityProvider) || !accountRefPattern.MatchString(spec.AccountRef) || spec.CLIAccountID <= 0 || !filepath.IsAbs(spec.CWD) || len(spec.Args) < 2 || spec.Args[0] != spec.Provider {
		return ErrInvalid
	}
	if st, err := os.Stat(spec.CWD); err != nil || !st.IsDir() {
		return errors.New("native_terminal_cwd_missing")
	}
	for _, arg := range spec.Args {
		if strings.ContainsRune(arg, '\x00') {
			return ErrInvalid
		}
	}
	_, err := specIntent(spec)
	return err
}
func report(output io.Writer, err error) int {
	_, _ = fmt.Fprintln(output, "aih native terminal:", err)
	return 1
}
