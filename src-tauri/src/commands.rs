use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{AppHandle, State, Window};

use crate::{
    app_state::AppState,
    blob_store::DesktopBlobResponse,
    error::{NativeError, NativeResult},
    profile_store::{ProfileSummary, ProfileUpsertInput},
    server_http::{
        DesktopHttpResponse, DesktopManagementKeyRotateInput, DesktopRequestInput,
        DesktopStreamInput,
    },
    stream_registry::StreamOpenResponse,
};

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EmptyInput {}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProfileIdInput {
    pub profile_id: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BlobIdInput {
    pub blob_id: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StreamCancelInput {
    pub request_id: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProfileListResponse {
    pub profiles: Vec<ProfileSummary>,
    pub active_profile_id: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProfileResponse {
    pub profile: Option<ProfileSummary>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ManagementKeyRotateResponse {
    pub rotated: bool,
    pub profile: ProfileSummary,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ActiveProfileResponse {
    pub active_profile_id: String,
    pub profile: Option<ProfileSummary>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProfileRemoveResponse {
    pub removed: bool,
    pub active_profile_id: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BlobReleaseResponse {
    pub released: bool,
}

async fn run_blocking<T, F>(operation: F) -> NativeResult<T>
where
    T: Send + 'static,
    F: FnOnce() -> NativeResult<T> + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(operation)
        .await
        .map_err(|_| NativeError::internal())?
}

#[tauri::command]
pub async fn desktop_profile_list(
    input: EmptyInput,
    state: State<'_, AppState>,
) -> NativeResult<ProfileListResponse> {
    let _ = input;
    let profiles = state.profiles.clone();
    let (profiles, active_profile_id) = run_blocking(move || profiles.list()).await?;
    Ok(ProfileListResponse {
        profiles,
        active_profile_id,
    })
}

#[tauri::command]
pub async fn desktop_profile_upsert(
    input: ProfileUpsertInput,
    state: State<'_, AppState>,
    app: AppHandle,
) -> NativeResult<ProfileResponse> {
    crate::tray::invalidate_before_profile_change();
    let profiles = state.profiles.clone();
    let profile = run_blocking(move || profiles.upsert(input)).await?;
    crate::tray::refresh_after_profile_change(app);
    Ok(ProfileResponse {
        profile: Some(profile),
    })
}

#[tauri::command]
pub async fn desktop_profile_remove(
    input: ProfileIdInput,
    state: State<'_, AppState>,
    app: AppHandle,
) -> NativeResult<ProfileRemoveResponse> {
    crate::tray::invalidate_before_profile_change();
    let profiles = state.profiles.clone();
    let (removed, active_profile_id) =
        run_blocking(move || profiles.remove(&input.profile_id)).await?;
    crate::tray::refresh_after_profile_change(app);
    Ok(ProfileRemoveResponse {
        removed,
        active_profile_id,
    })
}

#[tauri::command]
pub async fn desktop_profile_set_active(
    input: ProfileIdInput,
    state: State<'_, AppState>,
    app: AppHandle,
) -> NativeResult<ActiveProfileResponse> {
    crate::tray::invalidate_before_profile_change();
    let requested_id = input.profile_id.trim().to_string();
    let profiles = state.profiles.clone();
    let profile = run_blocking(move || profiles.set_active(&requested_id)).await?;
    crate::tray::refresh_after_profile_change(app);
    Ok(ActiveProfileResponse {
        active_profile_id: profile
            .as_ref()
            .map(|profile| profile.id.clone())
            .unwrap_or_default(),
        profile,
    })
}

#[tauri::command]
pub async fn desktop_profile_get_active(
    input: EmptyInput,
    state: State<'_, AppState>,
) -> NativeResult<ProfileResponse> {
    let _ = input;
    let profiles = state.profiles.clone();
    let profile = run_blocking(move || profiles.get_active()).await?;
    Ok(ProfileResponse { profile })
}

#[tauri::command]
pub async fn desktop_http_request(
    input: DesktopRequestInput,
    state: State<'_, AppState>,
) -> NativeResult<DesktopHttpResponse> {
    state.http.request_json(input).await
}

#[tauri::command]
pub async fn desktop_management_key_rotate(
    input: DesktopManagementKeyRotateInput,
    state: State<'_, AppState>,
    app: AppHandle,
) -> NativeResult<ManagementKeyRotateResponse> {
    crate::tray::invalidate_before_profile_change();
    let profile = state.http.rotate_management_key(input).await?;
    crate::tray::refresh_after_profile_change(app);
    Ok(ManagementKeyRotateResponse {
        rotated: true,
        profile,
    })
}

#[tauri::command]
pub async fn desktop_blob_request(
    input: DesktopRequestInput,
    state: State<'_, AppState>,
) -> NativeResult<DesktopBlobResponse> {
    let download = state.http.download_blob(input).await?;
    state.blobs.insert(download)
}

#[tauri::command]
pub async fn desktop_blob_release(
    input: BlobIdInput,
    state: State<'_, AppState>,
) -> NativeResult<BlobReleaseResponse> {
    Ok(BlobReleaseResponse {
        released: state.blobs.release(&input.blob_id)?,
    })
}

#[tauri::command]
pub async fn desktop_stream_open(
    input: DesktopStreamInput,
    state: State<'_, AppState>,
    window: Window,
) -> NativeResult<StreamOpenResponse> {
    let prepared = state.http.open_stream(&input).await?;
    state
        .streams
        .start(input.request_id.as_deref(), prepared, window)
}

#[tauri::command]
pub async fn desktop_stream_cancel(
    input: StreamCancelInput,
    state: State<'_, AppState>,
    window: Window,
) -> NativeResult<Value> {
    let cancelled = state.streams.cancel(&input.request_id, window.label())?;
    Ok(serde_json::json!({ "cancelled": cancelled }))
}
