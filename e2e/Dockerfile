# Self-contained e2e image: package + fixture app + e2e runner.
# Build context is the package ROOT (see e2e/docker-compose.yaml).
FROM node:22-alpine

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json tsconfig.build.json jest.config.json jest.config.e2e.json ./
COPY src ./src
COPY bin ./bin
COPY test ./test
COPY e2e ./e2e

RUN npm run build && npm run build:e2e

# Main app port. The debug child (port+1) and the inspector (9339) stay on
# loopback inside the container — all debugger traffic tunnels through 4123,
# which is exactly what the package exists for.
EXPOSE 4123

# Production convention: keep stack traces mapped to the TypeScript sources
# (builds use inlineSourceMap+inlineSources). The debug child inherits this
# through process.env, so fault logs inside the child also show .ts frames.
ENV NODE_OPTIONS=--enable-source-maps

CMD ["node", "e2e/dist/main.js"]
