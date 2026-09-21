# Self-contained example image: built infer-debug package + the NestJS app.
# Build context is the package ROOT (see examples/docker-compose.yaml).
FROM node:22-alpine

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
COPY bin ./bin
RUN npm run build

COPY examples/nestjs ./examples/nestjs
RUN npx tsc -p examples/nestjs/tsconfig.json

# Only the main app port is published. The debug child (port+1) and the Node
# inspector (9229) stay on loopback inside the container — all debugger
# traffic tunnels through 3003, which is exactly what the package exists for.
EXPOSE 3003
ENV INFER_DEBUG=true APP_PORT=3003

# Production convention: keep stack traces mapped to the TypeScript sources
# (the example build uses inlineSourceMap+inlineSources, inherited by the
# debug child through process.env).
ENV NODE_OPTIONS=--enable-source-maps

CMD ["node", "examples/nestjs/dist/main.js"]
