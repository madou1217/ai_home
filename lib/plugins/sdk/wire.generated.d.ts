// Generated from contracts/plugins/contract.json; DO NOT EDIT.

export type MessageKind = "hello" | "hello.result" | "call" | "result" | "error" | "cancel";

export type ErrorCode = "plugin_rpc_invalid" | "plugin_rpc_incompatible" | "plugin_rpc_unauthorized" | "plugin_rpc_metadata_limit" | "plugin_rpc_payload_limit" | "plugin_rpc_buffer_limit" | "plugin_rpc_inflight_limit" | "plugin_rpc_timeout" | "plugin_rpc_cancelled" | "plugin_rpc_closed" | "plugin_rpc_method_unknown" | "plugin_rpc_parent_unknown" | "plugin_next_called_twice" | "plugin_contribution_unknown" | "plugin_contribution_unavailable" | "plugin_generation_unknown" | "plugin_capability_requires_installers" | "app_install_descriptor_invalid" | "app_install_duplicate" | "app_install_status_invalid" | "app_install_operation_invalid" | "app_install_operation_unsupported" | "app_install_confirmation_required" | "app_install_payload_too_large" | "app_install_plugin_unavailable" | "app_install_proxy_invalid" | "network_connector_confirmation_required" | "network_connector_operation_required" | "network_connector_operation_unsupported" | "network_connector_unknown" | "network_connector_payload_too_large" | "network_connector_descriptor_invalid" | "network_connector_status_invalid" | "network_connector_operation_invalid" | "network_connector_duplicate";

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
  parent?: string;
  deadline?: number;
  value?: unknown;
  supported?: ProtocolRange;
  error?: Fault;
}
