# DesktopPet — 插件驱动的 Windows 桌面宠物

Tauri 2 + TypeScript/Vite 实现的桌面宠物框架：宠物本体只提供窗口、渲染与插件运行时，所有功能（BLE 心率、token 用量、待办等）由插件提供。完整设计见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)，插件开发规范见 docs/PLUGIN_SDK.md（实施步骤 5 编写）。

## 开发环境

- Node.js ≥ 20 与 npm
- Rust stable（`x86_64-pc-windows-msvc`）+ Visual Studio Build Tools（C++ 工作负载）
- Windows 10 1809+（WebView2 Runtime）

## 常用命令

```bash
npm install          # 首次安装前端依赖
npm run tauri dev    # 开发运行：宠物窗 + 前端热更新
npm run tauri build  # 打包发布
```

## 目录速览

- `src/pet/` 宠物渲染：立绘加载（含程序生成兜底）+ 播放器 + 状态机
- `src/runtime/` 插件运行时（manifest 校验、能力桥、事件总线、widget 宿主）
- `src-tauri/` Rust 宿主：窗口/托盘/单实例 + BLE/存储/权限/overlay 服务
- `plugins/` 示例插件（心率蓝牙已就绪）

## 致谢

- 宠物立绘「鲸鱼娘」来自开源项目 [dsh-whale-musume](https://github.com/Sutera-Diffusus/dsh-whale-musume)（© Sutera-Diffusus，MIT 协议），素材清单见 [src/pet/assets/whale/README.md](src/pet/assets/whale/README.md)

