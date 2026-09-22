# Core 与确定性规则系统架构

本文描述当前代码，而不是未来方案。目标是让第一次进入项目的人能回答四个问题：配置怎样变成可运行对象、一次规则运行怎样发生、各模块负责什么、常用名词是什么意思。

## 1. 一句话模型

```text
ContentPack → ParsedPack → MergedItem → CheckedConfig → RuntimeConfig
RuntimeConfig + RuleRequest → RuleResult
RuleResult → StateChangeRequest[] / ProcessChangeRequest[]
```

Core 负责把内容变成确定的计算计划，并根据显式输入计算“请求做出的变化”。Core 不直接修改 World、Body 或 Character 的权威状态。

## 2. 模块边界

| 模块 | 文件 | 职责 |
| --- | --- | --- |
| 系统说明 | `src/config/system-spec.ts` | 定义 `SystemSpec`，装载系统说明 |
| 系统索引 | `src/config/system-index.ts` | 查找 Item、Input、Output、Trigger、Process |
| 内容解析 | `src/config/source.ts` | 把 YAML 解析成 `ParsedPack` |
| 内容集合 | `src/config/packs.ts` | 管理包依赖、可见性及项目查找 |
| 项目合并 | `src/config/config-merge.ts` | 合并默认值、模板和覆盖 |
| 规则目录 | `src/config/rule-catalog.ts` | 提供 Input 和 Output 的类型信息 |
| 配置检查 | `src/config/config-checker.ts` | 绑定引用并生成 `CheckedConfig` |
| 配置构建 | `src/config/config-builder.ts` | 生成不可变的 `RuntimeConfig` |
| 规则运行 | `src/config/rule-engine.ts` | 执行规则并返回变化请求和追踪 |
| Core 门面 | `src/config/core-runtime.ts` | 注册、发布、恢复和 `runRules()` |
| 值表达式 | `src/config/value-expr.ts` | 定义并运行 `ValueExpr` |
| 数值规则 | `src/config/numeric.ts` | 单位、范围、映射和数值策略 |

依赖方向是单向的：解析层不知道运行时状态，规则运行层不读取文件，系统实现不绕过 Core 直接解释规则 YAML。

## 3. 两类输入不要混淆

### SystemSpec：系统提供给 Core 的说明书

`SystemSpec` 描述一个系统允许内容作者使用什么：

- `items`：可以配置哪些项目；
- `inputs`：规则可以读取哪些状态；
- `outputs`：规则可以请求修改哪些状态；
- `triggers`：哪些事件可以触发规则；
- `processes`：可以请求哪些过程动作；
- `validate`：该系统自己的语义检查。

系统使用简短的 `SystemId`，例如 `agentlife.body`。`/system` 不再出现在业务标识中。

### StateInput：一次规则运行的数据

```ts
interface StateInput {
  stateVersion: string;
  simTime: SimTime;
  shared: Readonly<Record<string, unknown>>;
  entities: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
}
```

它不是整个游戏状态，也不是可变服务对象。共享状态只保存一份，实体状态按稳定 `entityId` 隔离；`RuleRequest.entityIds` 显式指定本次需要求值的实体，RuleEngine 不会自行扫描实体集合。

## 4. 配置生命周期

### Parsed

`parsePack()` 负责文档结构。规则作者使用的格式是：

```yaml
kind: rule
id: base-move-cost
system: agentlife.body
triggers:
  - agentlife.body/value-changed
inputs:
  - name: load
    state: agentlife.body/values.load
condition:
  op: always
changes:
  - state: agentlife.body/values.move-cost
    combine: add
    value:
      kind: literal
      value: 1
      unit: points
```

`name` 是表达式中使用的局部名称；`state` 是完整 `StateRef`。内容作者不再分别填写底层 input 和 field。

### Merged

`mergeItems()` 只处理配置项目：

```text
系统默认值 → 模板 → 当前项目 → 显式覆盖
```

每个字段的来源会被保留，便于说明最终值为什么是这样。

### Checked

`checkConfig()` 把文本引用绑定到已注册系统，检查规则输入、状态输出、公式依赖、单位和 `CombineMode`，并调用各系统的 `validate`。

### Runtime

`buildConfig()` 生成不可变的 `RuntimeConfig`，其中包括：

- 按稳定顺序排列的规则和公式；
- `triggerIndex`：Trigger 对应哪些 Rule；
- `combinePlans`：每个 StateRef 怎样合并多个规则值；
- `configId`：运行计划的内容哈希；
- `sourceData`：恢复同一配置所需的源数据。

相同内容始终得到相同 `configId`，不同运行计划得到不同 `configId`。

## 5. 一次 runRules 怎样执行

```text
RuleRequest
  1. 检查 baseVersion
  2. 用 triggerIndex 选择 Rule
  3. 共享规则执行一次
  4. entityIds 去重并排序
  5. 每个实体建立独立输入作用域与公式缓存
  6. 运行 Condition、ValueExpr 和 Formula
  7. 按 (scope, entityId, StateRef) 收集并组合 RuleValue
  8. 返回按共享/实体分组的 RuleResult
```

`RuleResult` 在顶层暴露 `stateChanges`、`processChanges`，并在 `trace` 中保留完整运行证据。

### 确定性来自哪里

RuleEngine 不读取机器时钟、不使用随机数、不访问网络、不读取未声明状态。影响结果的所有数据都来自固定的 `RuntimeConfig` 和显式的 `RuleRequest`。

规则、公式、状态引用、来源规则和实体 ID 都按稳定顺序处理。因此同一配置和同一输入会产生相同结果、相同变化顺序与追踪；调用方传入实体的顺序不会改变结果。

## 6. 变化请求不是已经发生的状态

`StateChangeRequest` 的意思是：“请对应 System 在这个状态版本基础上尝试应用新值”。

```ts
interface StateChangeRequest {
  entityId: string | null;
  stateRef: string;
  system: string;
  newValue: SimpleValue;
  sourceRules: readonly string[];
  runId: string;
  baseVersion: string;
  simTime: SimTime;
}
```

`ProcessChangeRequest` 同样只是过程动作请求。权威 System 仍需检查状态版本、应用变化并产生实际事件。

## 7. Terminology

| 名称 | 人话解释 |
| --- | --- |
| ContentPack | 一组 Manifest、配置项目、规则和公式文件 |
| SystemSpec | 某个运行系统允许 Core 使用的能力说明 |
| SystemId | 系统自己的 ID，例如 `agentlife.body` |
| ConfigItem | 世界地点、身体值、角色等配置对象 |
| Rule | Trigger 到来时可能产生变化的一条规则 |
| Formula | 可被多条规则复用的具名计算 |
| StateInput | 一次运行允许读取的只读状态 |
| StateRef | 具体状态值的上层引用，例如 `agentlife.body/values.stamina` |
| ValueExpr | 计算一个标量值的受限表达式 |
| CombineMode | 同一 StateRef 的多个 RuleValue 怎样合并 |
| RuntimeConfig | 已检查、已索引、可直接运行的不可变配置 |
| RuleRequest | 调用 RuleEngine 的请求 |
| RuleResult | 一次规则运行的结果 |
| StateChangeRequest | 请求某个 System 修改状态 |
| ProcessChangeRequest | 请求某个 System 执行过程动作 |
| RunTrace | 本次运行选择、跳过、计算和合并了什么 |

`Id` 表示对象自身身份，`Ref` 表示指向另一个对象。代码不再使用 `Address` 表示业务引用，也不再用 Candidate、Domain、Owner、Target 描述主流程。

## 8. CoreRuntime 的使用方式

```ts
const core = new CoreRuntime();
for (const spec of createSystemSpecs()) core.addSystem(spec);

const published = core.publish({ root: packInput(snapshot) });
if (published.status !== "valid") throw new Error("invalid config");

const result = core.runRules({
  runId: "tick-42",
  trigger: "agentlife.body/tick-elapsed",
  entityIds: ["agentlife.demo/player", "agentlife.demo/companion"],
  input: {
    stateVersion: "state-10",
    simTime: { tick: 42, seconds: 420 },
    shared: sharedState,
    entities: entityStates,
  },
});

for (const change of result.stateChanges) {
  // 将请求交给 change.system 对应的权威系统。
}
```

## 9. 当前架构判断

当前配置管道的阶段边界清楚，`Parsed → Merged → Checked → Runtime` 适合继续扩展；确定性运行也保持了纯输入/纯输出边界。

仍值得在后续阶段处理一件事：

1. `CoreRuntime` 同时承担配置构建、发布/恢复和规则运行。功能扩大后可拆成 `ConfigCompiler`、`ConfigManager`、`RuleEngine`；现在先保留一个易用门面。

多实体边界已经由 `shared`、`entities` 和显式 `entityIds` 固定。当前不会对实体集合做聚合或关系查询；这类世界语义由阶段 2 的领域服务提供明确投影后再扩展。
