# ------------------------------------------------
# Stage 1: Build the TypeScript application

FROM node:22 AS builder

WORKDIR /app

COPY package*.json ./

RUN npm install

COPY . .

RUN npx tsc

# ------------------------------------------------
# Stage 2: Create the final image

FROM node:22

WORKDIR /app

COPY --from=builder /app/dist ./dist
COPY --from=builder /app/package*.json ./

RUN npm install --only=production && npm cache clean --force

WORKDIR /app/dist

RUN addgroup --system appgroup && adduser --system --ingroup appgroup appuser
USER appuser

EXPOSE 3301

CMD ["node", "index.js"]
