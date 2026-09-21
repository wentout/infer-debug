# Self-contained example image: built infer-debug package + the Fastify app.
# Build context is the package ROOT (see examples/docker-compose.yaml).
FROM node:22-alpine

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
COPY bin ./bin
RUN npm run build

COPY examples/fastify ./examples/fastify

# Only the main app port is published. The debug child (port+1) and the Node
# inspector (9229) stay on loopback inside the container — all debugger
# traffic tunnels through 3002, which is exactly what the package exists for.
EXPOSE 3002
ENV INFER_DEBUG=true APP_PORT=3002

CMD ["node", "examples/fastify/server.js"]
