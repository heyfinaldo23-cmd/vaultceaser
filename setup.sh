#!/bin/bash
# VaultCeaser self-hosted setup script
# Run this on your VPS after cloning the repo.
# Usage: bash setup.sh

set -e

REPO_DIR="$(cd "$(dirname "$0")" && pwd)"
DATA_DIR="$REPO_DIR/data"

echo "=== VaultCeaser Setup ==="
echo "Repo: $REPO_DIR"

# ── 1. Create data directory for SQLite ───────────────────────────────────────
mkdir -p "$DATA_DIR"
echo "[1/5] Created data/ directory at $DATA_DIR"

# ── 2. Python backend deps ────────────────────────────────────────────────────
echo "[2/5] Installing Python deps..."
pip3 install fastapi uvicorn httpx wreq-python structlog colorama --quiet
echo "      Python deps done."

# ── 3. Node.js frontend deps + build ─────────────────────────────────────────
echo "[3/5] Installing Node deps..."
cd "$REPO_DIR/web"
npm install --production=false --quiet

echo "[3/5] Building Next.js..."
# Set DATABASE_PATH so drizzle-kit knows where the db is
export DATABASE_PATH="$DATA_DIR/db.sqlite"
export BACKEND_URL="http://localhost:8080"
export SESSION_SECRET="${SESSION_SECRET:-$(openssl rand -hex 32)}"
npm run build
echo "      Next.js build done."

# ── 4. Init SQLite tables ─────────────────────────────────────────────────────
echo "[4/5] Initialising database tables..."
DATABASE_PATH="$DATA_DIR/db.sqlite" npx drizzle-kit push --config drizzle.config.ts
echo "      Database ready at $DATA_DIR/db.sqlite"

# ── 5. Create .env file ───────────────────────────────────────────────────────
ENV_FILE="$REPO_DIR/web/.env"
if [ ! -f "$ENV_FILE" ]; then
  SECRET=$(openssl rand -hex 32)
  cat > "$ENV_FILE" <<EOF
BACKEND_URL=http://localhost:8080
DATABASE_PATH=$DATA_DIR/db.sqlite
SESSION_SECRET=$SECRET
EOF
  echo "[5/5] Created $ENV_FILE (SESSION_SECRET auto-generated)"
else
  echo "[5/5] $ENV_FILE already exists, skipping."
fi

echo ""
echo "=== Setup complete ==="
echo ""
echo "Start the services:"
echo "  Backend:  cd $REPO_DIR && python3 server.py"
echo "  Frontend: cd $REPO_DIR/web && npm start"
echo ""
echo "Or use the start.sh script (also created)."

# ── Write start.sh ────────────────────────────────────────────────────────────
cat > "$REPO_DIR/start.sh" <<'STARTSCRIPT'
#!/bin/bash
REPO_DIR="$(cd "$(dirname "$0")" && pwd)"

# Load env
set -a
[ -f "$REPO_DIR/web/.env" ] && source "$REPO_DIR/web/.env"
set +a

export DATABASE_PATH="${DATABASE_PATH:-$REPO_DIR/data/db.sqlite}"
export BACKEND_URL="${BACKEND_URL:-http://localhost:8080}"

echo "Starting FastAPI backend on :8080..."
cd "$REPO_DIR"
python3 server.py &
BACKEND_PID=$!

echo "Starting Next.js frontend on :3456..."
cd "$REPO_DIR/web"
npm start &
FRONTEND_PID=$!

echo "Both services running."
echo "  Backend PID:  $BACKEND_PID"
echo "  Frontend PID: $FRONTEND_PID"
echo ""
echo "Visit: http://$(hostname -I | awk '{print $1}'):3456"
echo "Press Ctrl+C to stop both."

trap "kill $BACKEND_PID $FRONTEND_PID 2>/dev/null; exit" INT TERM
wait
STARTSCRIPT

chmod +x "$REPO_DIR/start.sh"
echo "Created start.sh"
