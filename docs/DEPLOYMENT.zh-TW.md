# Address 部署文件

[English](DEPLOYMENT.md) · [简体中文](DEPLOYMENT.zh-CN.md) · [繁體中文](DEPLOYMENT.zh-TW.md)

專案只維護一種生產部署方式：Docker Compose。根目錄的 `docker-compose.yml` 統一管理應用、PostgreSQL、遷移與自動同步。

## Docker Compose 快速部署

```bash
git clone https://github.com/daimon3332/address.git
cd address
sh ops/init-compose.sh
docker compose up -d
docker compose ps
curl -fsS http://127.0.0.1:8787/api/v1/ready
```

初始化腳本只建立相對目錄與四個隨機啟動密鑰，不會覆寫既有檔案。首次管理員密碼位於：

```bash
cat config/secrets/admin_bootstrap_password
```

登入 `/admin/` 後可修改前端密碼、管理員密碼、API 呼叫權杖、地圖平台 Key、額度與其他業務設定。

## 執行要求

- Linux AMD64 或 ARM64
- Docker Engine 與 Docker Compose v2
- OpenSSL，用於首次產生隨機啟動密鑰
- 4 GB 記憶體；執行大型國家首次同步建議 8 GB 或更多
- 足以容納 PostgreSQL、地址資料、同步暫存與備份的磁碟空間
- HTTPS 反向代理

開發電腦不需要安裝 Docker。正式映像由 GitHub Actions 建置並發佈到 Docker Hub：`daimon23/address`。

## 目錄結構

```text
address/
├── docker-compose.yml
├── config/address.env    # 選用的高級資料源適配器參數
├── config/secrets/       # 隨機啟動密鑰，不進入 Git
├── data/address/         # 地址池與同步暫存
├── data/postgres/        # PostgreSQL 資料
├── runtime/              # 同步執行狀態
├── backups/              # pg_dump 備份
└── logs/
```

所有掛載均為 Compose 檔案所在目錄的相對路徑，不依賴 `/root/address` 或其他固定安裝位置。不要讓兩個 PostgreSQL 容器同時掛載同一個 `data/postgres`。

## 選用部署設定

預設設定可直接啟動。只有需要修改映像、連接埠或反向代理設定時才建立 `.env`：

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

HTTPS 反向代理生產環境應設定準確的 `ALLOWED_ORIGIN`，並將 `TRUST_PROXY`、`COOKIE_SECURE` 改為 `true`。第三方 API Key 與一般業務參數統一在管理員後台管理。預設空白且被忽略的 `config/address.env` 只保留給同步程序啟動前必須存在的授權 feed URL、欄位映射與授權門禁。

## 服務與網路

- `postgres`：PostgreSQL 16，只連接內部網路
- `migrate`：每次啟動前執行一次資料庫遷移，成功後退出
- `api`：WebUI 與 API，預設只監聽 `127.0.0.1:8787`
- `sync`：手動同步服務，只連接 Compose 私有網路

自動同步預設關閉，管理員後台與同步控制 API 可以手動觸發指定國家。只有明確設定
`SYNC_SCHEDULER_ENABLED=true` 時，服務才會自動補跑未完成的初始化並啟用每日排程佇列。

## 常用命令

```bash
docker compose ps
docker compose logs -f api sync
docker compose restart api sync
docker compose down
docker compose up -d
```

升級映像：

```bash
sh ops/backup.sh
docker compose pull
docker compose up -d
docker compose ps
```

## 備份與還原

```bash
sh ops/backup.sh
sh ops/restore.sh ./backups/address-YYYYMMDDTHHMMSSZ.dump
```

備份包含地址表、控制表、加密後的憑據、同步狀態與稽核資料。`config/secrets/config_master_key` 必須與資料庫備份一起安全保存，否則無法解密後台保存的憑據。跨 PostgreSQL 主版本必須使用 `pg_dump` 與 `pg_restore`，不能直接重用資料目錄。

## Nginx 範例

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

只公開 HTTP/HTTPS，禁止公開 PostgreSQL 與同步服務連接埠。

## Docker Hub 發佈

`.github/workflows/docker-publish.yml` 在 `main` 更新、版本標籤或手動觸發時建置 AMD64/ARM64 映像。GitHub 儲存庫只需設定 `DOCKERHUB_TOKEN`，內容為具有讀寫權限的 Docker Hub Access Token；公開使用者名稱 `daimon23` 已固定在工作流程中。

Token 只保存在 GitHub Actions Secrets，禁止寫入儲存庫、Compose、截圖或日誌。
