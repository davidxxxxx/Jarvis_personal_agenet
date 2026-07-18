# Jarvis 启动、预算、录音反馈与当前页总结实施计划

**规格：** `docs/superpowers/specs/2026-07-17-jarvis-start-budget-ui-summary-design.md`  
**分支：** `codex/jarvis-start-budget-ui`  
**工作区：** `G:\Jarvis\.worktrees\jarvis-all-day-runtime`

## 执行原则

- 每项先增加失败测试，再实现最小改动，最后跑相关回归。
- 数据库、IPC、运行时守卫和 UI 必须在同一个提交中保持契约一致。
- 不创建新的音频分析器；波形复用现有 `currentMicLevel`。
- 测试临时目录、npm 缓存和打包产物统一放在 `G:\Jarvis\.runtime-cache`。
- 不触碰主工作区中与本任务无关的修改。

## Task 1：数据根运行租约与幂等接管

### 测试

- 扩展 `app/test/jarvis/DirectoryLease.test.js`：
  - 第二个 Windows 租约不能取得同一目录；
  - 释放后可重新取得；
  - 错误保持稳定的公开错误码。
- 扩展 `app/test/jarvis/DataRootRelocator.test.js`：
  - 源、目标录音根相同直接跳过；
  - 数据定位器已经全部指向目标时不替换数据库；
  - 安全的陈旧临时数据库可清理，不安全条目保留并失败关闭。
- 新增或扩展启动组合测试，证明租约先于 `adoptLegacyStorage` 和 `JarvisRepository` 打开。

### 实现

- 在 `app/main.js` 的核心管理器初始化中：
  - 创建并持有 `DirectoryLeaseProvider`；
  - 在接管和打开数据库前取得最终数据根租约；
  - 启动失败和正常退出都释放租约；
  - 将租约冲突转换为固定、脱敏的启动错误。
- 在 `app/src/jarvis/main/JarvisStorageBootstrap.js` 中增加明确的接管必要性判断。
- 在 `app/src/jarvis/main/DataRootRelocator.js` 中增加定位器无变化的 no-op 路径，以及受约束的临时文件清理。
- 保持在线数据目录迁移现有租约协议不变，并确保运行租约不会与迁移租约形成自锁。

### 验证

```powershell
node --test test/jarvis/DirectoryLease.test.js test/jarvis/DataRootRelocator.test.js
```

## Task 2：MiniMax 预算三态契约

### 测试

- 扩展 `app/test/jarvis/AnalysisBudgetMigration.test.js`：
  - 旧策略迁移为 `capped` 或 `off`；
  - 策略和周期均持久化 `mode`；
  - 新约束、不可变触发器和策略绑定完整。
- 扩展：
  - `AnalysisBudgetRepository.test.js`
  - `AnalysisBudgetGuard.test.js`
  - `AnalysisBudgetService.test.js`
  - `AnalysisBudgetPolicyBinding.test.js`
  - `JarvisIpc.test.js` 或对应 IPC 测试
- 覆盖 200 美元、关闭、限额、不限额、未知用量和重启恢复。
- 扩展 `app/src/jarvis/renderer/__tests__/MiniMaxAgentSettingsCard.test.tsx`，覆盖模式切换、警告和 200 美元保存。

### 实现

- 在 `app/src/jarvis/main/JarvisMigrations.js` 增加下一版迁移：
  - `analysis_budget_policy_revisions.mode`
  - `analysis_budget_periods.mode`
  - 允许最高 1,000,000 美元对应的安全 micro-USD 整数；
  - 重建依赖旧约束的表和触发器。
- 在以下位置统一输入和输出：
  - `app/src/jarvis/shared/contracts.js`
  - `app/src/jarvis/main/AnalysisBudgetRepository.js`
  - `app/src/jarvis/main/AnalysisBudgetGuard.js`
  - `app/src/jarvis/main/registerJarvisIpc.js`
  - preload 暴露类型及 `app/src/jarvis/types.ts`
- `unlimited` 跳过金额和未知用量阻断，但仍创建预算尝试并核算实际用量。
- `off` 在发送前稳定阻断。
- 更新 `MiniMaxAgentSettingsCard.tsx` 为模式选择器；只有 `capped` 显示金额输入。

### 验证

```powershell
node --test test/jarvis/AnalysisBudgetMigration.test.js test/jarvis/AnalysisBudgetRepository.test.js test/jarvis/AnalysisBudgetGuard.test.js test/jarvis/AnalysisBudgetService.test.js test/jarvis/AnalysisBudgetPolicyBinding.test.js
npm run test:renderer -- MiniMaxAgentSettingsCard
```

## Task 3：有界录音启动状态机

### 测试

- 为 `useJarvisRecording.ts` 增加控制器测试：
  - 按顺序发出模型检查、模型下载、麦克风检查、音频启动阶段；
  - 每阶段失败后持久会话不残留 `recording`；
  - 可取消、可重试。
- 扩展 meeting recording store 测试：
  - `getUserMedia` 永不返回时有界失败；
  - 超时后返回的流会立即停止；
  - 重新枚举后选定设备失败会回退物理/默认设备；
  - 成功后的音轨掉线仍进入现有无限恢复。
- 扩展 `RecordingControlsRecovery.test.tsx`，验证阶段文案和操作按钮。

### 实现

- 在 `app/src/jarvis/renderer/useJarvisRecording.ts`：
  - 将单一 `starting` 操作扩展为公开的 `preparationStage`；
  - 模型下载保留可见长任务；媒体与 IPC 使用有界等待；
  - 失败时执行统一的捕获清理与会话回滚。
- 在 `app/src/stores/meetingRecordingStore.ts`：
  - 引入可测试的超时/取消辅助器；
  - 管理晚到媒体流；
  - 复用现有麦克风候选排序和恢复逻辑完成初始回退。
- 在 `RecordingControls.tsx` 展示真实阶段、失败原因和重试。

### 验证

```powershell
npm run test:renderer -- RecordingControlsRecovery useJarvisRecording meetingRecordingStore
```

## Task 4：低功耗波形与设置抽屉

### 测试

- 新增 `InputLevelWave.test.tsx`：
  - 静音、活跃、恢复、不可用、系统声音模式；
  - `role=meter` 和数值；
  - 不创建 `AudioContext` 或定时器。
- 新增 `TodayView.test.tsx`：
  - 默认右栏不再挂载完整设置卡；
  - 设置按钮打开抽屉；
  - 所有原设置入口仍可访问。

### 实现

- 新增 `app/src/jarvis/renderer/InputLevelWave.tsx`，只消费 `recording.micLevel` 与源状态。
- 新增统一设置抽屉组件，将：
  - 麦克风/系统声音设置；
  - MiniMax Key 与预算；
  - OpenAI 纠错、转写质量和声纹校准
  重新分组，但不改变各模块的持久逻辑。
- 精简 `TodayView.tsx` 右栏，仅保留日结和紧凑状态。
- 必要时调整 `JarvisShell.tsx` 的右栏宽度与响应式布局。
- 增加中英文文案和 reduced-motion 样式。

### 验证

```powershell
npm run test:renderer -- InputLevelWave TodayView MiniMaxAgentSettingsCard
```

## Task 5：Finish and summarize 当前页闭环

### 测试

- 为录音控制器/Today 视图增加测试：
  - Finish 成功后立即进入 `summarizing`；
  - 最终分析完成后当前页面显示持久摘要；
  - Today 和 Memory 显示同一会话摘要；
  - 失败时显示设置、重试和查看转写动作；
  - 重复重试幂等；
  - 页面刷新/应用重启恢复最近完成会话。
- 扩展 `AnalysisScheduler.test.js` 和 IPC 测试，确保公开状态足以驱动界面且不泄露内部数据。

### 实现

- 在 `useJarvisRecording.ts` 中把最终分析 ID 和可恢复状态纳入返回值，不用 fire-and-forget 隐藏结果。
- 新增 `SessionSummaryPanel.tsx`：
  - 查询会话详情和分析公开状态；
  - 有界轮询，页面隐藏时降频；
  - 直接渲染持久 summary、topics、todos、suggestions。
- `TodayView.tsx` 在 Live Transcript 下方展示本次总结状态和结果。
- 启动时读取最近完成会话；新录音只收起旧结果，不删除 Memory。
- 重试调用同一会话的 final analysis，不创建平行摘要。

### 验证

```powershell
node --test test/jarvis/AnalysisScheduler.test.js
npm run test:renderer -- SessionSummaryPanel TodayView MemoryView
```

## Task 6：整体验证与 Windows 打包

1. 运行格式、类型和完整 Jarvis 测试。
2. 将一次 Windows 临时目录 `ENOTEMPTY` 清理竞态与产品逻辑失败区分；若重现则修复测试清理。
3. 构建 Windows unpacked 包，确认原生模块 ABI 正确。
4. 在真实应用中验证：
   - 第二实例的友好拒绝；
   - Start Listening 阶段和超时；
   - 实体麦克风波形；
   - 200 美元和不限额预算重启持久化；
   - Finish 后当前页显示摘要；
   - Memory 可再次打开相同摘要。
5. 检查 G 盘数据目录、日志和临时目录；确认 C 盘未新增大文件。

### 最终命令

```powershell
npm run format:check
npm run typecheck
npm run test:jarvis
npm run build
```

## 提交边界

按以下边界提交，便于回滚：

1. `fix: lock Jarvis data root before startup adoption`
2. `feat: add explicit MiniMax budget modes`
3. `fix: bound and expose recording preparation`
4. `feat: add low-power input wave and settings drawer`
5. `feat: show durable session summary after finish`
6. `test: verify Jarvis startup and summary workflow`

