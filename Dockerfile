FROM node:24-bookworm-slim

ENV NODE_ENV=production HOST=0.0.0.0 PORT=3000 DATA_DIR=/app/data
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund \
    && install -d -o node -g node /app/data

COPY server.js accounts.js push.js service-worker.js manifest.webmanifest ./
COPY mainpage.html style.css script.js student-themes.css student-polls.css student-interface.js ./
COPY admin.html admin.css admin.js ./
COPY images/ ./images/
COPY videos/ ./videos/

USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+process.env.PORT+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
CMD ["node", "server.js"]
