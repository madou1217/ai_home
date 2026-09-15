use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::Duration;

use serde::Deserialize;
use tauri::{
    AppHandle, CustomMenuItem, Manager, SystemTray, SystemTrayEvent, SystemTrayMenu,
    SystemTrayMenuItem, SystemTraySubmenu,
};

use crate::{app_state::AppState, server_http::DesktopRequestInput};

const OPEN_ITEM_ID: &str = "desktop-menu:open";
const REFRESH_ITEM_ID: &str = "desktop-menu:refresh";
const QUIT_ITEM_ID: &str = "desktop-menu:quit";
const SWITCH_ITEM_PREFIX: &str = "desktop-menu:switch:";
const REFRESH_INTERVAL: Duration = Duration::from_secs(20);

static REFRESH_REVISION: AtomicU64 = AtomicU64::new(0);
static SWITCH_IN_PROGRESS: AtomicBool = AtomicBool::new(false);

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DesktopMenuSnapshot {
    #[serde(default)]
    version: u32,
    #[serde(default)]
    providers: Vec<DesktopMenuProvider>,
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DesktopMenuProvider {
    id: String,
    label: String,
    /// 产品族标识；缺省（旧 Server）时按 provider 自身处理，等价于单站点产品。
    #[serde(default)]
    family: String,
    /// 产品族展示名（如 "Qoder"）；仅多站点产品用于子菜单标题。
    #[serde(default)]
    family_label: String,
    /// 站点展示名（"国际站"/"国内站"）；单站点产品为空。
    #[serde(default)]
    site_label: String,
    /// 是否为国内/国际双站点产品。
    #[serde(default)]
    multi_site: bool,
    #[serde(default)]
    accounts: Vec<DesktopMenuAccount>,
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DesktopMenuAccount {
    account_ref: String,
    label: String,
    usage_label: String,
    #[serde(default)]
    is_default: bool,
    #[serde(default)]
    switchable: bool,
}

struct SwitchGuard;

impl SwitchGuard {
    fn acquire() -> Option<Self> {
        SWITCH_IN_PROGRESS
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .ok()
            .map(|_| Self)
    }
}

impl Drop for SwitchGuard {
    fn drop(&mut self) {
        SWITCH_IN_PROGRESS.store(false, Ordering::Release);
    }
}

pub fn create_system_tray() -> SystemTray {
    let tray = SystemTray::new()
        .with_icon(tauri::Icon::Raw(
            include_bytes!("../icons/32x32.png").to_vec(),
        ))
        .with_tooltip("AI Home")
        .with_menu(build_loading_menu());
    #[cfg(target_os = "macos")]
    let tray = tray.with_menu_on_left_click(true);
    tray
}

pub fn should_hide_main_window_on_close() -> bool {
    cfg!(any(target_os = "macos", target_os = "windows"))
}

fn build_loading_menu() -> SystemTrayMenu {
    build_menu_shell(SystemTrayMenu::new().add_item(disabled_item(
        "desktop-menu:loading",
        "正在加载当前 Server…",
    )))
}

fn build_menu_shell(content: SystemTrayMenu) -> SystemTrayMenu {
    SystemTrayMenu::new()
        .add_item(CustomMenuItem::new(OPEN_ITEM_ID, "打开 AI Home"))
        .add_native_item(SystemTrayMenuItem::Separator)
        .add_submenu(SystemTraySubmenu::new("账号切换", content))
        .add_native_item(SystemTrayMenuItem::Separator)
        .add_item(CustomMenuItem::new(REFRESH_ITEM_ID, "刷新账号与用量"))
        .add_item(CustomMenuItem::new(QUIT_ITEM_ID, "退出 AI Home"))
}

fn disabled_item(id: &str, title: impl Into<String>) -> CustomMenuItem {
    CustomMenuItem::new(id, title).disabled()
}

fn normalize_provider(value: &str) -> Option<String> {
    let provider = value.trim().to_ascii_lowercase();
    let valid = !provider.is_empty()
        && provider.len() <= 32
        && provider.chars().enumerate().all(|(index, character)| {
            character.is_ascii_lowercase()
                || (index > 0
                    && (character.is_ascii_digit() || character == '-' || character == '_'))
        });
    (valid && provider != "gemini").then_some(provider)
}

fn normalize_account_ref(value: &str) -> Option<String> {
    let account_ref = value.trim();
    let valid = account_ref.len() == 25
        && account_ref.starts_with("acct_")
        && account_ref[5..]
            .chars()
            .all(|character| character.is_ascii_hexdigit() && !character.is_ascii_uppercase());
    valid.then_some(account_ref.to_string())
}

fn normalize_profile_id(value: &str) -> Option<String> {
    let profile_id = value.trim();
    let valid = !profile_id.is_empty()
        && profile_id.len() <= 128
        && profile_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'));
    valid.then_some(profile_id.to_string())
}

fn safe_label(value: &str, fallback: &str) -> String {
    let normalized = value
        .replace(['\r', '\n', '\0'], " ")
        .trim()
        .chars()
        .take(160)
        .collect::<String>();
    if normalized.is_empty() {
        fallback.to_string()
    } else {
        normalized
    }
}

fn switch_item_id(
    revision: u64,
    profile_id: &str,
    provider: &str,
    account_ref: &str,
) -> Option<String> {
    if revision == 0 {
        return None;
    }
    Some(format!(
        "{SWITCH_ITEM_PREFIX}{revision}:{}:{}:{}",
        normalize_profile_id(profile_id)?,
        normalize_provider(provider)?,
        normalize_account_ref(account_ref)?
    ))
}

fn parse_switch_item_id(item_id: &str) -> Option<(u64, String, String, String)> {
    let payload = item_id.strip_prefix(SWITCH_ITEM_PREFIX)?;
    let (revision, payload) = payload.split_once(':')?;
    let (profile_id, payload) = payload.split_once(':')?;
    let (provider, account_ref) = payload.split_once(':')?;
    let revision = revision.parse::<u64>().ok()?;
    if revision == 0 {
        return None;
    }
    Some((
        revision,
        normalize_profile_id(profile_id)?,
        normalize_provider(provider)?,
        normalize_account_ref(account_ref)?,
    ))
}

fn visible_providers(snapshot: &DesktopMenuSnapshot) -> Vec<&DesktopMenuProvider> {
    snapshot
        .providers
        .iter()
        .filter(|provider| {
            normalize_provider(&provider.id).is_some()
                && provider
                    .accounts
                    .iter()
                    .any(|account| normalize_account_ref(&account.account_ref).is_some())
        })
        .collect()
}

/// 产品族内的一个成员 Provider 及其可切换账号。
struct MenuFamilyMember<'a> {
    provider: &'a DesktopMenuProvider,
    accounts: Vec<&'a DesktopMenuAccount>,
}

/// 一个产品族的托盘子菜单：国内站与国际站共享一个入口，站点降为行内标记。
///
/// 注意成员仍然是**真实 Provider**——切换目标用成员自己的 id，
/// 合并只发生在展示层，账号身份不会被混。
struct MenuFamily<'a> {
    label: String,
    multi_site: bool,
    members: Vec<MenuFamilyMember<'a>>,
}

impl<'a> MenuFamily<'a> {
    fn default_account(&self) -> Option<(&'a DesktopMenuProvider, &'a DesktopMenuAccount)> {
        self.members.iter().find_map(|member| {
            member
                .accounts
                .iter()
                .find(|account| account.is_default)
                .map(|account| (member.provider, *account))
        })
    }

    fn submenu_label(&self) -> String {
        let mut parts = vec![self.label.clone()];
        if let Some((provider, account)) = self.default_account() {
            if self.multi_site {
                let site_label = safe_label(&provider.site_label, "");
                if !site_label.is_empty() {
                    parts.push(site_label);
                }
            }
            parts.push(safe_label(&account.label, "默认账号"));
            parts.push(safe_label(&account.usage_label, "用量未知"));
        }
        parts.join(" · ")
    }
}

/// 把快照里的 Provider 按产品族收进同一入口，保持 Provider 的首次出现顺序。
fn group_by_family<'a>(providers: &[&'a DesktopMenuProvider]) -> Vec<MenuFamily<'a>> {
    let mut order: Vec<String> = Vec::new();
    // family -> (标签, 是否多站点, 成员)
    let mut buckets: HashMap<String, (String, bool, Vec<MenuFamilyMember<'a>>)> = HashMap::new();

    for provider in providers {
        let Some(provider_id) = normalize_provider(&provider.id) else {
            continue;
        };
        let accounts = provider
            .accounts
            .iter()
            .filter(|account| normalize_account_ref(&account.account_ref).is_some())
            .collect::<Vec<_>>();
        if accounts.is_empty() {
            continue;
        }
        let family_key = match normalize_provider(&provider.family) {
            Some(family) => family,
            None => provider_id.clone(),
        };
        let member_label = safe_label(&provider.label, &provider_id);
        // 多站点产品用族名（"Qoder"）而不是站点名（"Qoder CN"）；单站点保持原样。
        let family_label = if provider.multi_site {
            let explicit = safe_label(&provider.family_label, "");
            if explicit.is_empty() {
                member_label
            } else {
                explicit
            }
        } else {
            member_label
        };

        let entry = buckets.entry(family_key.clone()).or_insert_with(|| {
            order.push(family_key.clone());
            (family_label.clone(), provider.multi_site, Vec::new())
        });
        entry.1 = entry.1 || provider.multi_site;
        if entry.0.is_empty() {
            entry.0 = family_label;
        }
        entry.2.push(MenuFamilyMember {
            provider,
            accounts,
        });
    }

    order
        .into_iter()
        .filter_map(|family| buckets.remove(&family))
        .map(|(label, multi_site, members)| MenuFamily {
            label,
            multi_site,
            members,
        })
        .collect()
}

fn build_snapshot_menu(
    server_name: &str,
    profile_id: &str,
    snapshot: &DesktopMenuSnapshot,
    revision: u64,
    notice: Option<&str>,
) -> SystemTrayMenu {
    let mut content = SystemTrayMenu::new().add_item(disabled_item(
        "desktop-menu:server",
        format!("Server · {}", safe_label(server_name, "当前 Server")),
    ));
    if let Some(notice) = notice.filter(|value| !value.trim().is_empty()) {
        content = content.add_item(disabled_item(
            "desktop-menu:notice",
            safe_label(notice, "操作已完成"),
        ));
    }
    content = content.add_native_item(SystemTrayMenuItem::Separator);

    let providers = visible_providers(snapshot);
    if providers.is_empty() {
        content = content.add_item(disabled_item(
            "desktop-menu:empty",
            "当前 Server 暂无可切换账号",
        ));
        return build_menu_shell(content);
    }

    for family in group_by_family(&providers) {
        let mut submenu = SystemTrayMenu::new();
        for member in &family.members {
            let Some(provider_id) = normalize_provider(&member.provider.id) else {
                continue;
            };
            // 多站点产品：行内加站点标记，否则同一个产品下两行账号看起来一模一样。
            let site_prefix = if family.multi_site {
                safe_label(&member.provider.site_label, "")
            } else {
                String::new()
            };
            for account in &member.accounts {
                let Some(item_id) =
                    switch_item_id(revision, profile_id, &provider_id, &account.account_ref)
                else {
                    continue;
                };
                let mut parts: Vec<String> = Vec::new();
                if !site_prefix.is_empty() {
                    parts.push(site_prefix.clone());
                }
                parts.push(safe_label(&account.label, "未命名账号"));
                parts.push(safe_label(&account.usage_label, "用量未知"));
                let mut item = CustomMenuItem::new(item_id, parts.join(" · "));
                if !account.switchable {
                    item = item.disabled();
                }
                if account.is_default {
                    item = item.selected();
                }
                submenu = submenu.add_item(item);
            }
        }
        content = content.add_submenu(SystemTraySubmenu::new(family.submenu_label(), submenu));
    }

    build_menu_shell(content)
}

fn build_unavailable_menu(message: &str) -> SystemTrayMenu {
    build_menu_shell(SystemTrayMenu::new().add_item(disabled_item(
        "desktop-menu:unavailable",
        safe_label(message, "无法读取当前 Server"),
    )))
}

fn apply_menu(app: &AppHandle, menu: SystemTrayMenu) {
    let _ = app.tray_handle().set_menu(menu);
}

async fn active_profile(
    app: &AppHandle,
) -> Result<Option<crate::profile_store::ProfileSummary>, String> {
    let profiles = app.state::<AppState>().profiles.clone();
    tauri::async_runtime::spawn_blocking(move || profiles.get_active())
        .await
        .map_err(|_| "无法读取当前 Server。".to_string())?
        .map_err(|error| error.message)
}

async fn load_snapshot(
    app: &AppHandle,
) -> Result<(crate::profile_store::ProfileSummary, DesktopMenuSnapshot), String> {
    let Some(profile) = active_profile(app).await? else {
        return Err("请先添加并选择 Server。".to_string());
    };
    let http = app.state::<AppState>().http.clone();
    let response = http
        .request_json(DesktopRequestInput {
            profile_id: profile.id.clone(),
            method: "GET".to_string(),
            path: "/v0/webui/desktop-menu".to_string(),
            body: None,
            accept: None,
            content_type: None,
            timeout_ms: Some(10_000),
        })
        .await
        .map_err(|error| error.message)?;
    if !(200..300).contains(&response.status)
        || response.body.get("ok").and_then(serde_json::Value::as_bool) != Some(true)
    {
        return Err(format!("加载账号失败（HTTP {}）。", response.status));
    }
    let snapshot = serde_json::from_value::<DesktopMenuSnapshot>(response.body)
        .map_err(|_| "Server 返回了无效的菜单数据。".to_string())?;
    if snapshot.version != 1 {
        return Err("当前 Server 的菜单协议版本不兼容。".to_string());
    }
    Ok((profile, snapshot))
}

pub async fn refresh_menu(app: AppHandle, notice: Option<String>) {
    if SWITCH_IN_PROGRESS.load(Ordering::Acquire) {
        return;
    }
    let revision = REFRESH_REVISION.fetch_add(1, Ordering::AcqRel) + 1;
    let result = load_snapshot(&app).await;
    if REFRESH_REVISION.load(Ordering::Acquire) != revision {
        return;
    }
    match result {
        Ok((profile, snapshot)) => {
            apply_menu(
                &app,
                build_snapshot_menu(
                    &profile.name,
                    &profile.id,
                    &snapshot,
                    revision,
                    notice.as_deref(),
                ),
            );
        }
        Err(message) => apply_menu(&app, build_unavailable_menu(&message)),
    }
}

async fn switch_default_account(
    app: AppHandle,
    menu_revision: u64,
    menu_profile_id: String,
    provider: String,
    account_ref: String,
) {
    let Some(_guard) = SwitchGuard::acquire() else {
        return;
    };
    let Some(operation_revision) = menu_revision.checked_add(1) else {
        return;
    };
    if REFRESH_REVISION
        .compare_exchange(
            menu_revision,
            operation_revision,
            Ordering::AcqRel,
            Ordering::Acquire,
        )
        .is_err()
    {
        drop(_guard);
        refresh_menu(app, None).await;
        return;
    }
    let result = switch_default_account_request(
        &app,
        operation_revision,
        &menu_profile_id,
        &provider,
        &account_ref,
    )
    .await;
    drop(_guard);
    let notice = match result {
        Ok(()) => Some(format!(
            "已切换 {} 默认账号",
            safe_label(&provider, "provider")
        )),
        Err(message) => Some(format!("切换失败 · {message}")),
    };
    refresh_menu(app, notice).await;
}

async fn switch_default_account_request(
    app: &AppHandle,
    operation_revision: u64,
    menu_profile_id: &str,
    provider: &str,
    account_ref: &str,
) -> Result<(), String> {
    let Some(profile) = active_profile(app).await? else {
        return Err("未选择 Server".to_string());
    };
    if profile.id != menu_profile_id {
        return Err("Server 已切换，请重新选择账号".to_string());
    }
    if REFRESH_REVISION.load(Ordering::Acquire) != operation_revision {
        return Err("Server 已切换，请重新选择账号".to_string());
    }
    let response = app
        .state::<AppState>()
        .http
        .clone()
        .request_json(DesktopRequestInput {
            profile_id: profile.id,
            method: "POST".to_string(),
            path: format!(
                "/v0/webui/accounts/{}/{}/set-default",
                normalize_provider(provider).ok_or_else(|| "provider 无效".to_string())?,
                normalize_account_ref(account_ref).ok_or_else(|| "账号无效".to_string())?
            ),
            body: None,
            accept: None,
            content_type: None,
            timeout_ms: Some(15_000),
        })
        .await
        .map_err(|error| error.message)?;
    if (200..300).contains(&response.status)
        && response.body.get("ok").and_then(serde_json::Value::as_bool) == Some(true)
    {
        return Ok(());
    }
    let message = response
        .body
        .get("message")
        .and_then(serde_json::Value::as_str)
        .unwrap_or("Server 拒绝切换")
        .to_string();
    Err(message)
}

fn show_main_window(app: &AppHandle) {
    if let Some(window) = app.get_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

pub fn handle_event(app: &AppHandle, event: SystemTrayEvent) {
    match event {
        SystemTrayEvent::MenuItemClick { id, .. } if id.as_str() == OPEN_ITEM_ID => {
            show_main_window(app);
        }
        SystemTrayEvent::MenuItemClick { id, .. } if id.as_str() == REFRESH_ITEM_ID => {
            let handle = app.clone();
            tauri::async_runtime::spawn(refresh_menu(handle, None));
        }
        SystemTrayEvent::MenuItemClick { id, .. } if id.as_str() == QUIT_ITEM_ID => {
            app.exit(0);
        }
        SystemTrayEvent::MenuItemClick { id, .. } => {
            if let Some((revision, profile_id, provider, account_ref)) =
                parse_switch_item_id(id.as_str())
            {
                let handle = app.clone();
                tauri::async_runtime::spawn(switch_default_account(
                    handle,
                    revision,
                    profile_id,
                    provider,
                    account_ref,
                ));
            }
        }
        SystemTrayEvent::LeftClick { .. } => {
            let handle = app.clone();
            tauri::async_runtime::spawn(refresh_menu(handle, None));
        }
        _ => {}
    }
}

pub fn start_refresh_loop(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        refresh_menu(app.clone(), None).await;
        loop {
            tokio::time::sleep(REFRESH_INTERVAL).await;
            refresh_menu(app.clone(), None).await;
        }
    });
}

pub fn refresh_after_profile_change(app: AppHandle) {
    REFRESH_REVISION.fetch_add(1, Ordering::AcqRel);
    tauri::async_runtime::spawn(refresh_menu(app, None));
}

pub fn invalidate_before_profile_change() {
    REFRESH_REVISION.fetch_add(1, Ordering::AcqRel);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn account(account_ref: &str, is_default: bool) -> DesktopMenuAccount {
        DesktopMenuAccount {
            account_ref: account_ref.to_string(),
            label: "Primary".to_string(),
            usage_label: "剩余 80%".to_string(),
            is_default,
            switchable: true,
        }
    }

    /// 造一个单站点 Provider 条目（族 == 自身，无站点标记）。
    fn provider(id: &str, label: &str, accounts: Vec<DesktopMenuAccount>) -> DesktopMenuProvider {
        DesktopMenuProvider {
            id: id.to_string(),
            label: label.to_string(),
            accounts,
            ..Default::default()
        }
    }

    /// 造一个多站点 Provider 条目，与同族成员共享 family。
    fn site_provider(
        id: &str,
        label: &str,
        site_label: &str,
        accounts: Vec<DesktopMenuAccount>,
    ) -> DesktopMenuProvider {
        DesktopMenuProvider {
            id: id.to_string(),
            label: label.to_string(),
            family: "qoder".to_string(),
            family_label: "Qoder".to_string(),
            site_label: site_label.to_string(),
            multi_site: true,
            accounts,
        }
    }

    #[test]
    fn close_to_tray_is_enabled_only_where_a_reliable_tray_host_is_expected() {
        assert_eq!(
            should_hide_main_window_on_close(),
            cfg!(any(target_os = "macos", target_os = "windows"))
        );
    }

    #[test]
    fn switch_item_identity_round_trips_only_safe_provider_and_account_ref() {
        let profile_id = "server-local";
        let account_ref = "acct_0123456789abcdef0123";
        let item_id = switch_item_id(7, profile_id, "codex", account_ref).unwrap();
        assert_eq!(
            parse_switch_item_id(&item_id),
            Some((
                7,
                profile_id.to_string(),
                "codex".to_string(),
                account_ref.to_string()
            ))
        );
        assert!(switch_item_id(0, profile_id, "codex", account_ref).is_none());
        assert!(switch_item_id(7, "../server", "codex", account_ref).is_none());
        assert!(switch_item_id(7, profile_id, "gemini", account_ref).is_none());
        assert!(switch_item_id(7, profile_id, "../codex", account_ref).is_none());
        assert!(switch_item_id(7, profile_id, "codex", "../../auth.json").is_none());
    }

    #[test]
    fn visible_provider_contract_excludes_gemini_and_empty_sections() {
        let snapshot = DesktopMenuSnapshot {
            version: 1,
            providers: vec![
                provider("gemini", "Gemini", vec![account("acct_0123456789abcdef0123", true)]),
                provider("claude", "Claude", Vec::new()),
                provider("codex", "Codex", vec![account("acct_abcdef0123456789abcd", true)]),
            ],
        };

        assert_eq!(
            visible_providers(&snapshot)
                .iter()
                .map(|provider| provider.id.as_str())
                .collect::<Vec<_>>(),
            vec!["codex"]
        );
    }

    #[test]
    fn snapshot_menu_builds_one_account_switch_submenu_for_one_visible_provider() {
        let snapshot = DesktopMenuSnapshot {
            version: 1,
            providers: vec![provider(
                "codex",
                "Codex",
                vec![account("acct_abcdef0123456789abcd", true)],
            )],
        };
        let menu = build_snapshot_menu("Local", "server-local", &snapshot, 9, None);
        let debug_menu = format!("{menu:?}");
        assert!(debug_menu.contains("账号切换"));
        assert!(debug_menu.contains("Codex"));
        assert!(debug_menu.contains("Primary"));
        assert!(debug_menu.contains("剩余 80%"));
    }

    #[test]
    fn snapshot_menu_merges_both_sites_of_one_family_into_a_single_entry() {
        let snapshot = DesktopMenuSnapshot {
            version: 1,
            providers: vec![
                site_provider(
                    "qoder",
                    "Qoder",
                    "国际站",
                    vec![account("acct_abcdef0123456789abcd", true)],
                ),
                site_provider(
                    "qodercn",
                    "Qoder CN",
                    "国内站",
                    vec![account("acct_0123456789abcdef0123", false)],
                ),
            ],
        };
        let menu = build_snapshot_menu("Local", "server-local", &snapshot, 11, None);
        let compact_debug = format!("{menu:#?}")
            .split_whitespace()
            .collect::<Vec<_>>()
            .join(" ");

        // 同族只出现一个"Qoder"入口，站点名不再当作产品名。
        assert_eq!(compact_debug.matches("Qoder").count(), 1, "{compact_debug}");
        assert!(!compact_debug.contains("Qoder CN"), "{compact_debug}");
        // 默认账号的站点进入标题，两个站点都在行内标记。
        assert!(
            compact_debug.contains("Qoder · 国际站 · Primary · 剩余 80%"),
            "{compact_debug}"
        );
        assert!(
            compact_debug.contains("国内站 · Primary · 剩余 80%"),
            "{compact_debug}"
        );
        // 切换目标仍是各自真实的 Provider，不会被族名覆盖。
        assert!(
            compact_debug.contains("desktop-menu:switch:11:server-local:qodercn:acct_0123456789abcdef0123"),
            "{compact_debug}"
        );
    }

    #[test]
    fn snapshot_menu_keeps_a_single_site_family_free_of_site_noise() {
        let snapshot = DesktopMenuSnapshot {
            version: 1,
            providers: vec![provider(
                "codex",
                "Codex",
                vec![account("acct_abcdef0123456789abcd", true)],
            )],
        };
        let menu = build_snapshot_menu("Local", "server-local", &snapshot, 12, None);
        let compact_debug = format!("{menu:#?}")
            .split_whitespace()
            .collect::<Vec<_>>()
            .join(" ");

        assert!(
            compact_debug.contains("Codex · Primary · 剩余 80%"),
            "{compact_debug}"
        );
        assert!(!compact_debug.contains("国际站"), "{compact_debug}");
    }

    #[test]
    fn snapshot_menu_treats_a_legacy_provider_without_family_as_its_own_entry() {
        // 旧 Server 不发送 family 字段：每个 Provider 独立入口，行为与今天一致。
        let snapshot = DesktopMenuSnapshot {
            version: 1,
            providers: vec![
                provider(
                    "qoder",
                    "Qoder",
                    vec![account("acct_abcdef0123456789abcd", true)],
                ),
                provider(
                    "qodercn",
                    "Qodercn",
                    vec![account("acct_0123456789abcdef0123", false)],
                ),
            ],
        };
        let menu = build_snapshot_menu("Local", "server-local", &snapshot, 13, None);
        let compact_debug = format!("{menu:#?}")
            .split_whitespace()
            .collect::<Vec<_>>()
            .join(" ");

        // 没有 family 字段时不合并：两个入口各自独立，站点标记不出现。
        assert!(
            compact_debug.contains("title: \"Qoder · Primary · 剩余 80%\""),
            "{compact_debug}"
        );
        assert!(
            compact_debug.contains("title: \"Qodercn\""),
            "{compact_debug}"
        );
        assert!(!compact_debug.contains("国内站"), "{compact_debug}");
    }

    #[test]
    fn snapshot_decodes_a_dual_site_family_payload_from_the_server() {
        // 这条锁的是**线格式**：Server 送来的多余字段（如 site）必须被忽略，
        // 新字段必须能解码，否则托盘菜单会在运行期才炸。
        let payload = serde_json::json!({
            "version": 1,
            "providers": [
                {
                    "id": "qoder",
                    "label": "Qoder",
                    "family": "qoder",
                    "familyLabel": "Qoder",
                    "site": "global",
                    "siteLabel": "国际站",
                    "multiSite": true,
                    "accounts": [{
                        "accountRef": "acct_abcdef0123456789abcd",
                        "label": "a",
                        "usageLabel": "剩余 10%",
                        "isDefault": true,
                        "switchable": true,
                        "status": "up"
                    }]
                },
                {
                    "id": "qodercn",
                    "label": "Qodercn",
                    "family": "qoder",
                    "familyLabel": "Qoder",
                    "site": "cn",
                    "siteLabel": "国内站",
                    "multiSite": true,
                    "accounts": [{
                        "accountRef": "acct_0123456789abcdef0123",
                        "label": "b",
                        "usageLabel": "剩余 20%",
                        "isDefault": false,
                        "switchable": true,
                        "status": "up"
                    }]
                }
            ]
        });
        let snapshot: DesktopMenuSnapshot =
            serde_json::from_value(payload).expect("双站点快照必须可解码");

        let menu = build_snapshot_menu("Local", "server-local", &snapshot, 21, None);
        let compact_debug = format!("{menu:#?}")
            .split_whitespace()
            .collect::<Vec<_>>()
            .join(" ");

        assert!(
            compact_debug.contains("title: \"Qoder · 国际站 · a · 剩余 10%\""),
            "{compact_debug}"
        );
        assert!(compact_debug.contains("国内站 · b · 剩余 20%"), "{compact_debug}");
        assert!(
            compact_debug.contains("desktop-menu:switch:21:server-local:qodercn:acct_0123456789abcdef0123"),
            "{compact_debug}"
        );
    }

    #[test]
    fn snapshot_decodes_a_legacy_payload_without_family_fields() {
        // 旧 Server 的快照没有 family/site 字段：必须回退成"各自独立入口"。
        let payload = serde_json::json!({
            "version": 1,
            "providers": [{
                "id": "codex",
                "label": "Codex",
                "accounts": [{
                    "accountRef": "acct_abcdef0123456789abcd",
                    "label": "Primary",
                    "usageLabel": "剩余 80%",
                    "isDefault": true,
                    "switchable": true
                }]
            }]
        });
        let snapshot: DesktopMenuSnapshot =
            serde_json::from_value(payload).expect("旧快照必须可解码");

        let menu = build_snapshot_menu("Local", "server-local", &snapshot, 22, None);
        let compact_debug = format!("{menu:#?}")
            .split_whitespace()
            .collect::<Vec<_>>()
            .join(" ");

        assert!(
            compact_debug.contains("title: \"Codex · Primary · 剩余 80%\""),
            "{compact_debug}"
        );
        assert!(!compact_debug.contains("国际站"), "{compact_debug}");
    }

    #[test]
    fn snapshot_menu_disables_an_account_marked_unswitchable_by_the_server() {
        let mut blocked_account = account("acct_abcdef0123456789abcd", false);
        blocked_account.switchable = false;
        let snapshot = DesktopMenuSnapshot {
            version: 1,
            providers: vec![provider("codex", "Codex", vec![blocked_account])],
        };

        let menu = build_snapshot_menu("Local", "server-local", &snapshot, 10, None);
        let compact_debug = format!("{menu:#?}")
            .split_whitespace()
            .collect::<Vec<_>>()
            .join(" ");

        assert!(
            compact_debug.contains(
                "title: \"Primary · 剩余 80%\", keyboard_accelerator: None, enabled: false,"
            ),
            "{compact_debug}"
        );
    }
}
