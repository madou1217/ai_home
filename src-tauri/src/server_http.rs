use std::time::Duration;

use futures_util::StreamExt;
use reqwest::{
    header::{HeaderMap, HeaderValue, ACCEPT, AUTHORIZATION, CONTENT_DISPOSITION, CONTENT_TYPE},
    Client, Method, Response, StatusCode,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::{
    endpoint::build_request_url,
    error::{NativeError, NativeResult},
    profile_store::{normalize_management_key, ProfileService, ProfileSummary, RequestCredential},
};

const DEFAULT_TIMEOUT_MS: u64 = 10_000;
const MIN_TIMEOUT_MS: u64 = 1_000;
const MAX_TIMEOUT_MS: u64 = 120_000;
const MAX_JSON_BYTES: usize = 8 * 1024 * 1024;
pub const MAX_BLOB_BYTES: usize = 64 * 1024 * 1024;
const MAX_SESSION_MESSAGES_JSON_BYTES: usize = MAX_BLOB_BYTES;
const MAX_SSE_CHUNK_BYTES: usize = 1024 * 1024;

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopRequestInput {
    pub profile_id: String,
    pub method: String,
    pub path: String,
    #[serde(default)]
    pub body: Option<Value>,
    #[serde(default)]
    pub accept: Option<String>,
    #[serde(default)]
    pub content_type: Option<String>,
    #[serde(default)]
    pub timeout_ms: Option<u64>,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopStreamInput {
    #[serde(default)]
    pub request_id: Option<String>,
    pub profile_id: String,
    #[serde(default = "default_get_method")]
    pub method: String,
    pub path: String,
    #[serde(default)]
    pub body: Option<Value>,
    #[serde(default)]
    pub accept: Option<String>,
    #[serde(default)]
    pub content_type: Option<String>,
    #[serde(default)]
    pub timeout_ms: Option<u64>,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopManagementKeyRotateInput {
    pub profile_id: String,
    pub management_key: String,
}

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SafeResponseHeaders {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub content_type: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub content_disposition: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopHttpResponse {
    pub status: u16,
    pub headers: SafeResponseHeaders,
    pub body: Value,
}

pub struct BlobDownload {
    pub status: u16,
    pub content_type: String,
    pub content_disposition: Option<String>,
    pub bytes: Vec<u8>,
}

pub struct PreparedStream {
    pub status: u16,
    pub response: Response,
}

#[derive(Clone)]
pub struct ServerHttp {
    client: Client,
    profiles: ProfileService,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum TimeoutScope {
    EntireResponse,
    ResponseHeaders,
}

impl ServerHttp {
    pub fn new(profiles: ProfileService) -> NativeResult<Self> {
        let client = Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .connect_timeout(Duration::from_secs(10))
            .user_agent(concat!("aih-desktop/", env!("CARGO_PKG_VERSION")))
            .build()
            .map_err(|_| NativeError::internal())?;
        Ok(Self { client, profiles })
    }

    pub async fn request_json(
        &self,
        input: DesktopRequestInput,
    ) -> NativeResult<DesktopHttpResponse> {
        let response_limit = json_response_limit(&input.path);
        let response = self
            .send(
                input,
                Some("application/json"),
                TimeoutScope::EntireResponse,
            )
            .await?;
        let status = response.status().as_u16();
        let headers = safe_response_headers(response.headers());
        let bytes = read_limited(response, response_limit).await?;
        let body = if bytes.is_empty() {
            Value::Null
        } else {
            serde_json::from_slice(&bytes).map_err(|_| {
                NativeError::new("invalid_response", "Server 返回了无效的 JSON 响应。", false)
                    .with_status(status)
            })?
        };
        Ok(DesktopHttpResponse {
            status,
            headers,
            body,
        })
    }

    pub async fn rotate_management_key(
        &self,
        input: DesktopManagementKeyRotateInput,
    ) -> NativeResult<ProfileSummary> {
        let profile_id = input.profile_id.trim().to_string();
        let replacement = normalize_management_key(&input.management_key)?;
        if replacement.len() < 32 {
            return Err(NativeError::invalid_input(
                "Management Key 至少需要 32 个字符。",
            ));
        }

        let profiles = self.profiles.clone();
        let preflight_profile_id = profile_id.clone();
        tauri::async_runtime::spawn_blocking(move || {
            profiles.verify_management_key_storage(&preflight_profile_id)
        })
        .await
        .map_err(|_| NativeError::internal())??;

        let profiles = self.profiles.clone();
        let credential_profile_id = profile_id.clone();
        let current = tauri::async_runtime::spawn_blocking(move || {
            profiles.request_credential(&credential_profile_id)
        })
        .await
        .map_err(|_| NativeError::internal())??;

        self.replace_server_management_key(&current, &replacement)
            .await?;

        let profiles = self.profiles.clone();
        let update_profile_id = profile_id.clone();
        let update_replacement = replacement.clone();
        let local_update = tauri::async_runtime::spawn_blocking(move || {
            profiles.replace_management_key(&update_profile_id, &update_replacement)
        })
        .await
        .map_err(|_| NativeError::internal())?;
        match local_update {
            Ok(profile) => Ok(profile),
            Err(local_error) => {
                let replacement_credential = RequestCredential {
                    endpoint: current.endpoint.clone(),
                    management_key: replacement.clone(),
                };
                if self
                    .replace_server_management_key(&replacement_credential, &current.management_key)
                    .await
                    .is_ok()
                {
                    return Err(local_error);
                }

                // The rollback request can fail after the Server has already
                // switched. Retry the local commit once so the client remains
                // usable whenever Keyring recovers transiently.
                let profiles = self.profiles.clone();
                let recovery_profile_id = profile_id.clone();
                let recovery_replacement = replacement.clone();
                if let Ok(Ok(profile)) = tauri::async_runtime::spawn_blocking(move || {
                    profiles.replace_management_key(&recovery_profile_id, &recovery_replacement)
                })
                .await
                {
                    return Ok(profile);
                }
                Err(NativeError::new(
                    "management_key_rotation_recovery_failed",
                    "Server 已切换 Management Key，但系统凭据库更新失败。新 Key 仍显示在轮换窗口中，请勿关闭并重试保存。",
                    false,
                ))
            }
        }
    }

    pub async fn download_blob(&self, input: DesktopRequestInput) -> NativeResult<BlobDownload> {
        if !input.method.eq_ignore_ascii_case("GET") {
            return Err(NativeError::invalid_input("Blob 请求仅支持 GET。"));
        }
        let response = self
            .send(
                input,
                Some("application/octet-stream"),
                TimeoutScope::EntireResponse,
            )
            .await?;
        let status = response.status();
        if !status.is_success() {
            return Err(http_status_error(status));
        }
        let headers = safe_response_headers(response.headers());
        let bytes = read_limited(response, MAX_BLOB_BYTES).await?;
        Ok(BlobDownload {
            status: status.as_u16(),
            content_type: headers
                .content_type
                .unwrap_or_else(|| "application/octet-stream".to_string()),
            content_disposition: headers.content_disposition,
            bytes,
        })
    }

    pub async fn open_stream(&self, input: &DesktopStreamInput) -> NativeResult<PreparedStream> {
        let request = DesktopRequestInput {
            profile_id: input.profile_id.clone(),
            method: input.method.clone(),
            path: input.path.clone(),
            body: input.body.clone(),
            accept: input
                .accept
                .clone()
                .or_else(|| Some("text/event-stream".to_string())),
            content_type: input.content_type.clone(),
            timeout_ms: input.timeout_ms,
        };
        let response = self
            .send(
                request,
                Some("text/event-stream"),
                TimeoutScope::ResponseHeaders,
            )
            .await?;
        let status = response.status();
        if !status.is_success() {
            return Err(http_status_error(status));
        }
        let content_type = response
            .headers()
            .get(CONTENT_TYPE)
            .and_then(|value| value.to_str().ok())
            .unwrap_or("")
            .to_ascii_lowercase();
        if !content_type.starts_with("text/event-stream") {
            return Err(NativeError::new(
                "invalid_stream_response",
                "Server 未返回 SSE 数据流。",
                false,
            )
            .with_status(status.as_u16()));
        }
        Ok(PreparedStream {
            status: status.as_u16(),
            response,
        })
    }

    async fn send(
        &self,
        input: DesktopRequestInput,
        default_accept: Option<&str>,
        timeout_scope: TimeoutScope,
    ) -> NativeResult<Response> {
        if input
            .body
            .as_ref()
            .map(body_contains_native_credential)
            .unwrap_or(false)
        {
            return Err(NativeError::new(
                "native_request_contains_management_credential",
                "原生请求体不能包含 Management Key 或 Authorization。",
                false,
            ));
        }
        let profile_id = input.profile_id.clone();
        let profiles = self.profiles.clone();
        let credential =
            tauri::async_runtime::spawn_blocking(move || profiles.request_credential(&profile_id))
                .await
                .map_err(|_| NativeError::internal())??;
        let method = parse_method(&input.method)?;
        let url = build_request_url(&credential.endpoint, &input.path)?;
        let timeout_ms = input
            .timeout_ms
            .unwrap_or(DEFAULT_TIMEOUT_MS)
            .clamp(MIN_TIMEOUT_MS, MAX_TIMEOUT_MS);
        let mut request = self.client.request(method, url);
        request = attach_safe_headers(
            request,
            credential,
            input.accept.as_deref().or(default_accept),
            input.content_type.as_deref(),
            input.body.is_some(),
        )?;
        if let Some(body) = input.body {
            request = request.json(&body);
        }
        match timeout_scope {
            TimeoutScope::EntireResponse => request
                .timeout(Duration::from_millis(timeout_ms))
                .send()
                .await
                .map_err(map_reqwest_error),
            TimeoutScope::ResponseHeaders => {
                match tokio::time::timeout(Duration::from_millis(timeout_ms), request.send()).await
                {
                    Ok(result) => result.map_err(map_reqwest_error),
                    Err(_) => Err(NativeError::new(
                        "request_timeout",
                        "等待 Server 响应超时。",
                        true,
                    )),
                }
            }
        }
    }

    async fn replace_server_management_key(
        &self,
        credential: &RequestCredential,
        replacement: &str,
    ) -> NativeResult<()> {
        let url = build_request_url(
            &credential.endpoint,
            "/v0/webui/server-config/management-key/rotate",
        )?;
        let authorization = HeaderValue::from_str(&format!("Bearer {}", credential.management_key))
            .map_err(|_| NativeError::invalid_input("Management Key 无效。"))?;
        let response = self
            .client
            .post(url)
            .header(AUTHORIZATION, authorization)
            .header(ACCEPT, "application/json")
            .json(&serde_json::json!({ "managementKey": replacement }))
            .timeout(Duration::from_millis(DEFAULT_TIMEOUT_MS))
            .send()
            .await
            .map_err(map_reqwest_error)?;
        let status = response.status();
        if !status.is_success() {
            return Err(http_status_error(status));
        }
        let body = read_limited(response, MAX_JSON_BYTES).await?;
        let payload = serde_json::from_slice::<Value>(&body).map_err(|_| {
            NativeError::new(
                "invalid_response",
                "Server 返回了无效的 Management Key 轮换响应。",
                false,
            )
            .with_status(status.as_u16())
        })?;
        if payload.get("ok").and_then(Value::as_bool) != Some(true) {
            return Err(NativeError::new(
                "management_key_rotation_rejected",
                "Server 未确认 Management Key 轮换。",
                false,
            )
            .with_status(status.as_u16()));
        }
        Ok(())
    }
}

fn body_contains_native_credential(value: &Value) -> bool {
    match value {
        Value::Object(object) => object.iter().any(|(key, nested)| {
            let normalized = key
                .chars()
                .filter(|character| character.is_ascii_alphanumeric())
                .flat_map(char::to_lowercase)
                .collect::<String>();
            matches!(normalized.as_str(), "managementkey" | "authorization")
                || body_contains_native_credential(nested)
        }),
        Value::Array(items) => items.iter().any(body_contains_native_credential),
        _ => false,
    }
}

fn default_get_method() -> String {
    "GET".to_string()
}

fn attach_safe_headers(
    mut request: reqwest::RequestBuilder,
    credential: RequestCredential,
    accept: Option<&str>,
    content_type: Option<&str>,
    has_body: bool,
) -> NativeResult<reqwest::RequestBuilder> {
    let authorization = HeaderValue::from_str(&format!("Bearer {}", credential.management_key))
        .map_err(|_| NativeError::invalid_input("Management Key 无效。"))?;
    request = request.header(AUTHORIZATION, authorization);
    if let Some(value) = accept {
        request = request.header(ACCEPT, safe_header_value(value, "Accept")?);
    }
    if has_body {
        let value = content_type.unwrap_or("application/json");
        request = request.header(CONTENT_TYPE, safe_header_value(value, "Content-Type")?);
    } else if content_type.is_some() {
        return Err(NativeError::invalid_input(
            "无请求体时不能设置 Content-Type。",
        ));
    }
    Ok(request)
}

fn safe_header_value(value: &str, label: &str) -> NativeResult<HeaderValue> {
    if value.is_empty() || value.len() > 256 {
        return Err(NativeError::invalid_input(&format!("{label} 无效。")));
    }
    HeaderValue::from_str(value).map_err(|_| NativeError::invalid_input(&format!("{label} 无效。")))
}

fn parse_method(value: &str) -> NativeResult<Method> {
    match value.trim().to_ascii_uppercase().as_str() {
        "GET" => Ok(Method::GET),
        "POST" => Ok(Method::POST),
        "PUT" => Ok(Method::PUT),
        "PATCH" => Ok(Method::PATCH),
        "DELETE" => Ok(Method::DELETE),
        _ => Err(NativeError::invalid_input("HTTP method 不受支持。")),
    }
}

fn safe_response_headers(headers: &HeaderMap) -> SafeResponseHeaders {
    SafeResponseHeaders {
        content_type: safe_response_header(headers, CONTENT_TYPE),
        content_disposition: safe_response_header(headers, CONTENT_DISPOSITION),
    }
}

fn safe_response_header(headers: &HeaderMap, name: reqwest::header::HeaderName) -> Option<String> {
    headers
        .get(name)
        .and_then(|value| value.to_str().ok())
        .filter(|value| value.len() <= 1024 && !value.contains('\r') && !value.contains('\n'))
        .map(str::to_string)
}

fn json_response_limit(path: &str) -> usize {
    let pathname = path.split('?').next().unwrap_or("");
    let segments = pathname
        .split('/')
        .filter(|segment| !segment.is_empty())
        .collect::<Vec<_>>();
    if segments.len() == 6
        && segments[0] == "v0"
        && segments[1] == "webui"
        && segments[2] == "sessions"
        && !segments[3].is_empty()
        && !segments[4].is_empty()
        && segments[5] == "messages"
    {
        return MAX_SESSION_MESSAGES_JSON_BYTES;
    }
    MAX_JSON_BYTES
}

async fn read_limited(response: Response, limit: usize) -> NativeResult<Vec<u8>> {
    if response.content_length().map(|size| size > limit as u64) == Some(true) {
        return Err(NativeError::new(
            "response_too_large",
            "Server 响应超过原生客户端安全限制。",
            false,
        ));
    }
    let mut stream = response.bytes_stream();
    let mut bytes = Vec::new();
    while let Some(chunk) = stream.next().await {
        let chunk =
            chunk.map_err(|_| NativeError::new("network_error", "读取 Server 响应失败。", true))?;
        if bytes.len().saturating_add(chunk.len()) > limit {
            return Err(NativeError::new(
                "response_too_large",
                "Server 响应超过原生客户端安全限制。",
                false,
            ));
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok(bytes)
}

pub fn validate_stream_chunk_size(size: usize) -> NativeResult<()> {
    if size > MAX_SSE_CHUNK_BYTES {
        Err(NativeError::new(
            "stream_chunk_too_large",
            "Server 数据流单个分块过大。",
            false,
        ))
    } else {
        Ok(())
    }
}

fn map_reqwest_error(error: reqwest::Error) -> NativeError {
    if error.is_timeout() {
        NativeError::new("request_timeout", "连接 Server 超时。", true)
    } else if error.is_redirect() {
        NativeError::new(
            "unexpected_redirect",
            "Server 返回了不允许的重定向。",
            false,
        )
    } else {
        NativeError::new("network_error", "无法连接 Server。", true)
    }
}

fn http_status_error(status: StatusCode) -> NativeError {
    NativeError::new(
        "http_status_error",
        "Server 拒绝了原生客户端请求。",
        status.is_server_error(),
    )
    .with_status(status.as_u16())
}

#[cfg(test)]
mod tests {
    use std::{
        fs,
        io::{Read, Write},
        net::TcpListener,
        path::PathBuf,
        thread,
    };

    use crate::{profile_store::ProfileUpsertInput, secret_store::testing::MemorySecretStore};

    use super::*;
    use rand::Rng;

    fn test_dir() -> PathBuf {
        let path =
            std::env::temp_dir().join(format!("aih-http-test-{}", rand::thread_rng().gen::<u64>()));
        fs::create_dir_all(&path).unwrap();
        path
    }

    fn local_service(endpoint: String) -> (ServerHttp, PathBuf) {
        let directory = test_dir();
        let profiles = ProfileService::load(&directory, MemorySecretStore::shared()).unwrap();
        profiles
            .upsert(ProfileUpsertInput {
                id: Some("local".to_string()),
                name: "Local".to_string(),
                endpoint,
                management_key: Some("test-management-key".to_string()),
                metadata: None,
            })
            .unwrap();
        (ServerHttp::new(profiles).unwrap(), directory)
    }

    fn read_local_response(
        body: Vec<u8>,
        content_length: usize,
        limit: usize,
    ) -> NativeResult<Vec<u8>> {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let server = thread::spawn(move || {
            let (mut socket, _) = listener.accept().unwrap();
            let mut request = [0_u8; 1024];
            let _read = socket.read(&mut request).unwrap();
            let headers = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {content_length}\r\n\r\n"
            );
            socket.write_all(headers.as_bytes()).unwrap();
            socket.write_all(&body).unwrap();
        });
        let result = tauri::async_runtime::block_on(async {
            let response = Client::new()
                .get(format!("http://{address}/session"))
                .send()
                .await
                .unwrap();
            read_limited(response, limit).await
        });
        server.join().unwrap();
        result
    }

    #[test]
    fn request_injects_authorization_without_putting_it_in_the_url() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let server = thread::spawn(move || {
            let (mut socket, _) = listener.accept().unwrap();
            let mut buffer = [0_u8; 8192];
            let read = socket.read(&mut buffer).unwrap();
            let request = String::from_utf8_lossy(&buffer[..read]).to_string();
            socket
        .write_all(
          b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 11\r\n\r\n{\"ok\":true}",
        )
        .unwrap();
            request
        });
        let (http, directory) = local_service(format!("http://{address}"));
        let response = tauri::async_runtime::block_on(http.request_json(DesktopRequestInput {
            profile_id: "local".to_string(),
            method: "GET".to_string(),
            path: "/v0/status?limit=1".to_string(),
            body: None,
            accept: None,
            content_type: None,
            timeout_ms: None,
        }))
        .unwrap();
        assert_eq!(response.body["ok"], true);
        let request = server.join().unwrap();
        assert!(request.starts_with("GET /v0/status?limit=1 HTTP/1.1"));
        assert!(request
            .to_ascii_lowercase()
            .contains("authorization: bearer test-management-key"));
        assert!(!request
            .lines()
            .next()
            .unwrap()
            .contains("test-management-key"));
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn dedicated_rotation_uses_old_bearer_then_updates_the_keyring_profile() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let server = thread::spawn(move || {
            let (mut socket, _) = listener.accept().unwrap();
            let mut received = Vec::new();
            let mut buffer = [0_u8; 8192];
            loop {
                let read = socket.read(&mut buffer).unwrap();
                if read == 0 {
                    break;
                }
                received.extend_from_slice(&buffer[..read]);
                let text = String::from_utf8_lossy(&received);
                if let Some(header_end) = text.find("\r\n\r\n") {
                    let content_length = text[..header_end]
                        .lines()
                        .find_map(|line| {
                            line.to_ascii_lowercase()
                                .strip_prefix("content-length: ")
                                .and_then(|value| value.parse::<usize>().ok())
                        })
                        .unwrap_or(0);
                    if received.len() >= header_end + 4 + content_length {
                        break;
                    }
                }
            }
            socket
                .write_all(
                    b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 11\r\n\r\n{\"ok\":true}",
                )
                .unwrap();
            String::from_utf8(received).unwrap()
        });

        let directory = test_dir();
        let profiles = ProfileService::load(&directory, MemorySecretStore::shared()).unwrap();
        profiles
            .upsert(ProfileUpsertInput {
                id: Some("local".to_string()),
                name: "Local".to_string(),
                endpoint: format!("http://{address}"),
                management_key: Some("old-management-key-that-is-long-enough".to_string()),
                metadata: None,
            })
            .unwrap();
        let http = ServerHttp::new(profiles.clone()).unwrap();
        let summary = tauri::async_runtime::block_on(http.rotate_management_key(
            DesktopManagementKeyRotateInput {
                profile_id: "local".to_string(),
                management_key: "new-management-key-that-is-long-enough".to_string(),
            },
        ))
        .unwrap();

        let request = server.join().unwrap();
        assert!(request.starts_with("POST /v0/webui/server-config/management-key/rotate HTTP/1.1"));
        assert!(request
            .to_ascii_lowercase()
            .contains("authorization: bearer old-management-key-that-is-long-enough"));
        assert!(request.contains("new-management-key-that-is-long-enough"));
        assert!(summary.management_key_configured);
        assert_eq!(
            profiles.request_credential("local").unwrap().management_key,
            "new-management-key-that-is-long-enough"
        );
        assert!(!serde_json::to_string(&summary)
            .unwrap()
            .contains("new-management-key"));
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn authenticated_request_never_follows_redirects() {
        let redirect_target = TcpListener::bind("127.0.0.1:0").unwrap();
        redirect_target.set_nonblocking(true).unwrap();
        let redirect_target_address = redirect_target.local_addr().unwrap();
        let target = thread::spawn(move || {
            let deadline = std::time::Instant::now() + Duration::from_millis(500);
            while std::time::Instant::now() < deadline {
                match redirect_target.accept() {
                    Ok((_socket, _)) => return true,
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                        thread::sleep(Duration::from_millis(10));
                    }
                    Err(error) => panic!("redirect target accept failed: {error}"),
                }
            }
            false
        });

        let origin = TcpListener::bind("127.0.0.1:0").unwrap();
        let origin_address = origin.local_addr().unwrap();
        let origin_server = thread::spawn(move || {
            let (mut socket, _) = origin.accept().unwrap();
            let mut buffer = [0_u8; 4096];
            let _read = socket.read(&mut buffer).unwrap();
            let response = format!(
                "HTTP/1.1 302 Found\r\nLocation: http://{redirect_target_address}/v0/capture\r\nContent-Length: 0\r\n\r\n"
            );
            socket.write_all(response.as_bytes()).unwrap();
        });
        let (http, directory) = local_service(format!("http://{origin_address}"));
        let response = tauri::async_runtime::block_on(http.request_json(DesktopRequestInput {
            profile_id: "local".to_string(),
            method: "GET".to_string(),
            path: "/v0/redirect".to_string(),
            body: None,
            accept: None,
            content_type: None,
            timeout_ms: None,
        }))
        .unwrap();
        assert_eq!(response.status, 302);
        origin_server.join().unwrap();
        assert!(!target.join().unwrap());
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn unsupported_headers_and_methods_are_rejected() {
        assert!(parse_method("OPTIONS").is_err());
        assert!(safe_header_value("bad\nheader", "Accept").is_err());
        assert!(validate_stream_chunk_size(MAX_SSE_CHUNK_BYTES + 1).is_err());
        assert!(body_contains_native_credential(&serde_json::json!({
            "nested": [{ "management_key": "must-not-cross-ipc" }]
        })));
        assert!(!body_contains_native_credential(&serde_json::json!({
            "model": "claude",
            "stream": true
        })));
    }

    #[test]
    fn json_response_budget_reads_an_untruncated_nine_mib_session_message() {
        let body = vec![b'x'; 9 * 1024 * 1024];
        let limit = json_response_limit(
            "/v0/webui/sessions/codex/session-id/messages?projectDirName=encoded&limit=50",
        );

        let response = read_local_response(body.clone(), body.len(), limit).unwrap();

        assert_eq!(limit, MAX_SESSION_MESSAGES_JSON_BYTES);
        assert_eq!(response, body);
    }

    #[test]
    fn json_response_budget_keeps_other_endpoints_at_eight_mib() {
        let limit = json_response_limit("/v0/webui/accounts");
        let error = read_local_response(Vec::new(), limit + 1, limit).unwrap_err();

        assert_eq!(limit, MAX_JSON_BYTES);
        assert_eq!(error.code, "response_too_large");
    }

    #[test]
    fn json_response_budget_rejects_a_session_message_over_sixty_four_mib() {
        let limit = json_response_limit("/v0/webui/sessions/claude/session-id/messages");
        let error = read_local_response(Vec::new(), limit + 1, limit).unwrap_err();

        assert_eq!(limit, MAX_SESSION_MESSAGES_JSON_BYTES);
        assert_eq!(error.code, "response_too_large");
    }

    #[test]
    fn stream_timeout_scope_is_distinct_from_entire_response_timeout() {
        assert_eq!(TimeoutScope::ResponseHeaders, TimeoutScope::ResponseHeaders);
        assert_ne!(TimeoutScope::ResponseHeaders, TimeoutScope::EntireResponse);
    }

    #[test]
    fn stream_body_can_outlive_the_response_header_timeout() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let server = thread::spawn(move || {
            let (mut socket, _) = listener.accept().unwrap();
            let mut buffer = [0_u8; 4096];
            let _read = socket.read(&mut buffer).unwrap();
            socket
                .write_all(
                    b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: 13\r\n\r\n",
                )
                .unwrap();
            socket.flush().unwrap();
            thread::sleep(Duration::from_millis(1_200));
            socket.write_all(b"data: ready\n\n").unwrap();
        });
        let (http, directory) = local_service(format!("http://{address}"));
        let bytes = tauri::async_runtime::block_on(async {
            let prepared = http
                .open_stream(&DesktopStreamInput {
                    request_id: Some("long-stream".to_string()),
                    profile_id: "local".to_string(),
                    method: "GET".to_string(),
                    path: "/v0/long-stream".to_string(),
                    body: None,
                    accept: Some("text/event-stream".to_string()),
                    content_type: None,
                    timeout_ms: Some(1_000),
                })
                .await
                .unwrap();
            prepared.response.bytes().await.unwrap()
        });
        assert_eq!(bytes.as_ref(), b"data: ready\n\n");
        server.join().unwrap();
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn stream_open_forwards_post_body_exactly_once() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let server = thread::spawn(move || {
            let (mut socket, _) = listener.accept().unwrap();
            let mut received = Vec::new();
            let mut buffer = [0_u8; 8192];
            loop {
                let read = socket.read(&mut buffer).unwrap();
                if read == 0 {
                    break;
                }
                received.extend_from_slice(&buffer[..read]);
                let text = String::from_utf8_lossy(&received);
                if let Some(header_end) = text.find("\r\n\r\n") {
                    let content_length = text[..header_end]
                        .lines()
                        .find_map(|line| {
                            line.to_ascii_lowercase()
                                .strip_prefix("content-length: ")
                                .and_then(|value| value.parse::<usize>().ok())
                        })
                        .unwrap_or(0);
                    if received.len() >= header_end + 4 + content_length {
                        break;
                    }
                }
            }
            socket
                .write_all(
                    b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: 13\r\n\r\ndata: ready\n\n",
                )
                .unwrap();
            String::from_utf8_lossy(&received).to_string()
        });
        let (http, directory) = local_service(format!("http://{address}"));
        let prepared = tauri::async_runtime::block_on(http.open_stream(&DesktopStreamInput {
            request_id: Some("post-stream".to_string()),
            profile_id: "local".to_string(),
            method: "POST".to_string(),
            path: "/v0/chat/completions".to_string(),
            body: Some(serde_json::json!({ "stream": true, "message": "hello" })),
            accept: Some("text/event-stream".to_string()),
            content_type: Some("application/json".to_string()),
            timeout_ms: None,
        }))
        .unwrap();
        assert_eq!(prepared.status, 200);
        drop(prepared);
        let request = server.join().unwrap();
        assert!(request.starts_with("POST /v0/chat/completions HTTP/1.1"));
        assert!(request
            .to_ascii_lowercase()
            .contains("content-type: application/json"));
        assert!(request.contains("\"stream\":true"));
        assert!(request.contains("\"message\":\"hello\""));
        fs::remove_dir_all(directory).unwrap();
    }
}
