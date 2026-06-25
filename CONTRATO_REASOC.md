# CONTRATO_REASOC — Re-asociación de ventas ML en espera + acceso total de MIA

> **Fuente de verdad de la Fase 1.** Cualquier agente (A–E) que toque dominio,
> tools, prompt, frontend o seguridad DEBE respetar este contrato al pie de la
> letra. La matemática canónica vive en `render-backend/ai/domain.mjs` y **todos**
> los consumidores (cron `ml-sync.js`, tools de MIA `tools.mjs`, frontend
> `index.html`) deben producir **cifras idénticas** (paridad).

## 0. Estado actual (diagnóstico real, ya verificado en código)

Mucho de lo que el brief original asumía roto **ya está implementado**:

- `register_pending_ml_sale` (tools.mjs:447-512) **ya** resuelve producto, lee
  comisión/envío/precio **reales** del `heldSale` (vía `buildMlSalesFromPending`),
  descuenta stock por la variante correcta (`applyStockDelta`), crea
  `mappings[item_id]`, saca de `pendingMappings`, blinda con `dismissedPending` y
  deduplica (`source+item_id+id`). Acepta variante en palabras (`resolveVariant`).
- `buildMlSalesFromPending` (domain.mjs:644-708) **ya** usa cifras reales del held.
- El system prompt de MIA (agent.mjs:29-140) **ya** declara acceso total y el flujo
  "agrega estas 3 ventas color negro" (una llamada por `item_id`).
- La seguridad **ya** aísla por documento: `uid` se verifica una sola vez
  (agent.mjs:277-294) y `selectStatePath(uid, isOwner)` elige el doc; las tools
  operan sobre un `state` ya acotado a un único dueño.

**El hueco real:** cuando se **crea/edita un producto** (sea por MIA o por el
frontend), **nadie barre las pendientes existentes** para auto-cargarlas. El cron
solo auto-mapea **pedidos nuevos** dentro de `applyOrder` (ml-sync.js:337-362); las
`heldSales` ya retenidas se quedan pendientes hasta que el usuario las carga a mano
en el chat. **No existe** una función que, dado un producto, barra
`state.pendingMappings` y resuelva las coincidencias de alta confianza.

Esa función es el entregable central: **`reassociatePendingForProduct`**.

---

## 1. `reassociatePendingForProduct(state, product, opts?)`

Ubicación: **`render-backend/ai/domain.mjs`** (exportada). Es la pieza canónica;
el frontend debe **reflejar el mismo resultado** (paridad), no reimplementar otra
heurística.

### Firma

```js
/**
 * Barre state.pendingMappings buscando las ventas ML en espera que correspondan
 * a `product`, auto-carga las de ALTA confianza y reporta las de confianza media
 * (para que la capa de presentación las ofrezca al usuario).
 *
 * MUTA `state` (sales, products[].stock, mappings, pendingMappings,
 * dismissedPending) EXACTAMENTE como register_pending_ml_sale lo hace por ítem,
 * pero en lote para un producto contra todas las pendientes. NO hace I/O.
 *
 * @param {object} state    Documento CRM ya acotado al dueño (NUNCA recibe uid).
 * @param {object} product  Producto recién creado/editado (objeto vivo dentro de state.products).
 * @param {object} [opts]   { nowIso, today, time, nextId, registeredBy='reassoc', autoThreshold=0.8, suggestThreshold=0.4 }
 * @returns {{ loaded: LoadedEntry[], suggested: SuggestedEntry[], skipped: SkippedEntry[] }}
 */
export function reassociatePendingForProduct(state, product, opts) { ... }
```

### Formas de retorno

```js
// Auto-cargada (alta confianza): ya entró a state.sales y se descontó stock.
LoadedEntry = {
  item_id, title, score,
  ventas,           // array devuelto por buildMlSalesFromPending (las NUEVAS, ya deduplicadas)
  registradas,      // ventas.length efectivamente nuevas (tras dedupe)
  variantId,        // id de variante resuelta, o null
  variantLabel      // etiqueta legible, o ''
}

// Confianza media o variante ambigua: NO se tocó el estado, se ofrece al usuario.
SuggestedEntry = {
  item_id, title, score,
  reason,                 // 'medium_match' | 'ambiguous_variant'
  suggestedVariantId,     // si la sync ya sugirió una, o null
  suggestedVariantLabel,  // o ''
  variantes               // variantSummary(product) cuando reason==='ambiguous_variant'
}

SkippedEntry = { item_id, reason } // 'dismissed' | 'already_mapped' | 'no_match'
```

### Algoritmo (determinista, sin azar)

Para cada `pending` en `state.pendingMappings`:

1. **Respeta descartes**: si `String(pending.item_id)` está en
   `state.dismissedPending` → `skipped: 'dismissed'`. **NUNCA** auto-cargar un
   descartado.
2. **No re-mapear**: si `state.mappings[pending.item_id]` ya existe →
   `skipped: 'already_mapped'`.
3. **Score del título contra ESTE producto** usando la normalización canónica de
   `domain.suggestProduct` (mismas STOPWORDS, mismo NFD, mismo split). Exporta un
   helper `scoreProductTitle(product, title)` en domain.mjs y reusa esa misma
   función dentro de `suggestProduct` para garantizar paridad (no dos
   normalizaciones distintas).
   - `score >= autoThreshold (0.8)` → candidato a **auto-carga**.
   - `suggestThreshold (0.4) <= score < 0.8` → `suggested: 'medium_match'`.
   - `score < 0.4` → `skipped: 'no_match'`.
4. **Resolución de variante** (solo si `product.hasVariants`):
   - `v = suggestVariant(product, pending.title)`; si no resuelve y
     `pending.suggestedVariantId` apunta a una variante de ESTE producto, úsala.
   - Si **no hay** variante inequívoca → **NO** auto-cargar: `suggested:
     'ambiguous_variant'` (con `variantes` = `variantSummary(product)`), aunque el
     score sea ≥ 0.8. (Paridad con el cron: ml-sync.js:344-348.)
5. **Auto-carga** (score≥0.8 y, si aplica, variante inequívoca):
   - `built = domain.buildMlSalesFromPending(pending, product, { variantId, baseId: opts.nextId?.(), nowIso, today, time, registeredBy: opts.registeredBy||'reassoc', registeredAt: nowIso })`.
   - Dedupe simétrico: para cada `sale` de `built`, saltar si
     `state.sales.some(s => s.source==='mercadolibre' && String(s.item_id)===String(sale.item_id) && s.id===sale.id)`.
   - `state.sales.push(sale)` + `domain.applyStockDelta(product, sale.variantId, -sale.quantity)`.
   - `state.mappings[item_id] = { productId, productName, title: pending.title, variantId, variantLabel }`.
   - Quitar de `state.pendingMappings`; agregar `item_id` a `state.dismissedPending`
     (anti re-encolado del cron, ver ml-sync.js:328) y `capDismissed`.
   - `product.lastModified = nowIso`.
   - Empujar a `loaded`.

### Invariantes (NO negociables)

- **Paridad**: las ventas auto-cargadas deben ser **idénticas** (mismos campos,
  mismos importes, mismo `id` determinista) a las que produciría
  `register_pending_ml_sale` para ese mismo ítem, y a las del cron `applyOrder`.
  Prohibido recalcular comisión/envío/precio fuera de `buildMlSalesFromPending`.
- **Idempotencia**: llamarla dos veces no duplica ventas (garantizado por el dedupe
  `source+item_id+id`, la salida de `pendingMappings` y el `dismissedPending`).
- **Respeta `dismissedPending`** siempre (paso 1).
- **Sin I/O**: no lee/escribe Firestore ni red. Solo muta `state`. La persistencia
  con **control optimista por `updateTime`** la hace el llamador (tools.mjs vía el
  ciclo del servidor; ml-sync.js:459-490 con reintento; frontend vía
  `saveToLocalStorage`).
- **`userId` nunca llega aquí**: opera sobre el `state` ya acotado al dueño.
- **No molesta de más**: lo dudoso va a `suggested`, no se auto-carga. Variante
  ambigua nunca se adivina.

---

## 2. Contrato extendido de `register_pending_ml_sale(args)`

Tool en `tools.mjs`. **Ya cumple** la mayor parte; este contrato lo fija y agrega
el parámetro de costo opcional.

### Args (Zod)

| Campo | Req. | Notas |
|---|---|---|
| `itemId` | sí | `string\|number`. La pendiente en `state.pendingMappings`. |
| `productId` | sí | `number`. Producto del CRM (créalo antes si no existe). |
| `variante` | no | color/talla **en palabras** ("negro", "color negro / talla M"). Se resuelve sola. |
| `variantId` | no | id exacto de variante (alternativa a `variante`). |
| `cost` | no | **(extensión)** costo unitario real. Si se entrega y `product.costPrice` es falsy/0, backfill `product.costPrice = cost` ANTES de construir las ventas (para que `profit` salga bien). Nunca pisa un costo ya puesto sin que el usuario lo pida. |

### Reglas (todas ya vigentes salvo `cost`)

- **Resolver producto** por `productId` exacto. Si no existe → error pidiendo
  crearlo con `add_product` (con el COSTO real). **Pedir costo solo si falta.**
- **Resolver heldSales por fecha y varias ventas por orden**: usar
  `pending.heldSales` tal cual (cada uno conserva su `date/time` real); una llamada
  registra **todas** las ventas retenidas de ese ítem (held.map en
  buildMlSalesFromPending). No inventar fechas.
- **Comisión / envío / precio del heldSale**: provienen del `pending`
  (`commissionPerUnit`, `shippingTotal`, `price`), NO se recalculan en la tool.
- **Costo del producto**: `product.costPrice` (o el `cost` recién backfilled).
- **Variante**: prioridad `variantId` exacto > `variante` en palabras > la que ML ya
  identificó (`pending.suggestedVariantId`). Si ambigua → error pidiendo la variante
  (con `variantSummary`).
- **Escrituras**: `sales[]` (dedupe), stock por variante, `mappings[item_id]`,
  salida de `pendingMappings`, `dismissedPending` + cap. Marca campos cambiados.
- **userId**: SIEMPRE del documento ya acotado (la tool no lo recibe).

### Relación con la re-asociación

`register_pending_ml_sale` es la **primitiva por-ítem**;
`reassociatePendingForProduct` es el **barrido por-producto** que reusa exactamente
la misma lógica de construcción/dedupe/stock/mapeo. Mantener ambos consistentes: si
cambia uno, cambia el otro (idealmente compartiendo un helper interno de "cargar un
pending resuelto").

---

## 3. Enganches por agente (Fase 1)

- **A — domain.mjs**: implementar `reassociatePendingForProduct` + helper
  `scoreProductTitle`; reforzar `suggestVariant` (color/talla por
  `variation_attributes`, singular/plural y nombre de variante). Tests de paridad
  (auto-carga == register_pending_ml_sale == cron).
- **B — tools.mjs**: tras `add_product`, `edit_product` (cuando cambia nombre) y
  `manage_variant` (add), llamar `reassociatePendingForProduct` y devolver en la
  respuesta `loaded`/`suggested`; agregar `cost?` a `register_pending_ml_sale`.
  Empujar a `ctx.did` un resumen de lo auto-cargado.
- **C — agent.mjs**: ajustar el prompt para que MIA, al crear un producto, **avise
  lo que se auto-cargó** y ofrezca lo sugerido; ejecución inmediata bajo orden
  explícita. **NO cambia el modelo** (qwen vía OpenRouter).
- **D — index.html**: tras guardar producto/variante (4737-4768), ejecutar la
  re-asociación con la **misma** matemática (reusar `registerMLSale`/`confirmMapping`
  ya existentes para no romper paridad), refrescar `flushChatNotifications` y mostrar
  lo cargado + ofrecer lo sugerido. Reusar `registerMLSale`.
- **E — seguridad/auditoría**: confirmar `userId` desde sesión (ya es así); añadir un
  **log de auditoría persistente** por tool-call de escritura (p. ej.
  `state.auditLog[]` acotado), sin romper paridad ni golden tests.

---

## 4. Verificación adversarial (Fase 3) — criterios de cierre

- **V1**: producto "Audífonos LE302" con variantes (negra/blanca), 3 ventas del
  21-jun simuladas en `pendingMappings.heldSales`; "agrega estas 3 ventas" debe dejar
  3 ventas en `sales[]` con comisión/envío/precio reales, variante correcta por venta,
  stock descontado por variante, `mappings[item_id]` creado y notificación.
- **V2**: correr el cron tras cargar → **no duplica** (dedupe `source+item_id+id` +
  `dismissedPending`).
- **V3**: MIA no puede tocar datos de otro `uid` (aislamiento por `selectStatePath`).

Cada verificador devuelve `{pasa|falla + evidencia}`. Si alguno falla, se vuelve a la
Fase 1 con el agente correspondiente. Se cierra solo cuando los 3 pasan.

**No hay push ni merge sin aprobación explícita del usuario.**
