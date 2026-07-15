# Jarvis 全天运行资源验收

日期：2026-07-15
范围：Phase 2 Task 13，用户批准的 3 小时虚拟耐久门禁。

## 自动化结论

| 门禁                 | 结果 | 实测                                         |
| -------------------- | ---- | -------------------------------------------- |
| 3 小时资源治理模拟   | PASS | 181 个最终任务，丢失 0                       |
| 重任务串行           | PASS | 最大并发 1                                   |
| CPU 预览回退         | PASS | 最大 4 线程，低优先级                        |
| 外部 GPU 占用让路    | PASS | 2 个窗口内重任务启动 0；预览暂停；积压后归零 |
| CUDA 崩溃恢复        | PASS | 1 次崩溃；耐久重试后全部完成                 |
| 睡眠租约恢复         | PASS | 1 次过期租约；任务 ID 保留并完成             |
| 最终任务队列         | PASS | 峰值 11，结束为 0                            |
| 实时预览队列         | PASS | pending 峰值 2（MIC、PC 各 1），结束为 0     |
| GPU 可用时预览 p95   | PASS | 0 ms（确定性无墙钟推理模拟）                 |
| 隐藏窗口 IPC smoke   | PASS | 5,400 次顺序读取，结果保持可用               |
| 生产轮询单飞         | PASS | `MemoryView` 挂起请求测试证明不重叠          |
| 捕获临时资源收敛     | PASS | CaptureSoak 结束无遗留临时文件或 helper      |
| 3 小时录音与证据模拟 | PASS | 224 chunks、448 jobs、孤儿 0、损坏 0         |
| 录音资源收敛         | PASS | writer/file/timer/VAD/retention 结束均为 0   |

执行命令：

```powershell
cd G:\Jarvis\.worktrees\jarvis-all-day-runtime\app
npm run test:jarvis:resource-soak
npm run test:jarvis:capture-soak
```

资源模拟耗时约 0.4 秒；完整录音/FLAC/迁移/保留清理模拟耗时约 38.5 秒。两项都使用虚拟时间，不需要等待真实 3 小时。

## 有界性定义

- 所有 preview、final 和 CPU fallback 共用生产 `HeavyJobGate`，最大重任务并发必须为 1。
- CPU preview fallback 必须明确携带 `cpuThreads <= 4` 和 `lowPriority=true`。
- MIC、PC 每条轨道最多保留一个最新 preview 请求；旧请求被合并，不按运行时长累积。
- 外部 GPU 占用和 CUDA 不可用期间允许 durable final backlog 增长；恢复后的健康窗口必须归零。
- 运行结束时 durable queue、preview pending/running、gate active/queue 必须归零；CaptureSoak 创建的临时文件与 helper 也必须清空。
- 三小时门禁对运行状态执行 5,400 次顺序 IPC smoke 读取，只保存计数和最后状态，不保存无限 snapshot 历史。
- 生产轮询器的频率与单飞语义由 `MemoryView.test.tsx` 的挂起请求测试独立验证；顺序 smoke 读取不用于推断 in-flight 上限。

## 参考机器

| 项目           | 值                                                               |
| -------------- | ---------------------------------------------------------------- |
| OS             | Windows 11 Pro 10.0.22631 (Build 22631)                          |
| CPU            | AMD Ryzen 7 9700X，8 核 / 16 线程                                |
| GPU            | NVIDIA GeForce RTX 5070 Ti                                       |
| GPU UUID       | `GPU-c026e85f-4b00-d1fd-ce38-0f3d2732cb49`                       |
| NVIDIA Driver  | 596.49                                                           |
| VRAM           | 16,303 MiB                                                       |
| 电源计划       | Balanced (`381b4222-f694-41f0-9685-ff5bb260df2e`)                |
| 自动化模型标识 | `resource-soak-model`（确定性测试替身，不代表真实 Whisper 性能） |

## 真实硬件性能测量状态

以下项目不能由虚拟模拟诚实代替。当前没有自动启动真实麦克风或下载约 755 MB CUDA 运行时，因此不标记为通过。

| 阈值                                             | 状态    | 原因/后续测量                                         |
| ------------------------------------------------ | ------- | ----------------------------------------------------- |
| 静默监听 10 分钟平均 CPU <= 3%，且不启动 Whisper | NOT RUN | 需要在打包应用上运行 WPR/等价采样                     |
| 录音 + VAD 10 分钟平均 CPU <= 5%                 | NOT RUN | 需要用户明确同意实际麦克风录音                        |
| 真实 CUDA provisional p95 <= 30 秒               | NOT RUN | 当前未下载/验证固定 CUDA Whisper 运行时与模型         |
| 真实外部 GPU 负载 15 秒内让路                    | NOT RUN | 自动化逻辑门禁已通过，仍需真实 NVIDIA 负载复核        |
| 真实 CPU fallback 线程 <= 4                      | NOT RUN | 参数门禁已通过，仍需进程级采样复核                    |
| 真实 3 小时 RSS/handle/log/sidecar 无增长        | NOT RUN | 用户已把原 24 小时要求改为 3 小时；需打包应用实机运行 |

CUDA 运行时自检（2026-07-15）已执行：

```json
{
  "ok": false,
  "backend": "cpu",
  "gpuUuid": null,
  "reason": "verified_runtime_missing"
}
```

这表示应用正确、明确地回退到了 CPU；它不代表真实 CUDA 推理门禁已经通过。

自动化测试没有启动真实 Whisper sidecar，也没有测量生产日志文件增长；这些只保留在上表的实机 `NOT RUN` 门禁中。

## 判定

- 自动化 3 小时可靠性与资源治理门禁：**PASS**。
- 参考机器身份与测试条件：**RECORDED**。
- 需要麦克风授权或真实 CUDA 安装的实机性能门禁：**NOT RUN**，不得解释为 PASS。

真实硬件复核时应把 WPR 配置、应用版本/commit、模型、GPU UUID、驱动、电源计划、各阈值原始结果追加到本文，不覆盖本次自动化证据。
