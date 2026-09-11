# Jarvis Memory · 个人记忆助手

基于 [OpenWhispr](https://github.com/OpenWhispr/openwhispr) 的 Windows 桌面个人助手：手动启动录音，持续保存麦克风与电脑声音，后台转写、区分说话人，提取有来源证据的记忆和行动。

当前源码版本：**0.2.0-rc.13**，数据库 schema **v60**。这是模块整理的候选版本，不代表新的安装包或真实设备验收已经完成。

## 从哪里看

| 你想了解 | 入口 |
| --- | --- |
| 现在实现了什么、有什么限制 | [功能清单](docs/product/features.md) |
| 模块如何划分、改功能应找哪里 | [架构与模块地图](docs/architecture/overview.md) |
| 如何准备并运行源码 | [开始使用](docs/guides/getting-started.md) |
| 麦克风、GPU、MiniMax 和预算设置 | [配置说明](docs/guides/configuration.md) |
| 开发、验证和发布 | [开发指南](docs/guides/development.md) · [测试指南](docs/testing/developer-checks.md) · [版本规则](docs/VERSIONING.md) |
| 历史变更 | [Jarvis 更新记录](CHANGELOG.md) |

## 当前界面

- **Today**：录音状态、输入音量、当前会话结果、行动中心和每日回顾。
- **People**：本人/匿名人物、声纹与人物复核；模型估计不等于已确认人数。
- **Topics / Todo**：跨会话主题、正式待办、待确认事项和建议的来源证据。
- **Memory**：历史会话、总结、可定位播放的转写、参与者复核和后台进度。

## 安全边界

录音由用户明确开始/暂停/结束；请确保录音场景和参与者许可符合当地规定。声纹保存在本地，云分析只接收经过边界校验和脱敏的输入；可选云转写纠错属于另外的音频上传能力，默认不应与文本总结混淆。无上限预算可能持续产生费用。

运行数据、音频、声纹、模型、密钥和构建产物不放进 Git。源码在 `app/`；上游说明保留在 [app/README.md](app/README.md)，其中的上游下载、账号和跨平台功能不能当作 Jarvis 的发布承诺。上游许可见 [app/LICENSE](app/LICENSE)。
