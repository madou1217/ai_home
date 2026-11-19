package sshterminalclip

import (
	"encoding/json"
	"fmt"
	"io"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"

	"golang.org/x/term"

	"github.com/madou1217/ai_home/internal/runtime/sshbridge"
)

// ProbeOptions 是 `aih ssh-clipboard probe` 的参数。
type ProbeOptions struct {
	Action     string
	Help       bool
	JSON       bool
	PasteEvent bool
	Timeout    time.Duration
	MaxBytes   int
}

func parsePositive(value string, fallback int) int {
	number, err := strconv.Atoi(strings.TrimSpace(value))
	if err != nil || number <= 0 {
		return fallback
	}
	return number
}

// ParseArgs 解析 `ssh-clipboard` 之后的参数（首词是动作）。
func ParseArgs(arguments []string) ProbeOptions {
	options := ProbeOptions{Action: "probe", Timeout: 1200 * time.Millisecond, MaxBytes: sshbridge.DefaultMaxBytes}
	if len(arguments) > 0 {
		if action := strings.TrimSpace(arguments[0]); action != "" && !strings.HasPrefix(action, "-") {
			options.Action = action
		}
	}
	for index := 0; index < len(arguments); index++ {
		token := arguments[index]
		switch token {
		case "--json":
			options.JSON = true
		case "--paste-event", "--wait-paste":
			options.PasteEvent = true
		case "--timeout-ms":
			if index+1 < len(arguments) {
				options.Timeout = time.Duration(parsePositive(arguments[index+1], int(options.Timeout/time.Millisecond))) * time.Millisecond
			}
			index++
		case "--max-bytes", "--clip-max-bytes":
			if index+1 < len(arguments) {
				options.MaxBytes = parsePositive(arguments[index+1], options.MaxBytes)
			}
			index++
		case "--help", "-h", "help":
			options.Help = true
		}
	}
	return options
}

// HelpText 是命令帮助。
func HelpText() string {
	text := `
\x1b[36mAI Home SSH Clipboard Probe\x1b[0m - Strict zero-client terminal clipboard diagnostics

\x1b[33mUsage:\x1b[0m
  aih ssh-clipboard probe [--json] [--timeout-ms 1200]
  aih ssh-clipboard probe --paste-event [--json] [--timeout-ms 10000]

\x1b[33mWhat it does:\x1b[0m
  Runs inside a normal SSH session and asks the current terminal for clipboard
  image data using terminal protocols only: OSC 5522, 5522 paste-events support,
  and OSC 52 image/data-url reads. It does not use clip-agent, RemoteForward,
  scp, or an SSH wrapper.

  --paste-event enables OSC 5522 paste-events and waits for you to paste an
  image in this same terminal, then reads the one-shot paste token.
`
	return strings.ReplaceAll(text, `\x1b`, "\x1b") + "\n"
}

func summarizeImage(image sshbridge.Image) map[string]any {
	return map[string]any{"status": "ok", "mimeType": image.MimeType, "byteLength": image.Bytes, "sha256": image.SHA256}
}

func classifyPasteEventsSupport(output ParseOutput) any {
	if output.PasteEventsSupport == nil {
		return nil
	}
	return map[string]any{
		"status":    "ok",
		"supported": output.PasteEventsSupport.Supported,
		"enabled":   output.PasteEventsSupport.Enabled,
		"state":     output.PasteEventsSupport.State,
	}
}

func classifyImageRead(output ParseOutput) any {
	if len(output.Images) > 0 {
		return summarizeImage(output.Images[0])
	}
	if len(output.Errors) > 0 {
		return map[string]any{"status": "error", "error": output.Errors[0].Error()}
	}
	return nil
}

func classifyMimeList(output ParseOutput) any {
	if len(output.MimeLists) > 0 {
		seen := map[string]bool{}
		values := make([]string, 0, len(output.MimeLists))
		for _, list := range output.MimeLists {
			for _, value := range list {
				normalized := strings.ToLower(strings.TrimSpace(value))
				if normalized == "" || seen[normalized] {
					continue
				}
				seen[normalized] = true
				values = append(values, normalized)
			}
		}
		return map[string]any{"status": "ok", "mimeTypes": values}
	}
	if len(output.Errors) > 0 {
		return map[string]any{"status": "error", "error": output.Errors[0].Error()}
	}
	return nil
}

func chooseImageMimeType(mimeTypes []string) string {
	for _, candidate := range OSC5522ImageMimeTypes {
		if containsString(mimeTypes, candidate) {
			return candidate
		}
	}
	for _, candidate := range mimeTypes {
		if containsString(OSC5522ImageMimeTypes, candidate) {
			return candidate
		}
	}
	for _, candidate := range OSC5522TextImageMimeTypes {
		if containsString(mimeTypes, candidate) {
			return candidate
		}
	}
	return ""
}

type terminalReader struct {
	chunks chan []byte
	done   chan struct{}
	once   sync.Once
}

func newTerminalReader(input *os.File) *terminalReader {
	reader := &terminalReader{chunks: make(chan []byte, 16), done: make(chan struct{})}
	go func() {
		buffer := make([]byte, 32*1024)
		for {
			count, err := input.Read(buffer)
			if count > 0 {
				chunk := make([]byte, count)
				copy(chunk, buffer[:count])
				select {
				case reader.chunks <- chunk:
				case <-reader.done:
					return
				}
			}
			if err != nil {
				reader.close()
				return
			}
		}
	}()
	return reader
}

func (r *terminalReader) close() {
	r.once.Do(func() { close(r.done) })
}

func waitForResponse(reader *terminalReader, output io.Writer, parser *Parser, sequence string, timeout time.Duration, classify func(ParseOutput) any) any {
	if reader == nil || output == nil {
		return map[string]any{"status": "error", "error": "terminal_stream_unavailable"}
	}
	if _, err := io.WriteString(output, sequence); err != nil {
		return map[string]any{"status": "error", "error": err.Error()}
	}
	timer := time.NewTimer(timeout)
	defer timer.Stop()
	for {
		select {
		case chunk := <-reader.chunks:
			parsed := parser.Consume(chunk)
			if value := classify(parsed); value != nil {
				return value
			}
		case <-reader.done:
			return map[string]any{"status": "timeout"}
		case <-timer.C:
			return map[string]any{"status": "timeout"}
		}
	}
}

func asMap(value any) map[string]any {
	if mapped, ok := value.(map[string]any); ok {
		return mapped
	}
	return map[string]any{"status": "unknown"}
}

func statusString(value any) string {
	return fmt.Sprint(asMap(value)["status"])
}

func formatProbeStatus(value any) string {
	if value == nil {
		return "unknown"
	}
	mapped := asMap(value)
	switch mapped["status"] {
	case "ok":
		if supported, ok := mapped["supported"].(bool); ok {
			return fmt.Sprintf("%s (state %v)", map[bool]string{true: "supported", false: "unsupported"}[supported], mapped["state"])
		}
		if mimeTypes, ok := mapped["mimeTypes"].([]string); ok {
			if len(mimeTypes) == 0 {
				return "empty"
			}
			return strings.Join(mimeTypes, ", ")
		}
		return fmt.Sprintf("%v %v bytes", mapped["mimeType"], mapped["byteLength"])
	case "error":
		return "error: " + fmt.Sprint(mapped["error"])
	default:
		return fmt.Sprint(mapped["status"])
	}
}

func waitForPasteEvent(reader *terminalReader, stdout, stderr io.Writer, parser *Parser, timeout time.Duration, tmuxPassthrough bool) map[string]any {
	advertised := []string{}
	phase := "paste_event"
	request := map[string]any(nil)
	timer := time.NewTimer(timeout)
	defer timer.Stop()
	reset := func(next string) {
		phase = next
		if !timer.Stop() {
			select {
			case <-timer.C:
			default:
			}
		}
		timer.Reset(timeout)
	}
	if _, err := io.WriteString(stdout, PasteEventsModeSequence(true, tmuxPassthrough)); err != nil {
		return map[string]any{"status": "error", "error": err.Error(), "phase": phase}
	}
	if stderr != nil {
		_, _ = io.WriteString(stderr, "\x1b[33m[aih ssh-clipboard]\x1b[0m paste an image in this terminal now...\n")
	}
	for {
		select {
		case chunk := <-reader.chunks:
			output := parser.Consume(chunk)
			if len(output.PasteRequests) > 0 {
				item := output.PasteRequests[0]
				advertised = append([]string{}, item.MimeTypes...)
				request = map[string]any{
					"mimeType":    item.MimeType,
					"mimeTypes":   item.MimeTypes,
					"loc":         item.Loc,
					"passwordKey": item.PasswordKey,
				}
				reset("paste_event_read")
				if _, err := io.WriteString(stdout, OSC5522ReadMimeQuery(item.MimeType, "", item.Loc, item.Pw, item.PasswordKey, item.Name, tmuxPassthrough)); err != nil {
					return map[string]any{"status": "error", "error": err.Error(), "phase": phase, "mimeTypes": advertised, "request": request}
				}
				continue
			}
			if len(output.UnsupportedPasteNotifications) > 0 {
				advertised = append([]string{}, output.UnsupportedPasteNotifications[0].MimeTypes...)
				return map[string]any{"status": "error", "error": "paste_event_unsupported_mime", "phase": phase, "mimeTypes": advertised}
			}
			if len(output.Images) > 0 {
				return map[string]any{"status": "ok", "mimeTypes": advertised, "request": request, "image": summarizeImage(output.Images[0])}
			}
			if len(output.TextPastes) > 0 {
				return map[string]any{"status": "error", "error": "paste_event_text_only", "phase": phase, "mimeTypes": advertised, "request": request}
			}
			if len(output.Errors) > 0 {
				return map[string]any{"status": "error", "error": output.Errors[0].Error(), "phase": phase, "mimeTypes": advertised, "request": request}
			}
		case <-reader.done:
			return map[string]any{"status": "timeout", "phase": phase}
		case <-timer.C:
			return map[string]any{"status": "timeout", "phase": phase}
		}
	}
}

func buildProbeSummary(result map[string]any) map[string]any {
	pasteEvent, _ := result["pasteEvent"].(map[string]any)
	pasteOK := false
	if pasteEvent != nil && pasteEvent["status"] == "ok" {
		if image, ok := pasteEvent["image"].(map[string]any); ok && image["status"] == "ok" {
			pasteOK = true
		}
	}
	osc5522, _ := result["osc5522"].(map[string]any)
	osc52, _ := result["osc52"].(map[string]any)
	osc5522OK := osc5522 != nil && osc5522["status"] == "ok"
	osc52OK := osc52 != nil && osc52["status"] == "ok"
	reason := "no_terminal_image_data"
	if pasteOK {
		reason = "osc5522_paste_event_image_data"
	} else if osc5522OK {
		reason = "osc5522_image_data"
	} else if osc52OK {
		reason = "osc52_image_or_data_url"
	}
	return map[string]any{"supported": pasteOK || osc5522OK || osc52OK, "reason": reason}
}

func printHuman(result map[string]any, write func(string)) {
	write("AIH strict zero-client SSH clipboard probe")
	sshSession, _ := result["sshSession"].(bool)
	if sshSession {
		write("SSH session: yes")
	} else {
		write("SSH session: no")
	}
	write(fmt.Sprintf("TTY: stdin=%s stdout=%s", yesNo(result, "stdin"), yesNo(result, "stdout")))
	write("5522 paste-events: " + formatProbeStatus(result["pasteEvents"]))
	if pasteEvent, ok := result["pasteEvent"].(map[string]any); ok && pasteEvent["status"] != "skipped" {
		target := any(pasteEvent)
		if image, ok := pasteEvent["image"].(map[string]any); ok {
			target = image
		}
		write("5522 paste-event image: " + formatProbeStatus(target))
	}
	write("OSC 5522 MIME list: " + formatProbeStatus(result["mimeTypes"]))
	write("OSC 5522 image read: " + formatProbeStatus(result["osc5522"]))
	write("OSC 52 image/data-url read: " + formatProbeStatus(result["osc52"]))
	zeroClient, _ := result["zeroClient"].(map[string]any)
	if zeroClient != nil && zeroClient["supported"] == true {
		write("Result: terminal returned image data (" + fmt.Sprint(zeroClient["reason"]) + ")")
	} else {
		reason := "not_run"
		if zeroClient != nil {
			reason = fmt.Sprint(zeroClient["reason"])
		}
		write("Result: terminal did not return image data (" + reason + ")")
	}
}

func yesNo(result map[string]any, key string) string {
	tty, _ := result["tty"].(map[string]any)
	if tty != nil && tty[key] == true {
		return "yes"
	}
	return "no"
}

// RunProbe 执行诊断；stdin/stdout 必须是终端。
func RunProbe(arguments []string, stdin *os.File, stdout, stderr io.Writer, getenv func(string) string) int {
	options := ParseArgs(arguments)
	if len(arguments) > 0 && (arguments[0] == "--help" || arguments[0] == "-h" || arguments[0] == "help") {
		options.Help = true
	}
	if options.Help || options.Action == "--help" || options.Action == "-h" || options.Action == "help" {
		_, _ = fmt.Fprint(stdout, HelpText())
		return 0
	}
	if options.Action != "probe" {
		_, _ = fmt.Fprintf(stderr, "\x1b[31m[aih ssh-clipboard]\x1b[0m unknown action: %s\n", options.Action)
		_, _ = fmt.Fprint(stderr, HelpText())
		return 1
	}

	result := map[string]any{
		"ok":          true,
		"sshSession":  strings.TrimSpace(getenv("SSH_CONNECTION")) != "" || strings.TrimSpace(getenv("SSH_TTY")) != "",
		"tty":         map[string]any{"stdin": isTerminalFile(stdin), "stdout": isTerminalWriter(stdout)},
		"pasteEvents": map[string]any{"status": "skipped"},
		"pasteEvent":  map[string]any{"status": "skipped"},
		"mimeTypes":   map[string]any{"status": "skipped"},
		"osc5522":     map[string]any{"status": "skipped"},
		"osc52":       map[string]any{"status": "skipped"},
		"zeroClient":  map[string]any{"supported": false, "reason": "not_run"},
	}
	tty := result["tty"].(map[string]any)
	if tty["stdin"] != true || tty["stdout"] != true {
		result["ok"] = false
		result["zeroClient"] = map[string]any{"supported": false, "reason": "tty_required"}
	} else {
		previous, _ := term.MakeRaw(int(stdin.Fd()))
		defer func() {
			if previous != nil {
				_ = term.Restore(int(stdin.Fd()), previous)
			}
		}()
		tmuxPassthrough := strings.TrimSpace(getenv("TMUX")) != ""
		parser := NewParser(options.MaxBytes, nil)
		reader := newTerminalReader(stdin)
		defer reader.close()
		result["pasteEvents"] = waitForResponse(reader, stdout, parser, PasteEventsSupportQuery(tmuxPassthrough), options.Timeout, classifyPasteEventsSupport)
		if options.PasteEvent {
			result["pasteEvent"] = waitForPasteEvent(reader, stdout, stderr, parser, options.Timeout, tmuxPassthrough)
			_, _ = io.WriteString(stdout, PasteEventsModeSequence(false, tmuxPassthrough))
			result["zeroClient"] = buildProbeSummary(result)
		} else {
			result["mimeTypes"] = waitForResponse(reader, stdout, parser,
				OSC5522ListMimeTypesQuery(fmt.Sprintf("aih-probe-mimes-%d", time.Now().UnixMilli()), "", tmuxPassthrough),
				options.Timeout, classifyMimeList)
			imageMimeType := ""
			if statusString(result["mimeTypes"]) == "ok" {
				if values, ok := asMap(result["mimeTypes"])["mimeTypes"].([]string); ok {
					imageMimeType = chooseImageMimeType(values)
				} else if values, ok := asMap(result["mimeTypes"])["mimeTypes"].([]any); ok {
					converted := make([]string, 0, len(values))
					for _, value := range values {
						converted = append(converted, fmt.Sprint(value))
					}
					imageMimeType = chooseImageMimeType(converted)
				}
			}
			if imageMimeType != "" {
				result["osc5522"] = waitForResponse(reader, stdout, parser,
					OSC5522ReadMimeQuery(imageMimeType, fmt.Sprintf("aih-probe-image-%d", time.Now().UnixMilli()), "", "", "", "AIH clipboard probe", tmuxPassthrough),
					options.Timeout, classifyImageRead)
			} else {
				result["osc5522"] = waitForResponse(reader, stdout, parser,
					OSC5522ReadImageQuery(nil, fmt.Sprintf("aih-probe-image-%d", time.Now().UnixMilli()), tmuxPassthrough),
					options.Timeout, classifyImageRead)
			}
			if statusString(result["osc5522"]) == "error" && statusString(result["mimeTypes"]) == "ok" && imageMimeType != "" {
				asMap(result["osc5522"])["requestedMimeType"] = imageMimeType
			} else if statusString(result["osc5522"]) == "ok" && imageMimeType != "" {
				asMap(result["osc5522"])["requestedMimeType"] = imageMimeType
			}
			if statusString(result["osc5522"]) == "ok" {
				result["osc52"] = map[string]any{"status": "skipped"}
			} else {
				result["osc52"] = waitForResponse(reader, stdout, parser, OSC52ReadQuery("c", tmuxPassthrough), options.Timeout, classifyImageRead)
			}
			result["zeroClient"] = buildProbeSummary(result)
		}
	}

	if options.JSON {
		encoded, _ := json.Marshal(result)
		_, _ = fmt.Fprintln(stdout, string(encoded))
	} else {
		printHuman(result, func(line string) {
			writer := stderr
			if writer == nil {
				writer = stdout
			}
			_, _ = fmt.Fprintln(writer, line)
		})
	}
	if result["ok"] == true {
		return 0
	}
	return 1
}

func isTerminalFile(file *os.File) bool {
	return file != nil && term.IsTerminal(int(file.Fd()))
}

func isTerminalWriter(writer io.Writer) bool {
	file, ok := writer.(*os.File)
	return ok && term.IsTerminal(int(file.Fd()))
}
