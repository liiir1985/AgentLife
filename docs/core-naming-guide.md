# Core 命名规范

> 状态：已应用到代码、内容包和测试。本文既是命名规范，也是旧名称的迁移索引。

## 1. 原则

1. 名称描述业务角色，不描述编译器内部动作。
2. 默认使用两个 CamelCase 单词，只有无法消歧时才使用三个。
3. 同一个概念只用一个词；System、StateRef、ChangeRequest 不再混用旧同义词。
4. `Id` 是对象自身身份，`Ref` 是指向另一个对象的引用。
5. 公共 API 使用自然动词：`parse → merge → check → build → publish → run → apply`。

## 2. 当前公共语言

```text
ContentPack
SystemSpec
ConfigItem
Rule
Formula
StateInput
StateRef
ValueExpr
CombineMode
RuleRequest
RuleResult
StateChangeRequest
ProcessChangeRequest
RunTrace
RuntimeConfig
```

主流程应能直接读成：

```text
ContentPack 被构建成 RuntimeConfig。
CoreRuntime 用 StateInput 运行 RuleRequest。
Rule 和 Formula 通过 ValueExpr 计算值。
同一 StateRef 的 RuleValue 按 CombineMode 合并。
RuleResult 返回 StateChangeRequest 或 ProcessChangeRequest。
对应 System 决定是否应用请求。
```

## 3. 当前配置格式

系统直接使用 `SystemId`，不附加 `/system`：

```yaml
systems:
  - agentlife.body@1.0.0
```

规则输入使用完整 `StateRef`：

```yaml
system: agentlife.body
inputs:
  - name: stamina
    state: agentlife.body/values.stamina
changes:
  - state: agentlife.body/values.move-cost
    combine: add
    value:
      kind: read
      name: stamina
```

公式引用写成：

```yaml
kind: formula
formulaRef: agentlife.demo/exhaustion-factor
```

过程变化写成：

```yaml
- processRef: agentlife.body/recovery
  action: establish
  params: {}
```

## 4. 配置阶段命名

```text
Parsed → Merged → Checked → Runtime
```

| 阶段 | 对象 |
| --- | --- |
| 文件刚解析 | `ParsedPack`、`ParsedItem`、`ParsedRule`、`ParsedFormula` |
| 默认值和模板已合并 | `MergedItem` |
| 引用和语义已检查 | `CheckedConfig`、`CheckedRule`、`CheckedFormula`、`CheckedInput` |
| 可直接运行 | `RuntimeConfig`、`RuntimeRule`、`RuntimeFormula` |

不要重新引入 `Source*`、`Bound*`、`Compiled*` 作为这些阶段的公共名称。

## 5. Id 与 Ref

推荐：

```ts
configId: string;
contentId: string;
systemId: string;
ruleId: string;
changeId: string;

stateRef: string;
formulaRef: string;
processRef: string;
```

规则：

- 自己是谁，用 `Id`；
- 指向谁，用具体的 `Ref`；
- 不使用通用 `identity` 表示运行时配置或内容哈希；
- 不使用 `Address` 表示上层状态引用；
- 公共请求、运行结果和配置元数据使用具体的 `stateRef`、`formulaRef`、`processRef` 与各类 `Id`。
- `Parsed* → Merged* → Checked* → Runtime*` 内部节点暂时保留通用 `ref`，因为解析、依赖排序和索引算法需要统一处理不同种类的配置项；它不是面向调用者的新公共语言。

内容模型中的角色 `identity` 是业务字段，不属于这条基础设施命名规则。

## 6. 变化与运行结果

```ts
interface RuleResult {
  status: ResultStatus;
  configId: string;
  stateChanges: readonly StateChangeRequest[];
  processChanges: readonly ProcessChangeRequest[];
  trace: RunTrace;
}
```

```ts
interface StateChangeRequest {
  changeId: string;
  system: string;
  stateRef: string;
  newValue: SimpleValue;
  baseVersion: string;
  simTime: SimTime;
  sourceRules: readonly string[];
}
```

`Request` 表示变化尚未成为事实。不要再用 Candidate、Effect、Proposal 作为同一对象的别名。

## 7. 基础设施名称

| 当前名称 | 职责 |
| --- | --- |
| `SystemCatalog` | 已装载系统的集合 |
| `SystemIndex` | 系统声明的快速查找索引 |
| `RuleCatalog` | 规则可读写状态的类型目录 |
| `CoreRuntime` | 当前阶段的统一门面 |
| `ConfigStore` | 保存和恢复运行配置的端口 |
| `RuntimeStore` | 配置、运行追踪和变化认领的持久化实现 |

存储接口使用：

```text
saveConfig / currentConfig / loadConfig
saveRunTrace / loadRunTrace
claimChange
```

## 8. 旧名称迁移表

以下名称只允许出现在历史说明或迁移表中：

| 旧名称 | 当前名称 |
| --- | --- |
| `DomainExtension` | `SystemSpec` |
| `ExtensionRegistry` | `SystemCatalog` |
| `ExtensionCapabilities` | `SystemIndex` |
| `ConfigVocabulary` | `RuleCatalog` |
| `CandidateEffect` | `StateChangeRequest` |
| `CandidateProcessOperation` | `ProcessChangeRequest` |
| `EvaluationRequest` | `RuleRequest` |
| `EvaluationSnapshot` | `StateInput` |
| `EvaluationResult` | `RuleResult` |
| `EvaluationTrace` | `RunTrace` |
| `ValueSource` | `ValueExpr` |
| `Derivation` | `Formula` |
| `CompositionKind` | `CombineMode` |
| `CompositionPlan` | `CombinePlan` |
| `ContributionTrace` | `ValueTrace` |
| `ConfigurationRegistry` | `CoreRuntime` |
| `apply()` | `publish()` |
| `evaluate()` | `runRules()` |
| `identityOf()` | `hashId()` |

字段迁移：

| 旧字段 | 当前字段 |
| --- | --- |
| `domain`、`owner` | `system` |
| `target` | `stateRef` 或 YAML `state` |
| `effects` | `changes` |
| `composition` | `combine` |
| `requestId` | `runId` |
| `simulationTime` | `simTime` |
| `candidates` | `stateChanges` |
| `processOperations` | `processChanges` |
| config `identity` | `configId` |
| pack `identity` | `contentId` |
| `fingerprint` | `specHash` |

## 9. 判断一个新名称是否合格

1. 没读架构文档的人能否大致猜出用途？
2. 名称是在描述业务角色，还是只描述内部刚做过的动作？
3. YAML、TypeScript、存储接口和文档是否使用同一个词？
4. 删除一个修饰词后是否仍不会歧义？
5. 是否保持在两个词，最多三个词？

如果一个名称必须先讲一段内部理论才能理解，就不应成为公共语言。
