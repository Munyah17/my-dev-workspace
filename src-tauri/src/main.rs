#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use tauri::Manager;

fn main() {
    tauri::Builder::default()
        .setup(|app| {
            if let Some(value) = option_env!("WORKSPACE_DESKTOP_URL") {
                let url = tauri::Url::parse(value)?;
                if url.scheme() != "https" || !url.username().is_empty() || url.password().is_some() {
                    return Err(std::io::Error::new(std::io::ErrorKind::InvalidInput, "Workspace URL must use HTTPS without credentials").into());
                }
                if let Some(window) = app.get_webview_window("main") {
                    window.navigate(url)?;
                }
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("could not launch MyDev Workspace");
}
