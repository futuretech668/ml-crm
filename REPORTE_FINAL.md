# REPORTE FINAL — Mejora multi-agente de NexSell (ml-crm)

**Fecha:** 2026-06-24
**Alcance:** completitud y robustez de MIA, flujo de ventas ML pendientes, concurrencia de escritura, reescritura de la guía, QA.
**Resultado de tests:** `cd render-backend && npm test` → **106 pass / 0 fail / 1 skipped** (el skip es el live-smoke gated en `OPENROUTER_API_KEY`, correcto que no corra sin red).

---

## Resumen ejecutivo

Se ejecutó la mejora en 3 olas de agentes en paralelo + consolidación. Se aplicaron 7 commits incrementales (ninguno pusheado todavía). No se borró ningún dato del usuario; todos los cambios son aditivos, reversibles y compatibles hacia atrás. El hallazgo más grave —doble registro de ventas de ML por divergencia frontend↔backend— fue detectado en QA y corregido.

### Commits aplicados (rama `main`, sin push)

| Commit | Agente | Contenido |
|---|---|---|
| `4a02329` | A+D | Completitud de MIA + control total de parámetros |
| `8d51ffa` | C | Reescritura completa `GUIA_DE_USO_v2.md` |
| `abbb0b7` | F | Eliminación de race conditions de escritura |
| `89641b5` | B | Robustez del flujo de ventas ML pendientes |
| `4ce373a` | E | Tests de contrato + fix off-by-one del confirm-gate |
| `a6723dc` | — | Alineación de `registerMLSale` (frontend) con el backend |

---

## 1. Fixes aplicados (por archivo)

### `render-backend/ai/tools.mjs`
- **`set_goal`** (`~734-745`): `tipoMeta` ahora acepta `['ganancia','ventas','unidades']` (antes faltaba `unidades`, que el dominio sí soportaba). Descripción aclara que `ganancia`=profit, `ventas`=ingresos, `unidades`=cantidad. `objetivo` con `.min(0)`.
- **`set_finance_config`** (`~756-790`): ahora permite fijar `finConfig.ivaMensual['YYYY-MM']` (IVA manual del SII) con merge sin pisar otros meses. `ivaPct` acotado a 0–100; `publicidadMonto` con `.min(0)`.
- **Validaciones Zod**: `add_sale.quantity` → `.int().positive()`; `add_product` `costPrice/salePrice/stock` → `.min(0)`; `manage_expense.monto` y `manage_fixed_expense.monto` → `.min(0)`.
- **`list_pending_ml_sales`** (`~391`): fuzzy-match de nombres — `suggestedProductId/Name/matchScore` (score >0.7) y `possibleMatches[]` (0.4–0.7). Descripción instruye a MIA a preguntar antes de mezclar.
- **`register_pending_ml_sale`** (`~444`): dedupe simétrico `source + item_id + id`.

### `render-backend/ai/domain.mjs` (se mantuvo PURO, sin imports ni side-effects)
- **`buildMlSalesFromPending`** (`632-696`): propaga `order_id` real, deriva `saleId` determinista con `saleIdFor` para heldSales legados, y añade los 5 campos de auditoría.
- **`fuzzyMatchProducts`** (nueva, pura): scorer normalizado 0..1 reutilizando el tokenizado/stopwords de `suggestProduct`. **No se usó fuse.js** (no era dependencia del backend — ver Decisiones).

### `render-backend/ai/ml.mjs`
- **confirm-gate** (`~75-118`): caducidad por turnos (válido solo si `currentTurn - issuedAtTurn <= 5`); `prunePendingConfirms()` elimina caducados y capa a los 20 más recientes. Fix off-by-one: re-capa tras `push` (la lista podía quedar en 21).
- **`ml_register_order_by_id`**: campos de auditoría (`registeredBy:'mia'`).

### `render-backend/ai/agent.mjs`
- **PERSONA**: documenta las 8 tools nuevas + bloque "REGISTRO RETROACTIVO" (ml_orders → by_id / add_sale) + instrucciones de conflicto de nombre.

### `render-backend/ml-sync.js`
- Cada `heldSale` (`~393`) guarda `orderId` real. Ventas del cron con auditoría (`registeredBy:'sync'`).

### `render-backend/api/lib/_core.js`
- `fsGetWithMeta` (lee `updateTime`); `fsPatch` acepta precondición `currentDocument.updateTime` opcional (detecta conflicto 409/412). Compatible con los 6 llamadores existentes.

### `render-backend/ai/store.mjs`
- `patchMasked` acepta `updateTime` opcional; `saveStateFields` es read-modify-write con concurrencia optimista y reintento (hasta 3×), replicando el patrón del cron.

### `index.html`
- **`FB.save`** (`~483-526`): merge defensivo anti-race — relee el doc remoto y hace unión por `id` de `sales` antes de `setDoc`, para no pisar ventas que el cron acaba de escribir.
- **`registerMLSale`** (`~7275`): alineado con `buildMlSalesFromPending` (order_id, saleId determinista, dedupe simétrico, auditoría con `registeredBy:'app'`). Resuelve el riesgo ALTO de doble registro.

---

## 2. Herramientas nuevas de MIA (8)

Todas registradas en el array de `tools.mjs`, documentadas en el PERSONA de `agent.mjs` y en `CONTRACT.md`, con schema Zod estricto, errores en español y test propio. Ninguna borra datos.

| Tool | Tipo | Qué hace |
|---|---|---|
| `mark_notification_read(id)` | escritura | Marca una notificación como leída |
| `dismiss_notification(id)` | escritura | Descarta/quita una notificación |
| `set_business_profile(text)` | escritura | Edita el perfil de negocio |
| `regenerate_business_profile()` | escritura | Reconstruye el perfil con `buildBusinessProfile` |
| `dismiss_pending_sale(itemId)` | escritura | Descarta una venta pendiente sin registrarla |
| `restore_pending_sale(itemId)` | escritura | Recupera una pendiente descartada |
| `list_mappings()` | lectura | Lista los mapeos item ML → producto |
| `remap_item(itemId, productId, variantId?)` | escritura | Re-apunta un mapeo (exige variantId si el producto tiene variantes) |

---

## 3. Guía de uso

`GUIA_DE_USO_v2.md` — reescritura completa (334 líneas) alineada 100% con la app real (Firebase cloud-first, backend Render, MIA, integración ML). 5 secciones con índice navegable: Inicio/cuenta, MIA, Ventas ML, CRM día a día, Configuración/troubleshooting. La `GUIA_DE_USO.md` original quedó intacta (describe la versión vieja localStorage; se puede archivar).

---

## 4. Decisiones tomadas durante la ejecución

1. **fuse.js no era dependencia del backend** (el plan lo asumía). En vez de añadir una dependencia nueva y romper la pureza de `domain.mjs`, se implementó `fuzzyMatchProducts` con un scorer propio reutilizando el tokenizado de `suggestProduct`. **Pregunta abierta:** ¿migrar a fuse.js real más adelante? (requiere `npm i fuse.js`).
2. **`body.confirmToken` del contrato es informativo**: el servidor no lo lee del body; el token viaja como argumento de la tool vía el LLM. Se documentó en `CONTRACT.md` (opción más simple y segura, sin cambiar el flujo).
3. **Concurrencia del frontend**: se eligió merge defensivo por `id` en `sales` (mínimamente invasivo) en vez de `runTransaction`. Existe un listener en vivo (`onSnapshot`) que ya reduce el riesgo.

---

## 5. Riesgos residuales y próximos pasos (priorizados)

1. **MEDIO — Verificación manual del frontend pendiente.** Los cambios en `index.html` (`FB.save` merge + `registerMLSale`) NO tienen tests automáticos. Se recomienda probar manualmente:
   - Resolver una venta pendiente desde la web y verificar que NO se duplica con la que registra el cron/MIA (mismo `saleId` determinista ahora).
   - Dos pestañas abiertas + escritura del cron simulada → la venta inyectada no desaparece tras un guardado local.
2. **BAJO — `mappings` y `pendingMappings` no se fusionan en `FB.save`** (solo `sales`). Protegidos por el listener en vivo + `dismissedPending`. Extender el merge solo si se observan pérdidas de mapeos.
3. **BAJO — Errores del proveedor de IA sin test** (`upstreamInfo`: 404→model_unavailable, 401→upstream_auth, 429→upstream_rate). Añadir tests directos.
4. **BAJO — Gaps de test**: rama legada sin `saleId`/`orderId` en `buildMlSalesFromPending`; `op:open` con ML conectado; `pruneThreads` (cap 25 hilos).
5. **Cosmético** — Los títulos de `GUIA_DE_USO_v2.md` conservan prefijos internos "C1—C5"; conviene renombrarlos a títulos de usuario.

---

## 6. Cumplimiento de las reglas de operación

- ✅ No se borraron ventas, productos ni datos del usuario.
- ✅ Conflictos de nombre: MIA pregunta, nunca mezcla automáticamente (fuzzy-match solo sugiere).
- ✅ Commits incrementales descriptivos tras cada sub-tarea.
- ✅ `domain.mjs` se mantuvo puro y verificado VERBATIM en las funciones de cifras.
- ✅ Cambios reversibles y aditivos (campos opcionales).
- ✅ Toda tool nueva registrada en el array Y en el PERSONA.
- ⏳ **Push pendiente de tu confirmación** (según acuerdo: preguntar antes de cada push).
