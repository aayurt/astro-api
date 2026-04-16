#!/bin/bash
set -e

SERVER="root@217.154.58.85"
REMOTE_PATH="/var/www/astro-api"
LOCAL_PATH="/Users/aayurtshrestha/projects/Astro/astro-backend"

# echo "🚀 Starting deploy..."
# rsync -avz $SERVER:/var/www/astro-api/gemini-ask-error.png $LOCAL_PATH/

# 2️⃣ SSH once to stop API, clean old DB (already synced if needed), and restart safely
ssh $SERVER "bash -c '
  source ~/.nvm/nvm.sh
  echo \"Git pull\"
  cd /var/www/astro-api 
  git pull origin
  pnpm run db:generate
  echo \"🛑 Removing old processes...\"
  pm2 restart ecosystem.config.cjs
  pm2 save
  echo \"🎉 Deploy complete!\"
'"