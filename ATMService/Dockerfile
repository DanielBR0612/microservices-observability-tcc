FROM node:18-alpine

WORKDIR /app

COPY package*.json ./
COPY tsconfig.json ./

RUN npm install
RUN npm install -g ts-node-dev typescript

COPY . .

CMD ["npm", "start"]
