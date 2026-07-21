use std::{
    fs,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
};

use rand::{distributions::Alphanumeric, Rng};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::{
    endpoint::{normalize_endpoint, normalize_trusted_endpoint},
    error::{NativeError, NativeResult},
    secret_store::{CredentialEnvelope, SharedSecretStore, TrustedRouteEnvelope},
};

const PROFILE_STORE_VERSION: u8 = 1;
const PROFILE_STORE_FILE: &str = "server-profiles.json";

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct StoredProfile {
    id: String,
    name: String,
    endpoint: String,
    credential_ref: String,
    metadata: Value,
    created_at: u64,
    updated_at: u64,
}

#[derive(Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct ProfileDocument {
    #[serde(default = "profile_store_version")]
    version: u8,
    #[serde(default)]
    profiles: Vec<StoredProfile>,
    #[serde(default)]
    active_profile_id: String,
}

fn profile_store_version() -> u8 {
    PROFILE_STORE_VERSION
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProfileSummary {
    pub id: String,
    pub name: String,
    pub endpoint: String,
    pub credential_ref: String,
    pub management_key_configured: bool,
    pub metadata: Value,
    pub created_at: u64,
    pub updated_at: u64,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProfileUpsertInput {
    #[serde(default)]
    pub id: Option<String>,
    pub name: String,
    pub endpoint: String,
    #[serde(default)]
    pub management_key: Option<String>,
    #[serde(default)]
    pub metadata: Option<Value>,
}

#[derive(Clone)]
pub struct RequestCredential {
    pub endpoint: String,
    pub management_key: String,
}

#[derive(Clone)]
pub struct RequestRouteCredentials {
    pub primary: RequestCredential,
    pub primary_trusted: bool,
    pub routes: Vec<TrustedRouteEnvelope>,
}

#[derive(Clone)]
pub struct ProfileService {
    store: Arc<ProfileStore>,
    secrets: SharedSecretStore,
    operations: Arc<Mutex<()>>,
}

struct ProfileStore {
    path: PathBuf,
    document: Mutex<ProfileDocument>,
}

impl ProfileStore {
    fn load(config_dir: &Path) -> NativeResult<Self> {
        let path = config_dir.join(PROFILE_STORE_FILE);
        let document = if path.exists() {
            let contents = fs::read_to_string(&path).map_err(|_| NativeError::storage())?;
            let parsed: ProfileDocument =
                serde_json::from_str(&contents).map_err(|_| NativeError::storage())?;
            if parsed.version != PROFILE_STORE_VERSION {
                return Err(NativeError::new(
                    "profile_store_unsupported",
                    "原生 Server Profile 数据版本不受支持。",
                    false,
                ));
            }
            parsed
        } else {
            ProfileDocument {
                version: PROFILE_STORE_VERSION,
                ..ProfileDocument::default()
            }
        };
        Ok(Self {
            path,
            document: Mutex::new(document),
        })
    }

    fn snapshot(&self) -> NativeResult<ProfileDocument> {
        self.document
            .lock()
            .map(|document| document.clone())
            .map_err(|_| NativeError::internal())
    }

    fn replace(&self, next: ProfileDocument) -> NativeResult<()> {
        let mut document = self.document.lock().map_err(|_| NativeError::internal())?;
        persist_document(&self.path, &next)?;
        *document = next;
        Ok(())
    }
}

fn persist_document(path: &Path, document: &ProfileDocument) -> NativeResult<()> {
    let parent = path.parent().ok_or_else(NativeError::storage)?;
    fs::create_dir_all(parent).map_err(|_| NativeError::storage())?;
    let encoded = serde_json::to_vec_pretty(document).map_err(|_| NativeError::storage())?;
    let temporary = path.with_extension("json.tmp");
    fs::write(&temporary, encoded).map_err(|_| NativeError::storage())?;
    if let Err(_rename_error) = fs::rename(&temporary, path) {
        if path.exists() {
            fs::remove_file(path).map_err(|_| NativeError::storage())?;
            fs::rename(&temporary, path).map_err(|_| NativeError::storage())?;
        } else {
            return Err(NativeError::storage());
        }
    }
    Ok(())
}

impl ProfileService {
    pub fn load(config_dir: &Path, secrets: SharedSecretStore) -> NativeResult<Self> {
        Ok(Self {
            store: Arc::new(ProfileStore::load(config_dir)?),
            secrets,
            operations: Arc::new(Mutex::new(())),
        })
    }

    pub fn list(&self) -> NativeResult<(Vec<ProfileSummary>, String)> {
        let document = self.store.snapshot()?;
        let profiles = document
            .profiles
            .iter()
            .map(|profile| self.summary(profile))
            .collect::<NativeResult<Vec<_>>>()?;
        Ok((profiles, document.active_profile_id))
    }

    pub fn upsert(&self, input: ProfileUpsertInput) -> NativeResult<ProfileSummary> {
        let _operation = self
            .operations
            .lock()
            .map_err(|_| NativeError::internal())?;
        let mut document = self.store.snapshot()?;
        let requested_id = input.id.as_deref().unwrap_or("").trim();
        let id = if requested_id.is_empty() {
            generate_id("server")
        } else {
            validate_identifier(requested_id, "profile id")?;
            requested_id.to_string()
        };
        let existing_index = document
            .profiles
            .iter()
            .position(|profile| profile.id == id);
        let existing = existing_index.map(|index| document.profiles[index].clone());
        let endpoint = match normalize_endpoint(&input.endpoint) {
            Ok(endpoint) => endpoint,
            Err(error)
                if error.code == "insecure_endpoint"
                    && input.management_key.is_none()
                    && is_pending_lan_profile(input.metadata.as_ref(), existing.as_ref()) =>
            {
                normalize_trusted_endpoint(&input.endpoint)?
            }
            Err(error) => return Err(error),
        };
        let name = normalize_name(&input.name)?;
        let metadata = normalize_metadata(input.metadata, existing.as_ref())?;
        let now = timestamp()?;
        let credential_ref = existing
            .as_ref()
            .map(|profile| profile.credential_ref.clone())
            .unwrap_or_else(|| format!("profile:{id}"));

        if let Some(profile) = existing.as_ref() {
            if profile.endpoint != endpoint && input.management_key.is_none() {
                return Err(NativeError::new(
                    "management_key_required_for_endpoint_change",
                    "修改 Server URL 时必须重新输入 Management Key。",
                    false,
                ));
            }
        }

        let management_key = input
            .management_key
            .as_deref()
            .map(normalize_management_key)
            .transpose()?;
        let previous_envelope = if management_key.is_some() {
            match self.secrets.get(&credential_ref) {
                Ok(envelope) => Some(envelope),
                Err(error) if error.code == "secret_not_found" => None,
                Err(error) => return Err(error),
            }
        } else {
            None
        };

        if let Some(key) = management_key.as_ref() {
            let trusted_routes = previous_envelope
                .as_ref()
                .filter(|envelope| envelope.endpoint == endpoint)
                .map(|envelope| envelope.trusted_routes.clone())
                .unwrap_or_default();
            self.secrets.put(
                &credential_ref,
                &CredentialEnvelope::new(endpoint.clone(), key.clone())
                    .with_trusted_routes(trusted_routes),
            )?;
        }

        let stored = StoredProfile {
            id: id.clone(),
            name,
            endpoint,
            credential_ref: credential_ref.clone(),
            metadata,
            created_at: existing
                .as_ref()
                .map(|profile| profile.created_at)
                .unwrap_or(now),
            updated_at: now,
        };
        match existing_index {
            Some(index) => document.profiles[index] = stored.clone(),
            None => document.profiles.push(stored.clone()),
        }

        if let Err(error) = self.store.replace(document) {
            if management_key.is_some() {
                let _rollback = match previous_envelope {
                    Some(envelope) => self.secrets.put(&credential_ref, &envelope),
                    None => self.secrets.delete(&credential_ref),
                };
            }
            return Err(error);
        }
        self.summary(&stored)
    }

    pub fn remove(&self, profile_id: &str) -> NativeResult<(bool, String)> {
        let _operation = self
            .operations
            .lock()
            .map_err(|_| NativeError::internal())?;
        let profile_id = profile_id.trim();
        validate_identifier(profile_id, "profile id")?;
        let mut document = self.store.snapshot()?;
        let Some(index) = document
            .profiles
            .iter()
            .position(|profile| profile.id == profile_id)
        else {
            return Ok((false, document.active_profile_id));
        };
        let profile = document.profiles[index].clone();
        self.secrets.delete(&profile.credential_ref)?;
        document.profiles.remove(index);
        if document.active_profile_id == profile_id {
            document.active_profile_id.clear();
        }
        let active_profile_id = document.active_profile_id.clone();
        self.store.replace(document)?;
        Ok((true, active_profile_id))
    }

    pub fn set_active(&self, profile_id: &str) -> NativeResult<Option<ProfileSummary>> {
        let _operation = self
            .operations
            .lock()
            .map_err(|_| NativeError::internal())?;
        let profile_id = profile_id.trim();
        let mut document = self.store.snapshot()?;
        if profile_id.is_empty() {
            document.active_profile_id.clear();
            self.store.replace(document)?;
            return Ok(None);
        }
        validate_identifier(profile_id, "profile id")?;
        let profile = document
            .profiles
            .iter()
            .find(|profile| profile.id == profile_id)
            .cloned()
            .ok_or_else(|| {
                NativeError::new("profile_not_found", "Server Profile 不存在。", false)
            })?;
        document.active_profile_id = profile_id.to_string();
        self.store.replace(document)?;
        self.summary(&profile).map(Some)
    }

    pub fn get_active(&self) -> NativeResult<Option<ProfileSummary>> {
        let document = self.store.snapshot()?;
        if document.active_profile_id.is_empty() {
            return Ok(None);
        }
        document
            .profiles
            .iter()
            .find(|profile| profile.id == document.active_profile_id)
            .map(|profile| self.summary(profile))
            .transpose()
    }

    pub fn request_credential(&self, profile_id: &str) -> NativeResult<RequestCredential> {
        let (profile, envelope) = self.credential_envelope(profile_id)?;
        let now = timestamp()?;
        let endpoint_trusted = normalize_endpoint(&profile.endpoint).is_ok()
            || envelope.trusted_routes.iter().any(|route| {
                route.kind == "direct-lan"
                    && route.endpoint == profile.endpoint
                    && route.expires_at > now
            });
        if !endpoint_trusted {
            return Err(NativeError::new(
                "lan_route_proof_required",
                "局域网 Server 路径需要重新验证。",
                true,
            ));
        }
        Ok(RequestCredential {
            endpoint: profile.endpoint,
            management_key: envelope.management_key,
        })
    }

    pub fn credential_for_lan_proof(&self, profile_id: &str) -> NativeResult<RequestCredential> {
        let (profile, envelope) = self.credential_envelope(profile_id)?;
        // This credential may only be used as a local HMAC verification key;
        // callers must not attach it to an unverified endpoint request.
        Ok(RequestCredential {
            endpoint: profile.endpoint,
            management_key: envelope.management_key,
        })
    }

    fn credential_envelope(
        &self,
        profile_id: &str,
    ) -> NativeResult<(StoredProfile, CredentialEnvelope)> {
        let profile_id = profile_id.trim();
        validate_identifier(profile_id, "profile id")?;
        let document = self.store.snapshot()?;
        let profile = document
            .profiles
            .iter()
            .find(|profile| profile.id == profile_id)
            .ok_or_else(|| {
                NativeError::new("profile_not_found", "Server Profile 不存在。", false)
            })?;
        let envelope = self.secrets.get(&profile.credential_ref)?;
        if envelope.endpoint != profile.endpoint {
            return Err(NativeError::new(
                "credential_endpoint_mismatch",
                "Management Key 与当前 Server URL 不匹配，请重新保存凭据。",
                false,
            ));
        }
        Ok((profile.clone(), envelope))
    }

    pub fn get(&self, profile_id: &str) -> NativeResult<ProfileSummary> {
        let profile_id = profile_id.trim();
        validate_identifier(profile_id, "profile id")?;
        let document = self.store.snapshot()?;
        let profile = document
            .profiles
            .iter()
            .find(|profile| profile.id == profile_id)
            .ok_or_else(|| {
                NativeError::new("profile_not_found", "Server Profile 不存在。", false)
            })?;
        self.summary(profile)
    }

    pub fn request_route_credentials(
        &self,
        profile_id: &str,
    ) -> NativeResult<RequestRouteCredentials> {
        let profile_id = profile_id.trim();
        validate_identifier(profile_id, "profile id")?;
        let document = self.store.snapshot()?;
        let profile = document
            .profiles
            .iter()
            .find(|profile| profile.id == profile_id)
            .ok_or_else(|| {
                NativeError::new("profile_not_found", "Server Profile 不存在。", false)
            })?;
        let envelope = self.secrets.get(&profile.credential_ref)?;
        if envelope.endpoint != profile.endpoint {
            return Err(NativeError::new(
                "credential_endpoint_mismatch",
                "Management Key 与当前 Server URL 不匹配，请重新保存凭据。",
                false,
            ));
        }
        let now = timestamp()?;
        let routes = envelope
            .trusted_routes
            .into_iter()
            .filter(|route| {
                if route.kind == "direct-lan" {
                    route.expires_at > now
                } else {
                    route.expires_at == 0
                }
            })
            .collect::<Vec<_>>();
        let primary_trusted = normalize_endpoint(&profile.endpoint).is_ok()
            || routes
                .iter()
                .any(|route| route.kind == "direct-lan" && route.endpoint == profile.endpoint);
        Ok(RequestRouteCredentials {
            primary: RequestCredential {
                endpoint: profile.endpoint.clone(),
                management_key: envelope.management_key,
            },
            primary_trusted,
            routes,
        })
    }

    pub fn authorize_lan_profile(
        &self,
        profile_id: &str,
        management_key: &str,
        route: TrustedRouteEnvelope,
    ) -> NativeResult<()> {
        let _operation = self
            .operations
            .lock()
            .map_err(|_| NativeError::internal())?;
        let profile_id = profile_id.trim();
        validate_identifier(profile_id, "profile id")?;
        let document = self.store.snapshot()?;
        let profile = document
            .profiles
            .iter()
            .find(|profile| profile.id == profile_id)
            .ok_or_else(|| {
                NativeError::new("profile_not_found", "Server Profile 不存在。", false)
            })?;
        let management_key = normalize_management_key(management_key)?;
        let route = normalize_trusted_route(route)?;
        if route.kind != "direct-lan" || route.endpoint != profile.endpoint {
            return Err(NativeError::new(
                "lan_route_profile_mismatch",
                "局域网路径与待授权 Server 不匹配。",
                false,
            ));
        }
        let mut trusted_routes = match self.secrets.get(&profile.credential_ref) {
            Ok(envelope) if envelope.endpoint == profile.endpoint => envelope
                .trusted_routes
                .into_iter()
                .filter(|current| current.kind != "direct-lan")
                .collect(),
            Ok(_) => Vec::new(),
            Err(error) if error.code == "secret_not_found" => Vec::new(),
            Err(error) => return Err(error),
        };
        trusted_routes.push(route);
        if trusted_routes.len() > 16 {
            return Err(NativeError::invalid_input("Server Route 数量超过限制。"));
        }
        self.secrets.put(
            &profile.credential_ref,
            &CredentialEnvelope::new(profile.endpoint.clone(), management_key)
                .with_trusted_routes(trusted_routes),
        )
    }

    pub fn trust_request_routes(
        &self,
        profile_id: &str,
        routes: Vec<TrustedRouteEnvelope>,
    ) -> NativeResult<()> {
        let _operation = self
            .operations
            .lock()
            .map_err(|_| NativeError::internal())?;
        let profile_id = profile_id.trim();
        validate_identifier(profile_id, "profile id")?;
        let document = self.store.snapshot()?;
        let profile = document
            .profiles
            .iter()
            .find(|profile| profile.id == profile_id)
            .ok_or_else(|| {
                NativeError::new("profile_not_found", "Server Profile 不存在。", false)
            })?;
        let mut envelope = self.secrets.get(&profile.credential_ref)?;
        if envelope.endpoint != profile.endpoint {
            return Err(NativeError::new(
                "credential_endpoint_mismatch",
                "Management Key 与当前 Server URL 不匹配，请重新保存凭据。",
                false,
            ));
        }
        for route in routes {
            let normalized = normalize_trusted_route(route)?;
            if let Some(existing) = envelope
                .trusted_routes
                .iter_mut()
                .find(|current| current.id == normalized.id)
            {
                *existing = normalized;
            } else {
                envelope.trusted_routes.push(normalized);
            }
        }
        envelope
            .trusted_routes
            .sort_by(|left, right| left.id.cmp(&right.id));
        envelope
            .trusted_routes
            .dedup_by(|left, right| left.id == right.id);
        if envelope.trusted_routes.len() > 16 {
            return Err(NativeError::invalid_input("Server Route 数量超过限制。"));
        }
        self.secrets.put(&profile.credential_ref, &envelope)
    }

    pub fn reconcile_request_routes(
        &self,
        profile_id: &str,
        kind: &str,
        routes: Vec<TrustedRouteEnvelope>,
    ) -> NativeResult<()> {
        if !matches!(kind, "relay-via-server" | "frp" | "direct-lan") {
            return Err(NativeError::invalid_input("Server Route 类型无效。"));
        }
        let _operation = self
            .operations
            .lock()
            .map_err(|_| NativeError::internal())?;
        let profile_id = profile_id.trim();
        validate_identifier(profile_id, "profile id")?;
        let document = self.store.snapshot()?;
        let profile = document
            .profiles
            .iter()
            .find(|profile| profile.id == profile_id)
            .ok_or_else(|| {
                NativeError::new("profile_not_found", "Server Profile 不存在。", false)
            })?;
        let mut envelope = self.secrets.get(&profile.credential_ref)?;
        if envelope.endpoint != profile.endpoint {
            return Err(NativeError::new(
                "credential_endpoint_mismatch",
                "Management Key 与当前 Server URL 不匹配，请重新保存凭据。",
                false,
            ));
        }
        let mut normalized_routes = routes
            .into_iter()
            .map(normalize_trusted_route)
            .collect::<NativeResult<Vec<_>>>()?;
        if normalized_routes.iter().any(|route| route.kind != kind) {
            return Err(NativeError::invalid_input(
                "Server Route reconcile 类型不匹配。",
            ));
        }
        envelope.trusted_routes.retain(|route| route.kind != kind);
        envelope.trusted_routes.append(&mut normalized_routes);
        envelope
            .trusted_routes
            .sort_by(|left, right| left.id.cmp(&right.id));
        envelope
            .trusted_routes
            .dedup_by(|left, right| left.id == right.id);
        if envelope.trusted_routes.len() > 16 {
            return Err(NativeError::invalid_input("Server Route 数量超过限制。"));
        }
        self.secrets.put(&profile.credential_ref, &envelope)
    }

    pub fn verify_management_key_storage(&self, profile_id: &str) -> NativeResult<()> {
        let _operation = self
            .operations
            .lock()
            .map_err(|_| NativeError::internal())?;
        let profile_id = profile_id.trim();
        validate_identifier(profile_id, "profile id")?;
        let document = self.store.snapshot()?;
        let profile = document
            .profiles
            .iter()
            .find(|profile| profile.id == profile_id)
            .ok_or_else(|| {
                NativeError::new("profile_not_found", "Server Profile 不存在。", false)
            })?;
        let envelope = self.secrets.get(&profile.credential_ref)?;
        if envelope.endpoint != profile.endpoint {
            return Err(NativeError::new(
                "credential_endpoint_mismatch",
                "Management Key 与当前 Server URL 不匹配，请重新保存凭据。",
                false,
            ));
        }
        // Rewriting the current envelope is a non-destructive Keyring
        // preflight. Rotation never changes the Server if secure storage is
        // already unavailable or locked.
        self.secrets.put(&profile.credential_ref, &envelope)
    }

    pub fn replace_management_key(
        &self,
        profile_id: &str,
        management_key: &str,
    ) -> NativeResult<ProfileSummary> {
        let _operation = self
            .operations
            .lock()
            .map_err(|_| NativeError::internal())?;
        let profile_id = profile_id.trim();
        validate_identifier(profile_id, "profile id")?;
        let management_key = normalize_management_key(management_key)?;
        let mut document = self.store.snapshot()?;
        let index = document
            .profiles
            .iter()
            .position(|profile| profile.id == profile_id)
            .ok_or_else(|| {
                NativeError::new("profile_not_found", "Server Profile 不存在。", false)
            })?;
        let mut profile = document.profiles[index].clone();
        let previous = self.secrets.get(&profile.credential_ref)?;
        if previous.endpoint != profile.endpoint {
            return Err(NativeError::new(
                "credential_endpoint_mismatch",
                "Management Key 与当前 Server URL 不匹配，请重新保存凭据。",
                false,
            ));
        }
        self.secrets.put(
            &profile.credential_ref,
            &CredentialEnvelope::new(profile.endpoint.clone(), management_key)
                .with_trusted_routes(previous.trusted_routes.clone()),
        )?;
        profile.updated_at = timestamp()?;
        document.profiles[index] = profile.clone();
        if let Err(error) = self.store.replace(document) {
            let _ = self.secrets.put(&profile.credential_ref, &previous);
            return Err(error);
        }
        self.summary(&profile)
    }

    fn summary(&self, profile: &StoredProfile) -> NativeResult<ProfileSummary> {
        Ok(ProfileSummary {
            id: profile.id.clone(),
            name: profile.name.clone(),
            endpoint: profile.endpoint.clone(),
            credential_ref: profile.credential_ref.clone(),
            management_key_configured: self.secrets.exists(&profile.credential_ref)?,
            metadata: profile.metadata.clone(),
            created_at: profile.created_at,
            updated_at: profile.updated_at,
        })
    }
}

fn normalize_name(value: &str) -> NativeResult<String> {
    let value = value.trim();
    if value.is_empty() || value.len() > 128 {
        Err(NativeError::invalid_input("Server 名称无效。"))
    } else {
        Ok(value.to_string())
    }
}

fn normalize_trusted_route(route: TrustedRouteEnvelope) -> NativeResult<TrustedRouteEnvelope> {
    validate_identifier(&route.id, "route id")?;
    validate_identifier(&route.via_profile_id, "relay profile id")?;
    if !matches!(
        route.kind.as_str(),
        "relay-via-server" | "frp" | "direct-lan"
    ) {
        return Err(NativeError::invalid_input("Server Route 类型无效。"));
    }
    let endpoint = if route.kind == "direct-lan" {
        normalize_trusted_endpoint(&route.endpoint)?
    } else {
        normalize_endpoint(&route.endpoint)?
    };
    let health = match route.health.as_str() {
        "healthy" | "degraded" | "offline" | "unknown" => route.health,
        _ => return Err(NativeError::invalid_input("Server Route 健康状态无效。")),
    };
    if !route.rtt_ms.is_finite() || route.rtt_ms < 0.0 || route.rtt_ms > 3_600_000.0 {
        return Err(NativeError::invalid_input("Server Route RTT 无效。"));
    }
    if route.kind == "direct-lan" && route.expires_at <= timestamp()? {
        return Err(NativeError::invalid_input("局域网 Server Route 已过期。"));
    }
    if route.kind != "direct-lan" && route.expires_at != 0 {
        return Err(NativeError::invalid_input(
            "持久 Server Route 不能设置过期时间。",
        ));
    }
    Ok(TrustedRouteEnvelope {
        endpoint,
        health,
        ..route
    })
}

fn is_pending_lan_profile(requested: Option<&Value>, existing: Option<&StoredProfile>) -> bool {
    let metadata = requested.or_else(|| existing.map(|profile| &profile.metadata));
    let Some(metadata) = metadata.and_then(Value::as_object) else {
        return false;
    };
    if metadata.get("authorizationState").and_then(Value::as_str) != Some("discovered-pending-auth")
    {
        return false;
    }
    metadata
        .get("routes")
        .and_then(Value::as_array)
        .map(|routes| {
            routes
                .iter()
                .any(|route| route.get("kind").and_then(Value::as_str) == Some("direct-lan"))
        })
        .unwrap_or(false)
}

pub(crate) fn normalize_management_key(value: &str) -> NativeResult<String> {
    let value = value.trim();
    if value.is_empty() || value.len() > 8192 || value.contains('\r') || value.contains('\n') {
        Err(NativeError::invalid_input("Management Key 无效。"))
    } else {
        Ok(value.to_string())
    }
}

fn normalize_metadata(
    requested: Option<Value>,
    existing: Option<&StoredProfile>,
) -> NativeResult<Value> {
    let value = requested
        .or_else(|| existing.map(|profile| profile.metadata.clone()))
        .unwrap_or_else(|| Value::Object(Map::new()));
    if !value.is_object() {
        return Err(NativeError::invalid_input("Profile metadata 必须是对象。"));
    }
    if contains_sensitive_metadata(&value) {
        return Err(NativeError::invalid_input(
            "Profile metadata 不能包含凭据或授权字段。",
        ));
    }
    if serde_json::to_vec(&value)
        .map(|encoded| encoded.len() > 64 * 1024)
        .unwrap_or(true)
    {
        return Err(NativeError::invalid_input("Profile metadata 过大。"));
    }
    Ok(value)
}

fn contains_sensitive_metadata(value: &Value) -> bool {
    match value {
        Value::Object(object) => object.iter().any(|(key, nested)| {
            let normalized = key
                .chars()
                .filter(|character| character.is_ascii_alphanumeric())
                .flat_map(char::to_lowercase)
                .collect::<String>();
            matches!(
                normalized.as_str(),
                "managementkey"
                    | "authorization"
                    | "devicetoken"
                    | "accesstoken"
                    | "apikey"
                    | "password"
                    | "secret"
            ) || contains_sensitive_metadata(nested)
        }),
        Value::Array(items) => items.iter().any(contains_sensitive_metadata),
        _ => false,
    }
}

fn validate_identifier(value: &str, label: &str) -> NativeResult<()> {
    let valid = !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'));
    if valid {
        Ok(())
    } else {
        Err(NativeError::invalid_input(&format!("{label} 无效。")))
    }
}

fn generate_id(prefix: &str) -> String {
    let random: String = rand::thread_rng()
        .sample_iter(&Alphanumeric)
        .take(20)
        .map(char::from)
        .collect();
    format!("{prefix}-{}", random.to_ascii_lowercase())
}

fn timestamp() -> NativeResult<u64> {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis().min(u128::from(u64::MAX)) as u64)
        .map_err(|_| NativeError::internal())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::secret_store::testing::MemorySecretStore;

    fn test_dir(name: &str) -> PathBuf {
        let path = std::env::temp_dir().join(format!("aih-native-{name}-{}", generate_id("test")));
        fs::create_dir_all(&path).unwrap();
        path
    }

    fn service(name: &str) -> (ProfileService, SharedSecretStore, PathBuf) {
        let directory = test_dir(name);
        let secrets = MemorySecretStore::shared();
        let service = ProfileService::load(&directory, secrets.clone()).unwrap();
        (service, secrets, directory)
    }

    fn upsert_input(endpoint: &str, key: Option<&str>) -> ProfileUpsertInput {
        ProfileUpsertInput {
            id: Some("home".to_string()),
            name: "Home".to_string(),
            endpoint: endpoint.to_string(),
            management_key: key.map(str::to_string),
            metadata: None,
        }
    }

    #[test]
    fn profile_file_never_contains_management_key() {
        let (service, _secrets, directory) = service("no-secret-file");
        service
            .upsert(upsert_input("https://server.example", Some("super-secret")))
            .unwrap();
        let persisted = fs::read_to_string(directory.join(PROFILE_STORE_FILE)).unwrap();
        assert!(!persisted.contains("super-secret"));
        assert!(!persisted.contains("managementKey"));
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn profile_without_management_key_cannot_create_request_credentials() {
        let (service, _secrets, directory) = service("missing-request-key");
        service
            .upsert(upsert_input("https://server.example", None))
            .unwrap();

        let error = match service.request_route_credentials("home") {
            Ok(_) => panic!("a profile without a Management Key must not create a request route"),
            Err(error) => error,
        };
        assert_eq!(error.code, "secret_not_found");
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn pending_lan_profile_writes_no_key_until_a_matching_verified_route_is_committed() {
        let (service, secrets, directory) = service("lan-authorization-gate");
        let mut input = upsert_input("http://192.168.1.20:9527", None);
        input.metadata = Some(serde_json::json!({
            "stableServerId": "server-home",
            "authorizationState": "discovered-pending-auth",
            "routes": [{
                "kind": "direct-lan",
                "endpoint": "http://192.168.1.20:9527"
            }]
        }));
        service.upsert(input).unwrap();
        assert!(!secrets.exists("profile:home").unwrap());

        let expires_at = timestamp().unwrap() + 120_000;
        let mismatched = TrustedRouteEnvelope {
            id: "lan-mismatch".to_string(),
            kind: "direct-lan".to_string(),
            endpoint: "http://192.168.1.21:9527".to_string(),
            via_profile_id: "home".to_string(),
            health: "healthy".to_string(),
            rtt_ms: 2.0,
            expires_at,
        };
        assert_eq!(
            service
                .authorize_lan_profile("home", &"m".repeat(32), mismatched)
                .unwrap_err()
                .code,
            "lan_route_profile_mismatch"
        );
        assert!(!secrets.exists("profile:home").unwrap());

        service
            .authorize_lan_profile(
                "home",
                &"m".repeat(32),
                TrustedRouteEnvelope {
                    id: "lan-home".to_string(),
                    kind: "direct-lan".to_string(),
                    endpoint: "http://192.168.1.20:9527".to_string(),
                    via_profile_id: "home".to_string(),
                    health: "healthy".to_string(),
                    rtt_ms: 1.0,
                    expires_at,
                },
            )
            .unwrap();
        assert!(secrets.exists("profile:home").unwrap());
        assert_eq!(
            service
                .request_route_credentials("home")
                .unwrap()
                .routes
                .len(),
            1
        );
        let mut expired = secrets.get("profile:home").unwrap();
        expired.trusted_routes[0].expires_at = timestamp().unwrap().saturating_sub(1);
        secrets.put("profile:home", &expired).unwrap();
        assert!(service
            .request_route_credentials("home")
            .unwrap()
            .routes
            .is_empty());
        let error = match service.request_credential("home") {
            Ok(_) => panic!("expired LAN proof must disable the primary credential route"),
            Err(error) => error,
        };
        assert_eq!(error.code, "lan_route_proof_required");
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn management_key_replacement_updates_keyring_without_exposing_profile_metadata() {
        let (service, secrets, directory) = service("rotate-key");
        service
            .upsert(upsert_input(
                "https://server.example",
                Some("old-management-key-that-is-long-enough"),
            ))
            .unwrap();

        service.verify_management_key_storage("home").unwrap();
        service
            .trust_request_routes(
                "home",
                vec![TrustedRouteEnvelope {
                    id: "relay-aws".to_string(),
                    kind: "relay-via-server".to_string(),
                    endpoint: "https://aws.example/v0/fabric/broker/servers/server-home/proxy"
                        .to_string(),
                    via_profile_id: "aws".to_string(),
                    health: "healthy".to_string(),
                    rtt_ms: 25.0,
                    expires_at: 0,
                }],
            )
            .unwrap();
        let summary = service
            .replace_management_key("home", "new-management-key-that-is-long-enough")
            .unwrap();

        assert!(summary.management_key_configured);
        assert_eq!(
            secrets.get("profile:home").unwrap().management_key,
            "new-management-key-that-is-long-enough"
        );
        assert_eq!(
            service
                .request_route_credentials("home")
                .unwrap()
                .routes
                .len(),
            1
        );
        let persisted = fs::read_to_string(directory.join(PROFILE_STORE_FILE)).unwrap();
        assert!(!persisted.contains("old-management-key"));
        assert!(!persisted.contains("new-management-key"));
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn profile_metadata_rejects_nested_credential_fields() {
        let (service, _secrets, directory) = service("metadata-secret");
        let mut input = upsert_input("https://server.example", Some("super-secret"));
        input.metadata = Some(serde_json::json!({
            "safe": { "nested": true },
            "unsafe": [{ "managementKey": "must-not-persist" }]
        }));
        assert_eq!(service.upsert(input).unwrap_err().code, "invalid_input");
        assert!(!directory.join(PROFILE_STORE_FILE).exists());
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn renderer_metadata_routes_never_become_authorized_request_routes() {
        let (service, _secrets, directory) = service("metadata-route-injection");
        let mut input = upsert_input("https://server.example", Some("super-secret"));
        input.metadata = Some(serde_json::json!({
            "stableServerId": "server-home",
            "routes": [{
                "id": "attacker",
                "kind": "relay-via-server",
                "endpoint": "https://attacker.example/v0/capture",
                "viaServerId": "attacker"
            }]
        }));
        service.upsert(input).unwrap();

        let routing = service.request_route_credentials("home").unwrap();
        assert_eq!(routing.primary.endpoint, "https://server.example");
        assert!(routing.routes.is_empty());
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn scoped_route_reconcile_replaces_only_the_requested_kind() {
        let (service, _secrets, directory) = service("route-reconcile");
        service
            .upsert(upsert_input("https://server.example", Some("super-secret")))
            .unwrap();
        service
            .trust_request_routes(
                "home",
                vec![
                    TrustedRouteEnvelope {
                        id: "relay-aws".to_string(),
                        kind: "relay-via-server".to_string(),
                        endpoint: "https://aws.example/v0/fabric/broker/servers/server-home/proxy"
                            .to_string(),
                        via_profile_id: "aws".to_string(),
                        health: "healthy".to_string(),
                        rtt_ms: 20.0,
                        expires_at: 0,
                    },
                    TrustedRouteEnvelope {
                        id: "frp-old".to_string(),
                        kind: "frp".to_string(),
                        endpoint: "https://old.example/v0/fabric/frp/servers/server-home/proxy"
                            .to_string(),
                        via_profile_id: "old".to_string(),
                        health: "healthy".to_string(),
                        rtt_ms: 30.0,
                        expires_at: 0,
                    },
                ],
            )
            .unwrap();
        service
            .reconcile_request_routes(
                "home",
                "frp",
                vec![TrustedRouteEnvelope {
                    id: "frp-new".to_string(),
                    kind: "frp".to_string(),
                    endpoint: "https://new.example/v0/fabric/frp/servers/server-home/proxy"
                        .to_string(),
                    via_profile_id: "new".to_string(),
                    health: "healthy".to_string(),
                    rtt_ms: 10.0,
                    expires_at: 0,
                }],
            )
            .unwrap();
        let routes = service.request_route_credentials("home").unwrap().routes;
        assert_eq!(
            routes
                .iter()
                .map(|route| route.id.as_str())
                .collect::<Vec<_>>(),
            vec!["frp-new", "relay-aws"]
        );

        service
            .reconcile_request_routes("home", "frp", Vec::new())
            .unwrap();
        let routes = service.request_route_credentials("home").unwrap().routes;
        assert_eq!(routes.len(), 1);
        assert_eq!(routes[0].id, "relay-aws");
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn endpoint_change_requires_a_new_management_key() {
        let (service, _secrets, directory) = service("endpoint-change");
        service
            .upsert(upsert_input("https://one.example", Some("secret")))
            .unwrap();
        let error = service
            .upsert(upsert_input("https://two.example", None))
            .unwrap_err();
        assert_eq!(error.code, "management_key_required_for_endpoint_change");
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn request_rejects_a_secret_bound_to_another_endpoint() {
        let (service, secrets, directory) = service("endpoint-binding");
        let profile = service
            .upsert(upsert_input("https://server.example", Some("secret")))
            .unwrap();
        secrets
            .put(
                &profile.credential_ref,
                &CredentialEnvelope::new(
                    "https://attacker.example".to_string(),
                    "secret".to_string(),
                ),
            )
            .unwrap();
        let error = service.request_credential("home").err().unwrap();
        assert_eq!(error.code, "credential_endpoint_mismatch");
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn active_profile_lifecycle_is_persisted() {
        let (service, _secrets, directory) = service("active-profile");
        service
            .upsert(upsert_input("https://server.example", Some("secret")))
            .unwrap();
        assert_eq!(service.set_active("home").unwrap().unwrap().id, "home");
        assert_eq!(service.get_active().unwrap().unwrap().id, "home");
        assert!(service.remove("home").unwrap().0);
        assert!(service.get_active().unwrap().is_none());
        fs::remove_dir_all(directory).unwrap();
    }
}
