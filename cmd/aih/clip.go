package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/madou1217/ai_home/application/clipboard"
	"github.com/madou1217/ai_home/internal/adapters/clipboardstore"
	"github.com/madou1217/ai_home/internal/runtime/aihhome"
	"github.com/madou1217/ai_home/internal/runtime/clipboardio"
	"github.com/madou1217/ai_home/internal/runtime/clipboardruntime"
	"github.com/madou1217/ai_home/internal/runtime/clippicker"
	"github.com/madou1217/ai_home/internal/transport/http/webuicontrolplaneapi"
)

type cliClipboardProbe struct {
	capability clipboardio.Capability
}

func (p cliClipboardProbe) CaptureStatus() clipboard.CaptureStatus {
	return clipboard.CaptureStatus{
		Supported: p.capability.Supported,
		Running:   false,
		Reason:    p.capability.Reason,
	}
}

func (p cliClipboardProbe) SyncStatus() clipboard.SyncStatus {
	return clipboard.SyncStatus{}
}

func (p cliClipboardProbe) Transports() []clipboard.TransportStatus {
	return clipboardruntime.DetectTransports()
}

func runClip(ctx context.Context, arguments []string, runtime commandRuntime) error {
	if len(arguments) == 0 || isClipHelp(arguments[0]) {
		writeClipUsage(runtime.stdout)
		return nil
	}
	subcommand := strings.ToLower(strings.TrimSpace(arguments[0]))
	rest := arguments[1:]
	if hasHelpToken(rest) {
		writeClipUsage(runtime.stdout)
		return nil
	}
	if subcommand == "vim" {
		return runClipVim(rest, runtime)
	}

	homeDir, err := resolveClipboardAIHomeDir(runtime)
	if err != nil {
		return err
	}
	store, err := clipboardstore.Open(ctx, homeDir)
	if err != nil {
		return err
	}
	defer func() { _ = store.Close() }()

	service, err := clipboard.NewService(store, store.Blobs(), time.Now)
	if err != nil {
		return err
	}
	sysIO := clipboardio.NewSystem()
	service.SetRuntimeProbe(cliClipboardProbe{capability: sysIO.Probe()})

	switch subcommand {
	case "ls", "list":
		return runClipList(ctx, service, rest, runtime)
	case "show":
		return runClipShow(ctx, service, rest, runtime)
	case "paste":
		return runClipPaste(ctx, service, rest, runtime)
	case "copy":
		return runClipCopy(ctx, service, sysIO, rest, runtime)
	case "pick", "ui":
		return runClipPick(ctx, service, sysIO, rest, runtime)
	case "pin":
		return runClipPin(ctx, service, rest, runtime)
	case "rm", "remove", "delete":
		return runClipRemove(ctx, service, rest, runtime)
	case "clear":
		return runClipClear(ctx, service, rest, runtime)
	case "enable":
		return runClipSetCapture(ctx, service, sysIO, true, rest, runtime)
	case "disable":
		return runClipSetCapture(ctx, service, sysIO, false, rest, runtime)
	case "sync":
		return runClipSync(ctx, homeDir, service, rest, runtime)
	case "status":
		return runClipStatus(ctx, service, rest, runtime)
	default:
		_, _ = fmt.Fprintf(runtime.stderr, "[aih clip] unknown subcommand: %s\n", subcommand)
		writeClipUsage(runtime.stderr)
		return cliExitCode{code: 1}
	}
}

func resolveClipboardAIHomeDir(runtime commandRuntime) (string, error) {
	home, err := resolveAIHomeDir(runtime)
	if err != nil {
		return "", err
	}
	if explicit, found := runtime.lookupEnv("AIH_HOME_DIR"); !found || strings.TrimSpace(explicit) == "" {
		if hostAIHome := aihhome.ProjectedHostAIHome(home); hostAIHome != "" {
			return hostAIHome, nil
		}
	}
	return home, nil
}

func runClipList(ctx context.Context, service *clipboard.Service, args []string, runtime commandRuntime) error {
	limit := 20
	var kind clipboard.Kind
	jsonOutput := false

	for i := 0; i < len(args); i++ {
		arg := args[i]
		switch {
		case arg == "--json":
			jsonOutput = true
		case arg == "--limit" && i+1 < len(args):
			i++
			parsed, err := strconv.Atoi(strings.TrimSpace(args[i]))
			if err != nil || parsed <= 0 {
				return fmt.Errorf("invalid --limit: %s", args[i])
			}
			limit = parsed
		case strings.HasPrefix(arg, "--limit="):
			parsed, err := strconv.Atoi(strings.TrimSpace(strings.TrimPrefix(arg, "--limit=")))
			if err != nil || parsed <= 0 {
				return fmt.Errorf("invalid --limit: %s", arg)
			}
			limit = parsed
		case arg == "--kind" && i+1 < len(args):
			i++
			parsed, err := clipboard.ParseKind(args[i])
			if err != nil {
				return fmt.Errorf("invalid --kind: %s", args[i])
			}
			kind = parsed
		case strings.HasPrefix(arg, "--kind="):
			parsed, err := clipboard.ParseKind(strings.TrimPrefix(arg, "--kind="))
			if err != nil {
				return fmt.Errorf("invalid --kind: %s", arg)
			}
			kind = parsed
		default:
			return fmt.Errorf("unknown flag for `aih clip ls`: %s", arg)
		}
	}

	items, err := service.List(ctx, clipboard.ListFilter{
		Limit: limit,
		Kind:  kind,
	})
	if err != nil {
		return err
	}
	if jsonOutput {
		type cliListItem struct {
			Index        int            `json:"index"`
			ID           string         `json:"id"`
			SHA256       string         `json:"sha256"`
			Kind         clipboard.Kind `json:"kind"`
			MIME         string         `json:"mime"`
			ByteSize     int64          `json:"byteSize"`
			Width        int            `json:"width,omitempty"`
			Height       int            `json:"height,omitempty"`
			Preview      string         `json:"preview"`
			Files        []string       `json:"files,omitempty"`
			SourceDevice string         `json:"sourceDevice,omitempty"`
			SourceApp    string         `json:"sourceApp,omitempty"`
			Pinned       bool           `json:"pinned"`
			SeenCount    int            `json:"seenCount"`
			CreatedAtMs  int64          `json:"createdAtMs"`
			LastSeenAtMs int64          `json:"lastSeenAtMs"`
		}
		out := make([]cliListItem, 0, len(items))
		for i, item := range items {
			out = append(out, cliListItem{
				Index:        i + 1,
				ID:           item.ID,
				SHA256:       item.SHA256,
				Kind:         item.Kind,
				MIME:         item.MIME,
				ByteSize:     item.ByteSize,
				Width:        item.Width,
				Height:       item.Height,
				Preview:      item.Preview,
				Files:        item.Files,
				SourceDevice: item.SourceDevice,
				SourceApp:    item.SourceApp,
				Pinned:       item.Pinned,
				SeenCount:    item.SeenCount,
				CreatedAtMs:  item.CreatedAtMs,
				LastSeenAtMs: item.LastSeenAtMs,
			})
		}
		return writeClipJSON(runtime.stdout, out)
	}
	if len(items) == 0 {
		_, _ = fmt.Fprintln(runtime.stdout, "(no clipboard items)")
		return nil
	}
	now := time.Now()
	for i, item := range items {
		pinMark := " "
		if item.Pinned {
			pinMark = "*"
		}
		shortID := item.ID
		if len(shortID) > 8 {
			shortID = shortID[:8]
		}
		preview := truncateRunes(item.Preview, 80)
		_, _ = fmt.Fprintf(
			runtime.stdout,
			"#%-3d %s %-5s %-8s %-10s %-8s %s\n",
			i+1,
			pinMark,
			item.Kind,
			shortID,
			formatRelativeTime(now, item.LastSeenAtMs),
			formatClipBytes(item.ByteSize),
			preview,
		)
	}
	return nil
}

func runClipShow(ctx context.Context, service *clipboard.Service, args []string, runtime commandRuntime) error {
	jsonOutput := false
	rawOutput := false
	selector := ""
	for _, arg := range args {
		switch arg {
		case "--json":
			jsonOutput = true
		case "--raw":
			rawOutput = true
		default:
			if strings.HasPrefix(arg, "-") {
				return fmt.Errorf("unknown flag for `aih clip show`: %s", arg)
			}
			if selector != "" {
				return errors.New("`aih clip show` accepts only one <id|#index>")
			}
			selector = arg
		}
	}
	if selector == "" {
		return errors.New("usage: aih clip show <id|#index> [--json] [--raw]")
	}
	item, err := service.ResolveSelector(ctx, selector)
	if err != nil {
		return err
	}
	content, err := service.ReadContent(ctx, item)
	if err != nil {
		return err
	}
	if rawOutput {
		_, err = runtime.stdout.Write(content.Data)
		return err
	}
	if jsonOutput {
		payload := map[string]any{
			"id":           item.ID,
			"sha256":       item.SHA256,
			"kind":         item.Kind,
			"mime":         item.MIME,
			"byteSize":     item.ByteSize,
			"width":        item.Width,
			"height":       item.Height,
			"preview":      item.Preview,
			"files":        item.Files,
			"blobPath":     item.BlobPath,
			"sourceDevice": item.SourceDevice,
			"sourceApp":    item.SourceApp,
			"pinned":       item.Pinned,
			"deleted":      item.Deleted,
			"seenCount":    item.SeenCount,
			"createdAtMs":  item.CreatedAtMs,
			"lastSeenAtMs": item.LastSeenAtMs,
		}
		if content.AbsoluteBlobPath != "" {
			payload["absoluteBlobPath"] = content.AbsoluteBlobPath
		}
		if item.Kind == clipboard.KindText || item.Kind == clipboard.KindLink {
			payload["text"] = string(content.Data)
		}
		return writeClipJSON(runtime.stdout, payload)
	}

	_, _ = fmt.Fprintf(runtime.stdout, "ID:        %s\n", item.ID)
	_, _ = fmt.Fprintf(runtime.stdout, "Kind:      %s (%s)\n", item.Kind, item.MIME)
	_, _ = fmt.Fprintf(runtime.stdout, "Size:      %d bytes (%s)\n", item.ByteSize, formatClipBytes(item.ByteSize))
	_, _ = fmt.Fprintf(runtime.stdout, "SHA-256:   %s\n", item.SHA256)
	_, _ = fmt.Fprintf(runtime.stdout, "Pinned:    %t\n", item.Pinned)
	_, _ = fmt.Fprintf(runtime.stdout, "Seen:      %d\n", item.SeenCount)
	_, _ = fmt.Fprintf(runtime.stdout, "Created:   %s\n", time.UnixMilli(item.CreatedAtMs).Format(time.RFC3339))
	_, _ = fmt.Fprintf(runtime.stdout, "LastSeen:  %s\n", time.UnixMilli(item.LastSeenAtMs).Format(time.RFC3339))
	if item.SourceDevice != "" {
		_, _ = fmt.Fprintf(runtime.stdout, "Device:    %s\n", item.SourceDevice)
	}
	if item.SourceApp != "" {
		_, _ = fmt.Fprintf(runtime.stdout, "App:       %s\n", item.SourceApp)
	}
	if item.Width > 0 && item.Height > 0 {
		_, _ = fmt.Fprintf(runtime.stdout, "Dimension: %dx%d\n", item.Width, item.Height)
	}
	if content.AbsoluteBlobPath != "" {
		_, _ = fmt.Fprintf(runtime.stdout, "Blob:      %s\n", content.AbsoluteBlobPath)
	}
	if len(item.Files) > 0 {
		_, _ = fmt.Fprintln(runtime.stdout, "Files:")
		for _, f := range item.Files {
			_, _ = fmt.Fprintf(runtime.stdout, "  %s\n", f)
		}
	}
	if item.Kind == clipboard.KindText || item.Kind == clipboard.KindLink {
		_, _ = fmt.Fprintln(runtime.stdout, "---")
		_, _ = runtime.stdout.Write(content.Data)
		if len(content.Data) > 0 && content.Data[len(content.Data)-1] != '\n' {
			_, _ = fmt.Fprintln(runtime.stdout)
		}
	}
	return nil
}

func runClipPaste(ctx context.Context, service *clipboard.Service, args []string, runtime commandRuntime) error {
	jsonOutput := false
	selector := "#1"
	hasSelector := false
	for _, arg := range args {
		switch arg {
		case "--stdout":
			// stdout is the default behavior; accepted for compatibility with CLI contract.
		case "--json":
			jsonOutput = true
		default:
			if strings.HasPrefix(arg, "-") {
				return fmt.Errorf("unknown flag for `aih clip paste`: %s", arg)
			}
			if hasSelector {
				return errors.New("`aih clip paste` accepts at most one <id|#index>")
			}
			selector = arg
			hasSelector = true
		}
	}
	item, err := service.ResolveSelector(ctx, selector)
	if err != nil {
		return err
	}
	content, err := service.ReadContent(ctx, item)
	if err != nil {
		return err
	}
	if jsonOutput {
		payload := map[string]any{
			"id":       item.ID,
			"kind":     item.Kind,
			"mime":     content.MIME,
			"byteSize": item.ByteSize,
		}
		switch item.Kind {
		case clipboard.KindImage:
			payload["blobPath"] = content.AbsoluteBlobPath
		case clipboard.KindFile:
			payload["files"] = item.Files
		default:
			payload["text"] = string(content.Data)
		}
		return writeClipJSON(runtime.stdout, payload)
	}
	switch item.Kind {
	case clipboard.KindImage:
		_, err = io.WriteString(runtime.stdout, content.AbsoluteBlobPath)
		return err
	default:
		_, err = runtime.stdout.Write(content.Data)
		return err
	}
}

func runClipCopy(ctx context.Context, service *clipboard.Service, sysIO clipboardio.Writer, args []string, runtime commandRuntime) error {
	selector := "#1"
	hasSelector := false
	for _, arg := range args {
		if strings.HasPrefix(arg, "-") {
			return fmt.Errorf("unknown flag for `aih clip copy`: %s", arg)
		}
		if hasSelector {
			return errors.New("`aih clip copy` accepts at most one <id|#index>")
		}
		selector = arg
		hasSelector = true
	}
	cap := sysIO.Probe()
	if !cap.Supported {
		reason := cap.Reason
		if reason == "" {
			reason = "unsupported environment"
		}
		return fmt.Errorf("clipboard copy unavailable: %s", reason)
	}
	item, err := service.ResolveSelector(ctx, selector)
	if err != nil {
		return err
	}
	content, err := service.ReadContent(ctx, item)
	if err != nil {
		return err
	}
	switch item.Kind {
	case clipboard.KindImage:
		if err := sysIO.WriteImage(ctx, content.Data, content.MIME); err != nil {
			return err
		}
	case clipboard.KindFile:
		if err := sysIO.WriteFiles(ctx, item.Files); err != nil {
			return err
		}
	default:
		if err := sysIO.WriteText(ctx, string(content.Data)); err != nil {
			return err
		}
	}
	_, _ = fmt.Fprintf(runtime.stdout, "copied %s (%s, %s)\n", item.ID, item.Kind, formatClipBytes(item.ByteSize))
	return nil
}

func runClipSetCapture(ctx context.Context, service *clipboard.Service, sysIO clipboardio.Reader, enabled bool, args []string, runtime commandRuntime) error {
	if len(args) > 0 {
		return fmt.Errorf("unexpected arguments: %s", strings.Join(args, " "))
	}
	if _, err := service.UpdateSettings(ctx, clipboard.SettingsPatch{CaptureEnabled: &enabled}); err != nil {
		return err
	}
	if enabled {
		cap := sysIO.Probe()
		if !cap.Supported && cap.Reason != "" {
			_, _ = fmt.Fprintf(runtime.stdout, "capture enabled (note: local capture unsupported: %s)\n", cap.Reason)
			return nil
		}
		_, _ = fmt.Fprintln(runtime.stdout, "capture enabled")
		return nil
	}
	_, _ = fmt.Fprintln(runtime.stdout, "capture disabled")
	return nil
}

func runClipPick(ctx context.Context, service *clipboard.Service, sysIO clipboardio.Writer, args []string, runtime commandRuntime) error {
	var kind clipboard.Kind
	query := ""
	limit := 200
	printStdout := false

	for i := 0; i < len(args); i++ {
		arg := args[i]
		switch {
		case arg == "--stdout":
			printStdout = true
		case arg == "--kind" && i+1 < len(args):
			i++
			parsed, err := clipboard.ParseKind(args[i])
			if err != nil {
				return fmt.Errorf("invalid --kind: %s", args[i])
			}
			kind = parsed
		case strings.HasPrefix(arg, "--kind="):
			parsed, err := clipboard.ParseKind(strings.TrimPrefix(arg, "--kind="))
			if err != nil {
				return fmt.Errorf("invalid --kind: %s", arg)
			}
			kind = parsed
		case arg == "--query" && i+1 < len(args):
			i++
			query = args[i]
		case strings.HasPrefix(arg, "--query="):
			query = strings.TrimPrefix(arg, "--query=")
		case arg == "--limit" && i+1 < len(args):
			i++
			parsed, err := strconv.Atoi(strings.TrimSpace(args[i]))
			if err != nil || parsed <= 0 {
				return fmt.Errorf("invalid --limit: %s", args[i])
			}
			limit = parsed
		case strings.HasPrefix(arg, "--limit="):
			parsed, err := strconv.Atoi(strings.TrimSpace(strings.TrimPrefix(arg, "--limit=")))
			if err != nil || parsed <= 0 {
				return fmt.Errorf("invalid --limit: %s", arg)
			}
			limit = parsed
		default:
			return fmt.Errorf("unknown flag for `aih clip pick`: %s", arg)
		}
	}

	noColorVal, noColorSet := runtime.lookupEnv("NO_COLOR")
	noColor := noColorSet && strings.TrimSpace(noColorVal) != ""

	return clippicker.Run(ctx, clippicker.Options{
		Service:     service,
		Writer:      sysIO,
		Stdin:       runtime.stdin,
		Stdout:      runtime.stdout,
		Stderr:      runtime.stderr,
		Kind:        kind,
		Query:       query,
		Limit:       limit,
		PrintStdout: printStdout,
		NoColor:     noColor,
	})
}

func runClipPin(ctx context.Context, service *clipboard.Service, args []string, runtime commandRuntime) error {
	pinned := true
	selector := ""
	for _, arg := range args {
		switch arg {
		case "--off":
			pinned = false
		default:
			if strings.HasPrefix(arg, "-") {
				return fmt.Errorf("unknown flag for `aih clip pin`: %s", arg)
			}
			if selector != "" {
				return errors.New("`aih clip pin` accepts only one <id|#index>")
			}
			selector = arg
		}
	}
	if selector == "" {
		return errors.New("usage: aih clip pin <id|#index> [--off]")
	}
	item, err := service.ResolveSelector(ctx, selector)
	if err != nil {
		return err
	}
	updated, err := service.SetPinned(ctx, item.ID, pinned)
	if err != nil {
		return err
	}
	state := "pinned"
	if !updated.Pinned {
		state = "unpinned"
	}
	_, _ = fmt.Fprintf(runtime.stdout, "%s %s\n", state, updated.ID)
	return nil
}

func runClipRemove(ctx context.Context, service *clipboard.Service, args []string, runtime commandRuntime) error {
	if len(args) == 0 {
		return errors.New("usage: aih clip rm <id|#index>...")
	}
	resolvedIDs := make([]string, 0, len(args))
	seen := map[string]struct{}{}
	for _, selector := range args {
		if strings.HasPrefix(selector, "-") {
			return fmt.Errorf("unknown flag for `aih clip rm`: %s", selector)
		}
		item, err := service.ResolveSelector(ctx, selector)
		if err != nil {
			return fmt.Errorf("%s: %w", selector, err)
		}
		if _, dup := seen[item.ID]; dup {
			continue
		}
		seen[item.ID] = struct{}{}
		resolvedIDs = append(resolvedIDs, item.ID)
	}
	for _, id := range resolvedIDs {
		if err := service.Delete(ctx, id); err != nil {
			return err
		}
		_, _ = fmt.Fprintf(runtime.stdout, "deleted %s\n", id)
	}
	return nil
}

func runClipClear(ctx context.Context, service *clipboard.Service, args []string, runtime commandRuntime) error {
	confirmed := false
	includePinned := false
	for _, arg := range args {
		switch arg {
		case "--yes", "-y":
			confirmed = true
		case "--all":
			includePinned = true
		default:
			return fmt.Errorf("unknown flag for `aih clip clear`: %s", arg)
		}
	}
	if !confirmed {
		_, _ = fmt.Fprintln(runtime.stderr, "[aih clip] pass --yes to confirm clearing clipboard history (use --all to include pinned items)")
		return cliExitCode{code: 1}
	}
	count, err := service.Clear(ctx, includePinned)
	if err != nil {
		return err
	}
	_, _ = fmt.Fprintf(runtime.stdout, "cleared %d item(s)\n", count)
	return nil
}

func runClipSync(ctx context.Context, homeDir string, service *clipboard.Service, args []string, runtime commandRuntime) error {
	watch := false
	serverSelector := ""
	for i := 0; i < len(args); i++ {
		arg := args[i]
		switch {
		case arg == "--once":
			watch = false
		case arg == "--watch":
			watch = true
		case arg == "--server" && i+1 < len(args):
			i++
			serverSelector = strings.TrimSpace(args[i])
		case strings.HasPrefix(arg, "--server="):
			serverSelector = strings.TrimSpace(strings.TrimPrefix(arg, "--server="))
		default:
			return fmt.Errorf("unknown flag for `aih clip sync`: %s", arg)
		}
	}

	targetID := serverSelector
	if targetID == "" {
		settings, err := service.GetSettings(ctx)
		if err != nil {
			return err
		}
		targetID = strings.TrimSpace(settings.SyncTargetProfileID)
	}
	if targetID == "" {
		return errors.New("no sync target configured; pass --server <profileId|name> or configure syncTargetProfileId")
	}

	resolvedID, _, _, err := resolveCLIControlPlaneProfile(ctx, homeDir, targetID)
	if err != nil {
		return err
	}

	syncer := clipboardruntime.NewSyncer(
		service,
		func(rCtx context.Context, id string) (string, string, error) {
			_, endpoint, key, rErr := resolveCLIControlPlaneProfile(rCtx, homeDir, id)
			return endpoint, key, rErr
		},
		&http.Client{Timeout: 30 * time.Second},
		time.Now,
	)

	runPass := func() error {
		if err := syncer.SyncTarget(ctx, resolvedID); err != nil {
			return err
		}
		_, fp, _, _ := service.GetSyncKey(ctx)
		_, _ = fmt.Fprintf(runtime.stdout, "synced target=%s fingerprint=%s\n", resolvedID, fp)
		return nil
	}

	if !watch {
		return runPass()
	}
	if err := runPass(); err != nil {
		_, _ = fmt.Fprintf(runtime.stderr, "[aih clip sync] %v\n", err)
	}
	ticker := time.NewTicker(5 * time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return nil
		case <-ticker.C:
			if err := runPass(); err != nil {
				_, _ = fmt.Fprintf(runtime.stderr, "[aih clip sync] %v\n", err)
			}
		}
	}
}

func resolveCLIControlPlaneProfile(ctx context.Context, homeDir, selector string) (id, endpoint, managementKey string, err error) {
	target := strings.TrimSpace(selector)
	if target == "" {
		return "", "", "", errors.New("server_profile_id_required")
	}
	store, err := webuicontrolplaneapi.ListProfiles(ctx, homeDir)
	if err != nil {
		return "", "", "", err
	}
	var list []map[string]any
	switch raw := store["profiles"].(type) {
	case []map[string]any:
		list = raw
	case []any:
		for _, entry := range raw {
			if m, ok := entry.(map[string]any); ok {
				list = append(list, m)
			}
		}
	}
	textOf := func(m map[string]any, key string) string {
		v, _ := m[key].(string)
		return strings.TrimSpace(v)
	}
	var matched map[string]any
	for _, profile := range list {
		if textOf(profile, "id") == target {
			matched = profile
			break
		}
	}
	if matched == nil {
		for _, profile := range list {
			if strings.EqualFold(textOf(profile, "name"), target) {
				matched = profile
				break
			}
		}
	}
	if matched == nil {
		return "", "", "", fmt.Errorf("server profile %q not found", target)
	}
	id = textOf(matched, "id")
	endpoint = strings.TrimRight(textOf(matched, "endpoint"), "/")
	managementKey = textOf(matched, "managementKey")
	if endpoint == "" || managementKey == "" {
		return "", "", "", fmt.Errorf("server profile %q is missing endpoint or managementKey", target)
	}
	return id, endpoint, managementKey, nil
}

func runClipStatus(ctx context.Context, service *clipboard.Service, args []string, runtime commandRuntime) error {
	jsonOutput := false
	for _, arg := range args {
		switch arg {
		case "--json":
			jsonOutput = true
		default:
			return fmt.Errorf("unknown flag for `aih clip status`: %s", arg)
		}
	}
	status, err := service.Status(ctx)
	if err != nil {
		return err
	}
	if jsonOutput {
		return writeClipJSON(runtime.stdout, status)
	}
	_, _ = fmt.Fprintf(runtime.stdout, "Platform: %s\n", status.Platform)
	_, _ = fmt.Fprintf(runtime.stdout, "Device:   %s (%s)\n", status.DeviceName, status.DeviceID)
	if status.Capture.Reason != "" {
		_, _ = fmt.Fprintf(runtime.stdout, "Capture:  enabled=%t supported=%t running=%t (%s)\n", status.Capture.Enabled, status.Capture.Supported, status.Capture.Running, status.Capture.Reason)
	} else {
		_, _ = fmt.Fprintf(runtime.stdout, "Capture:  enabled=%t supported=%t running=%t\n", status.Capture.Enabled, status.Capture.Supported, status.Capture.Running)
	}
	_, _ = fmt.Fprintf(runtime.stdout, "Sync:     enabled=%t target=%s\n", status.Sync.Enabled, status.Sync.TargetProfileID)
	_, _ = fmt.Fprintf(runtime.stdout, "Items:    %d total (%d pinned)\n", status.ItemCount, status.PinnedCount)
	if status.KeyFingerprint != "" {
		_, _ = fmt.Fprintf(runtime.stdout, "Key:      %s\n", status.KeyFingerprint)
	}
	return nil
}

func isClipHelp(arg string) bool {
	return arg == "-h" || arg == "--help" || arg == "help"
}

func writeClipUsage(w io.Writer) {
	_, _ = fmt.Fprintln(w, "用法:")
	_, _ = fmt.Fprintln(w, "  aih clip ls [--limit 20] [--kind text|link|image|file] [--json]")
	_, _ = fmt.Fprintln(w, "  aih clip show <id|#序号> [--json] [--raw]")
	_, _ = fmt.Fprintln(w, "  aih clip paste [<id|#序号>] [--stdout] [--json]")
	_, _ = fmt.Fprintln(w, "  aih clip copy [<id|#序号>]")
	_, _ = fmt.Fprintln(w, "  aih clip pick|ui [--kind text|link|image|file] [--query <q>] [--limit 200] [--stdout]")
	_, _ = fmt.Fprintln(w, "  aih clip pin <id|#序号> [--off]")
	_, _ = fmt.Fprintln(w, "  aih clip rm <id|#序号>...")
	_, _ = fmt.Fprintln(w, "  aih clip clear --yes [--all]")
	_, _ = fmt.Fprintln(w, "  aih clip enable | disable")
	_, _ = fmt.Fprintln(w, "  aih clip sync [--once|--watch] [--server <profileId|名称>]")
	_, _ = fmt.Fprintln(w, "  aih clip vim install | print")
	_, _ = fmt.Fprintln(w, "  aih clip status [--json]")
}

func writeClipJSON(w io.Writer, payload any) error {
	encoder := json.NewEncoder(w)
	encoder.SetIndent("", "  ")
	encoder.SetEscapeHTML(false)
	return encoder.Encode(payload)
}

func formatClipBytes(n int64) string {
	switch {
	case n >= 1024*1024:
		return fmt.Sprintf("%.1fMiB", float64(n)/(1024*1024))
	case n >= 1024:
		return fmt.Sprintf("%.1fKiB", float64(n)/1024)
	default:
		return fmt.Sprintf("%dB", n)
	}
}

func formatRelativeTime(now time.Time, tsMs int64) string {
	if tsMs <= 0 {
		return "-"
	}
	delta := now.Sub(time.UnixMilli(tsMs))
	if delta < 0 {
		delta = 0
	}
	switch {
	case delta < time.Minute:
		return fmt.Sprintf("%ds ago", int(delta.Seconds()))
	case delta < time.Hour:
		return fmt.Sprintf("%dm ago", int(delta.Minutes()))
	case delta < 24*time.Hour:
		return fmt.Sprintf("%dh ago", int(delta.Hours()))
	default:
		return fmt.Sprintf("%dd ago", int(delta.Hours()/24))
	}
}

func truncateRunes(s string, max int) string {
	runes := []rune(s)
	if len(runes) <= max {
		return s
	}
	if max <= 1 {
		return string(runes[:max])
	}
	return string(runes[:max-1]) + "…"
}
