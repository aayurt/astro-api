#!/bin/bash
set -e

SERVER="root@217.154.58.85"
REMOTE_PATH="/var/www/astro-api"

echo "🚀 Starting deploy..."

# 2️⃣ SSH once to stop API, clean old DB (already synced if needed), and restart safely
ssh $SERVER "bash -c '
  source ~/.nvm/nvm.sh
  echo \"Git pull\"
  cd /var/www/astro-api 
  git pull origin
  echo \"🛑 Removing old processes...\"
  pm2 delete ecosystem.config.cjs || true
  echo \"✅ Starting astro-api...\"
  pm2 start ecosystem.config.cjs
  pm2 save
  echo \"🎉 Deploy complete!\"
'"