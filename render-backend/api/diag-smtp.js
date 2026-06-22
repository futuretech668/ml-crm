// diag-smtp.js — Diagnóstico temporal: ¿qué puertos SMTP salientes permite Render?
// Prueba conectividad TCP cruda a smtp.gmail.com en varios puertos y reporta.
// (Se puede borrar una vez resuelto el tema del envío de correos.)
const net = require('net');

function testPort(port) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (r) => { if (settled) return; settled = true; try { s.destroy(); } catch (_) {} resolve(r); };
    const s = net.connect({ host: 'smtp.gmail.com', port: port, family: 4 });
    s.setTimeout(8000, () => done('timeout'));
    s.on('connect', () => done('OK'));
    s.on('error', (e) => done('error:' + (e && e.code ? e.code : 'unknown')));
  });
}

exports.handler = async () => {
  const out = {};
  for (const p of [465, 587, 25, 2525]) { out['port_' + p] = await testPort(p); }
  return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(out) };
};
