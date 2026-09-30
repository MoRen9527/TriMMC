// ── config-sync 域 barrel（i4-2：五维同步 TriMMC 接收侧）──
// types.ts         — bundle schema 契约 + 校验 + contentHash/指纹（§一）
// status.ts        — status 读取器（applied/fleetHead/pending/dims，§三.3）
// default-model.ts — 模型层 default 三级解析（§四）
// apply.ts         — apply 执行体（读→校验→版本比对→落地→退出码，§三.1）

export * from './types.js';
export * from './status.js';
export * from './default-model.js';
export * from './apply.js';
