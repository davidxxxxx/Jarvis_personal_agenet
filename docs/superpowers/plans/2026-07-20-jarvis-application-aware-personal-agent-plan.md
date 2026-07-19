# Jarvis 应用感知个人 Agent 四阶段实施计划

**规格：** `docs/superpowers/specs/2026-07-20-jarvis-application-aware-personal-agent-design.md`
**工作区：** `G:\Jarvis\.worktrees\jarvis-all-day-runtime`
**应用目录：** `G:\Jarvis\.worktrees\jarvis-all-day-runtime\app`
**当前数据库版本：** 31
**交付方式：** 四阶段、功能开关保护、逐阶段迁移与回归

## 0. 执行约束

- 当前工作树已有大量未提交修改，均视为用户现有成果；执行前记录 diff，不能回退或覆盖无关修改。
- 所有测试临时目录、npm 缓存、模型、下载和打包产物放在 `G:\Jarvis\.runtime-cache`、`G:\JarvisData` 或工作树内。
- 不向 C 盘写入模型、音频、打包目录或大型测试数据。
- 先测试后实现；数据库、共享契约、IPC、preload、renderer 类型和 UI 在同一任务内保持一致。
- 新能力位于独立功能开关后：
  - `applicationAudioV1`
  - `dualSpeakerVerificationV1`
  - `activityClassificationV1`
  - `actionCenterV1`
- 功能开关只控制新行为，不能绕过迁移、证据写入或安全清理。
- 每阶段先通过 focused tests，再跑 Jarvis 回归；只有阶段门禁通过才启用下一阶段。
- 原始音频证据不可被应用去重、分类或身份结果删除。

## 1. 依赖关系

```text
Phase 1 来源与数据底座
        ↓
Phase 2 人物与场景智能
        ↓
Phase 3 行动与个性化
        ↓
Phase 4 主界面与完整闭环
```

Phase 2 可以读取 Phase 1 的规范化应用轨；Phase 3 只能读取 Phase 2 已采用的身份和场景结果；Phase 4 只消费持久公共投影，不能在 renderer 内重新推断。

---

# Phase 1：来源与数据底座

## 版本与 GitHub 检查点

- Phase 1 完成：`0.2.0-alpha.1` / `jarvis-v0.2.0-alpha.1`
- Phase 2 完成：`0.2.0-alpha.2` / `jarvis-v0.2.0-alpha.2`
- Phase 3 完成：`0.2.0-beta.1` / `jarvis-v0.2.0-beta.1`
- Phase 4 验收：`0.2.0-rc.1` / `jarvis-v0.2.0-rc.1`
- 最终验证：`0.2.0` / `jarvis-v0.2.0`

每个节点必须更新 `CHANGELOG.md`，记录完整 commit SHA、数据库 schema 版本、测试证据和
安装包 SHA-256。当前只有上游 `openwhispr` remote；首次推送前必须增加用户自有的
`origin`，严禁把 Jarvis 分支推到上游仓库。详细规则见 `docs/VERSIONING.md`。

## Task 1.1：数据库 v32 多应用音轨迁移

### 测试

扩展：

- `app/test/jarvis/JarvisMigrations.test.js`
- `app/test/jarvis/CaptureEvidenceStore.test.js`
- `app/test/jarvis/JarvisRepository.test.js`
- `app/test/jarvis/KnowledgeContracts.test.js`

覆盖：

- v31 空库和真实结构副本迁移到 v32。
- 旧 mic/system 轨分别迁移为 `mic/system_mix`。
- 一个会话允许多条 application 轨。
- 所有 `audio_chunks`、`transcript_segments`、`processing_jobs`、`speaker_turns` 和 evidence 外键保持原 ID。
- 重复运行迁移幂等。
- 失败时事务回滚且 `user_version` 不前进。
- 原始路径和窗口标题无法写入长期应用来源表。

### 实现

修改：

- `app/src/jarvis/main/JarvisMigrations.js`
- `app/src/jarvis/main/JarvisRepository.js`
- `app/src/jarvis/main/CaptureEvidenceStore.js`
- `app/src/jarvis/main/MultiTrackAudioWriter.js`
- `app/src/jarvis/shared/contracts.js`
- `app/src/jarvis/types.ts`

新增：

- `track_kind = mic | system_mix | application`
- `application_key`
- `application_display_name`
- `attribution_state = exact | mixed_unknown`
- 应用活动区间、捕获代次和降级区间表
- 按 session、track kind、application key 和时间的索引

保留 `source_type = mic | system` 作为兼容字段；application 轨的兼容 `source_type` 为 `system`。

### 验证

```powershell
node --test test/jarvis/JarvisMigrations.test.js test/jarvis/CaptureEvidenceStore.test.js test/jarvis/JarvisRepository.test.js test/jarvis/KnowledgeContracts.test.js
```

## Task 1.2：Windows 音频会话发现和 include-process 捕获

### 测试

新增：

- `app/test/jarvis/WindowsAudioSessionWatcher.test.js`
- `app/test/jarvis/WindowsApplicationLoopback.test.js`
- native helper 参数、JSON 协议、父进程退出和打包 ABI 静态测试

覆盖：

- 发现、激活、静音、失效和 PID 重用。
- 同一应用多进程规范化。
- include process tree 与现有 exclude process tree 模式互不破坏。
- 不把路径、窗口标题或命令行写入事件。
- helper 异常退出、父进程退出和设备切换。
- 不支持的 Windows build 明确返回 capability，不进入重启循环。

### 实现

修改：

- `app/resources/windows-system-audio-helper.c`
- `app/src/helpers/windowsLoopbackAudioManager.js`
- `app/scripts/build-windows.js`
- `app/electron-builder.json`
- `app/main.js`

新增：

- `app/src/helpers/windowsAudioSessionWatcher.js`
- `app/src/helpers/applicationNameNormalizer.js`

native helper 增加：

- 活动音频会话 watch/list 协议。
- `include-process-tree` 捕获模式。
- 稳定、脱敏的 line-delimited JSON 状态事件。
- 显式 capability 和最低 Windows build 检查。

规范化只持久化应用键和展示名；PID、路径等只停留在内存。

### 验证

```powershell
node --test test/jarvis/WindowsAudioSessionWatcher.test.js test/jarvis/WindowsApplicationLoopback.test.js test/jarvis/NativeAbiPackaging.test.js
```

## Task 1.3：动态应用音轨池与安全兜底

### 测试

新增：

- `app/test/jarvis/ApplicationAudioCapturePool.test.js`
- `app/test/jarvis/ApplicationAudioFallback.test.js`
- `app/test/jarvis/ApplicationAudioSoak.test.js`

扩展：

- `app/test/jarvis/MultiTrackAudioWriter.test.js`
- `app/test/jarvis/AllDayCaptureSoak.test.js`
- `app/test/jarvis/FullscreenYieldPolicy.test.js`

覆盖：

- 默认四轨、设置 1–8 轨。
- 会议/通话、前台、浏览器/学习、游戏/后台媒体优先级。
- 活动后建立、静音后释放。
- 混合前缓冲补齐应用轨开头。
- 超限、应用重启、设备切换和权限失败时保守降级。
- 全屏游戏最多两条应用轨。
- 应用池变化不停止麦克风或混合系统轨。
- 长时间运行无 helper、句柄、Buffer 或 timer 无界增长。

### 实现

新增：

- `app/src/jarvis/main/ApplicationAudioCapturePool.js`
- `app/src/jarvis/main/ApplicationAudioPolicy.js`
- `app/src/jarvis/main/ApplicationAudioStatus.js`

修改：

- `app/main.js`
- `app/src/stores/meetingRecordingStore.ts`
- `app/src/jarvis/main/MultiTrackAudioWriter.js`
- `app/src/jarvis/main/PreviewAudioRing.js`
- `app/src/jarvis/main/ResourceGovernor.js`
- `app/src/jarvis/main/FullscreenYieldPolicy.js`
- `app/src/jarvis/main/registerJarvisIpc.js`
- `app/preload.js`
- `app/src/types/electron.ts`

混合系统轨始终是安全兜底；应用轨只提高来源精度，不能成为唯一音频证据。

### 验证

```powershell
node --test test/jarvis/ApplicationAudioCapturePool.test.js test/jarvis/ApplicationAudioFallback.test.js test/jarvis/MultiTrackAudioWriter.test.js test/jarvis/FullscreenYieldPolicy.test.js
```

## Task 1.4：数据库 v33 跨轨重复、来源公共投影和设置

### 测试

扩展：

- `app/test/jarvis/SessionDiarizationWorker.test.js`
- `app/test/jarvis/AnalysisInputBuilder.test.js`
- `app/test/jarvis/MemoryRepository.test.js`
- `app/src/jarvis/renderer/__tests__/ResourceGovernanceSettingsCard.test.tsx`

新增应用来源覆盖率和重复主转写测试。

### 实现

修改：

- `app/src/jarvis/main/SessionDiarizationWorker.js`
- `app/src/jarvis/main/MemoryRepository.js`
- `app/src/jarvis/main/AnalysisInputBuilder.js`
- `app/src/jarvis/renderer/ResourceGovernanceSettingsCard.tsx`
- `app/src/jarvis/renderer/ProcessingStatus.tsx`
- 中英文 locale

输出：

- 每个 segment 的规范化应用来源和 attribution state。
- 重复主片段及关联来源。
- 应用级捕获覆盖率、降级区间和恢复点。
- 活动音轨池上限及当前轨状态。

### Phase 1 门禁

- v31 数据库副本逐级迁移到 v33、回滚和外键检查通过。
- 实体麦克风、混合系统轨和应用轨同时录制不少于 30 分钟。
- KOOK 与 Chrome 能形成独立轨。
- DOTA 2 全屏让路不启动重型任务、不留下窗口残影。
- 功能关闭时行为与现有发布版一致。

---

# Phase 2：人物与场景智能

## Task 2.1：中文 CAM++ 与 ERes2NetV2 模型运行时

### 测试

扩展：

- `app/test/jarvis/SpeakerEmbeddingsPrivacy.test.js`
- `app/test/jarvis/SpeakerIdentityEvaluationContract.test.js`
- `app/test/jarvis/SpeakerIdentityEvaluationGate.test.js`
- `app/test/jarvis/NativeAbiPackaging.test.js`

新增：

- 模型清单、SHA-256、G 盘安装、原子切换和失败回滚测试。
- 两模型维度、模型 ID、阈值和 embedding 空间隔离测试。

### 实现

修改：

- `app/src/helpers/speakerEmbeddings.js`
- `app/src/workers/onnxWorker.js`
- `app/src/jarvis/main/SpeakerProcessingPolicy.js`
- `app/src/jarvis/main/SessionDiarizationPolicy.js`
- `app/src/jarvis/main/ResourceGovernor.js`

新增：

- `app/src/jarvis/main/SpeakerModelManifest.js`
- `app/src/jarvis/main/DualSpeakerVerifier.js`

规则：

- CAM++ 全天初判。
- ERes2NetV2 只在空闲、边界样本和高影响身份上运行。
- 两模型版本、阈值、margin、质量和评测指标分别持久化。
- 模型下载和缓存不得进入 C 盘。

## Task 2.2：三段本人录入与谨慎持续学习

### 测试

扩展：

- `app/src/jarvis/renderer/__tests__/VoiceEnrollment.test.tsx`
- `app/test/jarvis/PreloadVoiceEnrollment.test.js`
- `app/test/jarvis/SpeakerProfileIdentity.test.js`
- `app/test/jarvis/SpeakerIdentityRepository.test.js`

覆盖三段独立质量、内部一致性、实体麦克风限制、密文保存、取消、重录和内存清零。

### 实现

修改：

- `app/src/jarvis/renderer/VoiceEnrollment.tsx`
- `app/src/jarvis/main/VoiceEnrollmentService.js`
- `app/src/jarvis/main/VoiceProfileStore.js`
- `app/src/jarvis/main/SpeakerIdentityRepository.js`
- `app/src/jarvis/main/SpeakerIdentityResolutionPolicy.js`

录入完成前不得显示“已绑定”。持续学习必须同时通过实体麦克风、无重叠、非回声、高置信匹配和用户确认。

## Task 2.3：匿名跨会话人物双模型关联

### 测试

扩展：

- `app/test/jarvis/SpeakerIdentityResolution.test.js`
- `app/test/jarvis/SpeakerCorrectionService.test.js`
- `app/test/jarvis/SessionDiarizationRepository.test.js`
- `app/src/jarvis/renderer/__tests__/SpeakerChip.test.tsx`

覆盖：

- 两模型同时通过才自动关联匿名人物。
- 单模型、margin 不足、来源未知和重叠说话保持会话级 unknown。
- 自我介绍只能生成名字候选。
- 用户确认、撤销、拆分、合并和真实姓名本地化。

### 实现

修改：

- `app/src/jarvis/main/SpeakerIdentityResolver.js`
- `app/src/jarvis/main/SpeakerIdentityResolutionWorker.js`
- `app/src/jarvis/main/SpeakerCorrectionService.js`
- `app/src/jarvis/main/MemoryRepository.js`
- `app/src/jarvis/renderer/PeopleView.tsx`
- `app/src/jarvis/renderer/SpeakerChip.tsx`

## Task 2.4：活动分类 v34、本地初判和 MiniMax 复核

### 测试

新增：

- `app/test/jarvis/ActivityClassificationMigration.test.js`
- `app/test/jarvis/LocalActivityClassifier.test.js`
- `app/test/jarvis/MiniMaxActivityClassifier.test.js`
- `app/test/jarvis/ActivityClassificationPrivacy.test.js`
- `app/test/jarvis/ActivityClassificationBudget.test.js`

覆盖批准的八类、80/55 阈值、来源未知上限、云失败、本地回退、批处理、预算和敏感字段拒绝。

### 实现

新增：

- `app/src/jarvis/main/LocalActivityClassifier.js`
- `app/src/jarvis/main/ActivityClassificationInputBuilder.js`
- `app/src/jarvis/main/MiniMaxActivityClassifier.js`
- `app/src/jarvis/main/ActivityClassificationService.js`
- `app/src/jarvis/main/ActivityClassificationRepository.js`

修改：

- `app/src/jarvis/main/JarvisMigrations.js`
- `app/src/jarvis/main/AgentCloudComposition.js`
- `app/src/jarvis/main/AnalysisScheduler.js`
- `app/src/jarvis/main/AnalysisBudgetPricing.js`
- `app/src/jarvis/main/registerJarvisIpc.js`
- shared/preload/types

MiniMax 载荷使用严格白名单，只包含规范化应用、匿名人物、相关转写和非音频统计。

### Phase 2 门禁

- 本人三段真实录入通过。
- CAM++ 和 ERes2NetV2 都完成真实推理验证。
- 留出数据集达到自动关联 precision 门槛，否则功能保持候选模式。
- Chrome 球赛、Chrome 课程、KOOK 通话和 DOTA 2 样本按置信区间正确分类。
- MiniMax payload 隐私扫描和现有预算生命周期全部通过。

---

# Phase 3：行动与个性化

## Task 3.1：v34 行动候选和反馈生命周期

### 测试

新增：

- `app/test/jarvis/ActionCandidateMigration.test.js`
- `app/test/jarvis/ActionCandidateRepository.test.js`
- `app/test/jarvis/ActionCandidateIdempotence.test.js`

扩展：

- `app/test/jarvis/MemoryRepository.test.js`
- `app/test/jarvis/KnowledgeContracts.test.js`

覆盖 pending、accepted、ignored、converted、dismissed、undo、重复请求和证据外键。

### 实现

新增：

- `app/src/jarvis/main/ActionCandidateRepository.js`
- `app/src/jarvis/main/ActionCandidateService.js`

修改：

- `app/src/jarvis/main/JarvisMigrations.js`
- `app/src/jarvis/main/MemoryRepository.js`
- `app/src/jarvis/shared/contracts.js`
- IPC/preload/types

正式 `todos_v2` 和 `suggestions_v2` 不被替换；候选层在事务中转换为正式结果。

## Task 3.2：严格 Todo 归属门禁

### 测试

新增：

- `app/test/jarvis/TodoAttributionPolicy.test.js`
- `app/test/jarvis/ActionExtractionWorker.test.js`
- `app/test/jarvis/EntertainmentActionSuppression.test.js`

固定反例：

- 视频说“你明天应该联系客户”不能生成 Todo。
- 课程中的练习要求不能生成 Todo。
- 分配给 `P1` 的任务不能进入本人 Todo。
- unknown、overlap 和来源未知不能生成正式 Todo。

固定正例：

- `SELF` 明确承诺且三类置信度均达到 90%。
- `P1` 分配、`SELF` 接受后生成待确认候选。
- 用户手动转换直接生成正式 Todo。

### 实现

新增：

- `app/src/jarvis/main/TodoAttributionPolicy.js`
- `app/src/jarvis/main/ActionExtractionWorker.js`

修改：

- `app/src/jarvis/main/JarvisAnalysisSchema.js`
- `app/src/jarvis/main/JarvisAnalysisWorker.js`
- `app/src/jarvis/main/MemoryMerger.js`
- `app/src/jarvis/main/DailyDigestSchema.js`
- `app/src/jarvis/main/MiniMaxDailyDigestClient.js`

AI 输出只能提出带证据的候选；本地策略是最终授权门禁。

## Task 3.3：场景输出策略和本地渐进学习

### 测试

新增：

- `app/test/jarvis/ActivityOutputPolicy.test.js`
- `app/test/jarvis/PersonalizationFeedback.test.js`
- `app/test/jarvis/PersonalizationRuleLifecycle.test.js`

覆盖：

- 娱乐/游戏只记录兴趣。
- 学习建议必须绑定目标。
- 社交只提取明确约定。
- 单次纠错不形成全局应用规则。
- 重复纠错产生待确认规则。
- 人物、声纹、分类和行动反馈隔离。
- 删除/重置后缓存失效。

### 实现

新增：

- `app/src/jarvis/main/ActivityOutputPolicy.js`
- `app/src/jarvis/main/PersonalizationRepository.js`
- `app/src/jarvis/main/PersonalizationRuleEngine.js`

修改：

- `app/src/jarvis/main/JarvisMigrations.js`
- `app/src/jarvis/main/AnalysisInputBuilder.js`
- `app/src/jarvis/main/DailyDigestService.js`
- `app/src/jarvis/main/MemoryRepository.js`

## Task 3.4：克制 Windows 通知

### 测试

新增：

- `app/test/jarvis/JarvisNotificationPolicy.test.js`
- `app/test/jarvis/JarvisNotificationScheduler.test.js`

覆盖：

- 候选和建议不弹窗。
- 只有已确认且有提醒时间的 Todo 通知。
- Finish 只有一条合并通知。
- 全屏游戏、会议、演示期间延迟并合并。
- 专注模式和临时静音。

### 实现

新增：

- `app/src/jarvis/main/JarvisNotificationPolicy.js`
- `app/src/jarvis/main/JarvisNotificationScheduler.js`

修改：

- `app/main.js`
- `app/src/helpers/windowManager.js`
- `app/src/jarvis/main/FullscreenYieldPolicy.js`
- `app/src/jarvis/main/registerJarvisIpc.js`

### Phase 3 门禁

- 归属策略正反例全部通过。
- 所有正式 Todo 都有来源、理由、证据和置信度快照。
- 相同输入和重试不产生重复 Todo/建议。
- 娱乐和游戏测试集零自动 Todo。
- 通知在 DOTA 2 全屏期间保持静默。

---

# Phase 4：主界面与完整闭环

## Task 4.1：右侧行动中心和五级分区

### 测试

新增：

- `app/src/jarvis/renderer/__tests__/ActionCenter.test.tsx`
- `app/src/jarvis/renderer/__tests__/ActionCard.test.tsx`
- `app/src/jarvis/renderer/__tests__/TodayActionLayout.test.tsx`

覆盖：

- 现在要做、待确认、候选建议、稍后、今日已完成。
- 优先级排序、默认折叠和“查看全部”。
- 正式、候选和建议的不同按钮。
- 加载、空状态、局部失败和 optimistic rollback。
- 窄屏抽屉和键盘/屏幕阅读器行为。

### 实现

新增：

- `app/src/jarvis/renderer/ActionCenter.tsx`
- `app/src/jarvis/renderer/ActionCard.tsx`
- `app/src/jarvis/renderer/ActionEvidenceDetails.tsx`

修改：

- `app/src/jarvis/renderer/TodayView.tsx`
- `app/src/jarvis/renderer/JarvisShell.tsx`
- `app/src/jarvis/renderer/TodosView.tsx`
- `app/src/jarvis/renderer/jarvisStore.ts`
- locale

## Task 4.2：Finish 后渐进式本次会话

### 测试

扩展：

- `app/src/jarvis/renderer/__tests__/SessionSummaryPanel.test.tsx`
- `app/src/jarvis/renderer/__tests__/MemoryView.test.tsx`
- `app/src/jarvis/renderer/__tests__/RecordingControlsRecovery.test.tsx`

新增：

- `app/src/jarvis/renderer/__tests__/CompletedSessionWorkspace.test.tsx`

覆盖：

- Finish 后立即切换。
- 音频、转写、声纹和 MiniMax 四项独立进度。
- 总结、完整转写和处理详情三个标签。
- 内容渐进出现且旧完成内容不闪退。
- 付费重试、预算阻断和云失败。
- 新录音返回实时界面，旧会话仍在 Memory。

### 实现

新增：

- `app/src/jarvis/renderer/CompletedSessionWorkspace.tsx`
- `app/src/jarvis/renderer/SessionTranscriptBySource.tsx`
- `app/src/jarvis/renderer/SessionProcessingDetails.tsx`

修改：

- `app/src/jarvis/renderer/TodayView.tsx`
- `app/src/jarvis/renderer/SessionSummaryPanel.tsx`
- `app/src/jarvis/renderer/useJarvisRecording.ts`
- `app/src/jarvis/main/MemoryRepository.js`
- `app/src/jarvis/main/registerJarvisIpc.js`
- preload/types

## Task 4.3：人物、分类、规则和 Todo 管理页面

### 测试

扩展 People、Memory 和 Todos renderer 测试；新增分类纠错和个性化规则测试。

### 实现

修改：

- `app/src/jarvis/renderer/PeopleView.tsx`
- `app/src/jarvis/renderer/MemoryView.tsx`
- `app/src/jarvis/renderer/TodosView.tsx`
- `app/src/jarvis/renderer/ResourceGovernanceSettingsCard.tsx`

新增：

- `app/src/jarvis/renderer/ActivityClassificationEditor.tsx`
- `app/src/jarvis/renderer/PersonalizationRulesView.tsx`
- `app/src/jarvis/renderer/ApplicationAudioSettings.tsx`

提供：

- 活动类别修订和重处理入口。
- 人物候选命名、撤销和拆分。
- 个性化规则确认、停用、编辑、删除和重置。
- 应用音轨池上限与降级策略设置。

## Task 4.4：完整回归、真实硬件和 Windows 打包

### 自动验证

```powershell
$env:npm_config_cache='G:\Jarvis\.runtime-cache\npm'
$env:TEMP='G:\Jarvis\.runtime-cache\tmp'
$env:TMP='G:\Jarvis\.runtime-cache\tmp'
npm run format:check
npm run typecheck
npm run test:jarvis
npm run test:renderer
npm run build
```

打包产物放在工作树的版本化 `dist-*` 目录或 `G:\Jarvis\releases`，不得使用 C 盘临时目录。

### 真实 UAT

1. 实体麦克风完成三段本人声纹录入。
2. KOOK 通话与 Chrome 视频同时录制，验证独立来源和完整转写。
3. Chrome 球赛、课程和普通网页语音分别分类。
4. DOTA 2 全屏运行，验证 CPU/GPU 让路、无悬浮残影、退出后补处理。
5. 验证本人明确承诺、别人分配并接受、视频命令三类 Todo 归属。
6. 结束录音后在当前页查看渐进总结、完整转写和处理详情。
7. 重启应用，验证 Memory、Todo 候选、分类反馈和规则持久化。
8. 模拟 MiniMax 离线、预算关闭、付费重试和无上限模式。
9. 对真实 `G:\JarvisData` 的只读副本执行迁移和外键核验。

### Phase 4 发布门禁

- 所有 Phase 1–3 门禁仍为 GREEN。
- renderer 无阻塞错误、残留窗口或不可恢复空白态。
- 三小时虚拟耐久测试通过。
- 至少一次 30–60 分钟真实 DOTA 2 让路测试通过。
- 打包版从 G 盘启动，原生模块 ABI、模型路径、数据目录和 MiniMax 设置正确。
- C 盘没有新增大型 Jarvis 文件。

## 2. 提交边界

在用户要求提交时，按以下边界保持原子性：

1. `feat: add application-aware audio track schema`
2. `feat: discover and capture Windows app audio`
3. `feat: govern dynamic application audio tracks`
4. `feat: expose application source evidence`
5. `feat: add dual-model local speaker verification`
6. `feat: add activity classification with private cloud review`
7. `feat: enforce evidence-based action attribution`
8. `feat: learn reversible personal activity rules`
9. `feat: add the Jarvis action center`
10. `feat: show progressive completed-session results`
11. `test: verify application-aware personal agent release`

## 3. 完成定义

本计划不是以“页面出现”或“测试数量”判定完成。只有当以下用户路径在打包版中成立，才算达到初始目标：

```text
用户开始监听
→ 麦克风和发声应用安全分轨
→ 所有人声最终完整转写
→ 本人/匿名人物被谨慎识别
→ 活动被保守分类
→ 只有真实本人承诺进入正式 Todo
→ 首页立即显示可核查的待办与建议
→ Finish 后当前页显示可恢复的完整结果
→ 重启后人物、记忆、Todo 和个性化规则仍然存在
```
