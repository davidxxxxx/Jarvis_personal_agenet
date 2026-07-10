# Jarvis 个人记忆助手 MVP 设计规格

- 日期：2026-07-10
- 状态：用户已在对话中批准完整设计
- 目标平台：Windows 10/11 x64
- 首版交付目标：当天可运行的个人 MVP

## 1. 产品目标

Jarvis 是一个由用户手动启动的桌面个人记忆助手。它通过麦克风接收用户身边的对话，在本地完成录音、实时转写、说话人分离和声纹识别，再将转写文本发送给 MiniMax 做结构化分析。它把对话整理为人物、主题、事实、决定、承诺、待办和建议，形成能够追溯原始对话的长期记忆库。

首版的成功标准不是全天候无感运行，而是完成一条可靠、可验证的闭环：

1. 用户明确点击开始。
2. 本地实时转写并区分“我”和其他说话人。
3. 每 10 分钟增量分析一次。
4. 用户结束会话后生成完整总结。
5. 新信息进入可搜索、可修正、可追溯的长期记忆库。
6. 原始音频在本地保留 7 天后自动删除。

## 2. 已确认的产品边界

### 2.1 首版包含

- 手动开始、暂停、继续和结束监听。
- 任务栏和主窗口持续显示明确的录音状态。
- 首版仅采集麦克风，内部保留系统音频采集接口。
- 本地实时转写、语音活动检测、说话人分离和声纹识别。
- 首次录入约 30 秒“我的声纹”。
- 自动标注“我 / 说话人 2 / 说话人 3”，支持手动改名。
- 每 10 分钟调用 MiniMax 更新主题、决定、待办和建议。
- 结束录音时生成整场总结。
- 今天、人物、主题、待办和记忆搜索页面。
- 音频默认保留 7 天；转写、总结和记忆长期保存。
- MiniMax Key 通过本机设置输入并使用 Windows 安全存储。

### 2.2 首版不包含

- 开机自动监听或按时间自动监听。
- 隐蔽录音模式。
- 手机端、穿戴设备或云同步。
- 屏幕录制。
- 电脑系统声音采集。
- 日历、邮件和外部任务系统集成。
- 唤醒词和主动语音回复。
- 自动联系他人或代表用户发送消息。

## 3. 复用策略与许可

### 3.1 主底座：OpenWhispr

以 [OpenWhispr](https://github.com/OpenWhispr/openwhispr) 为桌面应用和本地语音处理底座，复用其 Electron/React 界面、Windows 支持、音频采集、Whisper/Parakeet、本地说话人分离、声纹、SQLite、笔记和语义搜索能力。OpenWhispr 使用 MIT 许可，导入源码时必须保留其许可证与版权声明。

### 3.2 记忆模型参考：Minutes

采用 [Minutes](https://github.com/silverstein/minutes) 的结构化对话记忆思路：音频 → 转写 → 说话人 → 总结 → 结构化记忆 → 人物/主题/承诺关系。首版不依赖 Minutes 的 Windows 二进制或其说话人组件，只复用其公开设计思想和适合的 MIT 许可实现片段；如复制代码，同样保留许可证与版权声明。

### 3.3 MiniMax

MiniMax 通过官方 OpenAI 兼容接口接入：

- Base URL：`https://api.minimaxi.com/v1`
- API：Chat Completions
- 鉴权：用户提供的订阅 Key，通过 `Authorization: Bearer` 由 OpenAI SDK 处理
- 增量分析默认模型：`MiniMax-M2.7-highspeed`
- 会话最终总结默认模型：`MiniMax-M3`
- 模型均可在设置中修改，以适配用户订阅权益
- 所有请求设置 `reasoning_split=true`，只把 `message.content` 当作业务 JSON；M2.x 的推理内容不得进入 JSON 解析器
- 最终总结使用 M3 时设置 `thinking: {"type":"disabled"}`，减少延迟并保持结构化输出稳定

官方参考：[MiniMax OpenAI SDK 文档](https://platform.minimaxi.com/docs/api-reference/text-openai-api)

用户曾在对话中提供 Key。该 Key 不得写入源码、规格、日志、测试夹具或 Git；正式测试前应使用用户在本机设置页输入的有效 Key。

## 4. 系统架构

```text
MicAudioSource ─┬─> AudioChunkStore ─────────────> RetentionCleaner
                └─> LocalSpeechPipeline ─────────> EventStore
                       │ VAD / STT / diarization        │
                       │ voice fingerprint              ├─> Live UI
                       │                                ├─> Local Search
                       └────────────────────────────────┘
                                                        │
                                                        v
                                                AnalysisScheduler
                                                        │
                                             text-only MiniMax request
                                                        │
                                                        v
                                                MemoryMerger
                                                        │
                                                        v
                                              People / Topics / Todos
```

### 4.1 Desktop Shell

职责：窗口、托盘、录音控制、设置、导航和状态展示。

依赖：Electron、React 和 OpenWhispr 已有桌面基础设施。

边界：Shell 只通过应用服务接口读写状态，不直接访问音频文件或拼装 MiniMax 请求。

### 4.2 AudioSource

职责：把音频源规范化为带时间戳的 PCM 帧。

首版实现：`MicAudioSource`。

预留实现：`SystemAudioSource`，首版仅显示“即将支持”，不启用。

边界：语音处理和存储只依赖通用 `AudioFrame`，未来增加系统声音不改动下游。

### 4.3 LocalSpeechPipeline

职责：语音活动检测、实时转写、说话人分离、声纹匹配和置信度计算。

行为：

- 优先复用 OpenWhispr 的 Windows 本地模型实现。
- 使用用户的 NVIDIA GPU 加速，首选适合中文的多语言模型。
- 先输出稳定片段，再写入数据库；临时 partial 文本只显示在 UI 中。
- 将声纹匹配为稳定的本地 `person_id`，不把真实姓名加入云端请求。

### 4.4 EventStore

职责：持久化会话、音频片段、转写片段、人物、分析任务和长期记忆。

实现：SQLite，使用事务保证音频索引、转写和分析游标一致。

### 4.5 AnalysisScheduler

职责：每 10 分钟发现未分析的稳定转写，检索相关旧记忆，构造最小 MiniMax 请求，校验响应并提交给 MemoryMerger。

行为：

- 同一输入窗口具有唯一哈希，确保重试不重复写入。
- MiniMax 失败不阻塞录音或转写。
- 会话结束时等待稳定转写完成，再生成最终总结。
- 最终总结以增量分析结果为主，不重复发送全天原始转写。

### 4.6 MemoryMerger

职责：把模型建议的结构化条目转换为本地可追溯记忆，完成去重、关联、版本化和冲突标记。

边界：模型不能直接更新数据库；所有模型输出必须先通过 JSON Schema、证据引用和业务规则校验。

## 5. 用户界面

### 5.1 首页：今日指挥台

用户已选择“A · 今日指挥台”。

- 左侧：今天、人物、主题、待办、记忆库、设置。
- 顶部：当前麦克风、录音时长、音量、MiniMax 状态、开始/暂停/继续/结束。
- 中间：按时间滚动的实时对话；每条包含说话人、时间、稳定/临时状态。
- 右侧：当前主题、关键决定、新待办、承诺和 AI 建议；显示上次分析时间。
- 最小化后：托盘图标使用明确红色录音状态，并提供暂停、继续、结束和打开窗口。

### 5.2 二级页面

- 今天：会话时间线、完整总结和来源跳转。
- 人物：姓名、声纹状态、最近互动、共同主题、承诺和待办。
- 主题：相关会话、人物、决定、当前状态和下一步。
- 待办：未完成、已完成、负责人、期限和来源证据。
- 记忆库：自然语言、关键词、人物和日期搜索；结果必须能跳到原始转写。
- 设置：麦克风、模型、MiniMax、声纹、保留周期和隐私说明。

### 5.3 说话人修正

- 点击说话人标签可改名、合并人物或标记为“我”。
- 改名只更新本地显示名和人物映射，不重写原始转写。
- 人物合并保留审计记录，允许撤销。
- 当声纹匹配置信度不足时显示“可能是张三”，不自动确认为张三。

## 6. 数据模型

### 6.1 Session

字段：`id`、`started_at`、`ended_at`、`status`、`mic_device_id`、`language`、`final_summary_id`。

状态：`recording`、`paused`、`finalizing`、`completed`、`recovered`、`failed`。

### 6.2 AudioChunk

字段：`id`、`session_id`、`path`、`started_at`、`ended_at`、`duration_ms`、`sha256`、`expires_at`、`transcription_status`。

音频默认按 60 秒分片；暂停或结束时允许产生不足 60 秒的尾片段。每片先写临时文件，再原子重命名；数据库只引用完整文件。若 OpenWhispr 上游录音器必须使用不同的内部帧长，持久化边界仍统一为不超过 60 秒。

### 6.3 TranscriptSegment

字段：`id`、`session_id`、`audio_chunk_id`、`started_at`、`ended_at`、`person_id`、`text`、`confidence`、`is_stable`、`analysis_state`。

### 6.4 Person

字段：`id`、`display_name`、`is_self`、`voiceprint_ref`、`voice_confidence`、`created_at`、`last_seen_at`。

真实姓名只存在本地。发送 MiniMax 时使用 `self`、`person_2` 等会话匿名标签。

### 6.5 Topic

字段：`id`、`canonical_title`、`description`、`status`、`created_at`、`last_seen_at`。

### 6.6 Memory

字段：

- `id`
- `type`：`fact`、`decision`、`commitment`、`todo`、`opinion`、`suggestion`
- `content`
- `person_id`
- `topic_id`
- `confidence`
- `status`
- `first_seen_at`
- `last_seen_at`
- `occurrence_count`
- `supersedes_memory_id`
- `needs_confirmation`

`MemoryEvidence` 关联一个或多个 `TranscriptSegment`。事实、决定、承诺和待办没有证据片段时不得持久化为长期记忆。

### 6.7 AnalysisRun

字段：`id`、`session_id`、`window_start`、`window_end`、`input_hash`、`model`、`status`、`attempt_count`、`next_retry_at`、`response_json`、`error_code`。

## 7. MiniMax 分析契约

### 7.1 发送内容

- 新增稳定转写文本。
- 本地匿名说话人编号。
- 时间范围。
- 通过本地搜索取回的少量相关旧记忆。
- 允许引用的转写片段 ID。

不发送原始音频、真实姓名、API Key 以外的本机凭据、无关历史或应用日志。

### 7.2 响应结构

```json
{
  "summary": "本时间段的客观摘要",
  "topics": [
    {"title": "支付功能上线", "evidence_segment_ids": ["seg_102"]}
  ],
  "memories": [
    {
      "type": "decision",
      "content": "首版仅支持支付宝",
      "person_ref": "self",
      "topic_ref": "支付功能上线",
      "confidence": 0.94,
      "evidence_segment_ids": ["seg_102"]
    }
  ],
  "todos": [
    {
      "content": "整理验收清单",
      "owner_ref": "self",
      "due_date": null,
      "evidence_segment_ids": ["seg_108"]
    }
  ],
  "suggestions": [
    {
      "content": "明确测试负责人和截止日期",
      "reason": "对话中尚未明确"
    }
  ]
}
```

`memories` 只接收 `fact`、`decision`、`commitment` 和 `opinion`；`todos` 与 `suggestions` 使用各自独立数组。校验通过后，本地把 `todos` 转换为 `Memory.type=todo`，把 `suggestions` 转换为 `Memory.type=suggestion`，避免同一条待办被模型重复返回两次。

### 7.3 校验

- 响应必须是合法 JSON，并通过本地 JSON Schema。
- 未知字段被忽略，缺少必需字段时整项拒绝。
- 证据 ID 必须属于本次输入或检索上下文。
- 模型标注的置信度只作为参考，本地规则仍可降低置信度。
- JSON 无效时允许一次格式修复请求；再次失败后进入人工可见的待重试状态。

## 8. 记忆合并规则

1. 使用 OpenWhispr 已有本地嵌入计算归一化余弦相似度。同一人物、同一主题且相似度不低于 0.86 的记忆自动合并，增加出现次数并更新时间。
2. 相似度为 0.78–0.86 的候选只建立“可能重复”关联并等待确认；低于 0.78，或主体、主题、时间意义不同的条目保持独立。
3. 新决定不覆盖旧决定；新条目通过 `supersedes_memory_id` 指向被替代条目。
4. 相互矛盾的事实或承诺同时保留，并标记 `needs_confirmation=true`。
5. 待办只有在用户明确表示完成或用户手动操作时关闭。
6. `suggestion` 永远不能自动升级为 `fact`、`decision` 或 `commitment`。
7. 低置信度转写产生的长期记忆默认进入待确认状态。
8. 人物重命名只改变展示；人物合并更新关联并保留可撤销审计记录。
9. 删除来源会话时删除对应证据；没有任何剩余证据的记忆被删除，有其他证据的共有记忆保留。

## 9. 隐私与安全

- 只支持手动启动，不提供隐蔽录音或自动监听。
- 录音期间主窗口和托盘始终提供明显状态。
- 首次使用显示录音权利和必要告知提示。
- 原始音频不上传 MiniMax。
- 真实姓名默认不上传 MiniMax。
- MiniMax Key 使用 Electron `safeStorage`，在 Windows 上由 DPAPI 保护；数据库只保存“已配置”状态。
- Key、转写全文和原始模型请求不得进入日志。
- 日志仅记录匿名任务 ID、错误码、耗时和重试次数。
- 首版 SQLite 数据库依赖 Windows 用户权限和磁盘加密保护，不宣称应用级数据库加密。
- 设置页明确建议在启用 BitLocker 的个人 Windows 账户下使用。

## 10. 数据保留与删除

- `AudioChunk.expires_at` 默认为创建后 7 天。
- RetentionCleaner 在应用启动后运行，并在应用持续运行期间每 24 小时运行一次。
- 删除顺序：标记待删除 → 删除文件 → 事务删除数据库引用 → 记录匿名清理结果。
- 文件占用导致删除失败时保留待删除标记，并在下次启动重试。
- 用户删除完整会话时，删除该会话的音频、转写、分析结果、总结和独占记忆证据。
- 长期转写、总结和仍有证据的记忆不会因音频过期而删除。

## 11. 故障处理

### 11.1 麦克风与权限

- 麦克风断开或权限丢失时立即停止采集并进入 `paused`。
- UI 和托盘显示原因；用户选择新设备后可继续同一会话。

### 11.2 转写故障

- 音频采集和转写解耦。
- 转写模型失败时继续保存完整音频片段，将片段标记为待重试。
- 恢复后按时间顺序补转写。

### 11.3 MiniMax 故障

- 网络错误、超时、429 和可重试 5xx 使用带抖动的指数退避。
- 401/403 立即停止重试并提示用户检查 Key 或订阅权益。
- `input_hash` 保证同一窗口不会重复生成持久化记忆。

### 11.4 磁盘不足

- 可用空间低于 `max(5 GB, 卷容量的 5%)` 时先停止创建新音频，保留已完成片段和索引。
- UI 和托盘显示明确错误，不静默丢弃音频。

### 11.5 程序崩溃

- 音频按最多 60 秒的片段先写临时文件并落盘。
- 启动时扫描未结束会话和完整孤立片段，恢复为 `recovered` 会话。
- 不完整的最后一个临时片段隔离并报告，不阻塞其他数据恢复。

## 12. 测试策略

### 12.1 单元测试

- 状态机：开始、暂停、继续、结束和崩溃恢复。
- MiniMax JSON Schema 与非法证据拒绝。
- 记忆去重、替代、冲突和待办关闭规则。
- 匿名人物映射和改名。
- 7 天保留周期与级联删除。
- Key 不出现在配置导出和日志中。

### 12.2 集成测试

- 使用固定 WAV 样本验证采音后转写、说话人标签和时间对齐。
- 使用模拟 MiniMax 服务验证成功、格式错误、401、429、5xx、超时和恢复。
- SQLite 崩溃恢复和分析幂等性。
- 托盘状态与录音状态机同步。

### 12.3 手工验收

- Windows 上启动应用并选择麦克风。
- 开始后看到红色录音状态、音量和实时转写。
- 暂停期间不产生新音频；继续后不新建会话。
- 安静环境中两人中文对话能够区分“我”和另一位说话人，错误标签可立即修正。
- 人物改名后，新片段能复用人物或以“可能是”状态等待确认。
- 约 10 分钟后出现增量主题、决定、待办和建议。
- 结束后生成完整总结。
- 可按人物、主题、日期和自然语言找到记忆并跳回来源片段。
- 断网时录音和转写继续，恢复后补做分析。
- 用测试时钟验证 7 天音频删除。

## 13. 性能目标

目标硬件：AMD Ryzen 7 9700X、NVIDIA RTX 5070 Ti、约 48 GB 内存。

- 点击开始到采音状态：不超过 3 秒。
- 稳定转写片段显示延迟：目标不超过 5 秒。
- 主 UI 在后台转写时保持可交互。
- MiniMax 分析不得阻塞音频采集或转写线程。
- 首版以真实中文对话调优，不承诺在远距离、多人重叠说话或高噪声下达到固定准确率。

## 14. 验收定义

以下条件全部满足才算 MVP 完成：

1. Windows 可运行构建已生成。
2. 手动录音、暂停、继续和结束闭环工作。
3. 本地转写、说话人标签和手动改名工作。
4. MiniMax 十分钟增量分析和最终总结工作。
5. 人物、主题、待办和记忆搜索工作。
6. 记忆可追溯到原始转写。
7. 断网、错误 Key、程序重启和磁盘不足具有明确行为。
8. 七天音频清理和删除会话行为通过测试。
9. Key 未进入 Git、日志、数据库明文或安装包默认配置。
10. 自动测试通过，且在目标电脑完成一次真实中文双人对话验收。

## 15. 已接受的风险与缓解

- **环境麦克风的说话人分离精度有限。** 使用声纹置信度、人工改名和“可能是”状态，避免过度自动确认。
- **OpenWhispr 上游变化快。** 固定导入版本，建立 upstream 远端，只选择性同步必要修复。
- **MiniMax 结构化输出可能不稳定。** 使用严格 JSON Schema、证据检查、一次修复和本地幂等合并。
- **长期文本未做应用级加密。** 首版明确依赖 Windows 账户权限和磁盘加密；后续可评估 SQLCipher，但不阻塞当天 MVP。
- **全天录音产生大量数据。** 采用最多 60 秒音频片段、7 天清理和 `max(5 GB, 5%)` 磁盘安全阈值。
