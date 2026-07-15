use std::{collections::HashMap, sync::Arc};

use base64::{engine::general_purpose::STANDARD, Engine};
use futures_util::{
    future::{AbortHandle, Abortable},
    StreamExt,
};
use rand::{distributions::Alphanumeric, Rng};
use serde::Serialize;
use tauri::Window;

use crate::{
    error::{NativeError, NativeResult},
    server_http::{validate_stream_chunk_size, PreparedStream},
};

pub const SERVER_STREAM_EVENT: &str = "aih://server-stream";

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StreamOpenResponse {
    pub request_id: String,
    pub status: u16,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ServerStreamEvent {
    request_id: String,
    sequence: u64,
    kind: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    chunk_base64: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error_code: Option<String>,
}

#[derive(Clone, Default)]
pub struct StreamRegistry {
    entries: Arc<std::sync::Mutex<HashMap<String, StreamEntry>>>,
}

struct StreamEntry {
    window_label: String,
    abort_handle: AbortHandle,
}

impl StreamRegistry {
    pub fn start(
        &self,
        requested_id: Option<&str>,
        prepared: PreparedStream,
        window: Window,
    ) -> NativeResult<StreamOpenResponse> {
        let request_id = match requested_id
            .map(str::trim)
            .filter(|value| !value.is_empty())
        {
            Some(value) => {
                validate_request_id(value)?;
                value.to_string()
            }
            None => generate_request_id(),
        };
        let (abort_handle, abort_registration) = AbortHandle::new_pair();
        self.insert(&request_id, window.label().to_string(), abort_handle)?;

        let response = StreamOpenResponse {
            request_id: request_id.clone(),
            status: prepared.status,
        };
        let registry = self.clone();
        tauri::async_runtime::spawn(async move {
            let task = async {
                let mut sequence = 0_u64;
                let mut body = prepared.response.bytes_stream();
                while let Some(next) = body.next().await {
                    let chunk = match next {
                        Ok(chunk) => chunk,
                        Err(_) => {
                            sequence = sequence.saturating_add(1);
                            emit_error(&window, &request_id, sequence, "network_error");
                            return;
                        }
                    };
                    if let Err(error) = validate_stream_chunk_size(chunk.len()) {
                        sequence = sequence.saturating_add(1);
                        emit_error(&window, &request_id, sequence, &error.code);
                        return;
                    }
                    sequence = sequence.saturating_add(1);
                    if window
                        .emit(
                            SERVER_STREAM_EVENT,
                            ServerStreamEvent {
                                request_id: request_id.clone(),
                                sequence,
                                kind: "chunk",
                                chunk_base64: Some(STANDARD.encode(chunk)),
                                error_code: None,
                            },
                        )
                        .is_err()
                    {
                        return;
                    }
                }
                sequence = sequence.saturating_add(1);
                let _emit_result = window.emit(
                    SERVER_STREAM_EVENT,
                    ServerStreamEvent {
                        request_id: request_id.clone(),
                        sequence,
                        kind: "end",
                        chunk_base64: None,
                        error_code: None,
                    },
                );
            };
            let _aborted = Abortable::new(task, abort_registration).await;
            registry.remove(&request_id);
        });
        Ok(response)
    }

    pub fn cancel(&self, request_id: &str, window_label: &str) -> NativeResult<bool> {
        validate_request_id(request_id)?;
        let entry = {
            let mut entries = self.entries.lock().map_err(|_| NativeError::internal())?;
            match entries.get(request_id) {
                Some(entry) if entry.window_label != window_label => {
                    return Err(NativeError::new(
                        "stream_owner_mismatch",
                        "不能取消其他窗口创建的数据流。",
                        false,
                    ));
                }
                Some(_) => entries.remove(request_id),
                None => None,
            }
        };
        if let Some(entry) = entry {
            entry.abort_handle.abort();
            Ok(true)
        } else {
            Ok(false)
        }
    }

    fn insert(
        &self,
        request_id: &str,
        window_label: String,
        abort_handle: AbortHandle,
    ) -> NativeResult<()> {
        let mut entries = self.entries.lock().map_err(|_| NativeError::internal())?;
        if entries.contains_key(request_id) {
            return Err(NativeError::new(
                "stream_request_id_conflict",
                "requestId 已存在。",
                false,
            ));
        }
        entries.insert(
            request_id.to_string(),
            StreamEntry {
                window_label,
                abort_handle,
            },
        );
        Ok(())
    }

    fn remove(&self, request_id: &str) {
        if let Ok(mut entries) = self.entries.lock() {
            entries.remove(request_id);
        }
    }
}

fn emit_error(window: &Window, request_id: &str, sequence: u64, error_code: &str) {
    let _emit_result = window.emit(
        SERVER_STREAM_EVENT,
        ServerStreamEvent {
            request_id: request_id.to_string(),
            sequence,
            kind: "error",
            chunk_base64: None,
            error_code: Some(error_code.to_string()),
        },
    );
}

fn generate_request_id() -> String {
    let random: String = rand::thread_rng()
        .sample_iter(&Alphanumeric)
        .take(24)
        .map(char::from)
        .collect();
    format!("stream-{}", random.to_ascii_lowercase())
}

fn validate_request_id(value: &str) -> NativeResult<()> {
    let valid = !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'));
    if valid {
        Ok(())
    } else {
        Err(NativeError::invalid_input("requestId 无效。"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stream_registry_rejects_conflicts_and_enforces_window_ownership() {
        let registry = StreamRegistry::default();
        let (first, _) = AbortHandle::new_pair();
        registry
            .insert("request-1", "main".to_string(), first)
            .unwrap();
        let (duplicate, _) = AbortHandle::new_pair();
        assert_eq!(
            registry
                .insert("request-1", "main".to_string(), duplicate)
                .unwrap_err()
                .code,
            "stream_request_id_conflict"
        );
        assert_eq!(
            registry.cancel("request-1", "other").unwrap_err().code,
            "stream_owner_mismatch"
        );
        assert!(registry.cancel("request-1", "main").unwrap());
        assert!(!registry.cancel("request-1", "main").unwrap());
    }

    #[test]
    fn stream_ids_reject_event_name_injection() {
        assert!(validate_request_id("good-request_1").is_ok());
        assert!(validate_request_id("bad/request").is_err());
        assert!(validate_request_id("bad:request").is_err());
    }
}
