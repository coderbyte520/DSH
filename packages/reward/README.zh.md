# reward/ —— 机械奖励信号

[English](README.md) | 中文

对 agent 工作做确定性打分，并记录为会话审计事件，使训练或评测流水线无需模型参与即可评判一次运行。记录只写日志：模型看不到它们，也没有任何会话 fold 消费它们，因此省略这些包的部署只丢失该信号，别无影响。

| 包 | 角色 | ctx key |
|---|---|---|
| [`verifiable-reward/`](verifiable-reward/README.zh.md) | 把 shell 工具结果机械打分记录为 `reward/check` | — |

部署所拥有的打分策略——被观察工具、命令检查、罚分模式——位于 [verifiable-reward](verifiable-reward/README.zh.md)；本组承载打分规则及其写入的事件词汇。
