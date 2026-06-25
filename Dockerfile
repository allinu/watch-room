FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && rm -rf ~/.npm

FROM node:22-alpine
WORKDIR /app
RUN addgroup -S afterglow && adduser -S afterglow -G afterglow
COPY --from=build /app/node_modules ./node_modules
COPY server.mjs ./
COPY public ./public
EXPOSE 4311
USER afterglow
ENV PORT=4311 HOST=0.0.0.0
CMD ["node", "server.mjs"]
