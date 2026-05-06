FROM node:22-alpine

RUN apk add --no-cache caddy supervisor openssl

WORKDIR /app

# Install root deps. --ignore-scripts skips the local-dev postinstall hook
# that recursively installs subdir deps (we do that explicitly below so we
# get proper Docker layer caching).
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts

# Install scenario + landing deps. Each scenario has its own package.json
# so deps stay isolated and Docker can cache the layer until any subdir
# package.json changes.
COPY landing/package.json          landing/package-lock.json          ./landing/
COPY cart-checkout/package.json    cart-checkout/package-lock.json    ./cart-checkout/
COPY payment-checkout/package.json payment-checkout/package-lock.json ./payment-checkout/
COPY bank-login/package.json       bank-login/package-lock.json       ./bank-login/
COPY product-search/package.json   product-search/package-lock.json   ./product-search/
COPY auction/package.json          auction/package-lock.json          ./auction/
COPY crypto-exchange/package.json  crypto-exchange/package-lock.json  ./crypto-exchange/
COPY image-captcha/package.json    image-captcha/package-lock.json    ./image-captcha/
RUN npm ci --prefix landing          \
 && npm ci --prefix cart-checkout    \
 && npm ci --prefix payment-checkout \
 && npm ci --prefix bank-login       \
 && npm ci --prefix product-search   \
 && npm ci --prefix auction          \
 && npm ci --prefix crypto-exchange  \
 && npm ci --prefix image-captcha

# Copy source (after deps so layer cache survives code-only changes)
COPY . .

# Minify + obfuscate client JS
RUN npm run build

EXPOSE 8080

CMD ["supervisord", "-c", "/app/supervisord.conf", "-n"]
