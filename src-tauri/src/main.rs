// 防止 Windows release 构建出现额外控制台窗口
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    desktop_pet_lib::run()
}
