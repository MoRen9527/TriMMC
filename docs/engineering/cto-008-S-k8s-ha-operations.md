# CTO-008-S：TriMMC K8s 高可用运维方案

> 设计人：ChiefTechnologyOfficer（小狄）
> 状态：APPROVED（CTO-008-S 交付，K8s manifests 已同步更新）
> 日期：2026-07-16
> 上游依据：`docs/architecture-overall-unified.mmd`（TriMMC K8s 三热备）、`TriMMC/k8s/trimc/`（现有 K8s manifests）

---

## 一、现状分析

### 现有 K8s 拓扑（基线）

| 资源 | 值 | 说明 |
|------|-----|------|
| Deployment replicas | **2** | 低于架构图定义的"三热备" |
| HPA minReplicas | 2 | 最低保持 2 副本 |
| HPA maxReplicas | 10 | CPU 70% 触发扩容 |
| PDB minAvailable | 1 | 允许 1 个 Pod 不可用期间驱逐 |
| Service type | ClusterIP | 仅集群内可达，端口 80→8710 |
| 健康检查 | readinessProbe + livenessProbe | 均指向 `/healthz` |

### 与架构图差距

```
架构图要求：TriMMC K8s 三热备
当前现状：2 replicas，PDB 仅保证 1 个可用

差距：
  1. replicas 2→3（达到最小热备数）
  2. PDB minAvailable 1→2（保证至少 2 个可用，容忍 1 个故障）
  3. 缺少 podAntiAffinity → 可能 2 个实例调度到同一节点
  4. 缺少多可用区/多集群拓扑分析
  5. 缺少 TriRLC→TriMMC 客户端侧故障切换指引
```

---

## 二、推荐架构：3 副本 + 跨节点反亲和

```
┌─────────────────────────────────────────────────────────┐
│  K8s Cluster (trimc namespace)                          │
│                                                          │
│  ┌──────────────────────────────────────────────────┐   │
│  │  Service: trimc (ClusterIP :80→:8710)             │   │
│  │  sessionAffinity: ClientIP (300s)                 │   │
│  └────────┬──────────────┬──────────────┬───────────┘   │
│           │              │              │                │
│  ┌────────▼──────┐ ┌────▼────────┐ ┌───▼─────────┐    │
│  │  TriMMC Pod-1  │ │ TriMMC Pod-2 │ │ TriMMC Pod-3 │    │
│  │  Node-A       │ │ Node-B      │ │ Node-C      │    │
│  │  (required)   │ │ (preferred) │ │ (preferred) │    │
│  └────────┬──────┘ └────┬────────┘ └───┬─────────┘    │
│           │              │              │                │
│           └──────────────┼──────────────┘                │
│                          │                               │
│                 ┌────────▼────────┐                      │
│                 │  PostgreSQL     │                      │
│                 │  (单实例/主从)   │                      │
│                 └─────────────────┘                      │
└─────────────────────────────────────────────────────────┘
```

### 关键设计决策

| 决策 | 推荐 | 理由 |
|------|------|------|
| 副本数 | **3**（固定，不依赖 HPA 下限） | 满足"三热备"定义；2 副本只剩 1 个可用时无法区分"单点故障"还是"健康实例不足" |
| Pod 反亲和 | **requiredDuringScheduling**（硬反亲和） | 确保 3 个副本分布在不同节点；若集群 <3 节点，调度阻塞（可降级为 preferred） |
| Service sessionAffinity | **ClientIP** | 同一 TriRLC 客户端请求路由到同一 TriMMC Pod，减少跨 Pod 会话切换 |
| PDB minAvailable | **2** | 允许最多 1 个 Pod 不可用期间驱逐；若设为 1 则允许 2 个 Pod 同时被驱逐 = 违反三热备语义 |

---

## 三、mult-AZ / 多集群可行性

### 3.1 单集群多 AZ（当前可行）

```
K8s 集群跨 3 个 AZ (us-east-1a/1b/1c)

  条件：
  - 每个 AZ 至少 1 个 worker node
  - Pod topologySpreadConstraints 或 podAntiAffinity 确保分布
  - 网络延迟 AZ 间 <2ms（典型云厂商内网延迟）
  - PostgreSQL 主库在 AZ-a，备库在 AZ-b（或使用云托管 RDS）

  收益：
  - 单 AZ 故障（网络分区/电力）→ 剩余 2 AZ 继续服务
  - 无需额外集群管理开销

  限制：
  - 共享控制面（API Server 故障影响所有 AZ）
  - 共享 etcd（需 etcd 自身有 quorum）
```

### 3.2 多集群（Phase 2+，当前不推荐）

```
Cluster-A (us-east-1)          Cluster-B (us-west-2)
  TriMMC × 3                      TriMMC × 2 (warm standby)
  PostgreSQL (primary)           PostgreSQL (read replica)

  需要额外投入：
  - 全局 DNS/负载均衡（Route53 + Health Check 故障转移）
  - TriMMC 无状态但 PostgreSQL 有状态 → 主从复制延迟
  - TriStaciss 模型平台也需要多集群部署或 VPN 打通
  - TriRLC 客户端需支持多 endpoint 故障切换

  结论：Phase 1 MVP 阶段不推荐多集群。单集群 3 AZ 已满足可用性需求。
  多集群在用户量突破 10 万或合规要求（数据不出境）时再评估。
```

### 3.3 半托管方案（推荐中间态）

若自建 PostgreSQL HA 负担过重：

```
TriMMC Pods × 3 (K8s, 无状态)  →  云托管 PostgreSQL (RDS/Aurora, Multi-AZ)
                                 →  TriStaciss (外部 HTTP 服务，已有冗余)
```

TriMMC 自身无状态（会话在内存/Redis），所有持久化走 PostgreSQL。将 PG 迁移到云托管后：
- TriMMC Pod 重启不影响数据
- K8s 集群故障不影响 PG（PG 独立于 K8s 集群）
- PG 自身的 Multi-AZ 由云厂商保证

---

## 四、K8s Manifest 变更

### 4.1 Deployment（replicas 2→3，增加 podAntiAffinity）

```yaml
spec:
  replicas: 3  # 2→3
  template:
    spec:
      affinity:
        podAntiAffinity:
          requiredDuringSchedulingIgnoredDuringExecution:
            - labelSelector:
                matchLabels:
                  app: trimc
              topologyKey: kubernetes.io/hostname
```

### 4.2 PDB（minAvailable 1→2）

```yaml
spec:
  minAvailable: 2  # 1→2
```

### 4.3 Service（增加 sessionAffinity）

```yaml
spec:
  sessionAffinity: ClientIP
  sessionAffinityConfig:
    clientIP:
      timeoutSeconds: 300
```

### 4.4 HPA（不变）

当前配置 `minReplicas: 2, maxReplicas: 10, CPU 70%` 保持。replicas 从 Deployment 级固定为 3，HPA 下限保持 2（允许手动缩容到 2 但不再低于 2）。

---

## 五、TriRLC 客户端侧故障切换

TriRLC `ConnectionManager`（CTO-008-P 已实现）负责检测 TriMMC 可用性并自动切换：

```
TriRLC 连接策略（当前）：
  1. 优先连接 trimcBaseUrl（默认 http://127.0.0.1:8710）
  2. 3 次连续失败 → degraded → 使用本地 agentLoop()
  3. 2 次连续成功 → 恢复 connected → 恢复代理到 TriMMC

未来增强（Phase 2）：
  - 支持 trimcEndpoints[] 多地址列表
  - 连接失败时轮询下一个 endpoint
  - 通过 /healthz 响应头获取"推荐 endpoint"（如当前集群负载高时建议切换到其他 endpoint）
```

### K8s Service 层的故障切换

```
TriRLC → trimc.example.com (DNS 解析到 K8s Service ClusterIP 或 Ingress)
      → K8s Service 自动负载均衡到健康 Pod
      → Pod 故障时 K8s 自动从 Service endpoint 摘除（readinessProbe 失败）
```

TriRLC 客户端无需感知 Pod 拓扑变化。K8s Service 的 readinessProbe 确保只路由到健康 Pod。

---

## 六、PostgreSQL 高可用

### 当前状态

docker-compose 中的 PostgreSQL 是单实例（无 HA）。

### 推荐路径

| 阶段 | 方案 | 适用场景 |
|------|------|---------|
| Phase A（当前） | docker-compose 单实例 | 开发/演示 |
| Phase B（staging） | K8s StatefulSet + persistent volume | 内部测试 |
| Phase C（生产） | 云托管 PostgreSQL（RDS Multi-AZ）或 Patroni HA | 生产流量 |

### TriMMC 对 PG 故障的容忍度

- TaskController 任务持久化依赖 PG
- 若 PG 不可用，新任务创建失败，但已有任务继续在内存中执行
- 恢复连接后补录任务状态

---

## 七、部署与验证清单

### 部署步骤

```bash
# 1. 应用 K8s manifests（kustomize）
kubectl apply -k k8s/trimc/

# 2. 验证 3 个 Pod 分布在不同节点
kubectl get pods -n trimc -o wide -l app=trimc

# 3. 验证 PDB
kubectl get pdb -n trimc trimc

# 4. 验证 HPA
kubectl get hpa -n trimc trimc

# 5. 验证健康检查
kubectl port-forward -n trimc svc/trimc 8710:80
curl http://localhost:8710/healthz
```

### 验收门禁

- [ ] 3 个 Pod 全部 Running 且分布在不同 node
- [ ] PDB minAvailable=2
- [ ] 手动删除 1 个 Pod → Service 自动摘除 → 剩余 2 Pod 继续服务
- [ ] TriRLC 连接 K8s Service → 代理成功 → 灭活 2 个 Pod（只剩 1 个）→ TriRLC 仍可代理
- [ ] 灭活全部 3 个 Pod → TriRLC 在 3 次失败后切换到本地模式
- [ ] 恢复 Pod → TriRLC 在 2 次成功后恢复代理模式

---

## 八、风险与缓解

| 风险 | 影响 | 缓解 |
|------|------|------|
| 集群仅 2 个 node | podAntiAffinity 硬反亲和导致第 3 个 Pod 无法调度 | 降级为 preferredDuringScheduling |
| PostgreSQL 单点故障 | 任务持久化中断 | Phase C 迁移到云托管 PG |
| K8s API Server 故障 | 新 Pod 无法调度，但已有 Pod 继续运行 | 已有 Pod 不受影响；控制面恢复后自动修复 |
| 全 AZ 网络分区 | 所有 TriMMC Pod 不可达 | TriRLC 自动切换本地模式（CTO-008-P 已实现） |
| TriStaciss 外部依赖故障 | 模型调用回退到 DeepSeek 直连 | TriModel fallback chain 已支持 |
| 会话粘滞导致负载不均 | 某 Pod 过载 | HPA CPU 70% 触发扩容；sessionAffinity timeout 300s 后重分配 |

---

## 九、使用依据

- `docs/architecture-overall-unified.mmd`：TriMMC K8s 三热备定义
- `TriMMC/k8s/trimc/`：现有 K8s manifests 基线（deployment/hpa/pdb/service）
- `TriMMC/docs/engineering/deployment-topology.md`：最小部署拓扑
- `TriRLC/src/server/app.ts`：ConnectionManager 故障切换实现
- `docs/engineering/cto-008-M-tri-mc-lc-protocol.md`：TriMMC↔TriRLC 通信协议
