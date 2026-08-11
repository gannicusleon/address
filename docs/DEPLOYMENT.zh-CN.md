# Address 部署文档

[English](DEPLOYMENT.md) · [简体中文](DEPLOYMENT.zh-CN.md) · [繁體中文](DEPLOYMENT.zh-TW.md)

项目只维护一种生产部署方式：Docker Compose。应用、PostgreSQL、迁移和自动同步均由仓库根目录的 `docker-compose.yml` 管理。

## Docker Compose 快速部署

```bash
git clone https://github.com/daimon3332/address.git
cd address
sh ops/init-compose.sh
docker compose up -d
docker compose ps
curl -fsS http://127.0.0.1:8787/api/v1/ready
```

初始化脚本只创建相对目录和四个随机启动密钥，不会覆盖已有文件。首次管理员密码位于：

```bash
cat config/secrets/admin_bootstrap_password
```

登录 `/admin/` 后可修改前端密码、管理员密码、API 调用令牌、地图平台 Key、额度与其他业务设置。

## 运行要求

- Linux AMD64 或 ARM64
- Docker Engine 与 Docker Compose v2
- OpenSSL，用于首次生成随机启动密钥
- 4 GB 内存；执行大型国家首次同步建议 8 GB 或更多
- 足够容纳 PostgreSQL、地址数据、同步暂存和备份的磁盘空间
- HTTPS 反向代理

开发电脑无需安装 Docker。正式镜像由 GitHub Actions 构建并发布到 Docker Hub：`daimon23/address`。

## 目录结构

```text
address/
├── docker-compose.yml
├── config/address.env    # 可选的高级数据源适配器参数
├── config/secrets/       # 随机启动密钥，不进入 Git
├── data/address/         # 地址池与同步暂存
├── data/postgres/        # PostgreSQL 数据
├── runtime/              # 同步运行状态
├── backups/              # pg_dump 备份
└── logs/
```

所有挂载均为 Compose 文件所在目录的相对路径，不依赖 `/root/address` 或其他固定安装位置。不要让两个 PostgreSQL 容器同时挂载同一个 `data/postgres`。

## 可选部署配置

默认配置可以直接启动。只有需要修改镜像、端口或反向代理设置时才创建 `.env`：

```bash
cp ops/compose.env.example .env
```

```dotenv
ADDRESS_IMAGE=daimon23/address:latest
API_BIND_ADDRESS=127.0.0.1
API_PORT=8787
ALLOWED_ORIGIN=*
TRUST_PROXY=false
COOKIE_SECURE=false
SYNC_SCHEDULER_ENABLED=false
```

HTTPS 反向代理生产环境应设置准确的 `ALLOWED_ORIGIN`，并将 `TRUST_PROXY`、`COOKIE_SECURE` 改为 `true`。第三方 API Key 和常规业务参数统一在管理员后台管理。默认空白且被忽略的 `config/address.env` 只保留给同步进程启动前必须存在的授权 feed URL、字段映射和许可门禁。

## 服务与网络

- `postgres`：PostgreSQL 16，只连接内部网络
- `migrate`：每次启动前执行一次数据库迁移，成功后退出
- `api`：WebUI 与 API，默认只监听 `127.0.0.1:8787`
- `sync`：手动同步服务，只连接 Compose 私有网络

自动同步默认关闭，管理员后台和同步控制 API 可以手动触发指定国家。只有显式设置
`SYNC_SCHEDULER_ENABLED=true` 时，服务才会自动补跑未完成的初始化并启用每日调度队列。

## 常用命令

```bash
docker compose ps
docker compose logs -f api sync
docker compose restart api sync
docker compose down
docker compose up -d
```

升级镜像：

```bash
sh ops/backup.sh
docker compose pull
docker compose up -d
docker compose ps
```

## 备份与恢复

```bash
sh ops/backup.sh
sh ops/restore.sh ./backups/address-YYYYMMDDTHHMMSSZ.dump
```

备份包含地址表、控制表、加密后的凭据、同步状态和审计数据。`config/secrets/config_master_key` 必须与数据库备份一起安全保存，否则无法解密后台保存的凭据。跨 PostgreSQL 主版本必须使用 `pg_dump` 与 `pg_restore`，不能直接复用数据目录。

## Nginx 示例

```nginx
server {
    listen 80;
    server_name YOUR_DOMAIN.example;

    location / {
        proxy_pass http://127.0.0.1:8787;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

只公开 HTTP/HTTPS，禁止公开 PostgreSQL 和同步服务端口。

## Docker Hub 发布

`.github/workflows/docker-publish.yml` 在 `main` 更新、版本标签或手动触发时构建 AMD64/ARM64 镜像。GitHub 仓库只需配置 `DOCKERHUB_TOKEN`，内容为具有读写权限的 Docker Hub Access Token；公开用户名 `daimon23` 已固定在工作流中。

Token 只保存在 GitHub Actions Secrets，禁止写入仓库、Compose、截图或日志。
