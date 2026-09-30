# TriMMC Business State

## Registry Role

- 本文件是 `TriMMC` 的 business registry 工作层。
- `TriMMC` 的 `product-state.md` 与 `code-state.md` 默认应以本文件作为业务上游约束。

## Module Business Role

- `TriMMC` 是服务域主控模块，也是统一运行面、任务控制、服务域执行、审计和事件聚合的承接层。

## Current Default Business Position

- 当前默认定位是统一 agent runtime 与 interaction core。

## Boundary Notes

- `core-agent` 只能作为历史 observability 迁移源，不应被重新写成现役主控。
- 若本模块事实与中央边界冲突，应先报告冲突，再请求更新中央 strategy registry。

## Sources

- `../../AGENTS.md`
- `../../README.md`