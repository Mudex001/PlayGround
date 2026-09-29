#!/usr/bin/env bash
set -euo pipefail
time -p cd "$(dirname "$0")"
/usr/bin/time -p pwd
: "${PORT:=3000}"
/usr/bin/time -p node --version
/usr/bin/time -p test -f public/index.html
/usr/bin/time -p test -f server.mjs
if /usr/bin/time -p test -f package.json; then
  if /usr/bin/time -p grep -q '"dependencies"' package.json; then
    /usr/bin/time -p npm install --no-audit --no-fund
  else
    /usr/bin/time -p echo "no dependencies to install"
  fi
fi
/usr/bin/time -p mkdir -p data public
/usr/bin/time -p node -e "const fs=require('fs');const path=require('path');const dir=process.env.OPENCODE_WEB_DIR||'/home/runner/work/_temp/omgithub-web';fs.mkdirSync(dir,{recursive:true});const out=path.join(dir,'deployment-output.json');const payload={project:'/home/runner/work/PlayGround/PlayGround',directory:require('path').resolve('public')};fs.writeFileSync(out,JSON.stringify(payload));console.log('wrote '+out+' -> '+JSON.stringify(payload));"
/usr/bin/time -p cat "${OPENCODE_WEB_DIR:-/home/runner/work/_temp/omgithub-web}/deployment-output.json"
export PORT
exec /usr/bin/time -p node server.mjs
