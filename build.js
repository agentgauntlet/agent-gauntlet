#!/usr/bin/env node
// Minify + obfuscate all client-side JS before serving.
// Pipeline: source → terser (minify + mangle) → javascript-obfuscator (encode strings,
// flatten control flow, rename identifiers) → public/*.min.js

const fs   = require('fs');
const path = require('path');

async function build() {
  // Lazy-require so missing devDeps give a clear error message.
  let terser, obfuscator;
  try {
    terser     = require('terser');
    obfuscator = require('javascript-obfuscator');
  } catch (e) {
    console.error('\nMissing build deps. Run:  npm install\n');
    process.exit(1);
  }

  const OBFUSCATOR_OPTIONS = {
    compact: true,
    // Control flow flattening — restructures if/else chains into switch-based state machines.
    controlFlowFlattening: true,
    controlFlowFlatteningThreshold: 0.4,
    // Dead code injection — inserts unreachable branches with real-looking logic.
    deadCodeInjection: true,
    deadCodeInjectionThreshold: 0.2,
    // Rename all identifiers to 0x-prefixed hex strings.
    identifierNamesGenerator: 'hexadecimal',
    renameGlobals: false,
    // String array — extract, encode, and rotate all string literals.
    rotateStringArray: true,
    shuffleStringArray: true,
    splitStrings: true,
    splitStringsChunkLength: 10,
    stringArray: true,
    stringArrayCallsTransform: true,
    stringArrayEncoding: ['base64'],
    stringArrayThreshold: 0.75,
    // Object key transformation — rename property keys.
    transformObjectKeys: true,
    unicodeEscapeSequence: false,
    // selfDefending deliberately off — it breaks strict-mode environments.
    selfDefending: false,
  };

  const FILES = [
    { src: 'cart-checkout/public/v2.js',     out: 'cart-checkout/public/v2.min.js' },
    { src: 'cart-checkout/public/app.js',    out: 'cart-checkout/public/app.min.js' },
    { src: 'payment-checkout/public/app.js', out: 'payment-checkout/public/app.min.js' },
    { src: 'bank-login/public/app.js',       out: 'bank-login/public/app.min.js' },
  ];

  const ROOT = __dirname;
  let ok = 0, skip = 0, fail = 0;

  for (const { src, out } of FILES) {
    const srcPath = path.join(ROOT, src);
    const outPath = path.join(ROOT, out);

    if (!fs.existsSync(srcPath)) {
      console.warn(`  skip   ${src}  (not found)`);
      skip++;
      continue;
    }

    try {
      const source = fs.readFileSync(srcPath, 'utf8');

      // Step 1 — terser: compress + mangle variable names.
      const { code: minified } = await terser.minify(source, {
        compress: { drop_console: false, passes: 2 },
        mangle: true,
      });

      // Step 2 — javascript-obfuscator: encode strings, flatten flow, rename.
      const result = obfuscator.obfuscate(minified, OBFUSCATOR_OPTIONS);
      const output = result.getObfuscatedCode();

      fs.writeFileSync(outPath, output, 'utf8');

      const srcKb = (source.length  / 1024).toFixed(1);
      const outKb = (output.length  / 1024).toFixed(1);
      console.log(`  built  ${src.padEnd(38)} ${srcKb.padStart(6)}KB → ${outKb}KB`);
      ok++;
    } catch (e) {
      console.error(`  ERROR  ${src}: ${e.message}`);
      fail++;
    }
  }

  console.log(`\n  ${ok} built  ${skip} skipped  ${fail} failed`);
  if (fail > 0) process.exit(1);
}

build();
