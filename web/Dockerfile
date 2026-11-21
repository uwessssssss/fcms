# FCMS web -- built and run in containers (deploy/docker-compose.yml).
FROM node:20-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
# NEXT_PUBLIC_* is baked in at BUILD time (src/lib/api.ts): the address the
# browser calls. Behind deploy/'s proxy it is the site's own address.
ARG NEXT_PUBLIC_API_URL
ENV NEXT_PUBLIC_API_URL=${NEXT_PUBLIC_API_URL} \
    NEXT_TELEMETRY_DISABLED=1
RUN npx next build

FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1
COPY --from=build --chown=node:node /app ./
USER node
EXPOSE 3000
# next start, not "npm start": package.json's start script runs the dev server.
CMD ["npx", "next", "start", "-p", "3000"]
