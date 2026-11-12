// Command verify-aws-agy-migration compares agy account refs between the local
// aih.db and a remote AWS host.
//
// Safety properties:
//   - Both databases are opened read-only (SQLite mode=ro / sqlite3 -readonly).
//   - Only accounts.account_ref and accounts.enabled are selected.
//   - SSH passwords, inline private keys, tokens, emails and credential blobs are
//     never selected, decoded into the report, or printed.
//   - The command performs no write, delete, rename or projection cleanup. Local
//     accounts and run/auth-projections are left untouched.
//
// Usage:
//
//	go run ./scripts/verify-aws-agy-migration
//	go run ./scripts/verify-aws-agy-migration --ssh ubuntu@host
//	go run ./scripts/verify-aws-agy-migration --connection conn_... --json
//
// Exit codes: 0 = pass, 2 = ref/state differences, 1 = execution error.
package main

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"

	_ "modernc.org/sqlite"
)

const providerID = "agy"

var accountRefPattern = regexp.MustCompile(`^acct_[0-9a-f]{20}$`)

type accountRefState struct {
	Ref     string
	Enabled bool
}

type sshConnection struct {
	ID           string `json:"id"`
	Label        string `json:"label"`
	Host         string `json:"host"`
	Port         int    `json:"port"`
	User         string `json:"user"`
	AuthType     string `json:"authType"`
	IdentityFile string `json:"identityFile"`
}

type remoteTarget struct {
	Destination  string
	Port         int
	IdentityFile string
}

type options struct {
	LocalDB    string
	AppStateDB string
	RemoteDB   string
	Connection string
	SSH        string
	Port       int
	Identity   string
	Timeout    time.Duration
	Strict     bool
	JSON       bool
}

type enabledMismatch struct {
	Ref           string `json:"ref"`
	LocalEnabled  bool   `json:"local_enabled"`
	RemoteEnabled bool   `json:"remote_enabled"`
}

type report struct {
	Provider        string            `json:"provider"`
	LocalCount      int               `json:"local_count"`
	RemoteCount     int               `json:"remote_count"`
	Matched         []string          `json:"matched"`
	MissingRemote   []string          `json:"missing_remote"`
	RemoteOnly      []string          `json:"remote_only"`
	EnabledMismatch []enabledMismatch `json:"enabled_mismatch"`
	Strict          bool              `json:"strict"`
	Pass            bool              `json:"pass"`
}

const pythonRefQuery = `import os, sqlite3, sys
path = os.path.expanduser(sys.argv[1])
con = sqlite3.connect("file:" + path + "?mode=ro", uri=True)
try:
    rows = con.execute(
        "SELECT account_ref, enabled FROM accounts WHERE provider_id = 'agy' ORDER BY account_ref"
    ).fetchall()
finally:
    con.close()
for ref, enabled in rows:
    print(ref + "\t" + str(int(enabled)))
`

func main() {
	code, err := run(os.Args[1:], os.Stdout, os.Stderr)
	if err != nil {
		fmt.Fprintln(os.Stderr, "error:", err)
		os.Exit(1)
	}
	os.Exit(code)
}

func run(args []string, stdout, stderr io.Writer) (int, error) {
	opts, err := parseOptions(args, stderr)
	if err != nil {
		if errors.Is(err, flag.ErrHelp) {
			return 0, nil
		}
		return 1, err
	}

	localRows, err := readLocal(opts.LocalDB)
	if err != nil {
		return 1, err
	}

	target, err := resolveTarget(opts)
	if err != nil {
		return 1, err
	}

	ctx, cancel := context.WithTimeout(context.Background(), opts.Timeout)
	defer cancel()

	remoteRows, err := readRemote(ctx, target, opts.RemoteDB, opts.Timeout)
	if err != nil {
		return 1, err
	}

	rep := compareRows(localRows, remoteRows, opts.Strict)
	if opts.JSON {
		encoder := json.NewEncoder(stdout)
		encoder.SetIndent("", "  ")
		if err := encoder.Encode(rep); err != nil {
			return 1, err
		}
	} else {
		printHuman(stdout, rep)
	}
	if rep.Pass {
		return 0, nil
	}
	return 2, nil
}

func parseOptions(args []string, stderr io.Writer) (options, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return options{}, fmt.Errorf("resolve home directory: %w", err)
	}
	opts := options{
		LocalDB:    filepath.Join(home, ".ai_home", "aih.db"),
		AppStateDB: filepath.Join(home, ".ai_home", "app-state.db"),
		RemoteDB:   "~/.ai_home/aih.db",
		Timeout:    15 * time.Second,
	}

	fs := flag.NewFlagSet("verify-aws-agy-migration", flag.ContinueOnError)
	fs.SetOutput(stderr)
	fs.StringVar(&opts.LocalDB, "local-db", opts.LocalDB, "local Go account database (read-only)")
	fs.StringVar(&opts.AppStateDB, "app-state-db", opts.AppStateDB, "local app-state.db used to resolve ssh_connections")
	fs.StringVar(&opts.RemoteDB, "remote-db", opts.RemoteDB, "remote aih.db path; ~ is expanded on the remote host")
	fs.StringVar(&opts.Connection, "connection", "", "ssh_connections id or label; defaults to the unique label containing aws")
	fs.StringVar(&opts.SSH, "ssh", "", "explicit user@host target; skips ssh_connections lookup")
	fs.IntVar(&opts.Port, "port", 0, "ssh port override (default: connection port or 22)")
	fs.StringVar(&opts.Identity, "identity", "", "identity file override (read locally, never printed)")
	fs.DurationVar(&opts.Timeout, "timeout", opts.Timeout, "total timeout for the remote read")
	fs.BoolVar(&opts.Strict, "strict", false, "fail when the remote side has extra agy refs")
	fs.BoolVar(&opts.JSON, "json", false, "emit a JSON report")
	fs.Usage = func() {
		fmt.Fprintln(stderr, "usage: go run ./scripts/verify-aws-agy-migration [options]")
		fmt.Fprintln(stderr)
		fmt.Fprintln(stderr, "Read-only check: every local agy account ref must exist on the remote host.")
		fmt.Fprintln(stderr, "Remote-only refs are reported as drift; --strict makes them a failure.")
		fmt.Fprintln(stderr, "No credentials, tokens, emails or SSH secrets are read or printed.")
		fmt.Fprintln(stderr, "Exit codes: 0 pass, 2 differences, 1 error (build the binary for exact codes; go run maps non-zero to 1).")
		fmt.Fprintln(stderr)
		fs.PrintDefaults()
	}
	if err := fs.Parse(args); err != nil {
		return options{}, err
	}
	if fs.NArg() > 0 {
		return options{}, fmt.Errorf("unexpected argument: %s", fs.Arg(0))
	}
	opts.LocalDB = strings.TrimSpace(opts.LocalDB)
	opts.AppStateDB = strings.TrimSpace(opts.AppStateDB)
	opts.RemoteDB = strings.TrimSpace(opts.RemoteDB)
	opts.Connection = strings.TrimSpace(opts.Connection)
	opts.SSH = strings.TrimSpace(opts.SSH)
	opts.Identity = strings.TrimSpace(opts.Identity)
	if opts.RemoteDB == "" {
		return options{}, errors.New("--remote-db must not be empty")
	}
	if opts.Timeout <= 0 {
		return options{}, errors.New("--timeout must be positive")
	}
	return opts, nil
}

func compareRows(local, remote []accountRefState, strict bool) report {
	localByRef := make(map[string]bool, len(local))
	remoteByRef := make(map[string]bool, len(remote))
	for _, row := range local {
		localByRef[row.Ref] = row.Enabled
	}
	for _, row := range remote {
		remoteByRef[row.Ref] = row.Enabled
	}

	rep := report{
		Provider:        providerID,
		LocalCount:      len(local),
		RemoteCount:     len(remote),
		Matched:         make([]string, 0),
		MissingRemote:   make([]string, 0),
		RemoteOnly:      make([]string, 0),
		EnabledMismatch: make([]enabledMismatch, 0),
		Strict:          strict,
	}
	for ref, localEnabled := range localByRef {
		remoteEnabled, ok := remoteByRef[ref]
		if !ok {
			rep.MissingRemote = append(rep.MissingRemote, ref)
			continue
		}
		rep.Matched = append(rep.Matched, ref)
		if localEnabled != remoteEnabled {
			rep.EnabledMismatch = append(rep.EnabledMismatch, enabledMismatch{
				Ref:           ref,
				LocalEnabled:  localEnabled,
				RemoteEnabled: remoteEnabled,
			})
		}
	}
	for ref := range remoteByRef {
		if _, ok := localByRef[ref]; !ok {
			rep.RemoteOnly = append(rep.RemoteOnly, ref)
		}
	}
	sort.Strings(rep.Matched)
	sort.Strings(rep.MissingRemote)
	sort.Strings(rep.RemoteOnly)
	sort.Slice(rep.EnabledMismatch, func(i, j int) bool {
		return rep.EnabledMismatch[i].Ref < rep.EnabledMismatch[j].Ref
	})
	rep.Pass = len(rep.MissingRemote) == 0 && len(rep.EnabledMismatch) == 0
	if strict && len(rep.RemoteOnly) > 0 {
		rep.Pass = false
	}
	return rep
}

func printHuman(w io.Writer, rep report) {
	fmt.Fprintln(w, "agy account ref migration check (read-only)")
	fmt.Fprintf(w, "local=%d remote=%d matched=%d\n", rep.LocalCount, rep.RemoteCount, len(rep.Matched))
	fmt.Fprintf(w, "missing_on_remote=%d remote_only=%d enabled_mismatch=%d\n",
		len(rep.MissingRemote), len(rep.RemoteOnly), len(rep.EnabledMismatch))
	if len(rep.MissingRemote) > 0 {
		fmt.Fprintln(w, "missing on remote:")
		for _, ref := range rep.MissingRemote {
			fmt.Fprintf(w, "  %s\n", ref)
		}
	}
	if len(rep.EnabledMismatch) > 0 {
		fmt.Fprintln(w, "enabled mismatch:")
		for _, item := range rep.EnabledMismatch {
			fmt.Fprintf(w, "  %s local=%t remote=%t\n", item.Ref, item.LocalEnabled, item.RemoteEnabled)
		}
	}
	if len(rep.RemoteOnly) > 0 {
		label := "remote-only (drift, not a migration failure)"
		if rep.Strict {
			label = "remote-only (drift, failure because --strict)"
		}
		fmt.Fprintln(w, label+":")
		for _, ref := range rep.RemoteOnly {
			fmt.Fprintf(w, "  %s\n", ref)
		}
	}
	if rep.LocalCount == 0 {
		fmt.Fprintln(w, "note: no local agy accounts were found; nothing to verify")
	}
	if rep.Pass {
		fmt.Fprintln(w, "RESULT: PASS")
	} else {
		fmt.Fprintln(w, "RESULT: FAIL")
	}
}

func readLocal(path string) ([]accountRefState, error) {
	abs, err := expandHome(path)
	if err != nil {
		return nil, fmt.Errorf("resolve local database: %w", err)
	}
	if _, err := os.Stat(abs); err != nil {
		return nil, fmt.Errorf("local account database not found: %s", abs)
	}
	db, err := sql.Open("sqlite", readOnlyDSN(abs))
	if err != nil {
		return nil, fmt.Errorf("open local account database: %w", err)
	}
	defer db.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	rows, err := db.QueryContext(ctx,
		"SELECT account_ref, enabled FROM accounts WHERE provider_id = ? ORDER BY account_ref", providerID)
	if err != nil {
		return nil, fmt.Errorf("query local agy accounts: %w", err)
	}
	defer rows.Close()

	result := make([]accountRefState, 0)
	for rows.Next() {
		var ref string
		var enabled int
		if err := rows.Scan(&ref, &enabled); err != nil {
			return nil, fmt.Errorf("scan local agy account: %w", err)
		}
		state, err := newAccountRefState(ref, enabled)
		if err != nil {
			return nil, fmt.Errorf("local account database returned an invalid row: %w", err)
		}
		result = append(result, state)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate local agy accounts: %w", err)
	}
	return result, nil
}

func newAccountRefState(ref string, enabled int) (accountRefState, error) {
	if !accountRefPattern.MatchString(ref) {
		return accountRefState{}, errors.New("account_ref does not match acct_<20 hex>")
	}
	if enabled != 0 && enabled != 1 {
		return accountRefState{}, errors.New("enabled is not 0 or 1")
	}
	return accountRefState{Ref: ref, Enabled: enabled == 1}, nil
}

func readOnlyDSN(path string) string {
	u := url.URL{Scheme: "file", Path: path}
	return u.String() + "?mode=ro"
}

func expandHome(path string) (string, error) {
	path = strings.TrimSpace(path)
	if path == "" {
		return "", errors.New("empty path")
	}
	if path == "~" || strings.HasPrefix(path, "~/") {
		home, err := os.UserHomeDir()
		if err != nil {
			return "", err
		}
		if path == "~" {
			return home, nil
		}
		return filepath.Join(home, path[2:]), nil
	}
	if !filepath.IsAbs(path) {
		return filepath.Abs(path)
	}
	return path, nil
}

func resolveTarget(opts options) (remoteTarget, error) {
	if opts.SSH != "" {
		if err := validateDestination(opts.SSH); err != nil {
			return remoteTarget{}, err
		}
		identity, err := resolveIdentity(opts.Identity)
		if err != nil {
			return remoteTarget{}, err
		}
		port := opts.Port
		if port == 0 {
			port = 22
		}
		return remoteTarget{Destination: opts.SSH, Port: port, IdentityFile: identity}, nil
	}

	connections, err := loadConnections(opts.AppStateDB)
	if err != nil {
		return remoteTarget{}, err
	}
	connection, err := selectConnection(connections, opts.Connection)
	if err != nil {
		return remoteTarget{}, err
	}
	if connection.Host == "" {
		return remoteTarget{}, fmt.Errorf("connection %q has no host", connection.Label)
	}
	destination := connection.Host
	if connection.User != "" {
		destination = connection.User + "@" + connection.Host
	}
	if err := validateDestination(destination); err != nil {
		return remoteTarget{}, err
	}

	var identity string
	switch strings.ToLower(strings.TrimSpace(connection.AuthType)) {
	case "key-file":
		if strings.TrimSpace(connection.IdentityFile) == "" {
			return remoteTarget{}, fmt.Errorf("connection %q uses key-file auth but has no identityFile; inline private keys are intentionally not used", connection.Label)
		}
		identity, err = resolveIdentity(connection.IdentityFile)
		if err != nil {
			return remoteTarget{}, err
		}
	case "agent", "":
		identity, err = resolveIdentity(opts.Identity)
		if err != nil {
			return remoteTarget{}, err
		}
	case "password":
		return remoteTarget{}, fmt.Errorf("connection %q uses password auth; BatchMode verification does not support it, use --ssh with an agent/key", connection.Label)
	default:
		return remoteTarget{}, fmt.Errorf("connection %q has unsupported authType %q", connection.Label, connection.AuthType)
	}

	port := connection.Port
	if opts.Port > 0 {
		port = opts.Port
	}
	if port == 0 {
		port = 22
	}
	return remoteTarget{Destination: destination, Port: port, IdentityFile: identity}, nil
}

func resolveIdentity(path string) (string, error) {
	path = strings.TrimSpace(path)
	if path == "" {
		return "", nil
	}
	abs, err := expandHome(path)
	if err != nil {
		return "", fmt.Errorf("resolve identity file: %w", err)
	}
	if _, err := os.Stat(abs); err != nil {
		return "", fmt.Errorf("identity file not found: %s", abs)
	}
	return abs, nil
}

func validateDestination(destination string) error {
	if destination == "" {
		return errors.New("ssh destination is empty")
	}
	if strings.HasPrefix(destination, "-") {
		return errors.New("ssh destination must not start with '-'")
	}
	if strings.ContainsAny(destination, " \t\r\n") {
		return errors.New("ssh destination must not contain whitespace")
	}
	return nil
}

func loadConnections(appStatePath string) ([]sshConnection, error) {
	abs, err := expandHome(appStatePath)
	if err != nil {
		return nil, fmt.Errorf("resolve app-state database: %w", err)
	}
	if _, err := os.Stat(abs); err != nil {
		return nil, fmt.Errorf("app-state database not found: %s; use --ssh to specify the target directly", abs)
	}
	db, err := sql.Open("sqlite", readOnlyDSN(abs))
	if err != nil {
		return nil, fmt.Errorf("open app-state database: %w", err)
	}
	defer db.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	var raw string
	err = db.QueryRowContext(ctx, "SELECT value FROM app_kv WHERE key = 'ssh_connections'").Scan(&raw)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, errors.New("app-state has no ssh_connections; use --ssh to specify the target directly")
	}
	if err != nil {
		return nil, fmt.Errorf("read ssh_connections: %w", err)
	}
	var connections []sshConnection
	if err := json.Unmarshal([]byte(raw), &connections); err != nil {
		return nil, fmt.Errorf("parse ssh_connections: %w", err)
	}
	return connections, nil
}

func selectConnection(connections []sshConnection, selector string) (sshConnection, error) {
	if len(connections) == 0 {
		return sshConnection{}, errors.New("no ssh connections are configured")
	}
	if selector != "" {
		matches := exactConnectionMatches(connections, selector)
		if len(matches) == 0 {
			matches = substringConnectionMatches(connections, selector)
		}
		switch len(matches) {
		case 1:
			return matches[0], nil
		case 0:
			return sshConnection{}, fmt.Errorf("no ssh connection matches %q; available: %s", selector, describeConnections(connections))
		default:
			return sshConnection{}, fmt.Errorf("ssh connection %q is ambiguous; available: %s", selector, describeConnections(connections))
		}
	}

	matches := make([]sshConnection, 0)
	for _, connection := range connections {
		if strings.Contains(strings.ToLower(connection.Label), "aws") {
			matches = append(matches, connection)
		}
	}
	switch len(matches) {
	case 1:
		return matches[0], nil
	case 0:
		return sshConnection{}, fmt.Errorf("no ssh connection label contains aws; use --connection or --ssh; available: %s", describeConnections(connections))
	default:
		return sshConnection{}, fmt.Errorf("multiple ssh connections match aws; use --connection; available: %s", describeConnections(connections))
	}
}

func exactConnectionMatches(connections []sshConnection, selector string) []sshConnection {
	matches := make([]sshConnection, 0, 1)
	for _, connection := range connections {
		if connection.ID == selector || strings.EqualFold(connection.Label, selector) {
			matches = append(matches, connection)
		}
	}
	return matches
}

func substringConnectionMatches(connections []sshConnection, selector string) []sshConnection {
	needle := strings.ToLower(selector)
	matches := make([]sshConnection, 0, 1)
	for _, connection := range connections {
		if strings.Contains(strings.ToLower(connection.Label), needle) {
			matches = append(matches, connection)
		}
	}
	return matches
}

func describeConnections(connections []sshConnection) string {
	parts := make([]string, 0, len(connections))
	for _, connection := range connections {
		label := connection.Label
		if label == "" {
			label = "(no label)"
		}
		parts = append(parts, fmt.Sprintf("%s [%s]", label, connection.ID))
	}
	return strings.Join(parts, ", ")
}

func readRemote(ctx context.Context, target remoteTarget, remoteDB string, timeout time.Duration) ([]accountRefState, error) {
	remoteCommand := "python3 - " + shellQuote(remoteDB)
	stdout, stderr, err := runSSH(ctx, target, remoteCommand, pythonRefQuery, timeout)
	if err == nil {
		return parseRemoteRows(stdout, "\t")
	}
	if !shouldFallbackToSQLite(stderr, err) {
		return nil, remoteReadError(err, stderr)
	}

	query := "SELECT account_ref, enabled FROM accounts WHERE provider_id = 'agy' ORDER BY account_ref;"
	remoteCommand = "sqlite3 -readonly -separator '|' " + remotePathExpr(remoteDB) + " " + shellQuote(query)
	stdout, stderr, err = runSSH(ctx, target, remoteCommand, "", timeout)
	if err != nil {
		return nil, remoteReadError(err, stderr)
	}
	return parseRemoteRows(stdout, "|")
}

func runSSH(ctx context.Context, target remoteTarget, remoteCommand, stdin string, timeout time.Duration) (string, string, error) {
	connectTimeout := int(timeout.Seconds())
	if connectTimeout < 1 {
		connectTimeout = 1
	}
	args := []string{
		"-o", "BatchMode=yes",
		"-o", fmt.Sprintf("ConnectTimeout=%d", connectTimeout),
		"-o", "StrictHostKeyChecking=accept-new",
		"-o", "ServerAliveInterval=5",
		"-o", "ServerAliveCountMax=2",
	}
	if target.IdentityFile != "" {
		args = append(args, "-i", target.IdentityFile)
	}
	if target.Port > 0 {
		args = append(args, "-p", strconv.Itoa(target.Port))
	}
	args = append(args, target.Destination, remoteCommand)

	command := exec.CommandContext(ctx, "ssh", args...)
	if stdin != "" {
		command.Stdin = strings.NewReader(stdin)
	}
	var stdout, stderr bytes.Buffer
	command.Stdout = &stdout
	command.Stderr = &stderr
	err := command.Run()
	if errors.Is(ctx.Err(), context.DeadlineExceeded) {
		return stdout.String(), stderr.String(), fmt.Errorf("ssh timed out after %s", timeout)
	}
	if err != nil {
		return stdout.String(), stderr.String(), err
	}
	return stdout.String(), stderr.String(), nil
}

func shouldFallbackToSQLite(stderr string, err error) bool {
	lower := strings.ToLower(stderr)
	if strings.Contains(lower, "no module named 'sqlite3'") || strings.Contains(lower, "no module named \"sqlite3\"") {
		return true
	}
	if strings.Contains(lower, "python3: not found") || strings.Contains(lower, "python3: command not found") {
		return true
	}
	if strings.Contains(lower, "command not found") && strings.Contains(lower, "python3") {
		return true
	}
	var exitErr *exec.ExitError
	return errors.As(err, &exitErr) && exitErr.ExitCode() == 127
}

func remoteReadError(err error, stderr string) error {
	detail := strings.TrimSpace(stderr)
	if len(detail) > 800 {
		detail = detail[:800] + "..."
	}
	if detail == "" {
		return fmt.Errorf("remote read failed: %w", err)
	}
	return fmt.Errorf("remote read failed: %w: %s", err, detail)
}

func parseRemoteRows(output, separator string) ([]accountRefState, error) {
	lines := strings.Split(output, "\n")
	result := make([]accountRefState, 0, len(lines))
	seen := make(map[string]struct{}, len(lines))
	for _, line := range lines {
		line = strings.TrimSuffix(line, "\r")
		if strings.TrimSpace(line) == "" {
			continue
		}
		parts := strings.SplitN(line, separator, 2)
		if len(parts) != 2 {
			return nil, errors.New("remote output is not ref<separator>enabled")
		}
		enabled, err := strconv.Atoi(strings.TrimSpace(parts[1]))
		if err != nil {
			return nil, errors.New("remote enabled value is not an integer")
		}
		state, err := newAccountRefState(strings.TrimSpace(parts[0]), enabled)
		if err != nil {
			return nil, fmt.Errorf("remote account database returned an invalid row: %w", err)
		}
		if _, ok := seen[state.Ref]; ok {
			return nil, errors.New("remote account database returned a duplicate ref")
		}
		seen[state.Ref] = struct{}{}
		result = append(result, state)
	}
	return result, nil
}

func shellQuote(value string) string {
	return "'" + strings.ReplaceAll(value, "'", `'\''`) + "'"
}

// remotePathExpr quotes a remote path for the remote shell. Unlike shellQuote it
// lets a leading ~ expand through $HOME, because sqlite3 does not expand tildes
// itself. Python uses os.path.expanduser instead.
func remotePathExpr(path string) string {
	if path == "~" {
		return `"$HOME"`
	}
	if strings.HasPrefix(path, "~/") {
		return `"$HOME"` + shellQuote(path[1:])
	}
	return shellQuote(path)
}
