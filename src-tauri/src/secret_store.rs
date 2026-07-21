use std::sync::Arc;

use serde::{Deserialize, Serialize};

use crate::error::{NativeError, NativeResult};

const KEYRING_SERVICE: &str = "com.aih.desktop.management-key";

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CredentialEnvelope {
    version: u8,
    pub endpoint: String,
    pub management_key: String,
    #[serde(default)]
    pub trusted_routes: Vec<TrustedRouteEnvelope>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrustedRouteEnvelope {
    pub id: String,
    pub kind: String,
    pub endpoint: String,
    pub via_profile_id: String,
    #[serde(default = "default_route_health")]
    pub health: String,
    #[serde(default)]
    pub rtt_ms: f64,
    #[serde(default)]
    pub expires_at: u64,
}

fn default_route_health() -> String {
    "unknown".to_string()
}

impl CredentialEnvelope {
    pub fn new(endpoint: String, management_key: String) -> Self {
        Self {
            version: 1,
            endpoint,
            management_key,
            trusted_routes: Vec::new(),
        }
    }

    pub fn with_trusted_routes(mut self, trusted_routes: Vec<TrustedRouteEnvelope>) -> Self {
        self.trusted_routes = trusted_routes;
        self
    }

    fn validate(self) -> NativeResult<Self> {
        if self.version != 1
            || self.endpoint.is_empty()
            || self.management_key.is_empty()
            || self.trusted_routes.len() > 16
        {
            return Err(NativeError::new(
                "secret_corrupt",
                "原生凭据格式无效，请重新保存 Management Key。",
                false,
            ));
        }
        Ok(self)
    }
}

pub trait SecretStore: Send + Sync {
    fn put(&self, credential_ref: &str, envelope: &CredentialEnvelope) -> NativeResult<()>;
    fn get(&self, credential_ref: &str) -> NativeResult<CredentialEnvelope>;
    fn delete(&self, credential_ref: &str) -> NativeResult<()>;

    fn exists(&self, credential_ref: &str) -> NativeResult<bool> {
        match self.get(credential_ref) {
            Ok(_) => Ok(true),
            Err(error) if error.code == "secret_not_found" => Ok(false),
            Err(error) => Err(error),
        }
    }
}

pub type SharedSecretStore = Arc<dyn SecretStore>;

#[derive(Default)]
pub struct KeyringSecretStore;

impl KeyringSecretStore {
    fn entry(credential_ref: &str) -> NativeResult<keyring::Entry> {
        validate_credential_ref(credential_ref)?;
        keyring::Entry::new(KEYRING_SERVICE, credential_ref).map_err(map_keyring_error)
    }
}

impl SecretStore for KeyringSecretStore {
    fn put(&self, credential_ref: &str, envelope: &CredentialEnvelope) -> NativeResult<()> {
        let encoded = serde_json::to_string(envelope).map_err(|_| NativeError::internal())?;
        Self::entry(credential_ref)?
            .set_password(&encoded)
            .map_err(map_keyring_error)
    }

    fn get(&self, credential_ref: &str) -> NativeResult<CredentialEnvelope> {
        let encoded = Self::entry(credential_ref)?
            .get_password()
            .map_err(map_keyring_error)?;
        serde_json::from_str::<CredentialEnvelope>(&encoded)
            .map_err(|_| {
                NativeError::new(
                    "secret_corrupt",
                    "原生凭据格式无效，请重新保存 Management Key。",
                    false,
                )
            })?
            .validate()
    }

    fn delete(&self, credential_ref: &str) -> NativeResult<()> {
        match Self::entry(credential_ref)?.delete_password() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(error) => Err(map_keyring_error(error)),
        }
    }
}

fn validate_credential_ref(value: &str) -> NativeResult<()> {
    let valid = !value.is_empty()
        && value.len() <= 256
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b':'));
    if valid {
        Ok(())
    } else {
        Err(NativeError::invalid_input("credentialRef 无效。"))
    }
}

fn map_keyring_error(error: keyring::Error) -> NativeError {
    match error {
        keyring::Error::NoEntry => NativeError::new(
            "secret_not_found",
            "该 Server 尚未保存 Management Key。",
            false,
        ),
        keyring::Error::NoStorageAccess(_) => {
            NativeError::new("secret_access_denied", "系统凭据库不可访问或已锁定。", true)
        }
        keyring::Error::PlatformFailure(_) => NativeError::new(
            "secret_unavailable",
            "系统凭据服务不可用。Linux 需要可用的 Secret Service。",
            true,
        ),
        _ => NativeError::new("secret_unavailable", "系统凭据服务无法完成请求。", true),
    }
}

#[cfg(test)]
pub mod testing {
    use std::{
        collections::HashMap,
        sync::{Arc, Mutex},
    };

    use super::*;

    #[derive(Default)]
    pub struct MemorySecretStore {
        entries: Mutex<HashMap<String, CredentialEnvelope>>,
    }

    impl MemorySecretStore {
        pub fn shared() -> SharedSecretStore {
            Arc::new(Self::default())
        }
    }

    impl SecretStore for MemorySecretStore {
        fn put(&self, credential_ref: &str, envelope: &CredentialEnvelope) -> NativeResult<()> {
            validate_credential_ref(credential_ref)?;
            self.entries
                .lock()
                .map_err(|_| NativeError::internal())?
                .insert(credential_ref.to_string(), envelope.clone());
            Ok(())
        }

        fn get(&self, credential_ref: &str) -> NativeResult<CredentialEnvelope> {
            self.entries
                .lock()
                .map_err(|_| NativeError::internal())?
                .get(credential_ref)
                .cloned()
                .ok_or_else(|| {
                    NativeError::new(
                        "secret_not_found",
                        "该 Server 尚未保存 Management Key。",
                        false,
                    )
                })
        }

        fn delete(&self, credential_ref: &str) -> NativeResult<()> {
            self.entries
                .lock()
                .map_err(|_| NativeError::internal())?
                .remove(credential_ref);
            Ok(())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{testing::MemorySecretStore, *};

    #[test]
    fn envelope_round_trip_never_exposes_a_get_command_shape() {
        let store = MemorySecretStore::default();
        let envelope = CredentialEnvelope::new(
            "https://server.example".to_string(),
            "management-secret".to_string(),
        );
        store.put("profile-1", &envelope).unwrap();
        let stored = store.get("profile-1").unwrap();
        assert_eq!(stored.endpoint, "https://server.example");
        assert_eq!(stored.management_key, "management-secret");
        store.delete("profile-1").unwrap();
        assert!(!store.exists("profile-1").unwrap());
    }
}
