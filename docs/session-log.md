# Session Log 与决策审视

启动 TUI（`pnpm start`）后，每次运行都会在 `.agentlife/session-logs/` 新建一个 JSONL 文件，并实时追加记录。文件名包含启动时间和 session ID；它独立于模拟存档，加载存档仍写在同一个 session 文件中。

一次 Tick 尝试是一条 turn。认知屏障等待、模型重试和玩家决定都属于该 turn；失败后重试相同 Tick 会得到新的 turn 序号。每条记录含有 `turn`、`timelineId`、`targetTick`、时间和事件类型。相关记录还含实体、认知轮次和请求 ID。

按 F2 打开管理员视图，用左右键切到「Session Log」页签；按 S 切换 session、上下键选择 turn、Enter 打开该 turn 的本机审视页。页面可按阶段、实体和认知尝试展开，并自动刷新当前日志。`/inspect` 仍可直接打开审视页。F2 的「当前状态」页签显示日志路径与写入状态。日志写入失败会在 TUI 提示，但不会改变模拟结果。

认知日志保存完整认知输入、Pi 发给模型的 messages、模型返回消息、工具调用和最终对话。它可能包含玩家输入及角色的私有上下文，只保存在本地 `.agentlife/` 目录；分享文件前应自行检查内容。

主界面标题显示当前 TUI session 的累计推理费用（美元），模型重试也计入。`config/agentlife.yaml` 的 `cognition.cost` 若已配置，就用它覆盖 Pi 内置单价；未配置时使用 Pi 内置单价。四项价格 `input`、`output`、`cacheRead`、`cacheWrite` 的单位均为美元/百万 token。两处都没有价格时标题显示「费用待配置」。每次模型响应的用量、费用和价格来源写入 `llm-usage` 记录。
