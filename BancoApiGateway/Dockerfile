FROM node:18-alpine
WORKDIR /usr/src/app/api-gateway

# Copia os arquivos de configuração de pacotes primeiro
COPY package.json ./

# Instala TODAS as dependências (incluindo as de desenvolvimento)
# Mantive a flag que você estava usando para evitar conflitos
RUN npm install --legacy-peer-deps --silent

# Copia o restante do código e dos protos
COPY . .

EXPOSE 3000

# O docker-compose vai sobrescrever este CMD, mas é bom deixar um fallback
CMD ["npm", "run", "start:dev"]
