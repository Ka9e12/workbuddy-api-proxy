# Nginx 负载均衡集群配置

使用 `ecosystem.cluster.config.cjs` 启动多个 worker 后，通过 Nginx 反向代理做负载均衡，将外部请求分发到各 worker。

## 架构说明

```
客户端 → Cloudflare CDN → Nginx(:80/:443 SSL) → Worker1(:3081)
                                           ──→ Worker2(:3082)
                                           ──→ Worker3(:3083)
                                           ──→ Worker4(:3084)
```

- **Nginx** 监听 80/443，处理 TLS 终结（Cloudflare Origin 证书）
- **4 个 Worker** 各自监听独立端口（3081~3084），仅绑定 127.0.0.1
- **Cloudflare** 做前端 CDN + DDoS 防护，开启 Authenticated Origin Pulls 验证回源

## 完整 Nginx 配置

配置文件路径：`/etc/nginx/conf.d/default.conf`

```nginx
# ============================================
# 默认 server — 拦截所有 IP 直接访问和非法 Host
# ============================================
server {
    listen 80 default_server;
    listen 443 ssl default_server;

    # 自签证书，仅用于满足 TLS 握手
    ssl_certificate     /etc/nginx/ssl/default.pem;
    ssl_certificate_key /etc/nginx/ssl/default.key;

    # 直接断开连接（Nginx 特有，不返回任何内容）
    return 444;
}

# ============================================
# WorkBuddy API Proxy 负载均衡上游
# ============================================
upstream claude_proxy {
    # 轮询（默认），加权可加 weight=N
    server 127.0.0.1:3081;
    server 127.0.0.1:3082;
    server 127.0.0.1:3083;
    server 127.0.0.1:3084;

    # 保持长连接，减少上游 TCP 握手开销
    keepalive 64;
}

# ============================================
# WebSocket Upgrade 映射
# 有 Upgrade 头时透传（WS 握手），无 Upgrade 时清空（HTTP keepalive）
# ============================================
map $http_upgrade $connection_upgrade {
    default upgrade;
    ''      "";
}

# ============================================
# 你的域名 — 反向代理到集群
# ============================================
server {
    listen 80;
    listen 443 ssl;
    server_name your-domain.example.com;  # 替换为你的域名

    # --- SSL 配置（Cloudflare Origin 证书）---
    ssl_certificate     /etc/nginx/ssl/cloudflare-origin.pem;
    ssl_certificate_key /etc/nginx/ssl/cloudflare-origin-key.pem;

    # Cloudflare Authenticated Origin Pulls 验证
    ssl_client_certificate /etc/nginx/ssl/cloudflare-origin-pull-ca.pem;
    ssl_verify_client on;
    ssl_verify_depth 2;

    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_ciphers ECDHE-ECDSA-AES128-GCM-SHA256:ECDHE-RSA-AES128-GCM-SHA256:ECDHE-ECDSA-AES256-GCM-SHA384:ECDHE-RSA-AES256-GCM-SHA384;
    ssl_prefer_server_ciphers on;
    ssl_session_cache shared:SSL:10m;
    ssl_session_timeout 10m;

    # --- 安全头 ---
    add_header X-Frame-Options "SAMEORIGIN" always;
    add_header X-Content-Type-Options "nosniff" always;
    add_header X-XSS-Protection "1; mode=block" always;
    add_header Referrer-Policy "strict-origin-when-cross-origin" always;

    # --- 日志 ---
    access_log /var/log/nginx/your-domain.access.log;
    error_log  /var/log/nginx/your-domain.error.log;

    # --- 反向代理 ---
    location / {
        proxy_pass http://claude_proxy;
        proxy_http_version 1.1;

        # WebSocket / HTTP keepalive 自适应
        # 普通请求：Connection 清空，Nginx 复用到上游的 keepalive 长连接
        # WS 请求：  Upgrade + Connection: upgrade 透传，完成握手升级
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection $connection_upgrade;

        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # SSE / 流式响应支持
        proxy_buffering off;
        proxy_cache off;

        # 超时（适配 SSE 长连接）
        proxy_connect_timeout 60s;
        proxy_send_timeout 300s;
        proxy_read_timeout 300s;

        # 客户端请求体大小限制（适配大模型请求）
        client_max_body_size 10m;
    }

    # 内部通信端点禁止外部访问
    location /internal/ {
        return 403;
    }
}
```

## 负载均衡策略选择

| 策略 | 配置 | 适用场景 |
|------|------|---------|
| `least_conn` | `least_conn;` | 长连接/SSE流式场景（**推荐**） |
| `ip_hash` | `ip_hash;` | 需要会话亲和性（同一客户端始终路由到同一 worker） |
| header 哈希 | `hash $http_x_conversation_id consistent;` | 按会话键（而非客户端 IP）做一致性哈希；适合**多客户端共用同一出口 IP** 时仍要会话粘性 |
| 轮询（默认） | 无需配置 | 无状态短请求场景 |

> **会话粘性与集群**：CodeBuddy 的会话粘性绑定是每 worker 独立的内存态。若用默认轮询，同一会话的请求会轮流落到不同 worker，跨 worker 命中率约 `1/worker数`。需要完整粘性时，用上表的 `hash $http_x_conversation_id consistent;`（客户端带 `x-conversation-id` 头时）或 `ip_hash`（同客户端同 IP 时）。`hash` 指令需放在 `upstream` 块内。

## 启动步骤

1. 启动集群：
```bash
pm2 start ecosystem.cluster.config.cjs
```

2. 验证各 worker 正常：
```bash
curl http://127.0.0.1:3081/
curl http://127.0.0.1:3082/
curl http://127.0.0.1:3083/
curl http://127.0.0.1:3084/
```

3. 启动 Nginx：
```bash
nginx -t && nginx -s reload
```

4. 通过域名访问验证：
```bash
curl https://your-domain.example.com/
```

## 注意事项

- **内部端点**：`/internal/*` 端点仅限 127.0.0.1 访问，Nginx 应阻止外部请求
- **WebSocket**：使用 `map` 指令自动判断 Upgrade 头，普通 HTTP 和 WS 请求在同一 location 中共存
- **SSE 流式**：必须关闭 `proxy_buffering` 否则流式响应会延迟
- **多进程同步**：`CLUSTER_PORTS` 环境变量已自动配置，worker 间通过内部 HTTP 广播同步状态
- **默认 server**：未匹配 Host 的请求直接 `return 444` 断开，防止 IP 直接访问泄露信息
- **Cloudflare Origin Pulls**：开启 `ssl_verify_client` 确保只有 Cloudflare 能回源，防止源站被直接访问
