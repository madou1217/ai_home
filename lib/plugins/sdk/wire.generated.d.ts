// Generated from contracts/plugins/contract.json; DO NOT EDIT.

export type MessageKind = "hello" | "hello.result" | "call" | "result" | "error" | "cancel";

export type ErrorCode = "plugin_rpc_invalid" | "plugin_rpc_incompatible" | "plugin_rpc_unauthorized" | "plugin_rpc_metadata_limit" | "plugin_rpc_payload_limit" | "plugin_rpc_buffer_limit" | "plugin_rpc_inflight_limit" | "plugin_rpc_timeout" | "plugin_rpc_cancelled" | "plugin_rpc_closed" | "plugin_rpc_method_unknown" | "plugin_contribution_unknown" | "plugin_contribution_unavailable" | "plugin_generation_unknown";

export interface Fault {
  code: string;
  message: string;
}

export interface ProtocolRange {
  min: number;
  max: number;
}

export interface Message {
  kind: string;
  protocolVersion: number;
  id: string;
  method?: string;
  token?: string;
  deadline?: number;
  value?: unknown;
  supported?: ProtocolRange;
  error?: Fault;
}
