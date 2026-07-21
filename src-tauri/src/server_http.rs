use std::{
    collections::HashSet,
    time::{Duration, Instant},
};

use futures_util::StreamExt;
use reqwest::{
    header::{HeaderMap, HeaderValue, ACCEPT, AUTHORIZATION, CONTENT_DISPOSITION, CONTENT_TYPE},
    Client, Method, Response, StatusCode,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};

use crate::{
    endpoint::build_request_url,
    error::{NativeError, NativeResult},
    lan_route_trust::verify_discovered_lan_routes,
    profile_store::{normalize_management_key, ProfileService, ProfileSummary, RequestCredential},
    secret_store::TrustedRouteEnvelope,
    server_discovery::discover_servers,
    server_id::require_server_id,
    server_route_runtime::{RouteCandidate, RouteHealth, ServerRouteRuntime},
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

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopOutboundRelayConfigureInput {
    pub local_profile_id: String,
    pub relay_profile_ids: Vec<String>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopFrpRouteConfigureInput {
    pub provider_profile_id: String,
    pub visitor_profile_ids: Vec<String>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopRelayRouteTrustInput {
    pub source_profile_id: String,
    pub target_profile_id: String,
    pub target_stable_server_id: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopLanProfileAuthorizeInput {
    pub profile_id: String,
    pub management_key: String,
    #[serde(default)]
    pub timeout_ms: Option<u64>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopLanRoutesRefreshInput {
    pub profile_ids: Vec<String>,
    #[serde(default)]
    pub timeout_ms: Option<u64>,
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
    routes: ServerRouteRuntime,
    frp_probe_timeout: Duration,
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
        Ok(Self {
            client,
            profiles,
            routes: ServerRouteRuntime::default(),
            frp_probe_timeout: Duration::from_millis(DEFAULT_TIMEOUT_MS),
        })
    }

    #[cfg(test)]
    fn with_frp_probe_timeout(mut self, timeout: Duration) -> Self {
        self.frp_probe_timeout = timeout;
        self
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

    pub async fn configure_outbound_relays(
        &self,
        input: DesktopOutboundRelayConfigureInput,
    ) -> NativeResult<Value> {
        let local_profile_id = input.local_profile_id.trim().to_string();
        let relay_profile_ids = input
            .relay_profile_ids
            .into_iter()
            .map(|profile_id| profile_id.trim().to_string())
            .filter(|profile_id| !profile_id.is_empty())
            .collect::<Vec<_>>();
        if relay_profile_ids.is_empty() || relay_profile_ids.len() > 5 {
            return Err(NativeError::new(
                "invalid_outbound_relay_count",
                "请选择 1 至 5 个公网 Server。",
                false,
            ));
        }
        let unique = relay_profile_ids
            .iter()
            .collect::<std::collections::BTreeSet<_>>();
        if unique.len() != relay_profile_ids.len()
            || relay_profile_ids
                .iter()
                .any(|profile_id| profile_id == &local_profile_id)
        {
            return Err(NativeError::invalid_input("Server 选择重复或互相冲突。"));
        }

        let profiles = self.profiles.clone();
        let local_id = local_profile_id.clone();
        let relay_ids = relay_profile_ids.clone();
        let (local, stable_server_id, relays) = tauri::async_runtime::spawn_blocking(move || {
            let local = profiles.request_credential(&local_id)?;
            let (summaries, _) = profiles.list()?;
            let summaries = summaries
                .into_iter()
                .map(|profile| (profile.id.clone(), profile))
                .collect::<std::collections::BTreeMap<_, _>>();
            let local_summary = summaries.get(&local_id).ok_or_else(|| {
                NativeError::new("profile_not_found", "Server Profile 不存在。", false)
            })?;
            let stable_server_id = stable_server_id_from_profile(local_summary)?;
            let relays = relay_ids
                .into_iter()
                .map(|profile_id| {
                    let credential = profiles.request_credential(&profile_id)?;
                    let name = summaries
                        .get(&profile_id)
                        .map(|profile| profile.name.clone())
                        .unwrap_or_else(|| profile_id.clone());
                    Ok((profile_id, name, credential))
                })
                .collect::<NativeResult<Vec<_>>>()?;
            Ok::<_, NativeError>((local, stable_server_id, relays))
        })
        .await
        .map_err(|_| NativeError::internal())??;

        let body = serde_json::json!({
            "relays": relays.iter().map(|(_, name, credential)| serde_json::json!({
                "endpoint": credential.endpoint,
                "name": name,
                "enabled": true,
                "managementKey": credential.management_key
            })).collect::<Vec<_>>()
        });
        let url = build_request_url(&local.endpoint, "/v0/webui/server-routes/relays")?;
        let authorization = HeaderValue::from_str(&format!("Bearer {}", local.management_key))
            .map_err(|_| NativeError::invalid_input("Management Key 无效。"))?;
        let response = self
            .client
            .put(url)
            .header(AUTHORIZATION, authorization)
            .header(ACCEPT, "application/json")
            .json(&body)
            .timeout(Duration::from_millis(DEFAULT_TIMEOUT_MS))
            .send()
            .await
            .map_err(map_reqwest_error)?;
        let status = response.status();
        if !status.is_success() {
            return Err(http_status_error(status));
        }
        let bytes = read_limited(response, MAX_JSON_BYTES).await?;
        let payload = serde_json::from_slice::<Value>(&bytes).map_err(|_| {
            NativeError::new(
                "invalid_response",
                "Server 返回了无效的公网连接配置响应。",
                false,
            )
            .with_status(status.as_u16())
        })?;
        if payload.get("ok").and_then(Value::as_bool) != Some(true) {
            return Err(NativeError::new(
                "outbound_relay_configuration_rejected",
                "Server 未接受公网连接配置。",
                false,
            )
            .with_status(status.as_u16()));
        }
        let serialized = serde_json::to_string(&payload).map_err(|_| NativeError::internal())?;
        if relays
            .iter()
            .any(|(_, _, credential)| serialized.contains(&credential.management_key))
            || serialized.contains(&local.management_key)
        {
            return Err(NativeError::new(
                "native_response_contains_management_credential",
                "Server 响应包含不应返回的凭据。",
                false,
            ));
        }
        let trusted_routes = relays
            .iter()
            .map(|(profile_id, _, credential)| {
                let path = format!("/v0/fabric/broker/servers/{stable_server_id}/proxy");
                Ok(TrustedRouteEnvelope {
                    id: format!("relay-{profile_id}"),
                    kind: "relay-via-server".to_string(),
                    endpoint: build_request_url(&credential.endpoint, &path)?.to_string(),
                    via_profile_id: profile_id.clone(),
                    health: "healthy".to_string(),
                    rtt_ms: 0.0,
                    expires_at: 0,
                })
            })
            .collect::<NativeResult<Vec<_>>>()?;
        let profiles = self.profiles.clone();
        tauri::async_runtime::spawn_blocking(move || {
            profiles.reconcile_request_routes(&local_profile_id, "relay-via-server", trusted_routes)
        })
        .await
        .map_err(|_| NativeError::internal())??;
        Ok(payload)
    }

    pub async fn trust_relay_route(
        &self,
        input: DesktopRelayRouteTrustInput,
    ) -> NativeResult<Value> {
        let source_profile_id = input.source_profile_id.trim().to_string();
        let target_profile_id = input.target_profile_id.trim().to_string();
        if source_profile_id == target_profile_id {
            return Err(NativeError::invalid_input(
                "公网 Server 与目标 Server 不能相同。",
            ));
        }
        let target_stable_server_id = require_server_id(&input.target_stable_server_id)?;
        let profiles = self.profiles.clone();
        let source_id = source_profile_id.clone();
        let target_id = target_profile_id.clone();
        let expected_target_id = target_stable_server_id.clone();
        let (source, _target) = tauri::async_runtime::spawn_blocking(move || {
            let (summaries, _) = profiles.list()?;
            let target = summaries
                .iter()
                .find(|profile| profile.id == target_id)
                .ok_or_else(|| {
                    NativeError::new("profile_not_found", "Server Profile 不存在。", false)
                })?;
            if stable_server_id_from_profile(target)? != expected_target_id {
                return Err(NativeError::new(
                    "stable_server_id_mismatch",
                    "目标 Server 的稳定身份不匹配。",
                    false,
                ));
            }
            Ok::<_, NativeError>((
                profiles.request_credential(&source_id)?,
                profiles.request_credential(&target_id)?,
            ))
        })
        .await
        .map_err(|_| NativeError::internal())??;

        let directory_url = build_request_url(&source.endpoint, "/v0/fabric/broker/servers")?;
        let authorization = HeaderValue::from_str(&format!("Bearer {}", source.management_key))
            .map_err(|_| NativeError::invalid_input("Management Key 无效。"))?;
        let response = self
            .client
            .get(directory_url)
            .header(AUTHORIZATION, authorization)
            .header(ACCEPT, "application/json")
            .timeout(Duration::from_millis(DEFAULT_TIMEOUT_MS))
            .send()
            .await
            .map_err(map_reqwest_error)?;
        let status = response.status();
        if !status.is_success() {
            return Err(http_status_error(status));
        }
        let bytes = read_limited(response, MAX_JSON_BYTES).await?;
        let payload = serde_json::from_slice::<Value>(&bytes).map_err(|_| {
            NativeError::new(
                "invalid_response",
                "公网 Server 返回了无效的目录响应。",
                false,
            )
            .with_status(status.as_u16())
        })?;
        let directory_routes = trusted_routes_from_directory(
            &payload,
            &source_profile_id,
            &source.endpoint,
            &target_stable_server_id,
        )?;
        let primary_route = directory_routes.first().cloned().ok_or_else(|| {
            NativeError::new(
                "relay_route_not_found",
                "公网 Server 目录中没有该目标 Server 的可用 Route。",
                true,
            )
        })?;
        let profiles = self.profiles.clone();
        let target_id = target_profile_id.clone();
        tauri::async_runtime::spawn_blocking(move || {
            profiles.trust_request_routes(&target_id, directory_routes)
        })
        .await
        .map_err(|_| NativeError::internal())??;
        Ok(serde_json::json!({
            "trusted": true,
            "routeId": primary_route.id,
            "kind": primary_route.kind
        }))
    }

    pub async fn authorize_lan_profile(
        &self,
        input: DesktopLanProfileAuthorizeInput,
    ) -> NativeResult<ProfileSummary> {
        let profile_id = input.profile_id.trim().to_string();
        let management_key = input.management_key.trim().to_string();
        let timeout = Duration::from_millis(input.timeout_ms.unwrap_or(1_500).clamp(250, 10_000));
        let profiles = self.profiles.clone();
        let lookup_id = profile_id.clone();
        let profile = tauri::async_runtime::spawn_blocking(move || profiles.get(&lookup_id))
            .await
            .map_err(|_| NativeError::internal())??;
        let stable_server_id = stable_server_id_from_profile(&profile)?;
        let discovered = tauri::async_runtime::spawn_blocking(move || discover_servers(timeout))
            .await
            .map_err(|_| NativeError::internal())??;
        let routes = verify_discovered_lan_routes(
            &self.client,
            &profile_id,
            &stable_server_id,
            &management_key,
            &discovered,
        )
        .await?;
        let primary_route = routes
            .into_iter()
            .find(|route| route.endpoint == profile.endpoint)
            .ok_or_else(|| {
                NativeError::new(
                    "lan_route_profile_mismatch",
                    "待授权 Server 地址已变化，请重新发现后再授权。",
                    true,
                )
            })?;
        let profiles = self.profiles.clone();
        let authorize_id = profile_id.clone();
        tauri::async_runtime::spawn_blocking(move || {
            profiles.authorize_lan_profile(&authorize_id, &management_key, primary_route)
        })
        .await
        .map_err(|_| NativeError::internal())??;
        let profiles = self.profiles.clone();
        tauri::async_runtime::spawn_blocking(move || profiles.get(&profile_id))
            .await
            .map_err(|_| NativeError::internal())?
    }

    pub async fn refresh_lan_routes(
        &self,
        input: DesktopLanRoutesRefreshInput,
    ) -> NativeResult<Value> {
        let profile_ids = input
            .profile_ids
            .into_iter()
            .map(|profile_id| profile_id.trim().to_string())
            .filter(|profile_id| !profile_id.is_empty())
            .collect::<std::collections::BTreeSet<_>>()
            .into_iter()
            .collect::<Vec<_>>();
        if profile_ids.len() > 64 {
            return Err(NativeError::invalid_input("局域网 Server 数量超过限制。"));
        }
        if profile_ids.is_empty() {
            return Ok(serde_json::json!({ "ok": true, "profiles": [] }));
        }
        let timeout = Duration::from_millis(input.timeout_ms.unwrap_or(1_500).clamp(250, 10_000));
        let discovered = tauri::async_runtime::spawn_blocking(move || discover_servers(timeout))
            .await
            .map_err(|_| NativeError::internal())??;
        let mut results = Vec::with_capacity(profile_ids.len());
        let mut success_count = 0;
        for profile_id in profile_ids {
            let profiles = self.profiles.clone();
            let lookup_id = profile_id.clone();
            let lookup = tauri::async_runtime::spawn_blocking(move || {
                Ok::<_, NativeError>((
                    profiles.get(&lookup_id)?,
                    profiles.credential_for_lan_proof(&lookup_id)?,
                ))
            })
            .await
            .map_err(|_| NativeError::internal())?;
            let (profile, credential) = match lookup {
                Ok(value) => value,
                Err(error) => {
                    results.push(serde_json::json!({
                        "profileId": profile_id,
                        "status": "failed",
                        "routeCount": 0,
                        "lastError": safe_native_error_code(&error)
                    }));
                    continue;
                }
            };
            let stable_server_id = match stable_server_id_from_profile(&profile) {
                Ok(value) => value,
                Err(error) => {
                    results.push(serde_json::json!({
                        "profileId": profile_id,
                        "status": "failed",
                        "routeCount": 0,
                        "lastError": safe_native_error_code(&error)
                    }));
                    continue;
                }
            };
            match verify_discovered_lan_routes(
                &self.client,
                &profile_id,
                &stable_server_id,
                &credential.management_key,
                &discovered,
            )
            .await
            {
                Ok(routes) => {
                    let route_count = routes.len();
                    let profiles = self.profiles.clone();
                    let reconcile_id = profile_id.clone();
                    tauri::async_runtime::spawn_blocking(move || {
                        profiles.reconcile_request_routes(&reconcile_id, "direct-lan", routes)
                    })
                    .await
                    .map_err(|_| NativeError::internal())??;
                    success_count += 1;
                    results.push(serde_json::json!({
                        "profileId": profile_id,
                        "status": "ready",
                        "routeCount": route_count,
                        "lastError": ""
                    }));
                }
                Err(error) => {
                    let profiles = self.profiles.clone();
                    let reconcile_id = profile_id.clone();
                    let _ = tauri::async_runtime::spawn_blocking(move || {
                        profiles.reconcile_request_routes(&reconcile_id, "direct-lan", Vec::new())
                    })
                    .await;
                    results.push(serde_json::json!({
                        "profileId": profile_id,
                        "status": "failed",
                        "routeCount": 0,
                        "lastError": safe_native_error_code(&error)
                    }));
                }
            }
        }
        Ok(serde_json::json!({
            "ok": success_count > 0,
            "partial": success_count > 0 && success_count < results.len(),
            "profiles": results
        }))
    }

    pub async fn configure_frp_route(
        &self,
        input: DesktopFrpRouteConfigureInput,
    ) -> NativeResult<Value> {
        let provider_profile_id = input.provider_profile_id.trim().to_string();
        let visitor_profile_ids = input
            .visitor_profile_ids
            .into_iter()
            .map(|profile_id| profile_id.trim().to_string())
            .filter(|profile_id| !profile_id.is_empty())
            .collect::<Vec<_>>();
        if visitor_profile_ids.is_empty() || visitor_profile_ids.len() > 5 {
            return Err(NativeError::new(
                "invalid_frp_visitor_count",
                "请选择 1 至 5 个公网 Server。",
                false,
            ));
        }
        let unique = visitor_profile_ids
            .iter()
            .collect::<std::collections::BTreeSet<_>>();
        if unique.len() != visitor_profile_ids.len()
            || visitor_profile_ids
                .iter()
                .any(|profile_id| profile_id == &provider_profile_id)
        {
            return Err(NativeError::invalid_input("Server 选择重复或互相冲突。"));
        }

        let profiles = self.profiles.clone();
        let provider_id = provider_profile_id.clone();
        let visitor_ids = visitor_profile_ids.clone();
        let (stable_server_id, provider_name, provider, visitors) =
            tauri::async_runtime::spawn_blocking(move || {
                let (summaries, _) = profiles.list()?;
                let summaries = summaries
                    .into_iter()
                    .map(|profile| (profile.id.clone(), profile))
                    .collect::<std::collections::BTreeMap<_, _>>();
                let provider_summary = summaries.get(&provider_id).ok_or_else(|| {
                    NativeError::new("profile_not_found", "Server Profile 不存在。", false)
                })?;
                let stable_server_id = stable_server_id_from_profile(provider_summary)?;
                let provider = profiles.request_credential(&provider_id)?;
                let visitors = visitor_ids
                    .into_iter()
                    .map(|profile_id| {
                        let summary = summaries.get(&profile_id).ok_or_else(|| {
                            NativeError::new("profile_not_found", "Server Profile 不存在。", false)
                        })?;
                        Ok((
                            profile_id,
                            summary.name.clone(),
                            profiles.request_credential(&summary.id)?,
                        ))
                    })
                    .collect::<NativeResult<Vec<_>>>()?;
                Ok::<_, NativeError>((
                    stable_server_id,
                    provider_summary.name.clone(),
                    provider,
                    visitors,
                ))
            })
            .await
            .map_err(|_| NativeError::internal())??;

        let mut digest = Sha256::new();
        digest.update(b"aih-frp-route-v1\0");
        digest.update(provider.management_key.as_bytes());
        digest.update(b"\0");
        digest.update(stable_server_id.as_bytes());
        let secret_key = digest
            .finalize()
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>();

        let provider_result = self
            .apply_internal_frp_config(
                &provider,
                serde_json::json!({
                    "role": "provider",
                    "stableServerId": stable_server_id,
                    "serverName": provider_name,
                    "secretKey": secret_key
                }),
            )
            .await?;
        let mut visitor_results = Vec::new();
        let mut trusted_routes = Vec::new();
        for (profile_id, _visitor_name, credential) in &visitors {
            let configured = self
                .apply_internal_frp_config(
                    credential,
                    serde_json::json!({
                        "role": "visitor",
                        "stableServerId": stable_server_id,
                        "serverName": provider_name,
                        "secretKey": secret_key
                    }),
                )
                .await;
            let (action, bind_port) = configured
                .as_ref()
                .map(|result| {
                    (
                        result
                            .get("action")
                            .and_then(Value::as_str)
                            .unwrap_or("none")
                            .to_string(),
                        result.get("bindPort").and_then(Value::as_u64).unwrap_or(0),
                    )
                })
                .unwrap_or(("none".to_string(), 0));
            let route_result = match configured {
                Ok(_) => {
                    self.probe_frp_route(profile_id, credential, &provider, &stable_server_id)
                        .await
                }
                Err(error) => Err(error),
            };
            match route_result {
                Ok(route) => {
                    trusted_routes.push(route);
                    visitor_results.push(serde_json::json!({
                        "profileId": profile_id,
                        "action": action,
                        "bindPort": bind_port,
                        "status": "ready",
                        "lastError": ""
                    }));
                }
                Err(error) => {
                    visitor_results.push(serde_json::json!({
                        "profileId": profile_id,
                        "action": action,
                        "bindPort": bind_port,
                        "status": "failed",
                        "lastError": safe_native_error_code(&error)
                    }));
                }
            }
        }

        let success_count = trusted_routes.len();
        let profiles = self.profiles.clone();
        let target_profile_id = provider_profile_id.clone();
        tauri::async_runtime::spawn_blocking(move || {
            profiles.reconcile_request_routes(&target_profile_id, "frp", trusted_routes)
        })
        .await
        .map_err(|_| NativeError::internal())??;

        Ok(serde_json::json!({
            "ok": success_count > 0,
            "partial": success_count > 0 && success_count < visitor_results.len(),
            "stableServerId": stable_server_id,
            "provider": {
                "profileId": provider_profile_id,
                "action": provider_result.get("action").and_then(Value::as_str).unwrap_or("none")
            },
            "visitors": visitor_results
        }))
    }

    async fn probe_frp_route(
        &self,
        visitor_profile_id: &str,
        visitor: &RequestCredential,
        target: &RequestCredential,
        stable_server_id: &str,
    ) -> NativeResult<TrustedRouteEnvelope> {
        let proxy_path = format!("/v0/fabric/frp/servers/{stable_server_id}/proxy");
        let proxy_endpoint = build_request_url(&visitor.endpoint, &proxy_path)?.to_string();
        let descriptor_url = build_request_url(&proxy_endpoint, "/v0/fabric/descriptor")?;
        let authorization = HeaderValue::from_str(&format!("Bearer {}", target.management_key))
            .map_err(|_| NativeError::invalid_input("Management Key 无效。"))?;
        let started_at = Instant::now();
        let response = self
            .client
            .get(descriptor_url)
            .header(AUTHORIZATION, authorization)
            .header(ACCEPT, "application/json")
            .timeout(self.frp_probe_timeout)
            .send()
            .await
            .map_err(map_reqwest_error)?;
        let status = response.status();
        if !status.is_success() {
            return Err(NativeError::new(
                "frp_descriptor_http_error",
                "FRP Route 未返回可用的目标 Server descriptor。",
                true,
            )
            .with_status(status.as_u16()));
        }
        let bytes = read_limited(response, MAX_JSON_BYTES).await?;
        let descriptor = serde_json::from_slice::<Value>(&bytes).map_err(|_| {
            NativeError::new(
                "frp_descriptor_invalid",
                "FRP Route 返回了无效的目标 Server descriptor。",
                false,
            )
        })?;
        let descriptor = descriptor
            .get("result")
            .filter(|value| value.is_object())
            .unwrap_or(&descriptor);
        if descriptor.get("service").and_then(Value::as_str) != Some("aih-fabric") {
            return Err(NativeError::new(
                "frp_descriptor_invalid",
                "FRP Route 未连接到 AI Home Server。",
                false,
            ));
        }
        let descriptor_server_id = descriptor
            .get("server")
            .and_then(|server| server.get("id"))
            .and_then(Value::as_str)
            .and_then(|value| require_server_id(value).ok());
        if descriptor_server_id.as_deref() != Some(stable_server_id) {
            return Err(NativeError::new(
                "frp_descriptor_identity_mismatch",
                "FRP Route 连接到了其他 Server。",
                false,
            ));
        }
        Ok(TrustedRouteEnvelope {
            id: format!("frp-{visitor_profile_id}"),
            kind: "frp".to_string(),
            endpoint: proxy_endpoint,
            via_profile_id: visitor_profile_id.to_string(),
            health: "healthy".to_string(),
            rtt_ms: started_at.elapsed().as_secs_f64() * 1_000.0,
            expires_at: 0,
        })
    }

    async fn apply_internal_frp_config(
        &self,
        credential: &RequestCredential,
        body: Value,
    ) -> NativeResult<Value> {
        let url = build_request_url(&credential.endpoint, "/v0/webui/server-routes/frp/apply")?;
        let authorization = HeaderValue::from_str(&format!("Bearer {}", credential.management_key))
            .map_err(|_| NativeError::invalid_input("Management Key 无效。"))?;
        let response = self
            .client
            .post(url)
            .header(AUTHORIZATION, authorization)
            .header(ACCEPT, "application/json")
            .json(&body)
            .timeout(Duration::from_millis(30_000))
            .send()
            .await
            .map_err(map_reqwest_error)?;
        let status = response.status();
        let bytes = read_limited(response, MAX_JSON_BYTES).await?;
        if !status.is_success() {
            if let Ok(payload) = serde_json::from_slice::<Value>(&bytes) {
                if let Some(code) = safe_frp_apply_error_code(&payload) {
                    return Err(
                        NativeError::new(code, "Server 未完成 FRP Route 配置。", true)
                            .with_status(status.as_u16()),
                    );
                }
            }
            return Err(http_status_error(status));
        }
        let payload = serde_json::from_slice::<Value>(&bytes).map_err(|_| {
            NativeError::new(
                "invalid_response",
                "Server 返回了无效的 FRP 配置响应。",
                false,
            )
            .with_status(status.as_u16())
        })?;
        if payload.get("ok").and_then(Value::as_bool) != Some(true) {
            return Err(NativeError::new(
                "frp_route_configuration_rejected",
                "Server 未接受 FRP 路径配置。",
                false,
            )
            .with_status(status.as_u16()));
        }
        Ok(payload)
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
        let routing = tauri::async_runtime::spawn_blocking(move || {
            profiles.request_route_credentials(&profile_id)
        })
        .await
        .map_err(|_| NativeError::internal())??;
        let method = parse_method(&input.method)?;
        let timeout_ms = input
            .timeout_ms
            .unwrap_or(DEFAULT_TIMEOUT_MS)
            .clamp(MIN_TIMEOUT_MS, MAX_TIMEOUT_MS);
        let mut candidates = routing
            .routes
            .iter()
            .map(|route| RouteCandidate {
                id: route.id.clone(),
                kind: route.kind.clone(),
                endpoint: route.endpoint.clone(),
                health: RouteHealth::parse(&route.health),
                rtt_ms: route.rtt_ms.max(0.0),
            })
            .collect::<Vec<_>>();
        if routing.primary_trusted {
            candidates.push(RouteCandidate {
                id: "primary".to_string(),
                kind: "primary".to_string(),
                endpoint: routing.primary.endpoint.clone(),
                health: RouteHealth::Unknown,
                rtt_ms: 0.0,
            });
        }
        let retry_allowed = method == Method::GET;
        let mut excluded = HashSet::new();
        let mut last_error = None;

        loop {
            let ordered =
                self.routes
                    .order_candidates(&input.profile_id, candidates.clone(), &excluded);
            let Some(route) = ordered.first() else {
                return Err(last_error.unwrap_or_else(|| {
                    NativeError::new("no_server_route", "没有可用的 Server Route。", true)
                }));
            };
            let url = build_request_url(&route.endpoint, &input.path)?;
            let mut request = self.client.request(method.clone(), url);
            request = attach_safe_headers(
                request,
                routing.primary.clone(),
                input.accept.as_deref().or(default_accept),
                input.content_type.as_deref(),
                input.body.is_some(),
            )?;
            if let Some(body) = input.body.as_ref() {
                request = request.json(body);
            }
            let started_at = Instant::now();
            let result = match timeout_scope {
                TimeoutScope::EntireResponse => request
                    .timeout(Duration::from_millis(timeout_ms))
                    .send()
                    .await
                    .map_err(map_reqwest_error),
                TimeoutScope::ResponseHeaders => {
                    match tokio::time::timeout(Duration::from_millis(timeout_ms), request.send())
                        .await
                    {
                        Ok(result) => result.map_err(map_reqwest_error),
                        Err(_) => Err(NativeError::new(
                            "request_timeout",
                            "等待 Server 响应超时。",
                            true,
                        )),
                    }
                }
            };
            match result {
                Ok(response) => {
                    if retry_allowed && is_proxy_transport_failure(&response, route) {
                        let status = response.status().as_u16();
                        self.routes.record_failure(&input.profile_id, &route.id);
                        excluded.insert(route.id.clone());
                        last_error = Some(
                            NativeError::new(
                                "server_route_proxy_unavailable",
                                "当前 Server Route 暂不可用。",
                                true,
                            )
                            .with_status(status),
                        );
                        continue;
                    }
                    self.routes
                        .record_success(&input.profile_id, &route.id, started_at.elapsed());
                    return Ok(response);
                }
                Err(error) => {
                    self.routes.record_failure(&input.profile_id, &route.id);
                    if !retry_allowed {
                        return Err(error);
                    }
                    excluded.insert(route.id.clone());
                    last_error = Some(error);
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

fn stable_server_id_from_profile(profile: &ProfileSummary) -> NativeResult<String> {
    let value = profile
        .metadata
        .get("stableServerId")
        .and_then(Value::as_str)
        .ok_or_else(|| {
            NativeError::new(
                "stable_server_id_missing",
                "请先同步该 Server 的稳定身份。",
                false,
            )
        })?;
    require_server_id(value)
}

fn trusted_routes_from_directory(
    payload: &Value,
    source_profile_id: &str,
    source_endpoint: &str,
    target_stable_server_id: &str,
) -> NativeResult<Vec<TrustedRouteEnvelope>> {
    let servers = payload
        .get("result")
        .and_then(|result| result.get("servers"))
        .and_then(Value::as_array)
        .or_else(|| payload.get("servers").and_then(Value::as_array))
        .ok_or_else(|| {
            NativeError::new(
                "invalid_response",
                "公网 Server 目录响应缺少 servers。",
                false,
            )
        })?;
    let server = servers
        .iter()
        .find(|server| {
            server
                .get("stableServerId")
                .or_else(|| server.get("serverId"))
                .and_then(Value::as_str)
                .and_then(|value| require_server_id(value).ok())
                .as_deref()
                == Some(target_stable_server_id)
        })
        .ok_or_else(|| {
            NativeError::new(
                "relay_route_not_found",
                "公网 Server 目录中没有该目标 Server。",
                true,
            )
        })?;
    let routes = server
        .get("routes")
        .and_then(Value::as_array)
        .ok_or_else(|| {
            NativeError::new(
                "relay_route_not_found",
                "公网 Server 目录中没有该目标 Server 的 Route。",
                true,
            )
        })?;
    let mut trusted = Vec::new();
    for route in routes {
        let raw_kind = route.get("kind").and_then(Value::as_str).unwrap_or("");
        let (kind, expected_path, route_id) = match raw_kind {
            "relay" | "relay-via-server" => (
                "relay-via-server",
                format!("/v0/fabric/broker/servers/{target_stable_server_id}/proxy"),
                format!("relay-{source_profile_id}"),
            ),
            "frp" => (
                "frp",
                format!("/v0/fabric/frp/servers/{target_stable_server_id}/proxy"),
                format!("frp-{source_profile_id}"),
            ),
            _ => continue,
        };
        let Some(path) = route.get("path").and_then(Value::as_str) else {
            continue;
        };
        if path != expected_path {
            continue;
        }
        let health = match route.get("health").and_then(Value::as_str) {
            Some("degraded") => "degraded",
            Some("offline") => "offline",
            Some("unknown") => "unknown",
            _ => "healthy",
        };
        trusted.push(TrustedRouteEnvelope {
            id: route_id,
            kind: kind.to_string(),
            endpoint: build_request_url(source_endpoint, path)?.to_string(),
            via_profile_id: source_profile_id.to_string(),
            health: health.to_string(),
            rtt_ms: route
                .get("rttMs")
                .and_then(Value::as_f64)
                .filter(|value| value.is_finite() && *value >= 0.0)
                .unwrap_or(0.0),
            expires_at: 0,
        });
    }
    trusted.sort_by(|left, right| left.id.cmp(&right.id));
    trusted.dedup_by(|left, right| left.id == right.id);
    Ok(trusted)
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

fn is_proxy_transport_failure(response: &Response, route: &RouteCandidate) -> bool {
    if !matches!(response.status().as_u16(), 429 | 502 | 503 | 504) {
        return false;
    }
    let proof_header = match route.kind.as_str() {
        "relay-via-server" => "x-aih-fabric-broker-server-id",
        "frp" => "x-aih-frp-server-id",
        _ => return false,
    };
    !response.headers().contains_key(proof_header)
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

fn safe_native_error_code(error: &NativeError) -> String {
    let code = error.code.as_str();
    if !code.is_empty()
        && code.len() <= 96
        && code
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-' | b'.' | b':'))
    {
        code.to_string()
    } else {
        "frp_route_failed".to_string()
    }
}

fn safe_frp_apply_error_code(payload: &Value) -> Option<&'static str> {
    let code = payload
        .get("error")
        .and_then(|error| {
            error
                .as_str()
                .or_else(|| error.get("code").and_then(Value::as_str))
        })
        .or_else(|| payload.get("code").and_then(Value::as_str))?;
    match code {
        "frp_visitor_identity_verification_failed" => {
            Some("frp_visitor_identity_verification_failed")
        }
        "frpc_config_not_found" => Some("frpc_config_not_found"),
        "frp_reload_failed" => Some("frp_reload_failed"),
        "frp_restart_failed" => Some("frp_restart_failed"),
        "frp_verify_failed" => Some("frp_verify_failed"),
        _ => None,
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

    fn read_http_request(socket: &mut std::net::TcpStream) -> String {
        socket
            .set_read_timeout(Some(Duration::from_millis(500)))
            .unwrap();
        let mut received = Vec::new();
        let mut buffer = [0_u8; 8192];
        loop {
            let read = socket.read(&mut buffer).unwrap_or(0);
            if read == 0 {
                break;
            }
            received.extend_from_slice(&buffer[..read]);
            let text = String::from_utf8_lossy(&received);
            let Some(header_end) = text.find("\r\n\r\n") else {
                continue;
            };
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
        String::from_utf8(received).unwrap()
    }

    fn route_test_server(
        max_requests: usize,
        response_for_path: fn(&str) -> &'static [u8],
    ) -> (String, thread::JoinHandle<Vec<String>>) {
        route_test_server_with_timeout(max_requests, response_for_path, Duration::from_secs(10))
    }

    fn route_test_server_with_timeout(
        max_requests: usize,
        response_for_path: fn(&str) -> &'static [u8],
        timeout: Duration,
    ) -> (String, thread::JoinHandle<Vec<String>>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let address = listener.local_addr().unwrap();
        let server = thread::spawn(move || {
            let deadline = std::time::Instant::now() + timeout;
            let mut requests = Vec::new();
            while requests.len() < max_requests && std::time::Instant::now() < deadline {
                let (mut socket, _) = match listener.accept() {
                    Ok(connection) => connection,
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                        thread::sleep(Duration::from_millis(5));
                        continue;
                    }
                    Err(error) => panic!("route test accept failed: {error}"),
                };
                let request = read_http_request(&mut socket);
                let path = request
                    .lines()
                    .next()
                    .and_then(|line| line.split_whitespace().nth(1))
                    .unwrap_or("");
                let body = response_for_path(path);
                let headers = format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                    body.len()
                );
                socket.write_all(headers.as_bytes()).unwrap();
                socket.write_all(body).unwrap();
                requests.push(request);
            }
            requests
        });
        (format!("http://{address}"), server)
    }

    fn byte_route_server(
        content_type: &'static str,
        body: &'static [u8],
    ) -> (String, thread::JoinHandle<String>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let server = thread::spawn(move || {
            let (mut socket, _) = listener.accept().unwrap();
            let request = read_http_request(&mut socket);
            let headers = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                body.len()
            );
            socket.write_all(headers.as_bytes()).unwrap();
            socket.write_all(body).unwrap();
            request
        });
        (format!("http://{address}"), server)
    }

    fn status_route_server(
        status: u16,
        proof_header: Option<(&'static str, &'static str)>,
        body: &'static [u8],
    ) -> (String, thread::JoinHandle<String>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let server = thread::spawn(move || {
            let (mut socket, _) = listener.accept().unwrap();
            let request = read_http_request(&mut socket);
            let proof = proof_header
                .map(|(name, value)| format!("{name}: {value}\r\n"))
                .unwrap_or_default();
            let headers = format!(
                "HTTP/1.1 {status} Test\r\nContent-Type: application/json\r\n{proof}Content-Length: {}\r\nConnection: close\r\n\r\n",
                body.len()
            );
            socket.write_all(headers.as_bytes()).unwrap();
            socket.write_all(body).unwrap();
            request
        });
        (format!("http://{address}"), server)
    }

    fn trust_test_route(profiles: &ProfileService, id: &str, endpoint: String) {
        profiles
            .trust_request_routes(
                "local",
                vec![TrustedRouteEnvelope {
                    id: id.to_string(),
                    kind: "relay-via-server".to_string(),
                    endpoint,
                    via_profile_id: "source".to_string(),
                    health: "healthy".to_string(),
                    rtt_ms: 1.0,
                    expires_at: 0,
                }],
            )
            .unwrap();
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
    fn outbound_relay_configuration_uses_keyring_credentials_without_returning_them_to_ipc() {
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
            let response = br#"{"ok":true,"config":{"version":1,"relays":[{"endpoint":"https://tokyo.example.com","name":"Tokyo","enabled":true,"managementKeyConfigured":true}]},"runtime":{"running":true,"relays":[]}}"#;
            let headers = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n",
                response.len()
            );
            socket.write_all(headers.as_bytes()).unwrap();
            socket.write_all(response).unwrap();
            String::from_utf8(received).unwrap()
        });

        let directory = test_dir();
        let profiles = ProfileService::load(&directory, MemorySecretStore::shared()).unwrap();
        for (id, name, endpoint, key) in [
            (
                "local",
                "Local",
                format!("http://{address}"),
                "local-management-key",
            ),
            (
                "tokyo",
                "Tokyo",
                "https://tokyo.example.com".to_string(),
                "tokyo-management-key",
            ),
        ] {
            profiles
                .upsert(ProfileUpsertInput {
                    id: Some(id.to_string()),
                    name: name.to_string(),
                    endpoint,
                    management_key: Some(key.to_string()),
                    metadata: Some(serde_json::json!({
                        "stableServerId": if id == "local" {
                            "server-local-home"
                        } else {
                            "server-aws-tokyo"
                        }
                    })),
                })
                .unwrap();
        }
        let http = ServerHttp::new(profiles.clone()).unwrap();
        let response = tauri::async_runtime::block_on(http.configure_outbound_relays(
            DesktopOutboundRelayConfigureInput {
                local_profile_id: "local".to_string(),
                relay_profile_ids: vec!["tokyo".to_string()],
            },
        ))
        .unwrap();

        let request = server.join().unwrap();
        assert!(request.starts_with("PUT /v0/webui/server-routes/relays HTTP/1.1"));
        assert!(request
            .to_ascii_lowercase()
            .contains("authorization: bearer local-management-key"));
        assert!(request.contains("tokyo-management-key"));
        let serialized = serde_json::to_string(&response).unwrap();
        assert!(!serialized.contains("local-management-key"));
        assert!(!serialized.contains("tokyo-management-key"));
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn outbound_relay_configuration_requires_one_to_five_distinct_profiles() {
        let (http, directory) = local_service("http://127.0.0.1:9".to_string());
        let error = tauri::async_runtime::block_on(http.configure_outbound_relays(
            DesktopOutboundRelayConfigureInput {
                local_profile_id: "local".to_string(),
                relay_profile_ids: vec![],
            },
        ))
        .unwrap_err();
        assert_eq!(error.code, "invalid_outbound_relay_count");
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn configured_public_server_route_carries_the_local_key_on_real_get_requests() {
        fn local_response(path: &str) -> &'static [u8] {
            if path == "/v0/webui/server-routes/relays" {
                br#"{"ok":true,"config":{"version":1,"relays":[]},"runtime":{"running":true,"relays":[]}}"#
            } else {
                br#"{"route":"primary"}"#
            }
        }
        fn relay_response(_path: &str) -> &'static [u8] {
            br#"{"route":"relay"}"#
        }

        let (local_endpoint, local_server) = route_test_server(2, local_response);
        let (relay_endpoint, relay_server) = route_test_server(1, relay_response);
        let directory = test_dir();
        let profiles = ProfileService::load(&directory, MemorySecretStore::shared()).unwrap();
        profiles
            .upsert(ProfileUpsertInput {
                id: Some("local".to_string()),
                name: "Local".to_string(),
                endpoint: local_endpoint,
                management_key: Some("local-management-key".to_string()),
                metadata: Some(serde_json::json!({
                    "stableServerId": "server-local-home"
                })),
            })
            .unwrap();
        profiles
            .upsert(ProfileUpsertInput {
                id: Some("tokyo".to_string()),
                name: "Tokyo".to_string(),
                endpoint: relay_endpoint,
                management_key: Some("tokyo-management-key".to_string()),
                metadata: Some(serde_json::json!({
                    "stableServerId": "server-aws-tokyo"
                })),
            })
            .unwrap();
        let http = ServerHttp::new(profiles.clone()).unwrap();
        tauri::async_runtime::block_on(http.configure_outbound_relays(
            DesktopOutboundRelayConfigureInput {
                local_profile_id: "local".to_string(),
                relay_profile_ids: vec!["tokyo".to_string()],
            },
        ))
        .unwrap();

        let routing = profiles.request_route_credentials("local").unwrap();
        assert_eq!(routing.routes.len(), 1);
        assert!(routing.routes[0].endpoint.contains(&format!(
            "/v0/fabric/broker/servers/server-local-home/proxy"
        )));

        let response = tauri::async_runtime::block_on(http.request_json(DesktopRequestInput {
            profile_id: "local".to_string(),
            method: "GET".to_string(),
            path: "/v0/status".to_string(),
            body: None,
            accept: None,
            content_type: None,
            timeout_ms: None,
        }))
        .unwrap();

        let local_requests = local_server.join().unwrap();
        let relay_requests = relay_server.join().unwrap();
        assert_eq!(response.body["route"], "relay");
        assert_eq!(relay_requests.len(), 1);
        assert!(relay_requests[0].starts_with(
            "GET /v0/fabric/broker/servers/server-local-home/proxy/v0/status HTTP/1.1"
        ));
        assert!(relay_requests[0]
            .to_ascii_lowercase()
            .contains("authorization: bearer local-management-key"));
        assert_eq!(local_requests.len(), 1);
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn get_retries_the_next_trusted_route_after_a_network_failure() {
        fn config_response(_path: &str) -> &'static [u8] {
            br#"{"ok":true,"config":{"version":1,"relays":[]},"runtime":{"running":true,"relays":[]}}"#
        }
        fn live_response(_path: &str) -> &'static [u8] {
            br#"{"route":"live"}"#
        }

        let (local_endpoint, local_server) = route_test_server(1, config_response);
        let (live_endpoint, live_server) = route_test_server(1, live_response);
        let directory = test_dir();
        let profiles = ProfileService::load(&directory, MemorySecretStore::shared()).unwrap();
        for (id, endpoint, stable_server_id, key) in [
            (
                "local",
                local_endpoint,
                "server-local-home",
                "local-management-key",
            ),
            (
                "a-dead",
                "http://127.0.0.1:9".to_string(),
                "server-aws-dead",
                "dead-management-key",
            ),
            (
                "z-live",
                live_endpoint,
                "server-aws-live",
                "live-management-key",
            ),
        ] {
            profiles
                .upsert(ProfileUpsertInput {
                    id: Some(id.to_string()),
                    name: id.to_string(),
                    endpoint,
                    management_key: Some(key.to_string()),
                    metadata: Some(serde_json::json!({
                        "stableServerId": stable_server_id
                    })),
                })
                .unwrap();
        }
        let http = ServerHttp::new(profiles).unwrap();
        tauri::async_runtime::block_on(http.configure_outbound_relays(
            DesktopOutboundRelayConfigureInput {
                local_profile_id: "local".to_string(),
                relay_profile_ids: vec!["a-dead".to_string(), "z-live".to_string()],
            },
        ))
        .unwrap();

        let response = tauri::async_runtime::block_on(http.request_json(DesktopRequestInput {
            profile_id: "local".to_string(),
            method: "GET".to_string(),
            path: "/v0/status".to_string(),
            body: None,
            accept: None,
            content_type: None,
            timeout_ms: Some(1_000),
        }))
        .unwrap();

        assert_eq!(response.body["route"], "live");
        assert_eq!(local_server.join().unwrap().len(), 1);
        let live_requests = live_server.join().unwrap();
        assert_eq!(live_requests.len(), 1);
        assert!(live_requests[0].starts_with(
            "GET /v0/fabric/broker/servers/server-local-home/proxy/v0/status HTTP/1.1"
        ));
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn relay_route_trust_rechecks_the_authenticated_directory_before_using_the_target_key() {
        fn source_response(path: &str) -> &'static [u8] {
            if path == "/v0/fabric/broker/servers" {
                br#"{"ok":true,"result":{"servers":[{"stableServerId":"server-local-home","routes":[{"kind":"relay-via-server","path":"/v0/fabric/broker/servers/server-local-home/proxy"}]}]}}"#
            } else {
                br#"{"route":"trusted-directory"}"#
            }
        }

        let (source_endpoint, source_server) = route_test_server(2, source_response);
        let directory = test_dir();
        let profiles = ProfileService::load(&directory, MemorySecretStore::shared()).unwrap();
        for (id, endpoint, stable_server_id, key) in [
            (
                "local",
                "http://127.0.0.1:9".to_string(),
                "server-local-home",
                "local-management-key",
            ),
            (
                "tokyo",
                source_endpoint,
                "server-aws-tokyo",
                "tokyo-management-key",
            ),
        ] {
            profiles
                .upsert(ProfileUpsertInput {
                    id: Some(id.to_string()),
                    name: id.to_string(),
                    endpoint,
                    management_key: Some(key.to_string()),
                    metadata: Some(serde_json::json!({
                        "stableServerId": stable_server_id
                    })),
                })
                .unwrap();
        }
        let http = ServerHttp::new(profiles).unwrap();
        let trust =
            tauri::async_runtime::block_on(http.trust_relay_route(DesktopRelayRouteTrustInput {
                source_profile_id: "tokyo".to_string(),
                target_profile_id: "local".to_string(),
                target_stable_server_id: "server-local-home".to_string(),
            }))
            .unwrap();
        assert_eq!(trust["trusted"], true);
        assert_eq!(trust["kind"], "relay-via-server");
        assert_eq!(trust["routeId"], "relay-tokyo");
        assert!(!serde_json::to_string(&trust).unwrap().contains("endpoint"));

        let response = tauri::async_runtime::block_on(http.request_json(DesktopRequestInput {
            profile_id: "local".to_string(),
            method: "GET".to_string(),
            path: "/v0/status".to_string(),
            body: None,
            accept: None,
            content_type: None,
            timeout_ms: Some(1_000),
        }))
        .unwrap();
        assert_eq!(response.body["route"], "trusted-directory");

        let requests = source_server.join().unwrap();
        assert_eq!(requests.len(), 2);
        assert!(requests[0].starts_with("GET /v0/fabric/broker/servers HTTP/1.1"));
        assert!(requests[0]
            .to_ascii_lowercase()
            .contains("authorization: bearer tokyo-management-key"));
        assert!(requests[1].starts_with(
            "GET /v0/fabric/broker/servers/server-local-home/proxy/v0/status HTTP/1.1"
        ));
        assert!(requests[1]
            .to_ascii_lowercase()
            .contains("authorization: bearer local-management-key"));
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn relay_directory_trust_rejects_absolute_and_noncanonical_proxy_paths() {
        let payload = serde_json::json!({
            "result": {
                "servers": [{
                    "stableServerId": "server-local-home",
                    "routes": [
                        {
                            "kind": "relay-via-server",
                            "endpoint": "https://attacker.example/v0/capture"
                        },
                        {
                            "kind": "relay-via-server",
                            "path": "//attacker.example/v0/capture"
                        },
                        {
                            "kind": "relay-via-server",
                            "path": "/v0/fabric/broker/servers/server-local-home/proxy?redirect=1"
                        },
                        {
                            "kind": "frp",
                            "path": "/v0/fabric/frp/servers/server-local-home/proxy\\escape"
                        }
                    ]
                }]
            }
        });

        let routes = trusted_routes_from_directory(
            &payload,
            "tokyo",
            "https://tokyo.example",
            "server-local-home",
        )
        .unwrap();
        assert!(routes.is_empty());
    }

    #[test]
    fn blob_and_sse_gets_use_the_same_trusted_route_selector() {
        let (blob_endpoint, blob_server) =
            byte_route_server("application/octet-stream", b"route-blob");
        let directory = test_dir();
        let profiles = ProfileService::load(&directory, MemorySecretStore::shared()).unwrap();
        profiles
            .upsert(ProfileUpsertInput {
                id: Some("local".to_string()),
                name: "Local".to_string(),
                endpoint: "http://127.0.0.1:9".to_string(),
                management_key: Some("local-management-key".to_string()),
                metadata: Some(serde_json::json!({
                    "stableServerId": "server-local-home"
                })),
            })
            .unwrap();
        trust_test_route(&profiles, "relay-blob", blob_endpoint);
        let http = ServerHttp::new(profiles.clone()).unwrap();
        let blob = tauri::async_runtime::block_on(http.download_blob(DesktopRequestInput {
            profile_id: "local".to_string(),
            method: "GET".to_string(),
            path: "/v0/blob".to_string(),
            body: None,
            accept: None,
            content_type: None,
            timeout_ms: Some(1_000),
        }))
        .unwrap();
        assert_eq!(blob.bytes, b"route-blob");
        let blob_request = blob_server.join().unwrap();
        assert!(blob_request.starts_with("GET /v0/blob HTTP/1.1"));
        assert!(blob_request
            .to_ascii_lowercase()
            .contains("authorization: bearer local-management-key"));

        let (sse_endpoint, sse_server) =
            byte_route_server("text/event-stream", b"data: routed\n\n");
        trust_test_route(&profiles, "relay-sse", sse_endpoint);
        let prepared = tauri::async_runtime::block_on(http.open_stream(&DesktopStreamInput {
            request_id: Some("route-stream".to_string()),
            profile_id: "local".to_string(),
            method: "GET".to_string(),
            path: "/v0/events".to_string(),
            body: None,
            accept: Some("text/event-stream".to_string()),
            content_type: None,
            timeout_ms: Some(1_000),
        }))
        .unwrap();
        let bytes = tauri::async_runtime::block_on(prepared.response.bytes()).unwrap();
        assert_eq!(bytes.as_ref(), b"data: routed\n\n");
        let sse_request = sse_server.join().unwrap();
        assert!(sse_request.starts_with("GET /v0/events HTTP/1.1"));
        assert!(sse_request
            .to_ascii_lowercase()
            .contains("authorization: bearer local-management-key"));
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn post_json_and_post_sse_never_replay_on_a_second_route() {
        fn unexpected_response(_path: &str) -> &'static [u8] {
            br#"{"unexpected":true}"#
        }

        fn service_with_dead_first_route(live_endpoint: &str) -> (ServerHttp, PathBuf) {
            let directory = test_dir();
            let profiles = ProfileService::load(&directory, MemorySecretStore::shared()).unwrap();
            profiles
                .upsert(ProfileUpsertInput {
                    id: Some("local".to_string()),
                    name: "Local".to_string(),
                    endpoint: "http://127.0.0.1:9".to_string(),
                    management_key: Some("local-management-key".to_string()),
                    metadata: Some(serde_json::json!({
                        "stableServerId": "server-local-home"
                    })),
                })
                .unwrap();
            trust_test_route(
                &profiles,
                "a-dead",
                "http://127.0.0.1:9/v0/fabric/broker/servers/server-local-home/proxy".to_string(),
            );
            trust_test_route(
                &profiles,
                "z-live",
                format!("{live_endpoint}/v0/fabric/broker/servers/server-local-home/proxy"),
            );
            (ServerHttp::new(profiles).unwrap(), directory)
        }

        let (json_live_endpoint, json_live_server) = route_test_server(1, unexpected_response);
        let (http, json_directory) = service_with_dead_first_route(&json_live_endpoint);

        let json_error = tauri::async_runtime::block_on(http.request_json(DesktopRequestInput {
            profile_id: "local".to_string(),
            method: "POST".to_string(),
            path: "/v0/write".to_string(),
            body: Some(serde_json::json!({ "value": 1 })),
            accept: None,
            content_type: Some("application/json".to_string()),
            timeout_ms: Some(1_000),
        }))
        .unwrap_err();
        assert!(matches!(
            json_error.code.as_str(),
            "network_error" | "request_timeout"
        ));
        assert!(json_live_server.join().unwrap().is_empty());
        fs::remove_dir_all(json_directory).unwrap();

        let (stream_live_endpoint, stream_live_server) = route_test_server(1, unexpected_response);
        let (http, stream_directory) = service_with_dead_first_route(&stream_live_endpoint);
        let stream_error = tauri::async_runtime::block_on(http.open_stream(&DesktopStreamInput {
            request_id: Some("post-route-stream".to_string()),
            profile_id: "local".to_string(),
            method: "POST".to_string(),
            path: "/v0/chat".to_string(),
            body: Some(serde_json::json!({ "message": "once" })),
            accept: Some("text/event-stream".to_string()),
            content_type: Some("application/json".to_string()),
            timeout_ms: Some(1_000),
        }))
        .err()
        .unwrap();
        assert!(matches!(
            stream_error.code.as_str(),
            "network_error" | "request_timeout"
        ));
        assert!(stream_live_server.join().unwrap().is_empty());
        fs::remove_dir_all(stream_directory).unwrap();
    }

    #[test]
    fn proxy_transport_status_failover_is_get_only_and_requires_a_missing_proof_header() {
        fn live_response(_path: &str) -> &'static [u8] {
            br#"{"route":"live"}"#
        }

        fn service_with_routes(
            first_endpoint: String,
            live_endpoint: &str,
        ) -> (ServerHttp, PathBuf) {
            let directory = test_dir();
            let profiles = ProfileService::load(&directory, MemorySecretStore::shared()).unwrap();
            profiles
                .upsert(ProfileUpsertInput {
                    id: Some("local".to_string()),
                    name: "Local".to_string(),
                    endpoint: "http://127.0.0.1:9".to_string(),
                    management_key: Some("local-management-key".to_string()),
                    metadata: Some(serde_json::json!({
                        "stableServerId": "server-local-home"
                    })),
                })
                .unwrap();
            trust_test_route(&profiles, "a-first", first_endpoint);
            trust_test_route(&profiles, "z-live", live_endpoint.to_string());
            (ServerHttp::new(profiles).unwrap(), directory)
        }

        let (offline_endpoint, offline_server) = status_route_server(
            503,
            None,
            br#"{"error":{"code":"fabric_broker_server_offline"}}"#,
        );
        let (live_endpoint, live_server) = route_test_server(1, live_response);
        let (http, directory) = service_with_routes(offline_endpoint, &live_endpoint);
        let response = tauri::async_runtime::block_on(http.request_json(DesktopRequestInput {
            profile_id: "local".to_string(),
            method: "GET".to_string(),
            path: "/v0/status".to_string(),
            body: None,
            accept: None,
            content_type: None,
            timeout_ms: Some(1_000),
        }))
        .unwrap();
        assert_eq!(response.body["route"], "live");
        offline_server.join().unwrap();
        assert_eq!(live_server.join().unwrap().len(), 1);
        fs::remove_dir_all(directory).unwrap();

        let (target_error_endpoint, target_error_server) =
            status_route_server(500, None, br#"{"error":"target-business-error"}"#);
        let (unused_endpoint, unused_server) = route_test_server(1, live_response);
        let (http, directory) = service_with_routes(target_error_endpoint, &unused_endpoint);
        let response = tauri::async_runtime::block_on(http.request_json(DesktopRequestInput {
            profile_id: "local".to_string(),
            method: "GET".to_string(),
            path: "/v0/status".to_string(),
            body: None,
            accept: None,
            content_type: None,
            timeout_ms: Some(1_000),
        }))
        .unwrap();
        assert_eq!(response.status, 500);
        assert_eq!(response.body["error"], "target-business-error");
        target_error_server.join().unwrap();
        assert!(unused_server.join().unwrap().is_empty());
        fs::remove_dir_all(directory).unwrap();

        let (post_error_endpoint, post_error_server) =
            status_route_server(503, None, br#"{"error":"proxy-unavailable"}"#);
        let (unused_endpoint, unused_server) = route_test_server(1, live_response);
        let (http, directory) = service_with_routes(post_error_endpoint, &unused_endpoint);
        let response = tauri::async_runtime::block_on(http.request_json(DesktopRequestInput {
            profile_id: "local".to_string(),
            method: "POST".to_string(),
            path: "/v0/write".to_string(),
            body: Some(serde_json::json!({ "value": 1 })),
            accept: None,
            content_type: Some("application/json".to_string()),
            timeout_ms: Some(1_000),
        }))
        .unwrap();
        assert_eq!(response.status, 503);
        post_error_server.join().unwrap();
        assert!(unused_server.join().unwrap().is_empty());
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn proxy_failure_statuses_fail_over_only_for_safe_reads_without_proof_headers() {
        fn service_with_routes(first: String, second: String) -> (ServerHttp, PathBuf) {
            let directory = test_dir();
            let profiles = ProfileService::load(&directory, MemorySecretStore::shared()).unwrap();
            profiles
                .upsert(ProfileUpsertInput {
                    id: Some("local".to_string()),
                    name: "Local".to_string(),
                    endpoint: "http://127.0.0.1:9".to_string(),
                    management_key: Some("local-management-key".to_string()),
                    metadata: Some(serde_json::json!({
                        "stableServerId": "server-local-home"
                    })),
                })
                .unwrap();
            trust_test_route(&profiles, "a-first", first);
            trust_test_route(&profiles, "z-second", second);
            (ServerHttp::new(profiles).unwrap(), directory)
        }

        let (offline_endpoint, offline_server) =
            status_route_server(503, None, br#"{"error":"fabric_broker_server_offline"}"#);
        let (healthy_endpoint, healthy_server) =
            status_route_server(200, None, br#"{"route":"healthy"}"#);
        let (http, directory) = service_with_routes(offline_endpoint, healthy_endpoint);
        let response = tauri::async_runtime::block_on(http.request_json(DesktopRequestInput {
            profile_id: "local".to_string(),
            method: "GET".to_string(),
            path: "/v0/status".to_string(),
            body: None,
            accept: None,
            content_type: None,
            timeout_ms: Some(1_000),
        }))
        .unwrap();
        assert_eq!(response.status, 200);
        assert_eq!(response.body["route"], "healthy");
        assert!(offline_server.join().unwrap().starts_with("GET /v0/status"));
        assert!(healthy_server.join().unwrap().starts_with("GET /v0/status"));
        fs::remove_dir_all(directory).unwrap();

        let (target_error_endpoint, target_error_server) = status_route_server(
            503,
            Some(("x-aih-fabric-broker-server-id", "server-local-home")),
            br#"{"error":"target_business_failure"}"#,
        );
        let (unused_endpoint, unused_server) = route_test_server(1, |_| br#"{"unexpected":true}"#);
        let (http, directory) = service_with_routes(target_error_endpoint, unused_endpoint);
        let response = tauri::async_runtime::block_on(http.request_json(DesktopRequestInput {
            profile_id: "local".to_string(),
            method: "GET".to_string(),
            path: "/v0/status".to_string(),
            body: None,
            accept: None,
            content_type: None,
            timeout_ms: Some(1_000),
        }))
        .unwrap();
        assert_eq!(response.status, 503);
        assert_eq!(response.body["error"], "target_business_failure");
        assert!(target_error_server
            .join()
            .unwrap()
            .starts_with("GET /v0/status"));
        assert!(unused_server.join().unwrap().is_empty());
        fs::remove_dir_all(directory).unwrap();

        let (post_error_endpoint, post_error_server) =
            status_route_server(503, None, br#"{"error":"proxy_unavailable"}"#);
        let (unused_endpoint, unused_server) = route_test_server(1, |_| br#"{"unexpected":true}"#);
        let (http, directory) = service_with_routes(post_error_endpoint, unused_endpoint);
        let response = tauri::async_runtime::block_on(http.request_json(DesktopRequestInput {
            profile_id: "local".to_string(),
            method: "POST".to_string(),
            path: "/v0/write".to_string(),
            body: Some(serde_json::json!({ "value": 1 })),
            accept: None,
            content_type: Some("application/json".to_string()),
            timeout_ms: Some(1_000),
        }))
        .unwrap();
        assert_eq!(response.status, 503);
        assert!(post_error_server
            .join()
            .unwrap()
            .starts_with("POST /v0/write"));
        assert!(unused_server.join().unwrap().is_empty());
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn frp_configuration_trusts_only_visitors_that_reach_the_target_descriptor() {
        fn provider_response(_path: &str) -> &'static [u8] {
            br#"{"ok":true,"role":"provider","stableServerId":"server-local-home","action":"restart","bindPort":0}"#
        }
        fn healthy_visitor_response(path: &str) -> &'static [u8] {
            if path == "/v0/webui/server-routes/frp/apply" {
                br#"{"ok":true,"role":"visitor","stableServerId":"server-local-home","action":"reload","bindPort":19588}"#
            } else {
                br#"{"ok":true,"rpc":"fabric.descriptor.read","result":{"service":"aih-fabric","server":{"id":"server-local-home"}}}"#
            }
        }
        fn wrong_visitor_response(path: &str) -> &'static [u8] {
            if path == "/v0/webui/server-routes/frp/apply" {
                br#"{"ok":true,"role":"visitor","stableServerId":"server-local-home","action":"reload","bindPort":19589}"#
            } else {
                br#"{"ok":true,"rpc":"fabric.descriptor.read","result":{"service":"aih-fabric","server":{"id":"server-someone-else"}}}"#
            }
        }

        // Large streaming fixtures run in parallel with this integration test;
        // give only these expected listeners a wider scheduling budget.
        let listener_timeout = Duration::from_secs(30);
        let (provider_endpoint, provider_server) =
            route_test_server_with_timeout(1, provider_response, listener_timeout);
        let (healthy_endpoint, healthy_server) =
            route_test_server_with_timeout(2, healthy_visitor_response, listener_timeout);
        let (wrong_endpoint, wrong_server) =
            route_test_server_with_timeout(2, wrong_visitor_response, listener_timeout);
        let (apply_fail_endpoint, apply_fail_server) = status_route_server(
            502,
            None,
            br#"{"ok":false,"error":"frp_visitor_identity_verification_failed","message":"must-not-cross-ipc","stderr":"must-not-cross-ipc"}"#,
        );
        let directory = test_dir();
        let profiles = ProfileService::load(&directory, MemorySecretStore::shared()).unwrap();
        for (id, endpoint, key, metadata) in [
            (
                "local",
                provider_endpoint,
                "local-management-key",
                Some(serde_json::json!({
                    "stableServerId": "server-local-home"
                })),
            ),
            ("healthy", healthy_endpoint, "healthy-management-key", None),
            ("wrong", wrong_endpoint, "wrong-management-key", None),
            (
                "apply-fail",
                apply_fail_endpoint,
                "apply-fail-management-key",
                None,
            ),
        ] {
            profiles
                .upsert(ProfileUpsertInput {
                    id: Some(id.to_string()),
                    name: id.to_string(),
                    endpoint,
                    management_key: Some(key.to_string()),
                    metadata,
                })
                .unwrap();
        }
        let http = ServerHttp::new(profiles.clone())
            .unwrap()
            .with_frp_probe_timeout(Duration::from_secs(30));
        let result = tauri::async_runtime::block_on(http.configure_frp_route(
            DesktopFrpRouteConfigureInput {
                provider_profile_id: "local".to_string(),
                visitor_profile_ids: vec![
                    "healthy".to_string(),
                    "wrong".to_string(),
                    "apply-fail".to_string(),
                ],
            },
        ))
        .unwrap();

        assert_eq!(result["ok"], true, "unexpected FRP result: {result}");
        assert_eq!(result["partial"], true, "unexpected FRP result: {result}");
        let visitors = result["visitors"].as_array().unwrap();
        assert_eq!(visitors[0]["profileId"], "healthy");
        assert_eq!(visitors[0]["status"], "ready");
        assert_eq!(visitors[0]["lastError"], "");
        assert_eq!(visitors[1]["profileId"], "wrong");
        assert_eq!(visitors[1]["status"], "failed");
        assert_eq!(visitors[1]["lastError"], "frp_descriptor_identity_mismatch");
        assert_eq!(visitors[2]["profileId"], "apply-fail");
        assert_eq!(visitors[2]["status"], "failed");
        assert_eq!(
            visitors[2]["lastError"],
            "frp_visitor_identity_verification_failed"
        );
        let routes = profiles.request_route_credentials("local").unwrap().routes;
        assert_eq!(routes.len(), 1);
        assert_eq!(routes[0].id, "frp-healthy");

        assert_eq!(provider_server.join().unwrap().len(), 1);
        let healthy_requests = healthy_server.join().unwrap();
        let wrong_requests = wrong_server.join().unwrap();
        let apply_fail_request = apply_fail_server.join().unwrap();
        assert_eq!(healthy_requests.len(), 2);
        assert_eq!(wrong_requests.len(), 2);
        assert!(apply_fail_request.starts_with("POST /v0/webui/server-routes/frp/apply HTTP/1.1"));
        for requests in [&healthy_requests, &wrong_requests] {
            assert!(requests[0]
                .to_ascii_lowercase()
                .contains("authorization: bearer "));
            assert!(requests[1]
                .to_ascii_lowercase()
                .contains("authorization: bearer local-management-key"));
            assert!(requests[1].starts_with(
                "GET /v0/fabric/frp/servers/server-local-home/proxy/v0/fabric/descriptor HTTP/1.1"
            ));
        }
        assert!(healthy_requests[0]
            .to_ascii_lowercase()
            .contains("authorization: bearer healthy-management-key"));
        assert!(wrong_requests[0]
            .to_ascii_lowercase()
            .contains("authorization: bearer wrong-management-key"));
        let serialized = serde_json::to_string(&result).unwrap();
        assert!(!serialized.contains("management-key"));
        assert!(!serialized.contains("127.0.0.1"));
        assert!(!serialized.contains("must-not-cross-ipc"));
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn frp_route_configuration_derives_one_internal_secret_and_never_returns_it_to_ipc() {
        fn capture_server(bind_port: u16) -> (String, thread::JoinHandle<String>) {
            let listener = TcpListener::bind(("127.0.0.1", bind_port)).unwrap();
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
                let request_text = String::from_utf8(received).unwrap();
                let body = request_text.split("\r\n\r\n").nth(1).unwrap_or("");
                let role = serde_json::from_str::<Value>(body)
                    .ok()
                    .and_then(|payload| {
                        payload
                            .get("role")
                            .and_then(Value::as_str)
                            .map(str::to_string)
                    })
                    .unwrap_or_default();
                let response = if role == "visitor" {
                    br#"{"ok":true,"role":"visitor","stableServerId":"server-local-home","action":"reload","bindPort":19588,"changes":{"main":false,"fragment":true,"permissions":false}}"#.as_slice()
                } else {
                    br#"{"ok":true,"role":"provider","stableServerId":"server-local-home","action":"restart","bindPort":0,"changes":{"main":true,"fragment":true,"permissions":true}}"#.as_slice()
                };
                let headers = format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n",
                    response.len()
                );
                socket.write_all(headers.as_bytes()).unwrap();
                socket.write_all(response).unwrap();
                request_text
            });
            (format!("http://{address}"), server)
        }

        let (provider_endpoint, provider_server) = capture_server(0);
        let (visitor_endpoint, visitor_server) = capture_server(0);
        let directory = test_dir();
        let profiles = ProfileService::load(&directory, MemorySecretStore::shared()).unwrap();
        profiles
            .upsert(ProfileUpsertInput {
                id: Some("local".to_string()),
                name: "Local Home".to_string(),
                endpoint: provider_endpoint,
                management_key: Some("local-management-key".to_string()),
                metadata: Some(serde_json::json!({
                    "stableServerId": "server-local-home"
                })),
            })
            .unwrap();
        profiles
            .upsert(ProfileUpsertInput {
                id: Some("tokyo".to_string()),
                name: "Tokyo".to_string(),
                endpoint: visitor_endpoint,
                management_key: Some("tokyo-management-key".to_string()),
                metadata: None,
            })
            .unwrap();
        let http = ServerHttp::new(profiles).unwrap();
        let result = tauri::async_runtime::block_on(http.configure_frp_route(
            DesktopFrpRouteConfigureInput {
                provider_profile_id: "local".to_string(),
                visitor_profile_ids: vec!["tokyo".to_string()],
            },
        ))
        .unwrap();

        let provider_request = provider_server.join().unwrap();
        let visitor_request = visitor_server.join().unwrap();
        let provider_body =
            serde_json::from_str::<Value>(provider_request.split("\r\n\r\n").nth(1).unwrap())
                .unwrap();
        let visitor_body =
            serde_json::from_str::<Value>(visitor_request.split("\r\n\r\n").nth(1).unwrap())
                .unwrap();
        let provider_secret = provider_body["secretKey"].as_str().unwrap();
        assert_eq!(provider_body["role"], "provider");
        assert_eq!(visitor_body["role"], "visitor");
        assert_eq!(visitor_body["secretKey"], provider_secret);
        assert!(provider_secret.len() >= 64);
        assert!(!provider_secret.contains("local-management-key"));
        let serialized = serde_json::to_string(&result).unwrap();
        assert!(!serialized.contains(provider_secret));
        assert!(!serialized.contains("management-key"));
        assert_eq!(result["visitors"][0]["bindPort"], 19588);
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
