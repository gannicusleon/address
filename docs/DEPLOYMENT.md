# Address Deployment

[English](DEPLOYMENT.md) · [简体中文](DEPLOYMENT.zh-CN.md) · [繁體中文](DEPLOYMENT.zh-TW.md)

The project maintains one production deployment path: Docker Compose. The root `docker-compose.yml` manages the application, PostgreSQL, migrations, and automatic synchronization.

## Docker Compose quick deployment

```bash
git clone https://github.com/daimon3332/address.git
cd address
sh ops/init-compose.sh
docker compose up -d
docker compose ps
curl -fsS http://127.0.0.1:8787/api/v1/ready
```

The initialization script creates only relative directories and four random bootstrap secrets. It never overwrites existing files. Read the initial administrator password with:

```bash
cat config/secrets/admin_bootstrap_password
```

After signing in to `/admin/`, manage the frontend password, administrator password, API token, provider keys, quotas, and business settings there.

## Requirements

- Linux AMD64 or ARM64
- Docker Engine and Docker Compose v2
- OpenSSL for one-time secret generation
- 4 GB RAM; 8 GB or more is recommended for large initial country imports
- Enough disk space for PostgreSQL, address data, synchronization staging, and backups
- An HTTPS reverse proxy

The development computer does not need Docker. GitHub Actions builds the production image and publishes it to Docker Hub as `daimon23/address`.

## Directory Layout

```text
address/
├── docker-compose.yml
├── config/address.env    # Optional advanced source-adapter settings
├── config/secrets/       # Random bootstrap secrets; excluded from Git
├── data/address/         # Address pool and synchronization staging
├── data/postgres/        # PostgreSQL data
├── runtime/              # Synchronization runtime state
├── backups/              # pg_dump backups
└── logs/
```

Every mount is relative to the Compose directory. No `/root/address` or other fixed installation path is required. Never attach one `data/postgres` directory to two PostgreSQL containers.

## Optional Deployment Settings

The defaults start without an `.env` file. Create one only to override the image, port, or reverse-proxy settings:

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

For production behind HTTPS, set an exact `ALLOWED_ORIGIN` and set `TRUST_PROXY` and `COOKIE_SECURE` to `true`. Manage provider API keys and ordinary business settings in the administrator console. The empty, ignored `config/address.env` is reserved for advanced licensed-feed URLs, field mappings, and license gates that must exist before the sync process starts.

## Services and Network

- `postgres`: PostgreSQL 16 on the internal network only
- `migrate`: runs database migrations once before application startup
- `api`: WebUI and API, bound to `127.0.0.1:8787` by default
- `sync`: manual synchronization on the private Compose network

Automatic synchronization is disabled by default. The administrator console and sync-control API can trigger selected countries manually. Set `SYNC_SCHEDULER_ENABLED=true` explicitly to resume incomplete initialization automatically and enable the daily scheduling queue.

## Operations

```bash
docker compose ps
docker compose logs -f api sync
docker compose restart api sync
docker compose down
docker compose up -d
```

Upgrade the image:

```bash
sh ops/backup.sh
docker compose pull
docker compose up -d
docker compose ps
```

## Backup and Restore

```bash
sh ops/backup.sh
sh ops/restore.sh ./backups/address-YYYYMMDDTHHMMSSZ.dump
```

A backup contains addresses, control data, encrypted credentials, synchronization state, and audit records. Securely retain `config/secrets/config_master_key` with the database backup or stored provider credentials cannot be decrypted. PostgreSQL major-version upgrades require `pg_dump` and `pg_restore`; do not reuse the data directory directly.

## Nginx Example

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

Expose only HTTP/HTTPS. Do not publish the PostgreSQL or synchronization service ports.

## Docker Hub Publishing

`.github/workflows/docker-publish.yml` builds AMD64/ARM64 images after updates to `main`, version tags, or manual dispatch. Configure the `DOCKERHUB_TOKEN` GitHub repository secret with a Docker Hub read/write access token. The public Docker Hub username is fixed to `daimon23` in the workflow.

Keep the token only in GitHub Actions Secrets. Never put it in the repository, Compose, screenshots, or logs.
