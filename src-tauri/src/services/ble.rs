use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use btleplug::api::{Central, Characteristic, Manager as _, Peripheral as _, ScanFilter};
use btleplug::platform::{Adapter, Manager as BtleManager, Peripheral};
use futures::StreamExt;
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::Mutex;
use uuid::Uuid;

const HR_SERVICE: Uuid = Uuid::from_u128(0x0000180d_0000_1000_8000_00805f9b34fb);
const HR_MEASUREMENT: Uuid = Uuid::from_u128(0x00002a37_0000_1000_8000_00805f9b34fb);

/// BLE 服务：btleplug（WinRT 后端）
/// - 扫描：轮询发现的外设，去重后向所有窗口广播 ble:device-found
/// - 连接：GATT 0x180D 服务订阅 0x2A37 心率通知，解析后广播 ble:heart-rate
pub struct BleState {
    core: Mutex<Option<Core>>,
    connected: Mutex<Option<String>>,
    scanning: Arc<AtomicBool>,
    notify_task: Mutex<Option<tauri::async_runtime::JoinHandle<()>>>,
}

struct Core {
    _manager: BtleManager,
    adapter: Adapter,
    /// 扫描期间累积的外设句柄，供按 id 连接
    peripherals: HashMap<String, Peripheral>,
    seen: HashSet<String>,
}

#[derive(Serialize, Clone)]
pub struct DeviceFound {
    pub id: String,
    pub name: Option<String>,
    pub rssi: Option<i16>,
}

#[derive(Serialize, Clone)]
pub struct HeartRate {
    pub bpm: u16,
    pub device_id: String,
}

impl BleState {
    pub fn new() -> Self {
        Self {
            core: Mutex::new(None),
            connected: Mutex::new(None),
            scanning: Arc::new(AtomicBool::new(false)),
            notify_task: Mutex::new(None),
        }
    }
}

fn parse_heart_rate(data: &[u8]) -> Option<u16> {
    if data.len() < 2 {
        return None;
    }
    let bpm = if data[0] & 0x01 != 0 {
        if data.len() < 3 {
            return None;
        }
        u16::from_le_bytes([data[1], data[2]])
    } else {
        data[1] as u16
    };
    (1..=250).contains(&bpm).then_some(bpm)
}

fn find_hr_char(peripheral: &Peripheral) -> Option<Characteristic> {
    peripheral
        .characteristics()
        .into_iter()
        .find(|c| c.uuid == HR_MEASUREMENT)
}

/// 通知流任务：流结束（断开）后自清理
async fn notify_pump(app: AppHandle, peripheral: Peripheral, device_id: String) {
    let hr_char = match find_hr_char(&peripheral) {
        Some(c) => c,
        None => {
            let _ = app.emit("ble:error", "设备没有心率服务 (0x180D)");
            return;
        }
    };
    if let Err(e) = peripheral.subscribe(&hr_char).await {
        let _ = app.emit("ble:error", format!("订阅心率通知失败: {e}"));
        return;
    }
    let mut stream = match peripheral.notifications().await {
        Ok(s) => s,
        Err(e) => {
            let _ = app.emit("ble:error", format!("打开通知流失败: {e}"));
            return;
        }
    };
    while let Some(item) = stream.next().await {
        if item.uuid == HR_MEASUREMENT {
            if let Some(bpm) = parse_heart_rate(&item.value) {
                let _ = app.emit("ble:heart-rate", HeartRate { bpm, device_id: device_id.clone() });
            }
        }
    }
    let _ = app.emit("ble:disconnected", device_id.clone());
    let state = app.state::<BleState>();
    *state.connected.lock().await = None;
    *state.notify_task.lock().await = None;
}

/// 初始化蓝牙（首次调用时创建 Manager/Adapter）
async fn init_ble(state: &BleState) -> Result<(), String> {
    let mut guard = state.core.lock().await;
    if guard.is_some() {
        return Ok(());
    }
    let manager = BtleManager::new().await.map_err(|e| format!("BLE manager: {e}"))?;
    let adapters = manager.adapters().await.map_err(|e| format!("BLE adapters: {e}"))?;
    let adapter = adapters
        .into_iter()
        .next()
        .ok_or("未找到蓝牙适配器（本机蓝牙可能未开启）")?;
    *guard = Some(Core {
        _manager: manager,
        adapter,
        peripherals: HashMap::new(),
        seen: HashSet::new(),
    });
    Ok(())
}

/// 开始扫描；发现的新设备通过 ble:device-found 事件广播
#[tauri::command]
pub async fn ble_start_scan(app: AppHandle, state: tauri::State<'_, BleState>) -> Result<(), String> {
    init_ble(&state).await?;

    // 每次扫描都重置去重集合：已上报过的设备允许重新上报（设置窗重开后也能刷新列表）
    {
        let mut core_guard = state.core.lock().await;
        if let Some(core) = core_guard.as_mut() {
            core.seen.clear();
            core.peripherals.clear();
        }
    }

    {
        let core_guard = state.core.lock().await;
        let core = core_guard.as_ref().ok_or("BLE init failed")?;
        core
            .adapter
            .start_scan(ScanFilter::default())
            .await
            .map_err(|e| format!("启动扫描失败: {e}"))?;
    }

    if state.scanning.swap(true, Ordering::SeqCst) {
        return Ok(()); // 扫描已在进行
    }
    let scanning = state.scanning.clone();
    tauri::async_runtime::spawn(async move {
        while scanning.load(Ordering::SeqCst) {
            let mut report: Vec<DeviceFound> = Vec::new();
            {
                let app_state = app.state::<BleState>();
                let mut core_guard = app_state.core.lock().await;
                if let Some(core) = core_guard.as_mut() {
                    if let Ok(peripherals) = core.adapter.peripherals().await {
                        for p in peripherals {
                            let id = format!("{}", p.id());
                            let is_new = !core.seen.contains(&id);
                            if is_new {
                                core.seen.insert(id.clone());
                                let (name, rssi) = match p.properties().await {
                                    Ok(Some(props)) => (props.local_name, props.rssi),
                                    _ => (None, None),
                                };
                                core.peripherals.insert(id.clone(), p.clone());
                                report.push(DeviceFound { id, name, rssi });
                            }
                        }
                    }
                }
            }
            for d in report {
                let _ = app.emit("ble:device-found", d);
            }
            tokio::time::sleep(Duration::from_millis(800)).await;
        }
    });
    Ok(())
}

#[tauri::command]
pub async fn ble_stop_scan(state: tauri::State<'_, BleState>) -> Result<(), String> {
    state.scanning.store(false, Ordering::SeqCst);
    let core_guard = state.core.lock().await;
    if let Some(core) = core_guard.as_ref() {
        let _ = core.adapter.stop_scan().await;
    }
    Ok(())
}

/// 连接指定设备并订阅心率通知（会自动断开旧连接）
#[tauri::command]
pub async fn ble_connect(app: AppHandle, state: tauri::State<'_, BleState>, device_id: String) -> Result<(), String> {
    init_ble(&state).await?;

    // 断开旧连接
    let current = state.connected.lock().await.clone();
    if let Some(old) = current {
        if old != device_id {
            let _ = ble_disconnect_inner(&state, old).await;
        }
    }

    let peripheral = {
        let core_guard = state.core.lock().await;
        let core = core_guard.as_ref().ok_or("BLE init failed")?;
        core
            .peripherals
            .get(&device_id)
            .cloned()
            .ok_or("设备未在扫描结果中，请先扫描")?
    };
    peripheral.connect().await.map_err(|e| format!("连接失败: {e}"))?;
    peripheral
        .discover_services()
        .await
        .map_err(|e| format!("发现服务失败: {e}"))?;
    if find_hr_char(&peripheral).is_none()
        || !peripheral.services().iter().any(|s| s.uuid == HR_SERVICE)
    {
        let _ = peripheral.disconnect().await;
        return Err("该设备没有标准心率服务 (0x180D)".into());
    }

    *state.connected.lock().await = Some(device_id.clone());
    let task = tauri::async_runtime::spawn(notify_pump(app, peripheral, device_id));
    *state.notify_task.lock().await = Some(task);
    Ok(())
}

async fn ble_disconnect_inner(state: &BleState, device_id: String) -> Result<(), String> {
    if let Some(task) = state.notify_task.lock().await.take() {
        task.abort();
    }
    let core_guard = state.core.lock().await;
    if let Some(core) = core_guard.as_ref() {
        if let Ok(peripherals) = core.adapter.peripherals().await {
            if let Some(p) = peripherals.into_iter().find(|p| format!("{}", p.id()) == device_id) {
                let _ = p.disconnect().await;
            }
        }
    }
    drop(core_guard);
    *state.connected.lock().await = None;
    Ok(())
}

#[tauri::command]
pub async fn ble_disconnect(state: tauri::State<'_, BleState>) -> Result<(), String> {
    let current = state.connected.lock().await.clone();
    match current {
        Some(id) => ble_disconnect_inner(&state, id).await,
        None => Ok(()),
    }
}

#[tauri::command]
pub async fn ble_connected_device(state: tauri::State<'_, BleState>) -> Result<Option<String>, String> {
    Ok(state.connected.lock().await.clone())
}
