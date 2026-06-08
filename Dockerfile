FROM mcr.microsoft.com/playwright:v1.44.0-jammy

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
