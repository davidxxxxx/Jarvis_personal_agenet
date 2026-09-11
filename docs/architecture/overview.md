# 架构与模块地图

这是模块化单体桌面应用，不是多服务部署。Electron 负责系统权限/设备/存储，React 负责展示，模型作为受控本地 helper 运行。保留 OpenWhispr 基础设施，不重新实现其通用能力。

```text
app/main.js                         应用启动、生命周期、系统依赖组装
  src/jarvis/main/registerJarvisIpc.js  IPC 权限/参数校验与调用
    ipc/                            公开数据白名单投影，不操作数据库
    JarvisService.js                 采集生命周期和安全写入
    JarvisRepository.js              会话/转写仓储兼容入口
    MemoryRepository.js              分析版本和知识事务
      analysis/                     规范化、哈希、候选校验、脱敏支持
      speakers/                     逻辑音轨选择、覆盖率、可展示声纹门禁
    JarvisProcessingRuntime.js       兼容入口，仅重导出
      runtime/ProcessingRuntime.js  任务循环、就绪状态、让路与停止
      runtime/createProcessingRuntime.js  Worker / 模型 / 云服务依赖组装
      runtime/CommittedAudioPreview.js    已落盘音频的临时预览
  src/jarvis/shared/                 IPC 与领域契约
  src/jarvis/renderer/               React 页面及录音控制
    memory/presentation.ts          Memory 展示模型，无 React/IPC 副作用
    memory/SessionSummaryCard.tsx   纯 props 总结卡片
  resources/ai-model-pack/           独立版本的本地模型组件
```

## 业务职责

| 领域 | 协作模块 | 边界 |
| --- | --- | --- |
| 音频采集 | ApplicationAudioCapturePool、JarvisService、CaptureEvidenceStore | 原始采集来源是证据；降级混音仍是应用未知 |
| 音频处理 | JarvisTranscriptionWorker、SessionDiarizationWorker、TranscriptReconciler | 预览不冒充最终转写；重叠路保留独立证据 |
| 人物身份 | DualSpeakerVerifier、DualSpeakerIdentityResolver、SpeakerCorrectionService、SessionParticipantProjector | cluster 是技术证据；participant 才是 UI/云端人物边界 |
| 语义与知识 | AnalysisScheduler、MemoryRepository、MemoryMerger、DailyDigestService | 冻结输入→预算→云请求→候选校验→原子应用；输出必须能追溯输入 |
| 行动与学习 | TodoAttributionPolicy、KnowledgeActionRepository、PersonalizationFeedbackRepository | 承诺、转交、建议分级；用户纠正独立可撤销 |
| 资源/安全 | ResourceGovernor、HeavyJobGate、AnalysisBudgetGuard、VoiceEmbeddingCipher | 录音保存优先；预算/授权/来源不可靠时不执行高风险动作 |

## 依赖规则

- renderer 通过现有 preload/IPC API 读取公开视图，不能导入 main 仓储、模型或 Node 文件访问。
- `ipc/` 只投影返回值；权限、输入校验、广播与异步错误边界仍在注册入口。切勿以“整理代码”为由跳过白名单。
- `runtime/ProcessingRuntime.js` 接收依赖，工厂创建依赖；两者都不能反向导入旧 `JarvisProcessingRuntime.js`。
- `analysis/` 和 `speakers/` 的提取模块不拥有数据库连接或事务。事务边界仍由原仓储控制；没有 schema 迁移。
- `memory/SessionSummaryCard.tsx` 只有 `onAnalyze` 回调，不能在渲染/加载时自行发起付费请求。
- 旧入口及公开导出保持兼容。新代码直接引用领域模块；不添加涵盖全项目的总 `index.js`，避免循环依赖和无意加载重模型。

`app/test/jarvis/ModuleBoundaries.test.js` 检查新模块不得反向依赖容器，并验证兼容入口指向同一实现。它是本轮提取模块的边界保护，不是完整依赖图的静态证明。

## 后续拆分顺序

先按单一业务用例提取仓储（会话查询、分析输入、Daily Review 事务），再抽出大页面的参与者复核控制器。历史迁移继续保持单一顺序入口，不拆散触发器安装顺序。不在结构整理中修改阈值、用户数据或处理任务状态。
