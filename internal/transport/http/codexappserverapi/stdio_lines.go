package codexappserverapi

import (
	"bufio"
	"errors"
	"io"
)

var errAppServerLineTooLarge = errors.New("codex_app_server_line_too_large")

// Borrow complete short lines from bufio; long frames grow once amortized and
// never exceed the configured wire ceiling. A final unterminated frame is data,
// not a reason to silently discard the last response when a process exits.
func readAppServerLine(reader *bufio.Reader, limit int) ([]byte, error) {
	var line []byte
	for {
		fragment, err := reader.ReadSlice('\n')
		if len(line)+len(fragment) > limit+1 {
			return nil, errAppServerLineTooLarge
		}
		if len(line) == 0 && err != bufio.ErrBufferFull {
			return fragment, err
		}
		line = append(line, fragment...)
		if err == bufio.ErrBufferFull {
			continue
		}
		return line, err
	}
}

func discardAppServerLine(reader *bufio.Reader) error {
	for {
		_, err := reader.ReadSlice('\n')
		if err != bufio.ErrBufferFull {
			return err
		}
	}
}

func drainAppServerStderr(reader io.Reader, log func(string)) {
	if log == nil {
		_, _ = io.Copy(io.Discard, reader)
		return
	}
	buffer := bufio.NewReaderSize(reader, 16<<10)
	for {
		line, err := readAppServerLine(buffer, 64<<10)
		if errors.Is(err, errAppServerLineTooLarge) {
			log("codex_app_server_stderr_line_truncated")
			if discardAppServerLine(buffer) != nil {
				return
			}
			continue
		}
		if len(line) > 0 {
			log(string(line))
		}
		if err != nil {
			return
		}
	}
}
