# reward/ — mechanical reward signals

English | [中文](README.zh.md)

Deterministic scoring of agent work, recorded as session audit events so a training or evaluation pipeline can judge a run without a model in the loop. Records stay log-only: the model never sees them and no session fold consumes them, so a deployment that omits the packages loses the signal and nothing else.

| Package | Role | ctx key |
|---|---|---|
| [`verifiable-reward/`](verifiable-reward/README.md) | Mechanical scoring of shell tool outcomes as `reward/check` | — |

The scoring policy a deployment owns — observed tools, command checks, forbidden patterns — lives in [verifiable-reward](verifiable-reward/README.md); this group holds the scoring rules and the event vocabulary they write.
