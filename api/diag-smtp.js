// api/diag-smtp.js — Diagnóstico temporal (función de Vercel).
// Prueba si Vercel deja salir conexiones SMTP hacia Gmail. Se borra luego.
const net = require('net');

function testPort(port) {
  return new Promise((resolve) => {
    let settled = false;
    const s = net.connect({ host: 'smtp.gmail.com', port: port, family: 4 });
    const done = (r) => { if (settled) return; settled = true; try { s.destroy(); } catch (_) {} resolve(r); };
    s.setTimeout(8000, () => done('timeout'));
    s.on('connect', () => done('OK'));
    s.on('error', (e) => done('error:' + (e && e.code ? e.code : 'unknown')));
  });
}

module.exports = async (req, res) => {
  const out = {};
  for (const p of [465, 587, 25, 2525]) { out['port_' + p] = await testPort(p); }
  res.setHeader('Content-Type', 'application/json');
  res.status(200).send(JSON.stringify(out));
};
