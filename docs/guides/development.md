# 开发与交付

## 工作约定

- 根目录用于文档和版本管理，`app/` 才是 npm/Electron 工程。
- 使用 `codex/` 功能分支，保留已有 worktree 改动。PR #1 是当前候选版本的集成入口。
- 重构保持公共入口、IPC contract、数据库事务和错误码；行为变化必须另有测试与变更说明。
- 不将音频、数据库、声纹向量、窗口标题、日志、API Key、HF Token、模型缓存提交到公共 GitHub。
- 不以源码任务授权运行生产回溯、重置人物、重启应用或调用付费 API。

## 常用入口

见[模块地图](../architecture/overview.md)。修改公开数据展示应先看 `main/ipc/`；预览看 `runtime/CommittedAudioPreview.js`；音轨选择看 `speakers/SpeakerEvidenceSelection.js`；Memory 的文本格式和总结卡片看 `renderer/memory/`。

## 提交前

按[测试指南](../testing/developer-checks.md)运行验证。使用 `git diff --check`，检查新增文件和路径，明确区分测试失败、未运行和通过。只暂存本次范围内的源文件/文档，不使用未经检查的 `git add .`。

版本文件是 `app/package.json`、`app/package-lock.json` 与根 `CHANGELOG.md`，不是上游 `app/CHANGELOG.md`。运行 `npm run release:check -- --tag jarvis-v<版本>`；标签不可移动。源码候选和已验收安装包必须分开记录。

## Windows 分发

现有 `npm run build:win:unsigned` 会准备原生依赖、校验 AI 模型包、构建 renderer 和 Windows 包。模型与程序是两个可独立版本化的组件，用户仍使用一个安装入口；不要把重量级文件提交到源代码仓库。

完整模型包/安装器准备见[模型组件说明](../../app/resources/ai-model-pack/README.md)，打包后使用 `npm run smoke:win:unpacked -- --runtime-root <G盘隔离目录> --executable <解包后的exe> --expected-commit <完整SHA>`。

包构建需要 Electron 的原生 ABI，Node 测试需要 Node ABI；切换后检查或重建 better-sqlite3，不能把 `bindings` 报错当作录音逻辑问题。版本 CI 只校验版本/标签，不证明安装包、模型、真实 GPU 或录音硬件通过。
