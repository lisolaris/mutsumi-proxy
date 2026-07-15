# mutsumi-proxy

基于 Cloudflare Workers 的多功能代理与工具服务。

![](https://s3.sorali.org/image/mutsumi.jpg)

## 功能

### Docker Registry 代理

代理主流容器镜像仓库：

- Docker Hub（`/docker`）
- Quay.io（`/quay`）
- GCR / GHCR / K8s Registry（`/gcr`, `/ghcr`, `/k8s` 等）

自动处理认证、Token 签发以及 Docker Hub 的 blob 重定向。

### 通用 CORS 代理

通过 `/cors/<target-url>` 转发请求并补全 CORS 响应头，支持预检（OPTIONS）请求。

### DDNS 动态 DNS

`GET/POST /ddns/update/<subdomain>` — 更新 Cloudflare DNS 记录：

- Bearer Token 认证，支持按 Token 粒度的子域名权限控制
- 自动从请求头解析客户端 IP（支持 `?ip=` 显式指定）
- IP 未变时自动跳过更新，减少 API 调用
- 支持 Cloudflare KV 持久化 IP 状态（可选）
- 按子域名互斥锁，避免并发更新冲突

### 工具端点

| 路径 | 说明 |
|------|------|
| `/` | 首页图片 |
| `/echo` | 返回请求调试信息（IP、Headers、Cloudflare Geo） |
| `/uuid?n=<count>` | 生成 UUID（最多 100 个） |
| `/status/<code>` | 返回指定 HTTP 状态码 |
| `/generate_204` | 返回 204 No Content |
| `/dummy` | 返回 200 空响应 |
| `/teapot` | 返回 418 I'm a teapot |

## 部署

1. 复制 `wrangler.toml.example` 为 `wrangler.toml` 并填入配置
2. 设置 secret：`npx wrangler secret put CF_API_TOKEN`（DDNS 需要）
3. 设置 DDNS 配置：`npx wrangler secret put DDNS_CONFIG`
4. （可选）创建 KV 命名空间用于 DDNS IP 缓存：`npx wrangler kv namespace create DDNS_STATE`
5. 部署：`npx wrangler deploy`

## 使用示例

```bash
# Docker 镜像代理
docker pull <workers.domain>/docker/library/nginx:latest

# DDNS 更新
curl -H "Authorization: Bearer <token>" \
  "https://<workers.domain>/ddns/update/my-subdomain"
```

## 致谢

Docker 代理部分代码源自 [cloudflare-docker-proxy](https://github.com/ciiiii/cloudflare-docker-proxy)。所有权利归于原作者。
