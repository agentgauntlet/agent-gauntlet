// TLS Client Hello parser + JA3 fingerprint computation.
// Pure JS, no deps. Parses the bytes off the wire before Node's TLS layer
// touches them, so we can capture JA3 even though Node's `tls` module
// doesn't expose the full Client Hello.

const net = require('net');
const tls = require('tls');
const https = require('https');
const crypto = require('crypto');

// RFC 8701 GREASE values — browsers send these to test middleboxes.
// Most non-browser clients (curl, Python requests, Go net/http) don't.
const GREASE = new Set([
  0x0a0a, 0x1a1a, 0x2a2a, 0x3a3a, 0x4a4a, 0x5a5a, 0x6a6a, 0x7a7a,
  0x8a8a, 0x9a9a, 0xaaaa, 0xbaba, 0xcaca, 0xdada, 0xeaea, 0xfafa,
]);

function parseClientHello(buf) {
  if (buf.length < 5) return null;
  if (buf[0] !== 0x16) return null;                  // not TLS handshake
  const recordLen = buf.readUInt16BE(3);
  if (buf.length < 5 + recordLen) return null;       // incomplete

  let p = 5;
  if (buf[p] !== 0x01) return null;                  // not ClientHello
  // skip handshake-type (1) + handshake-length (3)
  p += 4;

  const version = buf.readUInt16BE(p);  p += 2;
  p += 32;                                           // random
  const sidLen = buf[p];                p += 1 + sidLen;
  const csLen  = buf.readUInt16BE(p);   p += 2;

  const ciphers = [];
  let hasGrease = false;
  for (let i = 0; i < csLen; i += 2) {
    const c = buf.readUInt16BE(p + i);
    if (GREASE.has(c)) hasGrease = true;
    else ciphers.push(c);
  }
  p += csLen;
  const cmLen = buf[p];                 p += 1 + cmLen;

  if (p + 2 > buf.length) {
    return { version, ciphers, extensions: [], curves: [], pointFormats: [], sni: null, alpn: [], hasGrease };
  }
  const extLen = buf.readUInt16BE(p);   p += 2;
  const extEnd = Math.min(p + extLen, buf.length);

  const extensions = [];
  let curves = [], pointFormats = [], sni = null, alpn = [];
  let hasSupportedVersions = false, hasSigAlgs = false;

  while (p + 4 <= extEnd) {
    const extType = buf.readUInt16BE(p);
    const extDataLen = buf.readUInt16BE(p + 2);
    p += 4;
    if (p + extDataLen > extEnd) break;

    if (GREASE.has(extType)) hasGrease = true;
    else extensions.push(extType);

    if (extType === 0x002b) hasSupportedVersions = true;
    if (extType === 0x000d) hasSigAlgs = true;

    if (extType === 0x000a && extDataLen >= 2) {
      // supported_groups (curves)
      const subLen = buf.readUInt16BE(p);
      for (let i = 0; i < subLen && p + 2 + i + 2 <= p + extDataLen; i += 2) {
        const g = buf.readUInt16BE(p + 2 + i);
        if (!GREASE.has(g)) curves.push(g);
      }
    } else if (extType === 0x000b && extDataLen >= 1) {
      // ec_point_formats
      const subLen = buf[p];
      for (let i = 0; i < subLen && p + 1 + i < p + extDataLen; i++) {
        pointFormats.push(buf[p + 1 + i]);
      }
    } else if (extType === 0x0000 && extDataLen >= 5) {
      // server_name (SNI)
      // SNI list: list_len(2) entry_type(1) name_len(2) name(name_len)
      const nameType = buf[p + 2];
      if (nameType === 0) {
        const nameLen = buf.readUInt16BE(p + 3);
        if (p + 5 + nameLen <= p + extDataLen) {
          sni = buf.slice(p + 5, p + 5 + nameLen).toString('utf8');
        }
      }
    } else if (extType === 0x0010 && extDataLen >= 2) {
      // ALPN
      const alpnListLen = buf.readUInt16BE(p);
      let q = p + 2;
      const qEnd = p + 2 + alpnListLen;
      while (q < qEnd && q < p + extDataLen) {
        const protoLen = buf[q];
        if (q + 1 + protoLen > p + extDataLen) break;
        alpn.push(buf.slice(q + 1, q + 1 + protoLen).toString('utf8'));
        q += 1 + protoLen;
      }
    }
    p += extDataLen;
  }

  return {
    version, ciphers, extensions, curves, pointFormats,
    sni, alpn, hasGrease, hasSupportedVersions, hasSigAlgs,
  };
}

function ja3String(p) {
  return [
    p.version,
    p.ciphers.join('-'),
    p.extensions.join('-'),
    p.curves.join('-'),
    p.pointFormats.join('-'),
  ].join(',');
}

function ja3Hash(s) {
  return crypto.createHash('md5').update(s).digest('hex');
}

function scoreTls(fp) {
  // Heuristics that catch curl / requests / go-http / okhttp without
  // needing a JA3 hash database.
  const flags = { hard: [], soft: [] };
  if (!fp) {
    flags.soft.push('no_tls_fingerprint');
    return flags;
  }
  if (fp.ciphers.length === 0) flags.hard.push('zero_ciphers');
  if (fp.ciphers.length < 10) flags.soft.push('few_ciphers');
  if (!fp.sni) flags.soft.push('no_sni');
  if (!fp.alpn || fp.alpn.length === 0) flags.soft.push('no_alpn');
  // h2 missing on a port that should serve HTTPS to a browser is suspicious
  if (fp.alpn && fp.alpn.length > 0 && !fp.alpn.includes('h2') && !fp.alpn.includes('http/1.1')) {
    flags.soft.push('unusual_alpn');
  }
  if (!fp.hasGrease) flags.soft.push('no_grease');
  if (!fp.hasSupportedVersions) flags.soft.push('no_supported_versions');
  if (!fp.hasSigAlgs) flags.soft.push('no_signature_algorithms');
  return flags;
}

// Wraps a normal https.Server with a Client Hello-peeking TCP front-end.
// Stores the JA3 fingerprint in `store`, keyed by `${host}:${port}` of
// the remote socket. Express middleware reads it back via the same key.
//
// We use paused-mode `read()` (not 'data' events) so the socket never
// enters flowing mode — that way `unshift()` cleanly puts the buffered
// Client Hello back, and the downstream https.Server's TLS handshake
// reads it normally as if nothing happened.
function createCapturingServer(httpsOptions, store, requestListener) {
  const httpsServer = https.createServer(httpsOptions, requestListener);
  httpsServer.on('clientError', () => { /* swallow handshake noise */ });

  const front = net.createServer((socket) => {
    socket.setNoDelay(true);
    const key = `${socket.remoteAddress}:${socket.remotePort}`;
    let buffered = Buffer.alloc(0);
    let done = false;

    function onReadable() {
      if (done) return;
      let chunk;
      while ((chunk = socket.read()) !== null) {
        buffered = Buffer.concat([buffered, chunk]);
      }
      if (buffered.length === 0) return;

      const parsed = parseClientHello(buffered);
      if (parsed) {
        done = true;
        try {
          const ja3 = ja3String(parsed);
          const hash = ja3Hash(ja3);
          store.set(key, { ja3, hash, ...parsed, capturedAt: Date.now() });
        } catch (e) { /* ignore — we still want to forward */ }

        socket.removeListener('readable', onReadable);
        // Put the bytes back so Node's TLS layer reads them normally.
        socket.unshift(buffered);
        // Hand the connection to the internal HTTPS server.
        httpsServer.emit('connection', socket);
      } else if (buffered.length > 16 * 1024) {
        done = true;
        socket.destroy();
      }
    }

    socket.on('readable', onReadable);
    socket.on('error', () => store.delete(key));
    socket.on('close', () => setTimeout(() => store.delete(key), 60_000));
  });

  return front;
}

module.exports = {
  parseClientHello,
  ja3String,
  ja3Hash,
  scoreTls,
  createCapturingServer,
};
