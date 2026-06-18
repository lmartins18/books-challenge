# Node 24: ships the built-in `node:sqlite` module (no native build needed),
# so the image has no compiler toolchain and no native-addon fragility.
FROM node:24-alpine
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY . .
# SQLite file lives here; mount a volume at /data in production.
ENV DATA_DIR=/data
EXPOSE 3000
CMD ["node", "server.js"]
