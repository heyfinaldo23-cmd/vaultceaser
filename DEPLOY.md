# Deployment Guide — VaultCeaser (Self-Hosted)

## Architecture

```
User → nginx :80 → Next.js :3456 → FastAPI :8080
                                  ↓
                             data/db.sqlite  (~KB, grows slowly)
```

Everything runs on the same VPS. No external services needed.

**Disk usage estimate:**
- Python deps (already installed): ~0 new MB
- Node.js + node_modules: ~350 MB
- Next.js .next build: ~80 MB
- SQLite database: starts at 8 KB
- **Total new: ~430 MB** — well within your 3 GB free.

---

## One-Time Setup

```bash
# 1. Clone / pull the repo
cd ~
git clone https://github.com/heyfinaldo23-cmd/vaultceaser.git
cd vaultceaser

# 2. Run setup (installs deps, builds Next.js, creates SQLite tables)
bash setup.sh
```

That's it. Setup creates:
- `data/db.sqlite` — the database
- `web/.env` — auto-generated env file with a random SESSION_SECRET

---

## Start Everything

```bash
bash start.sh
```

This starts both services and keeps them running. Ctrl+C stops both.

For production (survives reboots), use systemd or pm2:

### Option A — pm2 (easier)
```bash
npm install -g pm2

pm2 start "python3 server.py" --name vaultceaser-api --cwd ~/vaultceaser
pm2 start "npm start"         --name vaultceaser-web --cwd ~/vaultceaser/web

pm2 save
pm2 startup   # follow the printed command to enable on boot
```

### Option B — systemd
Create `/etc/systemd/system/vc-api.service`:
```ini
[Unit]
Description=VaultCeaser FastAPI
After=network.target

[Service]
WorkingDirectory=/root/vaultceaser
ExecStart=python3 server.py
Restart=always

[Install]
WantedBy=multi-user.target
```

Create `/etc/systemd/system/vc-web.service`:
```ini
[Unit]
Description=VaultCeaser Next.js
After=vc-api.service

[Service]
WorkingDirectory=/root/vaultceaser/web
EnvironmentFile=/root/vaultceaser/web/.env
ExecStart=npm start
Restart=always

[Install]
WantedBy=multi-user.target
```

```bash
systemctl enable vc-api vc-web
systemctl start  vc-api vc-web
```

---

## nginx (optional, clean port 80)

```bash
# install nginx if not already
apt install nginx -y

# copy the config
cp ~/vaultceaser/nginx.conf /etc/nginx/sites-available/vaultceaser
ln -s /etc/nginx/sites-available/vaultceaser /etc/nginx/sites-enabled/
rm -f /etc/nginx/sites-enabled/default

nginx -t && systemctl reload nginx
```

Access the site at `http://37.114.37.107` (port 80).

Without nginx the site is at `http://37.114.37.107:3456`.

---

## Updating

```bash
cd ~/vaultceaser
git pull
cd web && npm install && npm run build
# restart services
pm2 restart all   # if using pm2
# or: systemctl restart vc-api vc-web
```

---

## Environment Variables (web/.env)

| Variable | Default | Notes |
|----------|---------|-------|
| `BACKEND_URL` | `http://localhost:8080` | FastAPI URL |
| `DATABASE_PATH` | `../data/db.sqlite` | SQLite file path |
| `SESSION_SECRET` | auto-generated | Min 32 chars, keep secret |

---

## Sanity checks

```bash
curl http://localhost:8080/health          # {"status":"ok"}
curl http://localhost:3456/api/health      # proxied through Next.js rewrites
curl "http://localhost:3456/api/search?q=naruto"
```
