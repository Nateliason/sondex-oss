FROM node:20-alpine

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install --omit=dev

COPY src ./src
COPY migrations ./migrations
COPY README.md ./README.md
COPY LICENSE ./LICENSE

EXPOSE 3200

ENV PORT=3200
CMD ["node", "src/cli.js", "start"]
