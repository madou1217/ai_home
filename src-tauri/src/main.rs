#![cfg_attr(
    all(not(debug_assertions), target_os = "windows"),
    windows_subsystem = "windows"
)]

mod app_state;
mod blob_store;
mod commands;
mod endpoint;
mod error;
mod lan_route_trust;
mod profile_store;
mod secret_store;
mod server_discovery;
mod server_http;
mod server_id;
mod server_route_runtime;
mod smoke_driver;
mod stream_registry;
mod tray;

use app_state::AppState;
use tauri::Manager;

fn main() {
    if smoke_driver::is_enabled() {
        std::process::exit(smoke_driver::run());
    }
    tauri::Builder::default()
        .system_tray(tray::create_system_tray())
        .on_system_tray_event(tray::handle_event)
        .on_window_event(|event| {
            if event.window().label() != "main" {
                return;
            }
            if !tray::should_hide_main_window_on_close() {
                return;
            }
            if let tauri::WindowEvent::CloseRequested { api, .. } = event.event() {
                api.prevent_close();
                let _ = event.window().hide();
            }
        })
        .setup(|app| {
            let config_dir = app
                .path_resolver()
                .app_config_dir()
                .ok_or("failed to resolve native app config directory")?;
            app.manage(AppState::load(&config_dir)?);
            tray::start_refresh_loop(app.handle());
            Ok(())
        })
        .register_uri_scheme_protocol("aihblob", |app, request| {
            app.state::<AppState>().blobs.protocol_response(request)
        })
        .invoke_handler(tauri::generate_handler![
            commands::desktop_profile_list,
            commands::desktop_profile_upsert,
            commands::desktop_profile_remove,
            commands::desktop_profile_set_active,
            commands::desktop_profile_get_active,
            commands::desktop_discover_servers,
            commands::desktop_outbound_relays_configure,
            commands::desktop_frp_route_configure,
            commands::desktop_relay_route_trust,
            commands::desktop_lan_profile_authorize,
            commands::desktop_lan_routes_refresh,
            commands::desktop_management_key_rotate,
            commands::desktop_http_request,
            commands::desktop_blob_request,
            commands::desktop_blob_release,
            commands::desktop_stream_open,
            commands::desktop_stream_cancel,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
