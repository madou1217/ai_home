package proxyingress

import (
	"io"
	"net"
)

// relay copies both directions until one side ends, then closes both ends so
// the remaining copy unblocks. Buffered client or upstream bytes must be
// supplied by the caller and are drained before the raw connection.
func relay(client net.Conn, upstream io.ReadWriteCloser, upstreamReader, clientReader io.Reader) {
	if upstreamReader == nil {
		upstreamReader = upstream
	}
	if clientReader == nil {
		clientReader = client
	}
	done := make(chan struct{}, 2)
	go func() {
		_, _ = io.Copy(client, upstreamReader)
		done <- struct{}{}
	}()
	go func() {
		_, _ = io.Copy(upstream, clientReader)
		done <- struct{}{}
	}()
	<-done
	_ = client.Close()
	_ = upstream.Close()
	<-done
}

func writeAll(writer io.Writer, payload []byte) error {
	for len(payload) > 0 {
		written, err := writer.Write(payload)
		if err != nil {
			return err
		}
		if written <= 0 {
			return io.ErrShortWrite
		}
		payload = payload[written:]
	}
	return nil
}
