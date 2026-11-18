package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/madou1217/ai_home/internal/adapters/desktopclientpaths"
	"github.com/madou1217/ai_home/internal/host/boundedinput"
)

func runDesktopClientPaths(ctx context.Context, runtime commandRuntime) error {
	ctx, stop := signal.NotifyContext(ctx, os.Interrupt, syscall.SIGTERM)
	defer stop()
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	invalid := errors.New("desktop_cache_request_invalid")
	raw, err := boundedinput.Read(ctx, runtime.stdin, 64*1024)
	defer clear(raw)
	if err != nil {
		return invalid
	}
	fields, err := desktopclientpaths.Object(raw)
	if err != nil {
		return invalid
	}
	var request desktopclientpaths.Request
	d := json.NewDecoder(bytes.NewReader(raw))
	d.DisallowUnknownFields()
	if d.Decode(&request) != nil {
		return invalid
	}
	names := []string{"intent", "operation", "aiHomeDir", "provider"}
	switch request.Operation {
	case "remember":
		names = append(names, "executablePath")
	case "forget":
		names = append(names, "expectedRecordSha256")
	case "get":
	default:
		return invalid
	}
	if len(fields) != len(names) {
		return invalid
	}
	for _, name := range names {
		value, ok := fields[name]
		if !ok || bytes.Equal(bytes.TrimSpace(value), []byte("null")) {
			return invalid
		}
	}
	if !desktopclientpaths.Validate(request) {
		return invalid
	}
	result := desktopclientpaths.Execute(ctx, request)
	if ctx.Err() != nil {
		return errors.New("desktop_cache_cancelled")
	}
	return json.NewEncoder(runtime.stdout).Encode(result)
}
