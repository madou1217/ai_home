package terminalsession

import (
	"bytes"
	"regexp"
	"time"
)

// tmux stops recognizing its initial capability replies after five seconds.
// Leave headroom for delivery to the PTY: even the first late browser response
// must not become a key. Each capability has one live response slot shared by
// all viewers; a later query reopens it after the preceding answer is consumed.
const capabilityReplyWindow = 4 * time.Second
const maxProtocolSequenceBytes = 1024

var capabilityQuery = regexp.MustCompile("\x1b\\[(?:0?c|>0?c|\\?[0-9]+\\$p)")
var capabilityReply = regexp.MustCompile("\x1b\\[(?:\\?[0-9;]+c|>[0-9;]+c|\\?[0-9]+;[0-9]+\\$y)")

type terminalProtocol struct {
	outputTail []byte
	replyTail  []byte
	pending    map[string]time.Time
	expiring   bool
}

// Observe without withholding or rewriting output. This applies to local,
// remote and direct PTYs, including fresh queries after SSH reconnection and
// queries intentionally forwarded by a pane via tmux passthrough.
func (protocol *terminalProtocol) observe(output []byte, now time.Time) {
	previous := len(protocol.outputTail)
	joined := append(protocol.outputTail, output...)
	for key, expires := range protocol.pending {
		if !expires.IsZero() && !now.Before(expires) {
			delete(protocol.pending, key)
		}
	}
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
			protocol.pending = make(map[string]time.Time)
		}
		expires := time.Time{}
		if protocol.expiring {
			expires = now.Add(capabilityReplyWindow)
		}
		protocol.pending[key] = expires
	}
	start := len(joined) - maxProtocolSequenceBytes
	if start < 0 {
		start = 0
	}
	protocol.outputTail = append([]byte(nil), joined[start:]...)
}

func (protocol *terminalProtocol) filter(input []byte, now time.Time) []byte {
	return capabilityReply.ReplaceAllFunc(input, func(reply []byte) []byte {
		key := "primary"
		if reply[2] == '>' {
			key = "secondary"
		} else if bytes.HasSuffix(reply, []byte("$y")) {
			key = string(reply[3:bytes.IndexByte(reply, ';')])
		}
		expires, pending := protocol.pending[key]
		delete(protocol.pending, key)
		if !pending || (!expires.IsZero() && !now.Before(expires)) {
			return nil
		}
		return reply
	})
}
