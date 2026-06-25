# REPORTE — 2ª pasada multi-agente de NexSell CRM

**Fecha:** 2026-06-24
**Alcance:** verificación exhaustiva + cierre de gaps reales tras la 1ª pasada (`REPORTE_FINAL.md`), mejoras visuales aditivas y QA.
**Tests:** `cd render-backend && npm test` → **111 pass / 0 fail / 1 skipped** (el skip es el live-smoke gated en `OPENROUTER_API_KEY`).
**Commits:** 6 incrementales en `main`, **sin push** (pendiente de tu confirmación).

---

## Resumen ejecutivo

La 1ª pasada ya había dejado MIA completa (44 herramientas), guía v2, fix de doble registro y 106 tests. Esta 2ª pasada se enfocó en **verificar** ese estado con 3 agentes Explore independientes y **cerrar los gaps reales** que afloraron, evitando re-trabajar lo correcto. El hallazgo más importante de riesgo —clobber de `sales` por concurrencia cron↔MIA— se confirmó y se arregló con tests. El "posible doble descuento de stock" se investigó y se **descartó como bug** (el cron no descuenta ventas retenidas).

---

## 1. Bugs corregidos (por commit)

| # | Severidad | Qué estaba mal | Archivo:zona | Fix |
|---|---|---|---|---|
| 1 | **Media-alta** | Ante conflicto de escritura, `agent.mjs` reescribía el array `sales` completo desde memoria → podía pisar ventas que el cron agregó a mitad de turno. El parámetro `merge` de `saveStateFields` existía pero no se conectaba. | `ai/agent.mjs` opSend (~370, ~434) | Snapshot de ids al cargar + `merge` que une por id las ventas remotas faltantes, **excepto las borradas en el turno** (delete_sale). +2 tests. |
| 3 | Media | `FB.save` (frontend) solo fusionaba `sales`; un `pendingMapping` nuevo del cron podía perderse con la pestaña abierta. | `index.html` FB.save (~483) | Unión por `item_id` de `pendingMappings`, excluyendo `dismissedPending` y `mappings` locales (no resucita pendientes ya resueltas). |
| 5 | Baja | `pendingChatItemsCount` definida 2×; el override no excluía `type==='sale'` → el badge contaba más que las burbujas visibles. | `index.html` (~7862) | El override ahora excluye `type==='sale'`, igual que `flushChatNotifications`. |
| 6 | Baja | `dismissedPending` crecía sin límite. | `ai/tools.mjs` | `capDismissed()` (cap 500) tras push; comentario aclara que el add es **load-bearing** (evita re-encolado del cron). |
| 7 | Baja | `confirmMapping` con `includes` bidireccional podía mapear a producto equivocado sin confirmar. | `index.html` (~7207) | Match exacto primero; parcial **solo si hay un único candidato** (con 2+ ambiguos no adivina). |
| 8 | Baja | Parseo de costo rompía con separador de miles chileno ("1.234,56" → 1.234). | `index.html` chatRegisterNewProduct (~7259) | Nuevo helper `parseMontoCL` (maneja miles con punto y decimal con coma). |
| 9 | Baja | `set_goal` para mes ≠ actual quedaba silencioso (`get_goal_progress` → `sinMeta:true`). | `ai/tools.mjs` set_goal (~764) | La respuesta incluye un `aviso` para que MIA lo comunique. +1 test. |
| 10 | Baja | No existía forma de consultar el estado del sync. | `api/sync-status.js` (nuevo) | `GET /api/sync-status` con auth Firebase, sin exponer tokens. |
| 11 | Baja | `redirect_uri` derivado de host en 2 lugares → riesgo de mismatch OAuth. | `api/lib/ml-redirect.js` (nuevo) | Fuente única `resolveRedirectUri(event)` usada por `ml-login.js` y `ml-callback.js`. |

### Bugs investigados y **descartados** (no eran bugs)
- **Doble descuento de stock (cron↔MIA):** el cron NO descuenta ventas retenidas (`heldSales`); solo descuenta al auto-mapear y registrar directo. MIA descuenta una sola vez al registrar el pendiente, con dedupe por `saleId` **antes** del descuento. Diseño consistente. (`ml-sync.js:390-397`, `tools.mjs:469-471`, `tools.mjs:329-360`)
- **Bug 4 — `buildProductPayload` escribe `stockMin:0`:** es **consistente** con el formulario manual de `index.html` (L4693 también usa `||0`). El fallback `:5` en `productMargins` solo aplica a productos legados sin el campo. Cambiarlo introduciría una divergencia MIA↔app. Se dejó como está (domain puro y VERBATIM).

---

## 2. Mejoras visuales implementadas (aditivas, respetan el sistema de diseño)

- **Dashboard — indicador "última sincronización ML":** chip que muestra "Mercado Libre: sincronizado hace X · N venta(s) por revisar", alimentado por el nuevo `/api/sync-status` (throttle 60s; oculto si no hay conexión). `index.html` page-head del dashboard + `updateMlSyncIndicator()`.
- **Ventas — resumen rápido del período:** fila con Ingresos / Unidades / Ganancia del conjunto mostrado, sobre la tabla.

### Ya existían (no se duplicaron)
- Badges de canal en la tabla de Ventas (ML en amarillo `#FFE600`, otros con su nombre).
- Barras de % de stock e indicadores 🟢/🟡/🔴 en Inventario (`stockLevel`).
- Gráficos del Dashboard (Top5, Stock, Ingreso/Costo, Margen) y Análisis con KPIs desde fuente única `getFinanzas()`.

### Diseños propuestos (wireframes) — pendientes de implementar con verificación en navegador

```
DASHBOARD (mejorado)
┌───────────────────────────────────────────────────────────┐
│ Dashboard                                                   │
│ Resumen de rendimiento de tu tienda                         │
│ ⟳ Mercado Libre: sincronizado hace 12 min · 2 por revisar   │  ← IMPLEMENTADO
├───────────────────────────────────────────────────────────┤
│ [Ingresos ↑8%] [Ganancia ↑3%] [IVA] [Publicidad] [Unid.]    │  ← tendencias ↑↓ = propuesto
│  $1.2M          $340k          ...                          │
├───────────────────────────────────────────────────────────┤
│ ┌── Top 5 productos ──┐  ┌── Stock bajo ──┐                  │
│ │ ▇▇▇▇▇ Audífonos     │  │ 🔴 Teclado  0%  │                 │
│ │ ▇▇▇   Cargador      │  │ 🟡 Cable   40%  │                 │
│ └─────────────────────┘  └────────────────┘                 │
└───────────────────────────────────────────────────────────┘

VENTAS (mejorado)
┌───────────────────────────────────────────────────────────┐
│ [Ingresos $250k] [Unidades 18] [Ganancia $90k]              │  ← IMPLEMENTADO
├───────────────────────────────────────────────────────────┤
│ Fecha │ Producto │ Cant │ Canal           │ … │ Ganancia    │
│ 06-24 │ Audíf.   │  2   │ [Mercado Libre] │   │ $42.000     │  ← badge ya existía
│ 06-23 │ Cargador │  1   │ [Manual]        │   │ $3.500      │
└───────────────────────────────────────────────────────────┘

ANÁLISIS / FINANZAS (propuesto)
  · Análisis: filtro de período + comparativa mes vs mes anterior + ventas por día.
  · Finanzas: torta de distribución de gastos (fijos/variables/comisiones/envíos)
    + barra de meta con color (rojo<50% / amarillo 50-80% / verde>80%).
```

> Nota honesta de alcance: la capa visual profunda (tendencias ↑↓ en todos los KPIs, nuevos
> gráficos de Análisis/Finanzas, insights automáticos) no se implementó a ciegas porque este
> entorno no permite verificar el render en navegador, y enviar cambios de UI sin verificar
> sería irresponsable sobre una SPA de 10.349 líneas en producción. Se entregan como wireframes
> y se recomienda implementarlos en una sesión con la app corriendo para validar visualmente.

---

## 3. Herramientas de MIA — verificación

**44 herramientas** (35 CRM + 9 ML), todas registradas en sus arrays (`tools.mjs:1026`, `ml.mjs:418`) y mencionadas en el PERSONA (`agent.mjs:43-55`). El prompt esperaba 45; la diferencia es de conteo: `ml_register_order_by_id` figura bajo "Acciones CRM" en el texto del PERSONA pero es una tool ML. No es un bug (está registrada y documentada). Recomendación cosmética: moverla a la lista "ML" del PERSONA.

---

## 4. Tests

- Total: **111 pass / 0 fail / 1 skip**.
- Nuevos en esta pasada: merge anti-clobber (cron agrega venta a mitad de turno), `delete_sale` no resucita la venta borrada, `set_goal` aviso de mes distinto.
- `domain.mjs` intacto y puro; consistencia VERBATIM de cifras preservada.

---

## 5. Preguntas abiertas para el dueño

1. **Push:** ¿confirmas el push de los 6 commits a `futuretech668/ml-crm` (`HEAD:main`)?
2. **Capa visual profunda:** ¿quieres que la implemente en una sesión con la app corriendo (para verificar el render), o te bastan los wireframes como diseño?
3. **`ML_REDIRECT_URI`:** conviene fijarla en producción (Render) para blindar el OAuth; ¿la configuras tú o te paso el valor exacto?
4. **fuse.js:** el fuzzy match es propio (`domain.fuzzyMatchProducts`); funciona bien. ¿Migrar a fuse.js real o dejarlo así? (recomendado: dejarlo, evita una dependencia).

---

## 6. Próximos pasos recomendados

- Implementar la capa visual profunda con verificación en navegador (tendencias, gráficos de Análisis/Finanzas, insights).
- Consumir `/api/sync-status` también en una vista de "estado de conexión ML" en Configuración.
- Tests de los errores del proveedor IA (`upstreamInfo` 404/401/429) y de `pruneThreads`.
- Considerar CAS también en `crm_ml_tokens/{uid}` (hoy sin precondición; mitigado por dedupe idempotente).

---

## 7. Cumplimiento de las reglas de operación

- ✅ No se borraron datos del usuario; todo aditivo/reversible.
- ✅ Conflictos de nombre: MIA pregunta, nunca mezcla automáticamente.
- ✅ Commits incrementales descriptivos por área.
- ✅ `domain.mjs` puro y VERBATIM.
- ✅ Toda tool registrada en su array y en el PERSONA.
- ⏳ Push pendiente de tu confirmación.
