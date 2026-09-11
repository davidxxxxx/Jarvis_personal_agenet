# 从源码开始

需要 Windows、Git、Node.js **24+**、npm。应用源码在 `app/`，不要在旧的根 checkout 上误启动另一个版本。

```powershell
git clone https://github.com/davidxxxxx/Jarvis_personal_agenet.git G:\JarvisDev
Set-Location G:\JarvisDev
git switch codex/jarvis-start-budget-ui
New-Item -ItemType Directory -Force G:\JarvisDev\.runtime-cache\tmp | Out-Null
$env:TEMP='G:\JarvisDev\.runtime-cache\tmp'
$env:TMP=$env:TEMP
$env:npm_config_cache='G:\JarvisDev\.runtime-cache\npm'
$env:ELECTRON_CACHE='G:\JarvisDev\.runtime-cache\electron'
$env:electron_config_cache=$env:ELECTRON_CACHE
Set-Location app
npm ci --ignore-scripts --no-audit --no-fund
node node_modules/electron/install.js
npm rebuild better-sqlite3 --foreground-scripts
npm run test:renderer -- --maxWorkers=4 --minWorkers=1
npm run typecheck
npm run build:renderer
```

上述流程用于源码和前端检查，不会自动准备全部语音模型或开始录音。`--ignore-scripts` 刻意跳过大模型/原生依赖安装；运行完整应用前仍需准备相应组件。

## 完整应用的额外准备

1. `npm run compile:windows-system-audio` 构建带源码哈希的 WASAPI helper，需要 Zig **0.16.0**；可用 `JARVIS_ZIG_PATH` 指向 G 盘上的 `zig.exe`。
2. 下载所选 Whisper 模型，按[模型组件说明](../../app/resources/ai-model-pack/README.md)准备/验证高精度声纹模型。受限模型要先取得访问授权；仓库不包含访问 Token 或权重。
3. 检查 `package.json` 中 `predev` / `prestart`：`npm run dev` 和 `npm start` 会执行原生编译和部分依赖下载，不是无副作用的健康检查。
4. 启动前确认开发 profile / 数据根目录与生产隔离，并确认磁盘、模型、麦克风权限；不要让开发版和正式版同时打开同一数据库。

本次 rc.13 只交付源码重构；不能用仓库存在或构建成功代替新安装包/本机录音验收。准备分发包请看[开发指南](development.md)。
