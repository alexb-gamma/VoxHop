FROM node:20-slim
WORKDIR /app

# Copy pre-built artefacts from the AMI (dist/ + pruned node_modules)
COPY package*.json ./
COPY dist/ ./dist/
COPY node_modules/ ./node_modules/

EXPOSE 3000
ENV NODE_ENV=production

CMD ["node", "dist/index.js"]
