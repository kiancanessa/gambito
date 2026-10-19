# Gambito: servidor Node (estáticos + API + WebSocket) en una sola imagen.
FROM node:24-slim

ENV NODE_ENV=production \
    DATA_DIR=/data

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY server ./server
COPY public ./public

# La base de datos SQLite vive en /data: monta ahí un volumen persistente.
# No se usa `USER node` a propósito: los discos/volúmenes de Render y Fly se montan como root y un usuario
# sin privilegios no podría escribir la base de datos. El contenedor ya aísla el proceso.
RUN mkdir -p /data
VOLUME /data

# El host (Render, Fly...) inyecta PORT; en local la imagen escucha en 8080.
ENV PORT=8080
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD node -e "fetch('http://localhost:'+process.env.PORT+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server/index.js"]
