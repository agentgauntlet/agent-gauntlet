require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const express = require('express');
const http    = require('http');
const path    = require('path');

const app  = express();
const PORT = process.env.PORT || 3080;

// In production Caddy handles routing; locally we proxy the same paths to cart (:3000).
const CART_PORT = process.env.CART_PORT || 3000;

function proxyTo(port, req, res) {
  const options = {
    hostname: '127.0.0.1',
    port,
    path:     req.url,
    method:   req.method,
    headers:  { ...req.headers, host: `127.0.0.1:${port}` },
  };
  const proxy = http.request(options, (upstream) => {
    res.writeHead(upstream.statusCode, upstream.headers);
    upstream.pipe(res);
  });
  proxy.on('error', () => res.status(502).json({ ok: false, reason: 'upstream_unavailable' }));
  req.pipe(proxy);
}

// Routes served by the cart scenario server — mirror Caddy's rules.
app.all('/leaderboard*',    (req, res) => proxyTo(CART_PORT, req, res));
app.all('/api/leaderboard*',(req, res) => proxyTo(CART_PORT, req, res));
app.all('/api/keys/*',      (req, res) => proxyTo(CART_PORT, req, res));
app.all('/api/risk-weights',(req, res) => proxyTo(CART_PORT, req, res));
app.all('/auth/*',          (req, res) => proxyTo(CART_PORT, req, res));
app.all('/shared/*',        (req, res) => proxyTo(CART_PORT, req, res));
app.all('/api/detect/*',    (req, res) => proxyTo(CART_PORT, req, res));
app.all('/api/enterprise/*',(req, res) => proxyTo(CART_PORT, req, res));
// Hackathon events — mounted on cart-checkout when ENABLE_EVENTS=true.
app.all('/api/events/*',    (req, res) => proxyTo(CART_PORT, req, res));
app.all('/event/*',         (req, res) => proxyTo(CART_PORT, req, res));
app.all('/api/search/*',   (req, res) => proxyTo(process.env.SEARCH_PORT  || 3003, req, res));
app.all('/api/auction/*', (req, res) => proxyTo(process.env.AUCTION_PORT || 3004, req, res));
app.all('/api/crypto/*',  (req, res) => proxyTo(process.env.CRYPTO_PORT  || 3005, req, res));
app.all('/api/captcha/*',(req, res) => proxyTo(process.env.CAPTCHA_PORT || 3006, req, res));

app.use(express.static(path.join(__dirname, 'public')));

app.listen(PORT, () => console.log(`[landing] http://localhost:${PORT}`));
