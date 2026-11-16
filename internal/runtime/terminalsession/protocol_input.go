package terminalsession

import (
	"bytes"
	"time"
)

// Machine replies have their own stream. They may be split across calls with
// arbitrary pauses; user Escape keys, UTF-8 and paste bytes never enter it.
// Bound a malformed/incomplete machine frame without timing out user input.
func (protocol *terminalProtocol) filterReply(input []byte, now time.Time) []byte {
	input = append(protocol.replyTail, input...)
	protocol.replyTail = nil
	output := make([]byte, 0, len(input))
	for len(input) > 0 {
		start := bytes.IndexByte(input, '\x1b')
		if start < 0 {
			break
		}
		input = input[start:]
		length, complete, valid := terminalReplyLength(input)
		if !complete {
			protocol.replyTail = append([]byte(nil), input...)
			break
		}
		if valid {
			sequence := input[:length]
			if input[1] == '[' {
				sequence = protocol.filter(sequence, now)
			}
			output = append(output, sequence...)
		}
		if length == 0 {
			length = 1
		}
		input = input[length:]
	}
	return output
}

// CSI, OSC and DCS replies are emitted by xterm as complete events. Framing
// also protects clients that transport a reply as multiple typed requests.
func terminalReplyLength(input []byte) (int, bool, bool) {
	if len(input) < 2 {
		return 0, false, false
	}
	switch input[1] {
	case '[':
		for index := 2; index < len(input) && index < maxProtocolSequenceBytes; index++ {
			if input[index] >= 0x40 && input[index] <= 0x7e {
				return index + 1, true, true
			}
			if input[index] < 0x20 || input[index] > 0x3f {
				return index, true, false
			}
		}
	case ']', 'P':
		for index := 2; index < len(input) && index < maxProtocolSequenceBytes; index++ {
			if input[index] == '\x07' {
				return index + 1, true, true
			}
			if input[index] == '\x1b' && index+1 < len(input) && input[index+1] == '\\' {
				return index + 2, true, true
			}
			if input[index] == '\x1b' && index+1 < len(input) {
				return index, true, false
			}
		}
	default:
		return 1, true, false
	}
	if len(input) >= maxProtocolSequenceBytes {
		return 1, true, false
	}
	return 0, false, false
}
