# SiteMate web app (Next.js). Build from frontend/:  docker build -t sitemate-web frontend
FROM node:22-alpine AS deps
WORKDIR /web
COPY package.json package-lock.json ./
RUN npm ci

FROM node:22-alpine AS build
WORKDIR /web
COPY --from=deps /web/node_modules node_modules
COPY . .
# Live API mode is baked into the client bundle at build time.
ARG NEXT_PUBLIC_USE_FIXTURES=false
ARG NEXT_PUBLIC_PROJECT_ID=RIV
ENV NEXT_PUBLIC_USE_FIXTURES=$NEXT_PUBLIC_USE_FIXTURES NEXT_PUBLIC_PROJECT_ID=$NEXT_PUBLIC_PROJECT_ID NEXT_TELEMETRY_DISABLED=1
RUN npm run build

FROM node:22-alpine
WORKDIR /web
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1
COPY --from=build /web/package.json /web/package-lock.json ./
COPY --from=build /web/node_modules node_modules
COPY --from=build /web/.next .next
USER node
EXPOSE 3000
CMD ["npx", "next", "start", "-H", "0.0.0.0", "-p", "3000"]
