# 当前功能清单

核对基线：rc.12 → rc.13 源码，2026-09-12。本页的“已实现”表示存在调用链和测试，不表示本机今天的录音已验收，也不表示所有历史任务已经处理完成。

| 模块 / 用户功能 | 主要源码（均在 app/src/jarvis） | 当前能力与边界 |
| --- | --- | --- |
| 录音与恢复 | `main/JarvisService.js`、`renderer/useJarvisRecording.ts` | 开始/暂停/结束、设备选择、来源恢复、音量展示；硬件掉线及长时间恢复需实体设备验收 |
| 按应用采集 | `main/ApplicationAudioCapturePool.js`、`main/ApplicationAudioLifecycleCoordinator.js`、`main/ApplicationAudioPolicy.js` | 动态音轨池、粘滞选择/防抖、规范化应用名和混音兜底；应用未知时不从文字猜来源，不区分浏览器内标签页 |
| 安全音频保存 | `main/CaptureEvidenceStore.js`、`main/SpeechTriggeredCaptureGate.js`、`main/RetentionCleaner.js` | 分片持久化、语音触发前后缓冲、连续模式、FLAC 后台压缩、保留期保护；磁盘分片不是 UI 必须分段播放的理由 |
| 转写与去重 | `main/JarvisTranscriptionWorker.js`、`main/TranscriptReconciler.js`、`main/DualTrackTranscriptDeduper.js` | 实时预览与最终转写分开；中英质量检查、词级时序/话语关联、独立应用优先；噪声、脏话、重叠仍可能错识别，不承诺逐字正确 |
| 说话人分离 | `main/SessionDiarizationWorker.js`、`main/HybridDiarizationManager.js` | 结束后/空闲时高精度处理，全局聚类与重叠分离；依赖本地模型包，不能将 raw cluster 数直接当作人数 |
| SELF 和长期人物 | `main/VoiceEnrollmentService.js`、`main/DualSpeakerIdentityResolver.js`、`main/SessionParticipantProjector.js` | 本人绑定、CAM++ / ERes2NetV2 双模型复核、匿名跨会话关联和谨慎命名；不可靠时保持未知，不能保证每段都认出本人 |
| 人物复核 | `main/SpeakerCorrectionService.js`、`renderer/MemoryView.tsx` | 预计人数范围、已确认/待复核、命名、拆分、合并、媒体声音、试听证据及撤销；长期身份需通过质量/证据门禁 |
| 活动与总结 | `main/ActivityClassificationService.js`、`main/AnalysisScheduler.js`、`main/MiniMaxAnalysisClient.js` | 本地保守分类＋MiniMax 复核，多窗口长录音分析、总结版本和证据；需要正确云配置/预算，失败时不删除本地结果 |
| 每日回顾 | `main/DailyDigestService.js`、`main/DailyDigestScheduler.js` | 按日期汇总，保留版本和引用；仅处理有证据的内容，云请求失败仍可能需要付费重试 |
| 主题与长期记忆 | `main/MemoryRepository.js`、`main/MemoryMerger.js`、`renderer/TopicsView.tsx` | 跨会话主题归并、记忆冲突/历史和来源导航；不把 LLM 推测当作用户事实 |
| 行动中心 | `main/KnowledgeActionRepository.js`、`main/TodoAttributionPolicy.js`、`renderer/ActionCenter.tsx` | 现在要做、待确认、候选建议、稍后、今日已完成；严格归属，娱乐/游戏命令不能自动成为个人待办 |
| 个性化与提醒 | `main/PersonalizationFeedbackRepository.js`、`main/JarvisNotificationScheduler.js` | 本地纠正、规则确认/关闭、学习目标、专注/静音和克制提醒；候选建议不主动弹窗 |
| 资源与模型 | `main/ResourceGovernor.js`、`main/HeavyJobGate.js`、`main/CudaWhisperVerifier.js` | 游戏优先/平衡/处理优先，主动让路，积压恢复，CUDA 验证和模型包校验；任务排队不是推理成功 |
| 云预算与隐私 | `main/AnalysisBudgetGuard.js`、`main/AnalysisInputBuilder.js`、`main/VoiceEmbeddingCipher.js` | 预算预留/结算、无上限选项、未知消费保护、云输入白名单、本地声纹加密；MiniMax 文本总结与可选云纠错是不同权限/预算路径 |
| 历史播放与浏览 | `renderer/MemoryView.tsx`、`renderer/ContinuousSessionPlayer.tsx`、`renderer/SpeakerUtteranceTimeline.tsx` | 分页/虚拟列表、点击文字定位播放、逐人/重叠话语、音量处理、来源和后台状态 |

## 仍需独立完成或验证

1. **真实录音质量闭环**：当前设备/模型是否正确、实际几个人、SELF 和匿名人物是否合理，必须抽样听原音并人工标注；本次没有读取生产数据库或重跑历史音频。
2. **硬件与耐久验收**：实体麦克风、KOOK/腾讯会议/浏览器、设备重启、全屏游戏、真实 CUDA 和三小时耐久不能由单元测试代替。
3. **便携硬件产品**：现有实现是桌面录音基础；随身硬件、电池治理、固件、离线同步不是本轮已经交付的能力。
4. **完整模块迁移**：rc.13 提取了运行器、公开数据投影、分析输入支持、音轨选择和 Memory 展示；大仓储的事务 SQL、历史迁移和主启动顺序仍保留原位。

声纹的 CPU/GPU 要区分路径：`SpeakerModelManifest.js` 当前将 CAM++ 和 ERes2NetV2 清单标为 CPU；Whisper CUDA、混合高精度 pipeline 及其他 helper 的实际设备以运行结果为准。不能看到 CUDA 开启就宣称所有声纹步骤都在 GPU 上。
