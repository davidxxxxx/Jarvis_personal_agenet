# 开发验证

在 `app/` 下运行，首先把 `TEMP`/`TMP` 和缓存指向存在的非系统盘目录。依赖准备见[开始使用](../guides/getting-started.md)。测试使用临时/内存数据库，不应指定生产数据根目录。

```powershell
node --test test/jarvis/ModuleBoundaries.test.js
npm run test:main
npm run test:renderer -- --maxWorkers=4 --minWorkers=1
npm run typecheck
npm run lint
npm run build:renderer
npm run release:check -- --tag jarvis-v0.2.0-rc.13
```

`test:main` 排除两个独立 soak 文件。在日常工作电脑上可限制并行度，保持同样的测试清单：

```powershell
$files = Get-ChildItem test/jarvis -Filter '*.test.js' |
  Where-Object Name -NotIn @('AllDayCaptureSoak.test.js','AllDayResourceSoak.test.js') |
  Sort-Object Name | ForEach-Object FullName
node --test --test-concurrency=4 @files
```

Windows 主进程测试包含 helper 源码/二进制哈希及 capability 检查，需要先执行 `npm run compile:windows-system-audio`。测试不应因为全新 checkout 未生成二进制而把环境缺失错认成业务回归；也不能跳过失败后声称全绿。

## rc.13 的专项保护

- `ModuleBoundaries.test.js`：兼容导出、无反向容器依赖、应用代次聚合、混音覆盖、声纹公开门禁、哈希/校验、IPC 脱敏和真实执行设备一致性。
- `SessionSummaryCard.test.tsx`：处理中与未生成的区别，刷新必须显式点击，加载时禁用重复请求。
- 现有 `JarvisProcessingRuntime.test.js`、`MemoryRepository.test.js`、`contracts.test.js` 和 `MemoryView.test.tsx` 继续经由兼容入口覆盖集成行为。

## 不属于自动证明的内容

真实 CUDA、实体麦克风与 WASAPI 录音、人工声纹准确率、云账户/费用、三小时真实耐久以及 Windows 安装/重启都需要单独验收。沿用[完整验收矩阵](jarvis-phase4-release-acceptance.md)与[私人声纹测试规则](../TESTING.md)。本轮结果见 [rc.13 验证记录](rc13-modularization.md)。
