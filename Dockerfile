FROM node:22-alpine

RUN apk add --no-cache caddy supervisor openssl

WORKDIR /app

# Install root deps (express, concurrently, build tools)
COPY package.json package-lock.json ./
RUN npm ci

# Install scenario deps
COPY cart-checkout/package.json cart-checkout/package-lock.json ./cart-checkout/
COPY payment-checkout/package.json payment-checkout/package-lock.json ./payment-checkout/
COPY bank-login/package.json bank-login/package-lock.json ./bank-login/
RUN npm ci --prefix cart-checkout \
 && npm ci --prefix payment-checkout \
 && npm ci --prefix bank-login

# Copy source (after deps so layer cache survives code-only changes)
COPY . .

# Minify + obfuscate client JS
RUN npm run build

EXPOSE 8080

CMD ["supervisord", "-c", "/app/supervisord.conf", "-n"]
