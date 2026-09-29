# A BARC node in one container. Mount a volume at /data to keep the database.
FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/server/package.json apps/server/
RUN npm ci --omit=dev --workspace apps/server --include-workspace-root=false
COPY packages/shared packages/shared
COPY apps/server apps/server
ENV PORT=8787 HOST=0.0.0.0 BARC_DB=/data/barc.db
VOLUME ["/data"]
EXPOSE 8787
CMD ["npm", "start", "--workspace", "apps/server"]
