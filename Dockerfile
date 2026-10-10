FROM node:20-alpine

WORKDIR /app

COPY src/server ./src/server
RUN npm install --omit=dev ws@8.22.0 && chown -R node:node /app

ENV PORT=8080
EXPOSE 8080

USER node
CMD ["node", "src/server/cli.js"]
