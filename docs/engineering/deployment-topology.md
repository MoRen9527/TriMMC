# TriMMC 最小部署拓扑

- 文档定位：CARRY-004 执行设计 — TriMMC 服务器正式版最小部署拓扑
- 状态：DRAFT — CTO 执行中
- 最后更新：2026-07-14
- 维护归属：CTO（小狄）
- 上游依据：`TriMMC/docs/engineering/DESIGN.md` §1 两种部署形态

## 文档同步元信息

- sourceOfTruth: TriMMC/docs/engineering/deployment-topology.md
- publishedFrom: 当前文件（source）
- syncMode: source-only
- publishTier: source-only
- lastSyncedAt: 2026-07-14

---

## 1. 范围与目标

本设计覆盖 TriMMC 从零到最小可运行部署的完整路径：

- **TriMMC 服务器进程**（Node.js 20+, TypeScript → JS 构建产物）
- **TriModel 模型层**（bundled via `file:` dependency）
- **PostgreSQL 数据库**（TaskController 持久化）
- **API Key 注入**（DeepSeek 直连 + TriStaciss 平台）

不覆盖：OpenClow Gateway、VSCodium Glue、本地域 TriRLC 联调（这些属于后续阶段）。

## 2. 最小部署拓扑

```
┌──────────────────────────────────────────────────────────┐
│  Docker Compose / K8s Pod                                │
│                                                          │
│  ┌──────────────┐    ┌──────────────┐                    │
│  │  TriMMC       │    │  PostgreSQL  │                    │
│  │  :8710       │◄──►│  :5432       │                    │
│  │  (HTTP)      │    │  (内部)       │                    │
│  └──────┬───────┘    └──────────────┘                    │
│         │                                                │
│         │ TriModel (bundled)                             │
│         ▼                                                │
│  ┌──────────────────────────────────┐                    │
│  │  外部模型 API                     │                    │
│  │  • DeepSeek API (直连)            │                    │
│  │  • TriStaciss (平台路由)           │                    │
│  └──────────────────────────────────┘                    │
└──────────────────────────────────────────────────────────┘
```

## 3. 组件说明

### 3.1 TriMMC Server

| 属性 | 值 |
|------|-----|
| 运行时 | Node.js ≥20 |
| 默认端口 | 8710 |
| 入口 | `dist/index.js`（TypeScript 编译产物） |
| 构建 | `tsc -p tsconfig.json` → `dist/` |
| 关键端点 | `/healthz`, `/internal/v1/agent`, `/internal/v1/agent?stream=true` |
| 依赖 | `trimodel` (file:../TriModel), `pg`, `yaml` |

### 3.2 TriModel

| 属性 | 值 |
|------|-----|
| 主提供者 | DeepSeek（默认 `deepseek-v4-pro`） |
| 备用提供者 | TriStaciss（平台统一路由） |
| 所需密钥 | `DEEPSEEK_API_KEY`（必填）, `TRIMODEL_TRIMETAVERSE_API_KEY`（可选，有默认值） |

### 3.3 PostgreSQL

| 属性 | 值 |
|------|-----|
| 用途 | TaskController 任务持久化 |
| 版本 | ≥15 |
| 数据库名 | `trimc`（默认） |
| 连接方式 | 环境变量注入 |

## 4. 环境变量映射

### 4.1 TriMMC 层

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `TRIMC_PORT` | `8710` | HTTP 监听端口 |
| `TRISTACISS_BASE_URL` | `http://127.0.0.1:8008` | TriStaciss 服务地址 |
| `OPENCLOW_GATEWAY_URL` | `ws://127.0.0.1:8822` | OpenClow WebSocket |
| `VSCODIUM_GLUE_BASE_URL` | `http://127.0.0.1:8730` | VSCodium Glue |
| `DATABASE_URL` | — | PostgreSQL 连接串（pg 使用） |

### 4.2 TriModel 层

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `DEEPSEEK_API_KEY` | — | **必填** — DeepSeek API 密钥 |
| `DEEPSEEK_BASE_URL` | `https://api.deepseek.com/v1` | DeepSeek API 地址 |
| `TRIMODEL_TRIMETAVERSE_API_KEY` | `tmv-sk-dev-default` | TriStaciss 平台密钥 |
| `TRIMODEL_TRISTACISS_BASE_URL` | `http://127.0.0.1:8000/v1` | TriStaciss 服务地址 |
| `TRIMODEL_PRIMARY_PROVIDER` | `deepseek` | 主模型提供者 |
| `TRIMODEL_DEFAULT_MODEL` | `deepseek-v4-pro` | 默认模型 |
| `TRIMODEL_FALLBACK_MODEL` | `deepseek-v4-flash` | 回退模型 |
| `TRIMODEL_REQUEST_TIMEOUT_MS` | `60000` | 请求超时（毫秒） |

### 4.3 启动所需最小变量集合

在 Docker Compose 或 K8s 中至少需要注入：

```bash
DEEPSEEK_API_KEY=sk-xxx        # 必填
# 以下使用默认值即可启动
# TRIMC_PORT=8710
# TRIMODEL_PRIMARY_PROVIDER=deepseek
```

## 5. 网络拓扑

| 端口 | 服务 | 方向 | 说明 |
|------|------|------|------|
| 8710 | TriMMC HTTP | Ingress | 对外服务端口 |
| 5432 | PostgreSQL | 内部 | 仅容器网络内可见 |
| 8000 | TriStaciss | 外部 | 模型平台路由（外部服务） |
| 8008 | TriStaciss | 外部 | TriMMC → TriStaciss 桥接 |

## 6. 健康检查

| 端点 | 方法 | 预期响应 | 说明 |
|------|------|----------|------|
| `GET /healthz` | HTTP | `200 {"ok":true,"service":"trimc"}` | 基础存活检查 |
| `GET /hello` | HTTP | `200 {"ok":true,"greeting":"..."}` | 模型连通性检查（需 DeepSeek API） |

## 7. 部署路径

```
Phase A: docker-compose up (本机验证)    ← CARRY-004 当前阶段
Phase B: K8s staging (TriDeployment 工具) ← CARRY-004 后续
Phase C: K8s production               ← 后续 CARRY
```

### Phase A：docker-compose

```bash
# 1. 构建镜像
docker build -t trimc:dev -f docker/Dockerfile ../..

# 2. 启动
docker-compose -f docker/docker-compose.yml up -d

# 3. 验证
curl http://localhost:8710/healthz
```

### Phase B：K8s staging

使用 TriDeployment 工具生成 K8s manifests：

```powershell
pwsh ../TriDeployment/tools/scaffold-k8s-app.ps1 -AppName trimc -Namespace ai-staging -Image ghcr.io/Moren9527/trimc:dev -Port 8710
```

## 8. 安全边界

- **API 密钥**通过 Docker secrets 或 K8s Secrets 注入，不写入镜像层
- **PostgreSQL** 仅容器网络内暴露，不映射到宿主机（生产环境）
- **/healthz** 不暴露模型状态，仅暴露进程存活
- **防火墙**：生产环境仅放开 8710 端口的 Ingress 流量

## 9. 已覆盖项（CTO-008-S 交付后）

- HPA / PDB / 多副本拓扑 ✅ — 详见 `cto-008-S-k8s-ha-operations.md`（3 replicas + podAntiAffinity + PDB minAvailable=2 + Service sessionAffinity）
- 日志聚合与指标暴露（待后续 CARRY）

## 10. 未覆盖项（后续阶段）
