use std::{path::Path, sync::Arc};

use crate::{
    blob_store::BlobStore,
    error::NativeResult,
    profile_store::ProfileService,
    secret_store::{KeyringSecretStore, SharedSecretStore},
    server_http::ServerHttp,
    stream_registry::StreamRegistry,
};

#[derive(Clone)]
pub struct AppState {
    pub profiles: ProfileService,
    pub http: ServerHttp,
    pub blobs: BlobStore,
    pub streams: StreamRegistry,
}

impl AppState {
    pub fn load(config_dir: &Path) -> NativeResult<Self> {
        let secrets: SharedSecretStore = Arc::new(KeyringSecretStore);
        let profiles = ProfileService::load(config_dir, secrets)?;
        let http = ServerHttp::new(profiles.clone())?;
        Ok(Self {
            profiles,
            http,
            blobs: BlobStore::default(),
            streams: StreamRegistry::default(),
        })
    }
}
