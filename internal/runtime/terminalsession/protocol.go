package terminalsession

import (
	"bytes"
	"regexp"
)

// Multiple browser subscribers can answer the same tmux capability query.
// tmux consumes the first answer and forwards duplicates as literal TUI input.
// Track queries at the owning PTY so only one matching answer reaches it.
var capabilityQuery = regexp.MustCompile("\x1b\\[(?:0?c|>0?c|\\?[0-9]+\\$p)")
var capabilityReply = regexp.MustCompile("\x1b\\[(?:\\?[0-9;]+c|>[0-9;]+c|\\?[0-9]+;[0-9]+\\$y)")

type terminalProtocol struct {
	tail    []byte
	pending map[string]bool
}

func (protocol *terminalProtocol) observe(output []byte) {
	previous := len(protocol.tail)
	joined := append(protocol.tail, output...)
	for _, match := range capabilityQuery.FindAllIndex(joined, -1) {
		if match[1] <= previous {
			continue
		}
		query := joined[match[0]:match[1]]
		key := "primary"
		if query[2] == '>' {
			key = "secondary"
		} else if query[2] == '?' {
			key = string(query[3 : len(query)-2])
		}
		if protocol.pending == nil {
			protocol.pending = make(map[string]bool)
		}
		protocol.pending[key] = true
	}
	start := len(joined) - 64
	if start < 0 {
		start = 0
	}
	protocol.tail = append([]byte(nil), joined[start:]...)
}

func (protocol *terminalProtocol) filter(input []byte) []byte {
	return capabilityReply.ReplaceAllFunc(input, func(reply []byte) []byte {
		key := "primary"
		if reply[2] == '>' {
			key = "secondary"
		} else if bytes.HasSuffix(reply, []byte("$y")) {
			key = string(reply[3:bytes.IndexByte(reply, ';')])
		}
		if !protocol.pending[key] {
			return nil
		}
		delete(protocol.pending, key)
		return reply
	})
}
