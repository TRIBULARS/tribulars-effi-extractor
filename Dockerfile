FROM mcr.microsoft.com/playwright:v1.49.0-noble

WORKDIR /app

# Instalar dependencias
COPY package.json ./
RUN npm install

# Copiar el resto del código
COPY . .

# Railway asigna el puerto por la variable PORT
ENV PORT=8080
EXPOSE 8080

CMD ["node", "server.js"]
