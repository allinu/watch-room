# Afterglow · 多人在线放映室

一个轻量、实时的多人同步观影工具。服务端 Node.js，前端纯 HTML/CSS/JS，无框架、无构建、无数据库。

## 快速开始

```bash
# 本地运行
npm install
npm run start
# → http://localhost:4311

# 或 Docker
docker build -t afterglow .
docker run -d -p 4311:4311 --name afterglow afterglow
```

## 功能

- **创建 / 加入房间** — 自动生成或自定义房间代码，链接或代码均可加入
- **多端实时同步** — 服务端 4Hz 权威心跳，所有客户端统一播放位置
- **OpenList 文件浏览器** — 输入 OpenList 站点地址，像文件选择器一样浏览并搜索视频
- **直链播放** — 支持 MP4 / WebM 在线直链
- **主持人权限** — 控制播放、换片、移交；主持人断线 15 秒宽限期保留权限
- **智能文件名** — 列表中的视频文件自动省略公共前缀/后缀，只显示差异部分（`…S01E01…`）
- **聊天 & 表情反应** — 房间内即时消息和浮动表情
- **移动端适配** — 响应式布局
- **本地持久化** — 昵称、地区、上次播放位置自动保存

## 架构

```
watch-room/
├── server.mjs       # HTTP + WebSocket 服务端（~450 行）
├── public/
│   ├── index.html   # 单页应用（所有弹窗、布局）
│   ├── style.css    # 深色主题、响应式
│   └── app.js       # 客户端逻辑（~830 行）
├── tests/
│   ├── sync.mjs     # 多客户端同步测试
│   ├── openlist.mjs # OpenList API 代理测试
│   └── ui.mjs       # Playwright 端到端测试
├── Dockerfile
└── package.json
```

### 服务端

| 路径 | 说明 |
|------|------|
| `GET /` | 静态文件服务 |
| `POST /api/rooms` | 创建房间 |
| `GET /api/rooms/:id` | 查询房间信息 |
| `POST /api/openlist/browse` | 代理 OpenList 目录列表 / 搜索 |
| `POST /api/openlist/resolve` | 代理 OpenList 文件解析为播放直链 |
| `WS /sync` | WebSocket 房间同步协议 |

### WebSocket 事件

| 方向 | 事件 | 说明 |
|------|------|------|
| C→S | `ping` | RTT 采样（客户端发起） |
| S→C | `pong` | RTT + 时钟偏移回执 |
| C→S | `join` | 加入房间（携带 persistentId） |
| S→C | `snapshot` | 房间完整状态快照 |
| S→C | `sync` | **4Hz 权威心跳**：当前播放位置、暂停状态、片源 |
| S→C | `playback` | 主持人操作触发的低延迟播放事件 |
| C→S | `set-media` | 设置片源（主持人） |
| C→S | `playback` | 播放/暂停/跳转（主持人） |
| C→S | `request-host` | 请求接管主持人 |
| S→C | `host-changed` | 主持人变更通知 |
| C→S | `chat` | 发送聊天消息 |
| S→C | `chat` / `notice` / `members` | 聊天/通知/成员列表 |

## 同步模型

```
服务端权威时钟 + 4Hz 心跳 + 客户端逐帧纠偏
```

1. **时钟同步** — ping/pong 每 2 秒采样，指数加权平滑，sync 心跳作为被动时钟源（4Hz）
2. **心跳驱动** — 服务端每 250ms 广播当前权威位置；新成员在 join 后立即收到 sync
3. **逐帧纠偏** — 每 350ms 检查实际位置与权威位置的偏差：
   - \|漂移\| > 0.5s → seek 到权威位置
   - 0.12s < \|漂移\| ≤ 0.5s → `playbackRate` 微调（最大 ±8%）
   - \|漂移\| ≤ 0.12s → 保持正常速率
4. **主持人操作低延迟** — 主持人点击播放时，额外发送 `playback` 事件附带 `executeAt` 时间戳，所有客户端在同一服务端时刻执行
5. **浏览器缓冲感知** — `readyState < 2` 时不纠偏，避免缓冲期间误 seek

### 同步精度

典型场景下各端播放位置偏差 ≤ 200ms（同区域 ≤ 80ms）。

## OpenList 文件浏览器

输入 OpenList 站点首页或任意文件夹地址，自动识别站点根目录和路径。支持：
- 面包屑导航
- 目录搜索（含子目录）
- 自动过滤非视频文件
- 智能文件名缩短
- 鉴权 Token 和文件密码

**流程：** 用户输入 OpenList 地址 → 服务端代理 `/api/fs/list` 获取目录 → 选中视频 → 服务端调用 `/api/fs/get` 获取直链 → 所有人同步播放

## 环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `PORT` | 4311 | HTTP + WebSocket 端口 |
| `HOST` | 0.0.0.0 | 监听地址 |

## 测试

```bash
npm run check          # 语法检查
npm run test:sync      # 5 客户端、4 地区同步测试
npm run test:openlist  # OpenList 搜索/解析测试（需联网）
npm run test:ui        # Playwright 端到端测试（需 Chrome）
```

测试默认连 `localhost:4311`，可用 `HTTP_URL` `SYNC_URL` `OPENLIST_URL` 覆盖。

## Docker

```bash
docker build -t afterglow .
docker run -d -p 4311:4311 afterglow
```

镜像采用两阶段构建，最终仅约 150MB，以非 root 用户运行。

## 部署建议

当前为单节点 MVP，所有房间状态在内存中。生产部署建议：

1. 在 Cloudflare / Fly.io / AWS Global Accelerator 后部署多个就近接入节点
2. 使用 Redis / NATS JetStream 持久化房间状态
3. 视频数据由 OpenList / CDN 直出，不经过同步服务器
