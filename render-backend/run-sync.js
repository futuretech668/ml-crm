// ============================================================================
// run-sync.js  —  Lanzador para Render (Cron Job).
// Ejecuta UNA vez la sincronización de ventas de Mercado Libre y termina.
// Render lo corre con el comando:  node run-sync.js
// ============================================================================

const { handler } = require('./ml-sync.js');

(async () => {
  try {
    const r = await handler({});
    console.log(r && r.body ? r.body : 'sync sin salida');
    process.exit(r && r.statusCode >= 400 ? 1 : 0);
  } catch (e) {
    console.error('run-sync error:', e && e.message ? e.message : e);
    process.exit(1);
  }
})();
