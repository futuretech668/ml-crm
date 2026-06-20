// ============================================================================
// run-emails.js  —  Lanzador para Render (Cron Job).
// Ejecuta UNA vez el envío de correos (bienvenida, ventas, stock, reportes) y termina.
// Render lo corre con el comando:  node run-emails.js
// ============================================================================

const { handler } = require('./ml-emails.js');

(async () => {
  try {
    const r = await handler({});
    console.log(r && r.body ? r.body : 'emails sin salida');
    process.exit(r && r.statusCode >= 400 ? 1 : 0);
  } catch (e) {
    console.error('run-emails error:', e && e.message ? e.message : e);
    process.exit(1);
  }
})();
