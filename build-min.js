// build-min.js — Genera la versión OFUSCADA del frontend para el público.
// Lee index.html (legible, copia de trabajo) y escribe _subir-a-netlify/index.html
// minificado + con variables locales ofuscadas. Reusar: `node build-min.js`
const { minify } = require('html-minifier-terser');
const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, 'index.html');
const OUT = path.join(__dirname, '_subir-a-netlify', 'index.html');

(async () => {
  const src = fs.readFileSync(SRC, 'utf8');
  const out = await minify(src, {
    collapseWhitespace: true,
    removeComments: true,
    removeAttributeQuotes: false,   // mantener comillas: más seguro
    minifyCSS: true,
    minifyJS: {
      compress: { drop_console: true, passes: 1 },
      mangle: { toplevel: false },  // NO renombrar funciones globales (las usan los onclick del HTML)
      format: { comments: false }
    }
  });
  fs.writeFileSync(OUT, out, 'utf8');
  const a = fs.statSync(SRC).size, b = fs.statSync(OUT).size;
  console.log('Legible (fuente): ' + a + ' bytes');
  console.log('Ofuscado (deploy): ' + b + ' bytes  (' + Math.round((1 - b / a) * 100) + '% más chico)');
})().catch(e => { console.error('ERROR DE BUILD:', e.message); process.exit(1); });
