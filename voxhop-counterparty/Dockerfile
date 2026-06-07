FROM node:20-alpine

WORKDIR /app

# M-05: Zero production node_modules — copy only the single stub file
COPY index.js .
COPY package.json .

EXPOSE 3001

CMD ["node", "index.js"]
