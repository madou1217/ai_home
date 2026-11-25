// Package acpclient implements the client half of the Agent Client Protocol
// (ACP) for an AGY process.
//
// The package is split along one axis only: protocol translation vs. workspace
// capabilities. Client owns the ACP method surface and maps wire events to a
// small domain vocabulary; FileSystem, TerminalHost and PermissionBroker are
// injected. That keeps provider/process details out of the client and makes a
// remote Workspace Connector host a drop-in replacement for the local host.
//
// ACP is deliberately used instead of MCP here because AGY 1.5+ exposes
// "agy acp" (JSON-RPC/NDJSON over stdio); MCP remains the channel for
// Codex/Claude. See docs/remote/2026-11-25-agy-acp-tool-loop.md.
package acpclient
