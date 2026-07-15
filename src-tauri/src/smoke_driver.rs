use std::{
    fs,
    path::{Path, PathBuf},
    sync::Arc,
};

use futures_util::StreamExt;
use serde::Serialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use crate::{
    endpoint::normalize_endpoint,
    error::{NativeError, NativeResult},
    profile_store::{ProfileService, ProfileUpsertInput},
    secret_store::{KeyringSecretStore, SharedSecretStore},
    server_http::{DesktopRequestInput, DesktopStreamInput, ServerHttp},
};

const SMOKE_MODE_ENV: &str = "AIH_DESKTOP_SMOKE_MODE";
const RUN_ID_ENV: &str = "AIH_DESKTOP_SMOKE_RUN_ID";
const SERVER_URL_ENV: &str = "AIH_DESKTOP_SMOKE_SERVER_URL";
const MANAGEMENT_KEY_ENV: &str = "AIH_DESKTOP_SMOKE_MANAGEMENT_KEY";
const RESULT_PATH_ENV: &str = "AIH_DESKTOP_SMOKE_RESULT_PATH";
const MAX_SMOKE_SSE_BYTES: usize = 1024 * 1024;

pub fn is_enabled() -> bool {
    std::env::var(SMOKE_MODE_ENV).as_deref() == Ok("1")
}

pub fn run() -> i32 {
    let environment = match SmokeEnvironment::read() {
        Ok(environment) => environment,
        Err(error) => {
            write_failure_from_partial_environment(&error);
            return 1;
        }
    };
    let result = tauri::async_runtime::block_on(execute(&environment));
    match result {
        Ok(evidence) if write_success(&environment, &evidence).is_ok() => 0,
        Ok(_) => 1,
        Err(error) => {
            let _write_result = write_failure(&environment, &error);
            1
        }
    }
}

struct SmokeEnvironment {
    run_id: String,
    server_url: String,
    management_key: String,
    result_path: PathBuf,
}

impl SmokeEnvironment {
    fn read() -> NativeResult<Self> {
        let run_id = required_env(RUN_ID_ENV)?;
        uuid::Uuid::parse_str(&run_id)
            .map_err(|_| NativeError::invalid_input("desktop smoke runId 无效。"))?;
        let server_url = normalize_endpoint(&required_env(SERVER_URL_ENV)?)?;
        if !server_url.starts_with("http://127.0.0.1:") {
            return Err(NativeError::invalid_input(
                "desktop smoke fixture 必须监听 127.0.0.1。",
            ));
        }
        let management_key = required_env(MANAGEMENT_KEY_ENV)?;
        if management_key.len() > 8192
            || management_key.contains('\r')
            || management_key.contains('\n')
        {
            return Err(NativeError::invalid_input(
                "desktop smoke Management Key 无效。",
            ));
        }
        let result_path = PathBuf::from(required_env(RESULT_PATH_ENV)?);
        if !result_path.is_absolute() {
            return Err(NativeError::invalid_input(
                "desktop smoke result path 必须是绝对路径。",
            ));
        }
        Ok(Self {
            run_id,
            server_url,
            management_key,
            result_path,
        })
    }
}

fn required_env(name: &str) -> NativeResult<String> {
    let value = std::env::var(name)
        .map_err(|_| NativeError::invalid_input("desktop smoke 环境变量不完整。"))?;
    if value.is_empty() {
        Err(NativeError::invalid_input("desktop smoke 环境变量不完整。"))
    } else {
        Ok(value)
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SmokeEvidence {
    schema_version: u8,
    run_id: String,
    platform: &'static str,
    keyring: KeyringEvidence,
    http: HttpEvidence,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct KeyringEvidence {
    backend: &'static str,
    stored: bool,
    read_back: bool,
    deleted: bool,
    missing_after_delete: bool,
}

#[derive(Serialize)]
struct HttpEvidence {
    json: JsonEvidence,
    sse: SseEvidence,
    blob: BlobEvidence,
}

#[derive(Serialize)]
struct JsonEvidence {
    status: u16,
    body: Value,
}

#[derive(Serialize)]
struct SseEvidence {
    status: u16,
    events: Vec<Value>,
    completed: bool,
}

#[derive(Serialize)]
struct BlobEvidence {
    status: u16,
    bytes: usize,
    sha256: String,
}

async fn execute(environment: &SmokeEnvironment) -> NativeResult<SmokeEvidence> {
    let temporary_dir =
        std::env::temp_dir().join(format!("aih-desktop-smoke-{}", environment.run_id));
    if temporary_dir.exists() {
        fs::remove_dir_all(&temporary_dir).map_err(|_| NativeError::storage())?;
    }
    fs::create_dir_all(&temporary_dir).map_err(|_| NativeError::storage())?;

    let secrets: SharedSecretStore = Arc::new(KeyringSecretStore);
    let profiles = ProfileService::load(&temporary_dir, secrets.clone())?;
    let http = ServerHttp::new(profiles.clone())?;
    let profile_id = format!("desktop-smoke-{}", environment.run_id);
    let profile = profiles.upsert(ProfileUpsertInput {
        id: Some(profile_id.clone()),
        name: "Desktop packaged smoke".to_string(),
        endpoint: environment.server_url.clone(),
        management_key: Some(environment.management_key.clone()),
        metadata: Some(json!({ "smokeRunId": environment.run_id })),
    })?;

    let transport_result =
        execute_authenticated_transports(environment, &profiles, &http, &profile_id).await;
    let delete_result = profiles.remove(&profile_id);
    if delete_result.is_err() {
        let _fallback_delete = secrets.delete(&profile.credential_ref);
    }
    let missing_after_delete = secrets
        .exists(&profile.credential_ref)
        .map(|exists| !exists);
    let cleanup_result = fs::remove_dir_all(&temporary_dir).map_err(|_| NativeError::storage());

    let transport = transport_result?;
    let (deleted, _) = delete_result?;
    let missing_after_delete = missing_after_delete?;
    cleanup_result?;
    Ok(SmokeEvidence {
        schema_version: 1,
        run_id: environment.run_id.clone(),
        platform: platform_name(),
        keyring: KeyringEvidence {
            backend: keyring_backend(),
            stored: profile.management_key_configured,
            read_back: transport.read_back,
            deleted,
            missing_after_delete,
        },
        http: transport.http,
    })
}

struct TransportEvidence {
    read_back: bool,
    http: HttpEvidence,
}

async fn execute_authenticated_transports(
    environment: &SmokeEnvironment,
    profiles: &ProfileService,
    http: &ServerHttp,
    profile_id: &str,
) -> NativeResult<TransportEvidence> {
    let credential = profiles.request_credential(profile_id)?;
    let read_back = credential.management_key == environment.management_key;
    drop(credential);
    if !read_back {
        return Err(NativeError::new(
            "smoke_keyring_readback_mismatch",
            "系统凭据库读回校验失败。",
            false,
        ));
    }

    let json_response = http
        .request_json(get_request(
            profile_id,
            "/v0/desktop-smoke/json",
            "application/json",
        ))
        .await?;
    let prepared = http
        .open_stream(&DesktopStreamInput {
            request_id: Some(format!("smoke-{}", environment.run_id)),
            profile_id: profile_id.to_string(),
            method: "GET".to_string(),
            path: "/v0/desktop-smoke/sse".to_string(),
            body: None,
            accept: Some("text/event-stream".to_string()),
            content_type: None,
            timeout_ms: Some(30_000),
        })
        .await?;
    let sse_status = prepared.status;
    let events = consume_smoke_sse(prepared.response).await?;
    let blob = http
        .download_blob(get_request(
            profile_id,
            "/v0/desktop-smoke/blob",
            "application/octet-stream",
        ))
        .await?;
    let digest = Sha256::digest(&blob.bytes);
    let sha256 = digest.iter().map(|byte| format!("{byte:02x}")).collect();

    Ok(TransportEvidence {
        read_back,
        http: HttpEvidence {
            json: JsonEvidence {
                status: json_response.status,
                body: json_response.body,
            },
            sse: SseEvidence {
                status: sse_status,
                events,
                completed: true,
            },
            blob: BlobEvidence {
                status: blob.status,
                bytes: blob.bytes.len(),
                sha256,
            },
        },
    })
}

fn get_request(profile_id: &str, path: &str, accept: &str) -> DesktopRequestInput {
    DesktopRequestInput {
        profile_id: profile_id.to_string(),
        method: "GET".to_string(),
        path: path.to_string(),
        body: None,
        accept: Some(accept.to_string()),
        content_type: None,
        timeout_ms: Some(30_000),
    }
}

async fn consume_smoke_sse(response: reqwest::Response) -> NativeResult<Vec<Value>> {
    let mut body = response.bytes_stream();
    let mut bytes = Vec::new();
    while let Some(chunk) = body.next().await {
        let chunk = chunk
            .map_err(|_| NativeError::new("smoke_sse_read_error", "读取 smoke SSE 失败。", true))?;
        if bytes.len().saturating_add(chunk.len()) > MAX_SMOKE_SSE_BYTES {
            return Err(NativeError::new(
                "response_too_large",
                "smoke SSE 响应过大。",
                false,
            ));
        }
        bytes.extend_from_slice(&chunk);
    }
    let text = String::from_utf8(bytes).map_err(|_| {
        NativeError::new("invalid_stream_response", "smoke SSE 不是 UTF-8。", false)
    })?;
    parse_smoke_sse(&text)
}

fn parse_smoke_sse(text: &str) -> NativeResult<Vec<Value>> {
    let normalized = text.replace("\r\n", "\n");
    let mut events = Vec::new();
    for frame in normalized
        .split("\n\n")
        .filter(|frame| !frame.trim().is_empty())
    {
        let mut event_name = "message";
        let mut data_lines = Vec::new();
        for line in frame.lines() {
            if let Some(value) = line.strip_prefix("event:") {
                event_name = value.trim();
            } else if let Some(value) = line.strip_prefix("data:") {
                data_lines.push(value.strip_prefix(' ').unwrap_or(value));
            }
        }
        if data_lines.is_empty() {
            continue;
        }
        let data = serde_json::from_str::<Value>(&data_lines.join("\n")).map_err(|_| {
            NativeError::new(
                "invalid_stream_response",
                "smoke SSE data 不是有效 JSON。",
                false,
            )
        })?;
        events.push(json!({ "event": event_name, "data": data }));
    }
    if events.is_empty() {
        return Err(NativeError::new(
            "invalid_stream_response",
            "smoke SSE 没有事件。",
            false,
        ));
    }
    Ok(events)
}

fn write_success(environment: &SmokeEnvironment, evidence: &SmokeEvidence) -> NativeResult<()> {
    let encoded = serde_json::to_vec_pretty(evidence).map_err(|_| NativeError::internal())?;
    if contains_secret(&encoded, environment.management_key.as_bytes()) {
        let _remove = fs::remove_file(&environment.result_path);
        return Err(NativeError::new(
            "smoke_evidence_secret_leak",
            "smoke evidence 安全检查失败。",
            false,
        ));
    }
    write_atomic(&environment.result_path, &encoded)
}

fn write_failure(environment: &SmokeEnvironment, error: &NativeError) -> NativeResult<()> {
    let encoded = serde_json::to_vec_pretty(&json!({
        "schemaVersion": 1,
        "runId": environment.run_id,
        "platform": platform_name(),
        "error": { "code": error.code }
    }))
    .map_err(|_| NativeError::internal())?;
    if contains_secret(&encoded, environment.management_key.as_bytes()) {
        return Err(NativeError::internal());
    }
    write_atomic(&environment.result_path, &encoded)
}

fn write_failure_from_partial_environment(error: &NativeError) {
    let Ok(path) = std::env::var(RESULT_PATH_ENV).map(PathBuf::from) else {
        return;
    };
    if !path.is_absolute() {
        return;
    }
    let run_id = std::env::var(RUN_ID_ENV).unwrap_or_default();
    let encoded = serde_json::to_vec_pretty(&json!({
        "schemaVersion": 1,
        "runId": run_id,
        "platform": platform_name(),
        "error": { "code": error.code }
    }));
    if let Ok(encoded) = encoded {
        if let Ok(secret) = std::env::var(MANAGEMENT_KEY_ENV) {
            if contains_secret(&encoded, secret.as_bytes()) {
                return;
            }
        }
        let _write_result = write_atomic(&path, &encoded);
    }
}

fn write_atomic(path: &Path, encoded: &[u8]) -> NativeResult<()> {
    let parent = path
        .parent()
        .ok_or_else(|| NativeError::invalid_input("smoke result path 无效。"))?;
    fs::create_dir_all(parent).map_err(|_| NativeError::storage())?;
    let temporary = path.with_extension("tmp");
    fs::write(&temporary, encoded).map_err(|_| NativeError::storage())?;
    if path.exists() {
        fs::remove_file(path).map_err(|_| NativeError::storage())?;
    }
    fs::rename(temporary, path).map_err(|_| NativeError::storage())
}

fn contains_secret(haystack: &[u8], secret: &[u8]) -> bool {
    !secret.is_empty()
        && haystack
            .windows(secret.len())
            .any(|window| window == secret)
}

#[cfg(target_os = "macos")]
fn platform_name() -> &'static str {
    "macos"
}

#[cfg(target_os = "windows")]
fn platform_name() -> &'static str {
    "windows"
}

#[cfg(target_os = "linux")]
fn platform_name() -> &'static str {
    "linux"
}

#[cfg(target_os = "macos")]
fn keyring_backend() -> &'static str {
    "macos-keychain"
}

#[cfg(target_os = "windows")]
fn keyring_backend() -> &'static str {
    "windows-credential-manager"
}

#[cfg(target_os = "linux")]
fn keyring_backend() -> &'static str {
    "linux-secret-service"
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn smoke_sse_parser_preserves_order_and_unicode() {
        let events = parse_smoke_sse(
            "event: meta\ndata: {\"sequence\":0}\n\nevent: delta\ndata: {\"sequence\":1,\"text\":\"跨平台\"}\n\n",
        )
        .unwrap();
        assert_eq!(events.len(), 2);
        assert_eq!(events[0]["event"], "meta");
        assert_eq!(events[1]["data"]["text"], "跨平台");
    }

    #[test]
    fn evidence_secret_scan_detects_exact_bytes() {
        assert!(contains_secret(b"prefix-secret-suffix", b"secret"));
        assert!(!contains_secret(b"safe evidence", b"secret"));
    }
}
