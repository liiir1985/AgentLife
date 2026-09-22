# 阶段 4 详细执行计划：授权感知、指令式玩家交互与 Pi 认知

## 1. 目标与阶段边界

阶段 4 将阶段 3 的临时玩家投影替换为正式授权观察，同时为 AI 角色接入 Pi 认知、最小 Working Memory 和全局认知屏障。

玩家继续使用阶段 3 的“上下文指令选择 + 参数向导”：

- 左右键选择动作。
- Enter 确认。
- Entity 参数使用列表选择。
- 文本参数继续使用文本输入。
- 动作完成填写后排入认知轮次，统一交给 Body 验证。
- 不实现用户自然语言意图推论 Agent。

阶段 4 完成后：

1. 玩家只能看到自身角色获得的授权观察。
2. 玩家通过结构化指令控制角色，AI 通过 Pi Agent 形成决定。
3. 玩家和 AI 的计划经过相同的 Body 与 World 验证。
4. 等待 AI 或玩家选择期间，模拟时间和确定性过程冻结。
5. 同轮计划批量交接，模型返回顺序不产生优先级。
6. 玩家可以通过“说话”指令输入文本，与 AI 交谈并共同活动。

### 1.1 已确认的设计调整

- 前移最小 Working Memory：阶段 4 实现观察与意图准入、替换、消费确认和保存恢复。
- 身份关联整体后移到阶段 5。
- 屏障期间的保存请求进入 pending，在当前 Tick 完整发布后、下一 Tick 开始前执行。
- 玩家自然语言解释 Agent 取消；路线图中“普通自然语言成为正式角色输入”由本计划覆盖。
- 阶段 3 动作栏继续作为普通玩家入口，不移入管理模式。
- AI 使用可插拔真实模型，自动测试使用 Pi faux provider。

### 1.2 阶段 4 不实现

- 用户输入解释 LLM。
- 自由文本到移动、拿取、操作等动作的语义推断。
- Recent/Long-term Memory、`memory_search`、embedding 和主观实体档案。
- 身份关联与从自我介绍建立持久人物认识。
- Fast Forward、规则生成 Agent 和生产级模型故障转移。

本文服从 `AGENT.md`：保持 PoC 范围，只验证主要场景，公共命名必须能够从业务用途直接理解。

## 2. P4.0：配置与内容契约

新增：

- `agentlife.perception@1.0.0`：外在表现、事件表现、分辨率、显著度、连续观察和重复抑制。
- `agentlife.cognition@1.0.0`：AI 认知状态、认知需求、意图、空闲契约、短计划和模型调用限制。
- 视觉、听觉及演示实体的外在表现配置。
- AI 认知提示。
- Working Memory 容量及意图预留容量。
- 模型 provider、model、超时和重试启动配置。

演示默认：

- AI 请求最多两次尝试。
- 单次请求现实超时 60 秒。
- 一个 AI 短计划最多三个 ActionStep。
- 具体感知阈值、容量和等待期限写入内容配置，不硬编码进服务。

配置验证必须拒绝：

- 感知投影引用 Identity、控制来源、认知、记忆或管理字段。
- 低分辨率投影暴露高分辨率信息。
- 认知配置引用未知动作、无界等待或无效计划长度。
- 正常实体缺少 perception、cognition、memory 模块关联。
- 玩家动作命令引用不存在的能力、目标类型或参数绑定。

新增 SystemSpec 使用 `1.0.0`；被修改的既有 SystemSpec 升级到 `1.2.0`；演示包升级到 `1.3.0`。

## 3. P4.1：正式感知链路

World 和 Body 提供用途受限的感知材料：

- World 提供当前地点、空间关系、外在表现、环境表现和可观察事件。
- Body 提供感官可用性、效率、允许主观感受的身体表现、动作状态和认知参与许可。
- 不把完整 WorldState、BodyState 或 Character Identity 交给感知系统。

PerceptionService 为每个正常实体维护：

- 待处理观察。
- 观察者局部对象引用。
- 连续观察状态。
- 已处理材料版本。
- 重复抑制状态。
- 注意输入版本。

阶段 8 的处理顺序：

1. 根据客观变化、事件、持续刺激和注意变化建立候选材料。
2. 按位置、通道、环境和身体效率判断可达性。
3. 计算显著度和分辨率。
4. 使用白名单外在投影形成结构化观察。
5. 生成出现、持续、变化、消失和重新出现关系。
6. 抑制稳定场景的逐 Tick 重复。
7. 提交到对应角色的待处理观察流。

PoC 感知范围：

- 视觉：同地点人物、物品、出口和环境；光照、雾和视觉效率影响细节。
- 听觉：同地点已经完成的说话动作。
- 自身动作结果：完成、失败或中断。
- 不实现复杂距离、跨地点声音和物理遮挡。

身份关联尚未实现，因此人物只显示配置化外在描述，例如“一个穿旧外套的人”。不得直接显示 Character 配置中的真实姓名。

## 4. P4.2：可观察的说话动作

说话文本继续通过阶段 3 的文本参数向导输入。

处理顺序：

1. 玩家选择“说话”指令并填写文本。
2. 文本作为 ActionStep 的不透明输入进入计划。
3. BodyService 验证能力、资源和动作状态。
4. 说话动作按 Tick 推进。
5. 只有动作完成后，World 才产生客观 `utterance` 事件。
6. PerceptionService 根据听觉条件决定哪些角色听见。
7. AI 只有实际听见后才获得观察和认知需求。

以下内容不得直接成为世界内发言：

- 玩家尚未完成的参数输入。
- 被 Body 拒绝的说话计划。
- AI 原始模型响应。
- AI 尚未执行的表达候选。
- 管理员诊断文本。

## 5. P4.3：玩家授权视图与指令候选

阶段 3 的 `PlayerView` 被正式 `PerceivedPlayerView` 替代。

普通 TUI 只读取：

- 用户角色当前感知到的地点表现。
- 当前仍可观察的局部对象。
- 用户角色持有且能够感知的物品。
- 用户角色实际感知到的动作和事件结果。
- 用户自己的动作连续状态。

上下文动作仍由内容命令定义，但候选来源改为授权观察：

- “移动”只能选择当前观察中存在的出口。
- “拿取”只能选择当前观察中存在且满足属性要求的物品。
- “放置”只能选择角色持有物和当前观察中的支撑物。
- “操作”只能选择当前观察中的可操作对象。
- “挥手”只能选择当前可观察对象。
- “说话”保留文本参数。

动作栏查询仍然只用于发现候选，不试运行规则、不占用资源、不预测成功。

观察者局部引用在参数确认时映射回受保护实体锚点；界面和认知可见对象不得依赖世界实体 ID 查询额外信息。

## 6. P4.4：最小 Working Memory 与认知状态

每个正常实体增加：

- `WorkingMemoryState`：已准入观察、意图激活引用、容量占用、消费状态和版本。
- `CognitionState`：注意、主观理解、疑问和持续性决定。
- `IntentionRecord`：意图内容、来源、状态和使用信息。
- `IdleCommitment`：等待外部事件、确定性重审条件或持续活动边界。

阶段 4 Working Memory 语义：

- 观察和意图只有准入后才能进入 AI 认知上下文。
- 观察容量和意图预留容量分别配置。
- 超限时按显著度、时间、优先级和稳定 ID 确定性裁剪。
- AI 提交决定时确认实际消费的观察和实际考虑、追随的意图。
- 不生成 Recent Memory，不进行语义检索或快速时间衰减。
- 被新观察替代的旧观察可以按连续观察规则折叠。

意图支持新建、重申、暂停、满足和放弃。一个计划可以关联零条、一条或多条意图。AI 无立即动作时必须提交合法的 IdleCommitment。

用户角色仍保留独立 Working Memory 和认知连续状态，但阶段 4 不使用 LLM 替玩家生成理解、意图或计划。用户实际选择的指令、实际消费的观察和已经裁定的结果可以更新最小连续状态，不得补造隐藏思想。

## 7. P4.5：认知需求与全局屏障

Runner 的阶段 8–12 改为正式状态机：

- 阶段 8：感知。
- 阶段 9：认知需求汇总。
- 阶段 10：全局认知屏障。
- 阶段 11：Working Memory 消费确认和意图维护。
- 阶段 12：发布完整 Tick。

认知需求来源：

- AI 初始化后尚未形成行动或合法空闲状态。
- 新的高显著观察或可回应发言。
- 动作完成、失败、中断或明确决策点。
- 持续决定条件变化。
- IdleCommitment 到期。
- 玩家在稳定边界主动开始动作选择。

玩家参与屏障时：

- 动作栏显示当前授权观察允许的指令。
- 完成参数向导后，本轮玩家参与状态变为“已决定”。
- 玩家可以 `/skip`，表示本轮不提交新计划。
- Esc 只取消当前参数填写，不自动跳过认知轮次。
- 等待选择期间世界和身体不推进。

屏障固定：

- timeline、Tick、配置版本和客观状态版本。
- 参与者全集。
- 每个参与者的授权观察和动作连续状态。
- Working Memory 准入结果。
- 玩家选择状态和 AI 请求状态。
- 尚未交接的决定及计划。

所有参与者解决后：

1. 按实体 ID 和计划 ID 稳定排序结果。
2. 提交 AI 认知状态、意图变化和消费确认。
3. 提交玩家实际选择对应的消费确认。
4. 批量交给 BodyService 验证计划。
5. 完成阶段 11。
6. 发布完整 Tick。
7. 执行 pending 保存。
8. 再决定是否开始下一 Tick。

## 8. P4.6：Pi AI 认知

正式 AgentRuntime：

- 通过 Pi provider factory 和启动参数选择 provider/model。
- 每次请求使用 `timelineId + roundId + requestId`。
- 取消、加载、重试或新轮次后，旧响应只能进入诊断。
- Agent 不获得文件、Shell、数据库、完整世界读取或直接状态写入工具。

阶段 4 只注册 `submit_cognitive_decision`：

- 返回认知状态更新。
- 返回意图变化。
- 返回需要表达的文本。
- 返回一个短身体计划，或合法 IdleCommitment。
- 确认实际消费的观察及意图。
- 目标使用观察者局部引用，由服务端验证并映射。
- 普通模型叙述不构成提交。
- 无合法工具提交、非法引用或无界空闲决定触发有限重试。

AI 表达转换为普通说话 ActionStep，必须经过 Body 执行后才能产生 `utterance` 事件。

`memory_search` 在阶段 5 才注册，阶段 4 不提供伪检索结果。

## 9. P4.7：TUI 调整

保留阶段 3 的固定动作栏和参数向导。

普通交互：

- 左右键选择指令。
- Enter 进入参数向导。
- Entity 参数上下选择。
- 文本参数使用现有 Input，支持中文和粘贴。
- Esc 返回或取消。
- 空格继续控制普通连续运行与暂停，但认知屏障期间不能绕过屏障。
- `/skip` 跳过当前玩家决策轮次。

顶栏增加：

- 等待 AI。
- 等待玩家选择。
- AI 决定验证中。
- 计划统一交接中。
- 保存待处理。
- 认知失败。

日志规则：

- 普通日志只显示玩家角色实际感知到的观察。
- AI 流式生成过程只显示系统等待状态。
- AI 说话只有在动作完成且玩家实际听见后才显示。
- 管理信息、原始模型响应和未执行计划不得进入普通日志。

管理面板增加：

- Perception：各角色观察数量、连续对象和材料版本。
- Cognition：当前轮次、参与者、状态和等待原因。
- Working Memory：容量、已准入数量和消费状态，不展示未经授权的完整私密文本。
- Diagnostics：模型请求、响应、验证、重试和拒绝原因。

## 10. P4.8：保存与加载

存档 schema 从版本 2 升级到版本 3，保存：

- PerceptionService 状态。
- 最小 Working Memory。
- AI CognitionState、意图和 IdleCommitment。
- 用户最小认知连续状态。
- 已完成并发布的认知轮次结果。
- 服务版本和配置身份。

阶段 3 版本 2 存档不迁移，加载时明确报告不兼容。

保存行为：

- 稳定 Tick 边界的 `/save <id>` 立即保存。
- 认知屏障中的保存请求进入 pending。
- 已有 pending 时再次保存明确拒绝并保留原请求。
- 屏障解除、当前 Tick 发布后，在连续运行开始下一 Tick 前执行保存。
- AI 失败、等待玩家或需要管理处理时继续保持 pending。
- 加载取消活动模型请求、清除未持久化 pending 保存并建立新 timeline。

## 11. 关键接口变化

```ts
interface PerceptionService {
  observe(input: PerceptionFrame): PerceptionResult;
  pendingObservations(characterId: string): readonly Observation[];
  playerView(characterId: string): PerceivedPlayerView;
  confirmConsumed(characterId: string, observationIds: readonly string[]): void;
}

interface WorkingMemoryService {
  admit(input: WorkingMemoryAdmission): WorkingMemoryResult;
  contextFor(characterId: string, roundId: string): CognitionInput;
  confirmUsage(input: CognitionUsageConfirmation): void;
}

interface CognitionCoordinator {
  openRound(demands: readonly CognitionDemand[]): CognitionRound;
  resolveAiParticipants(roundId: string): Promise<void>;
  submitPlayerCommand(roundId: string, plan: ActionPlan): PlayerDecisionResult;
  skipPlayer(roundId: string, characterId: string): void;
  completeRound(roundId: string): RoundCompletion;
}

type TickResult =
  | { status: "completed"; summary: TickSummary }
  | { status: "rule-barrier"; barrier: RuleBarrier }
  | { status: "cognitive-barrier"; round: CognitionRound }
  | { status: "failed"; failure: TickFailure };
```

玩家命令生成的计划不再使用 `source: diagnostic`。`ActionSource` 增加直观的 `player-command`，AI 计划使用 `ai-cognition`，行为树和管理诊断保持独立来源。

## 12. 实施顺序

1. 注册 Perception 与 Cognition SystemSpec，增加演示感知、听觉和模型配置。
2. 建立 World/Body 用途受限感知材料和 `utterance` 客观事件。
3. 实现 PerceptionService、结构化观察、连续观察和重复抑制。
4. 实现最小 Working Memory、认知状态、意图和空闲契约。
5. 将 Runner 阶段 8–12 改为可建立和解除认知屏障的状态机。
6. 实现 Pi AI 认知适配、结构化提交、验证、重试和迟到响应隔离。
7. 将玩家视图与动作候选切换为授权观察，同时保留阶段 3 动作栏交互。
8. 扩展 TUI 状态、日志和管理监视面板。
9. 升级存档 schema，实现 pending 保存。
10. 增加主路径测试、faux Agent 演示、真实模型人工验收清单和阶段报告。

## 13. 测试与验收

自动测试只覆盖主要路径：

1. 同地点可见、黑暗或浓雾降低细节、远处实体不可见。
2. 说话完成后同地点角色可以听见，未完成或被拒绝的说话不可感知。
3. 稳定场景不重复产生观察，出现、变化和消失保持连续性。
4. 普通玩家视图不包含人物真实姓名、Identity、控制来源或管理状态。
5. 动作候选只能来自玩家授权观察。
6. Working Memory 容量准入、确定性替换和消费确认。
7. 等待 AI 或玩家选择期间 Tick、动作和世界过程冻结。
8. AI 返回顺序不影响批量计划交接结果。
9. AI 合法工具提交成功，非法或迟到结果不能改变模拟。
10. 玩家 `/skip` 不取消既有动作。
11. 屏障期间保存请求在 Tick 发布后、下一 Tick 前执行。
12. 保存加载后感知、认知和动作结果保持一致。
13. 普通视图与管理员视图保持信息隔离。

端到端 faux Agent 场景：

```text
启动 → AI 完成初始化认知
→ 玩家通过动作栏移动到果园
→ 玩家只观察到一个未识别的人
→ 玩家选择“说话”并输入文本
→ 说话动作完成并形成听觉观察
→ AI 被唤醒，世界冻结
→ AI 提交回应和共同移动计划
→ 玩家通过动作栏接受或选择自己的行动
→ 所有计划统一交给 Body/World
→ 屏障期间请求保存
→ Tick 发布后保存
→ 加载并继续相同结果
```

新增命令：

```text
pnpm phase4:verify
pnpm phase4:demo
pnpm phase4:tui -- --provider <provider> --model <model>
```

人工验收覆盖 Windows Terminal 中文说话输入、参数向导、窗口缩放、等待状态、真实 AI 回应和管理信息隔离。

## 14. 阶段退出条件

- 普通 TUI 已完全停止消费阶段 3 临时玩家投影。
- 玩家通过阶段 3 指令选择模式完成移动、拿取、说话和共同活动。
- AI 能依据授权观察和最小 Working Memory 作出决定。
- 玩家和 AI 的计划接受相同 Body 与 World 验证。
- 模型或玩家等待期间模拟时间保持冻结。
- 同轮计划批量交接，响应顺序不影响结果。
- 未执行表达、原始模型响应和管理信息不会成为角色观察。
- pending 保存发生在完整 Tick 发布后、下一 Tick 前。
- 阶段 0–3 回归与阶段 4 主路径测试全部通过。
- 阶段报告明确记录：用户自然语言解释、身份关联和完整记忆均不属于阶段 4。
