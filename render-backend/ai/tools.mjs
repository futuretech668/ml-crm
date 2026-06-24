// ============================================================================
// tools.mjs — Herramientas LangChain del CRM (lectura + escritura + memoria).
//
// Cada herramienta cierra sobre un contexto `ctx` ENLAZADO EN EL SERVIDOR:
//   { state, changed, did, aiDoc, now(), nextId(), nowIso(), today(), time(),
//     sendReport(period) }
// El modelo NUNCA provee identidad ni tokens — solo argumentos de negocio.
//
// · Lecturas: puras sobre el doc cargado (domain.mjs). Devuelven JSON string.
// · Escrituras al doc PROPIO del usuario: se ejecutan directo (read-modify-write
//   en memoria), marcan los campos cambiados en `ctx.changed` y registran un
//   resumen en `ctx.did`. (Las acciones HACIA AFUERA de ML viven en ml.mjs y son
//   confirm-gated.)
// ============================================================================

import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import * as domain from './domain.mjs';

const j = (o) => JSON.stringify(o);

export function buildCrmTools(ctx) {
  const state = ctx.state;
  const mark = (f) => ctx.changed.add(f);
  const findProduct = (id) => (state.products || []).find(p => p.id === id);

  const query_sales = tool(
    async (args) => j(domain.querySales(state, { ...args, now: ctx.now() })),
    {
      name: 'query_sales',
      description: 'Consulta ventas del CRM ya sincronizado (período hoy/semana/mes/año/total, o rango from/to). ' +
        'Permite filtrar por productId o source y agrupar por producto/dia/fuente. Devuelve totales exactos (count, units, revenue, commission, shipping, profit), top productos y grupos. Úsala para CUALQUIER cifra de ventas/ganancia.',
      schema: z.object({
        period: z.enum(['hoy', 'semana', 'mes', 'año', 'total']).optional().describe('Período nombrado. Si no se indica, usa el mes en curso.'),
        from: z.string().optional().describe('Fecha inicio YYYY-MM-DD (inclusive).'),
        to: z.string().optional().describe('Fecha fin YYYY-MM-DD (exclusiva).'),
        productId: z.number().optional(),
        groupBy: z.enum(['producto', 'dia', 'fuente']).optional(),
        source: z.enum(['mercadolibre', 'manual', 'otro']).optional()
      })
    }
  );

  const list_products = tool(
    async (args) => j(domain.productMargins(state, args || {})),
    {
      name: 'list_products',
      description: 'Lista productos con su margen unitario y porcentual exactos, stock y si están bajo stock. ' +
        'Incluye hasVariants y, si las tiene, variantes:[{variantId,label,stock}]. Para VENDER un producto con variantes, ' +
        'pasa a add_sale el variantId EXACTO de aquí (suele ser texto, ej. "v0-Negro"). ' +
        'Filtra archivados o solo bajo stock; ordena por margen/margenPct/stock/nombre.',
      schema: z.object({
        includeArchived: z.boolean().optional(),
        lowStockOnly: z.boolean().optional(),
        sortBy: z.enum(['margen', 'margenPct', 'stock', 'nombre']).optional()
      })
    }
  );

  const get_goal_progress = tool(
    async () => {
      const g = domain.computeGoalProgress(state.goals, state.sales, ctx.now());
      return j(g || { sinMeta: true });
    },
    {
      name: 'get_goal_progress',
      description: 'Progreso de la meta mensual del usuario (del mes en curso): tipo de meta, objetivo, logrado, % y si está cumplida. Devuelve {sinMeta:true} si no hay meta.',
      schema: z.object({})
    }
  );

  const get_finance_summary = tool(
    async (args) => j(domain.financeSummary(state, { ...(args || {}), now: ctx.now() })),
    {
      name: 'get_finance_summary',
      description: 'Resumen financiero exacto: ingresos, ganancia operativa, comisiones, envíos, IVA, publicidad, gastos fijos, gastos variables, ganancia NETA y margen neto. period: "mes" (mes en curso) o "total" (histórico, lo que muestra el Dashboard).',
      schema: z.object({ period: z.enum(['mes', 'total']).optional() })
    }
  );

  // Lista compacta de variantes de un producto (para guiar al modelo).
  const variantSummary = (p) => (p.variants || []).map(v => ({
    variantId: v.id, label: domain.variantLabelOf(v) || '(sin etiqueta)', stock: v.stock
  }));

  const add_sale = tool(
    async (args) => {
      const product = findProduct(args.productId);
      if (!product) return j({ error: 'No existe un producto con ese id. Usa list_products para ver los ids.' });
      let variant = null;
      if (product.hasVariants) {
        if (args.variantId == null) {
          return j({ error: 'Este producto maneja stock por variante. Indica variantId.', variantes: variantSummary(product) });
        }
        variant = domain.findVariant(product, args.variantId);
        if (!variant) return j({ error: 'No existe esa variante en el producto.', variantes: variantSummary(product) });
      }
      const sale = domain.buildSalePayload(product, args, {
        id: ctx.nextId(), today: ctx.today(), time: ctx.time(), nowIso: ctx.nowIso(), variant
      });
      state.sales = state.sales || [];
      state.sales.push(sale);
      domain.applyStockDelta(product, sale.variantId, -sale.quantity);
      product.lastModified = ctx.nowIso();
      mark('sales'); mark('products');
      ctx.did.push({ action: 'add_sale', saleId: sale.id, productName: sale.productName, variantLabel: sale.variantLabel, quantity: sale.quantity, totalPrice: sale.totalPrice, profit: sale.profit });
      return j({ ok: true, sale });
    },
    {
      name: 'add_sale',
      description: 'Registra una venta en el CRM del usuario. profit = total − costo·cantidad − comisión − envío. Descuenta el stock del producto (de la VARIANTE si el producto las maneja). salePrice/costPrice por defecto son los del producto o de la variante. Si el producto tiene variantes (hasVariants:true en list_products), DEBES pasar variantId copiándolo EXACTO de list_products (puede ser texto como "v0-Negro", no lo inventes ni lo conviertas a número).',
      schema: z.object({
        productId: z.number(),
        quantity: z.number().int('La cantidad debe ser un número entero.').positive('La cantidad vendida debe ser mayor que 0.'),
        variantId: z.union([z.string(), z.number()]).optional().describe('Obligatorio si el producto maneja variantes (color/talla). Cópialo EXACTO de list_products (suele ser texto, ej. "v0-Negro").'),
        salePrice: z.number().optional(),
        costPrice: z.number().optional(),
        commission: z.number().optional(),
        commissionType: z.enum(['fixed', 'percentage']).optional(),
        shipping: z.number().optional(),
        date: z.string().optional().describe('YYYY-MM-DD; por defecto hoy.'),
        source: z.string().optional().describe('Canal: "manual" (default), "mercadolibre", "otro", o el nombre de un canal propio del usuario (ver list_channels).')
      })
    }
  );

  const delete_sale = tool(
    async (args) => {
      state.sales = state.sales || [];
      const idx = state.sales.findIndex(s => s.id === args.id);
      if (idx < 0) return j({ error: 'No encontré una venta con ese id.' });
      const [removed] = state.sales.splice(idx, 1);
      const product = findProduct(removed.productId);
      if (product) {
        domain.applyStockDelta(product, removed.variantId, +(removed.quantity || 0));
        product.lastModified = ctx.nowIso();
      }
      mark('sales'); if (product) mark('products');
      ctx.did.push({ action: 'delete_sale', saleId: removed.id, productName: removed.productName });
      return j({ ok: true, removed });
    },
    {
      name: 'delete_sale',
      description: 'Elimina una venta del CRM por id y restaura el stock del producto (de la variante si la venta tenía variantId).',
      schema: z.object({ id: z.number() })
    }
  );

  const add_product = tool(
    async (args) => {
      const product = domain.buildProductPayload(args, { id: ctx.nextId(), nowIso: ctx.nowIso() });
      state.products = state.products || [];
      state.products.push(product);
      mark('products');
      ctx.did.push({ action: 'add_product', productId: product.id, name: product.name });
      return j({ ok: true, product });
    },
    {
      name: 'add_product',
      description: 'Crea un producto en el CRM con la forma exacta de la app. Para un producto con variantes (color/talla), pasa variants[] y el stock total se calcula como la suma de las variantes.',
      schema: z.object({
        name: z.string(),
        costPrice: z.number().min(0, 'El precio de costo no puede ser negativo.'),
        salePrice: z.number().min(0, 'El precio de venta no puede ser negativo.'),
        stock: z.number().min(0, 'El stock no puede ser negativo.'),
        stockMin: z.number().optional(),
        shipping: z.number().optional(),
        commission: z.number().optional(),
        commissionType: z.enum(['fixed', 'percentage']).optional(),
        variants: z.array(z.object({
          color: z.string().optional(),
          colorHex: z.string().optional(),
          talla: z.string().optional(),
          precioVenta: z.number().optional(),
          precioCosto: z.number().optional(),
          stock: z.number().optional(),
          tieneEnvio: z.boolean().optional(),
          costoEnvio: z.number().optional(),
          tieneComision: z.boolean().optional(),
          comisionTipo: z.enum(['fixed', 'percentage']).optional(),
          comision: z.number().optional()
        })).optional().describe('Variantes del producto (color/talla) con su stock propio.')
      })
    }
  );

  const edit_product = tool(
    async (args) => {
      const product = findProduct(args.id);
      if (!product) return j({ error: 'No existe un producto con ese id.' });
      // En productos con variantes el stock es derivado (Σ variantes); editarlo aquí lo
      // sobrescribiría el siguiente recálculo de la app. Guíalo a manage_variant.
      if (args.stock !== undefined && product.hasVariants) {
        return j({ error: 'Este producto maneja stock por variante; no edites product.stock. Usa manage_variant para ajustar el stock de cada variante.' });
      }
      const fields = ['name', 'costPrice', 'salePrice', 'stock', 'stockMin', 'shipping', 'commission', 'commissionType', 'archived'];
      for (const f of fields) if (args[f] !== undefined) product[f] = args[f];
      product.lastModified = ctx.nowIso();
      mark('products');
      ctx.did.push({ action: 'edit_product', productId: product.id, name: product.name, archived: product.archived });
      return j({ ok: true, product });
    },
    {
      name: 'edit_product',
      description: 'Edita campos de un producto existente (por id). Solo cambia los campos provistos. Usa archived:true para ARCHIVAR (ocultar sin borrar, reversible) o archived:false para desarchivar. No edites stock de productos con variantes (usa manage_variant).',
      schema: z.object({
        id: z.number(),
        name: z.string().optional(),
        costPrice: z.number().optional(),
        salePrice: z.number().optional(),
        stock: z.number().optional(),
        stockMin: z.number().optional(),
        shipping: z.number().optional(),
        commission: z.number().optional(),
        commissionType: z.enum(['fixed', 'percentage']).optional(),
        archived: z.boolean().optional().describe('true = archivar (reversible); false = desarchivar.')
      })
    }
  );

  const delete_product = tool(
    async (args) => {
      state.products = state.products || [];
      const idx = state.products.findIndex(p => p.id === args.id);
      if (idx < 0) return j({ error: 'No existe un producto con ese id.' });
      const product = state.products[idx];
      const ventas = (state.sales || []).filter(s => s.productId === args.id).length;
      // Salvaguarda: si tiene ventas asociadas, exige confirmación explícita.
      if (ventas > 0 && args.confirm !== true) {
        return j({
          needsConfirm: true,
          message: `El producto "${product.name}" tiene ${ventas} venta(s) asociada(s). Las ventas históricas se conservarán, pero el producto se quitará del catálogo. Confirma para borrar.`,
          ventasAsociadas: ventas,
          hint: 'Vuelve a llamar delete_product con confirm:true tras la confirmación del usuario. Si prefieres conservarlo, usa edit_product con archived:true.'
        });
      }
      state.products.splice(idx, 1);
      mark('products');
      ctx.did.push({ action: 'delete_product', productId: product.id, name: product.name, ventasConservadas: ventas });
      return j({ ok: true, deleted: { id: product.id, name: product.name }, ventasConservadas: ventas });
    },
    {
      name: 'delete_product',
      description: 'Borra DEFINITIVAMENTE un producto del catálogo (las ventas históricas se conservan). Si tiene ventas asociadas, devuelve needsConfirm:true y NO borra hasta que lo llames de nuevo con confirm:true. Para ocultar sin borrar, usa edit_product con archived:true.',
      schema: z.object({
        id: z.number(),
        confirm: z.boolean().optional().describe('Pásalo en true para confirmar el borrado de un producto con ventas asociadas.')
      })
    }
  );

  const manage_variant = tool(
    async (args) => {
      const product = findProduct(args.productId);
      if (!product) return j({ error: 'No existe un producto con ese id.' });
      product.variants = Array.isArray(product.variants) ? product.variants : [];
      if (args.action === 'add') {
        const variant = domain.buildVariantPayload(args, { id: ctx.nextId() });
        product.variants.push(variant);
        product.hasVariants = true;
        domain.recalcVariantStock(product);
        product.lastModified = ctx.nowIso();
        mark('products');
        ctx.did.push({ action: 'variant_add', productId: product.id, variantId: variant.id, label: domain.variantLabelOf(variant) });
        return j({ ok: true, variant, stockTotal: product.stock });
      }
      const variant = domain.findVariant(product, args.variantId);
      if (!variant) return j({ error: 'No existe esa variante.', variantes: variantSummary(product) });
      if (args.action === 'edit') {
        const fields = ['color', 'colorHex', 'talla', 'precioVenta', 'precioCosto', 'tieneEnvio', 'costoEnvio', 'tieneComision', 'comisionTipo', 'comision', 'stock'];
        for (const f of fields) if (args[f] !== undefined) variant[f] = args[f];
        domain.recalcVariantStock(product);
        product.lastModified = ctx.nowIso();
        mark('products');
        ctx.did.push({ action: 'variant_edit', productId: product.id, variantId: variant.id });
        return j({ ok: true, variant, stockTotal: product.stock });
      }
      if (args.action === 'delete') {
        const i = product.variants.findIndex(v => String(v.id) === String(args.variantId));
        const [removed] = product.variants.splice(i, 1);
        // Stock = suma de las variantes restantes (0 si no queda ninguna).
        product.stock = product.variants.reduce((a, v) => a + (Number(v.stock) || 0), 0);
        product.hasVariants = product.variants.length > 0;
        if (product.hasVariants) domain.recalcVariantStock(product);
        product.lastModified = ctx.nowIso();
        mark('products');
        ctx.did.push({ action: 'variant_delete', productId: product.id, variantId: removed.id });
        return j({ ok: true, removed, stockTotal: product.stock });
      }
      return j({ error: 'Acción de variante no válida.' });
    },
    {
      name: 'manage_variant',
      description: 'Gestiona variantes (color/talla) de un producto y su stock. action: add (crea variante; marca el producto como con variantes), edit (cambia solo campos provistos de una variante por variantId), delete (quita la variante). El stock total del producto se recalcula como la suma de las variantes.',
      schema: z.object({
        action: z.enum(['add', 'edit', 'delete']),
        productId: z.number(),
        variantId: z.union([z.string(), z.number()]).optional().describe('Obligatorio para edit/delete (cópialo EXACTO de list_products; suele ser texto, ej. "v0-Negro").'),
        color: z.string().optional(),
        colorHex: z.string().optional(),
        talla: z.string().optional(),
        precioVenta: z.number().optional(),
        precioCosto: z.number().optional(),
        stock: z.number().optional(),
        tieneEnvio: z.boolean().optional(),
        costoEnvio: z.number().optional(),
        tieneComision: z.boolean().optional(),
        comisionTipo: z.enum(['fixed', 'percentage']).optional(),
        comision: z.number().optional()
      })
    }
  );

  const ml_register_order = tool(
    async (args) => {
      const product = findProduct(args.productId);
      if (!product) return j({ error: 'No existe el producto mapeado. Crea el producto con add_product (o mapéalo a uno existente) y vuelve a intentar.' });
      let variant = null;
      if (product.hasVariants) {
        if (args.variantId == null) return j({ error: 'El producto maneja variantes. Indica variantId.', variantes: variantSummary(product) });
        variant = domain.findVariant(product, args.variantId);
        if (!variant) return j({ error: 'No existe esa variante.', variantes: variantSummary(product) });
      }
      const itemId = String(args.itemId);
      const orderId = String(args.orderId);
      const saleId = domain.saleIdFor({ id: orderId }, itemId);
      state.sales = state.sales || [];
      // Dedupe con el MISMO criterio del cron (ml-sync.js:298): no duplicar.
      if (state.sales.some(s => s.source === 'mercadolibre' && String(s.item_id) === itemId && s.id === saleId)) {
        return j({ alreadyRegistered: true, message: 'Esta venta de Mercado Libre ya está registrada en el CRM.', saleId });
      }
      const qty = Number(args.quantity) || 1;
      const unitPrice = Number(args.unitPrice) || 0;
      const comm = domain.unitCommissionFor({ sale_fee: args.saleFee, unit_price: unitPrice, listing_type_id: args.listingTypeId });
      const commissionPerUnit = +comm.perUnit.toFixed(2);
      const commission = +(commissionPerUnit * qty).toFixed(2);
      const costPriceUnit = variant ? (Number(variant.precioCosto) || 0) : (Number(product.costPrice) || 0);
      const hasShip = args.shipping != null;
      const shipping = hasShip ? Number(args.shipping) : (Number(product.shipping) || 0) * qty;
      const totalPrice = unitPrice * qty;
      const profit = totalPrice - costPriceUnit * qty - commission - shipping;
      const _resolvedName = variant ? `${product.name} (${domain.variantLabelOf(variant)})` : (args.title || product.name);
      const _origTitle = args.title || product.name;
      const sale = {
        id: saleId, date: args.date || ctx.today(), time: args.time || ctx.time(),
        productId: product.id, productName: _resolvedName,
        quantity: qty, salePrice: unitPrice, costPrice: costPriceUnit, commission,
        commissionType: 'percentage',
        commissionValue: unitPrice > 0 ? +((commissionPerUnit / unitPrice) * 100).toFixed(2) : 0,
        shipping, totalPrice, profit, createdAt: ctx.nowIso(),
        source: 'mercadolibre', item_id: itemId, order_id: orderId,
        feeSource: comm.source, shippingSource: hasShip ? 'ml' : 'local',
        variantId: variant ? variant.id : null, variantLabel: variant ? domain.variantLabelOf(variant) : '',
        // Auditoría (campos aditivos).
        registeredAt: ctx.nowIso(), registeredBy: 'mia',
        originalTitle: _origTitle, resolvedProductName: _resolvedName,
        nameConflictResolved: !!(_origTitle && _origTitle !== _resolvedName)
      };
      state.sales.push(sale);
      domain.applyStockDelta(product, sale.variantId, -qty);
      product.lastModified = ctx.nowIso();
      // Crea el mapeo item_id → producto para que el cron NO la retenga ni duplique,
      // y limpia cualquier pendiente/descarte de esa publicación (ml-sync.js:300-355).
      state.mappings = state.mappings || {};
      state.mappings[itemId] = { productId: product.id, productName: product.name, variantId: variant ? variant.id : null, variantLabel: variant ? domain.variantLabelOf(variant) : '' };
      if (Array.isArray(state.pendingMappings)) state.pendingMappings = state.pendingMappings.filter(p => String(p.item_id) !== itemId);
      if (Array.isArray(state.dismissedPending)) state.dismissedPending = state.dismissedPending.filter(x => String(x) !== itemId);
      mark('sales'); mark('products'); mark('mappings'); mark('pendingMappings');
      if (state.dismissedPending) mark('dismissedPending');
      ctx.did.push({ action: 'ml_register_order', saleId, orderId, itemId, productName: sale.productName, totalPrice, feeSource: comm.source });
      return j({ ok: true, sale, mapped: true });
    },
    {
      name: 'ml_register_order',
      description: 'Registra en el CRM una venta de Mercado Libre EN VIVO leída con ml_orders que NO está en pendientes (p. ej. ocurrió después del último sync). Para ventas que quedaron EN ESPERA porque el producto no existía, usa antes list_pending_ml_sales + register_pending_ml_sale (traen los datos reales). Usa la comisión REAL (saleFee) si la entrega ML, o la estima por tipo de publicación. Es anti-duplicado: usa el mismo id que el cron y crea el mapeo item_id→producto. Si el producto aún no existe, primero créalo con add_product.',
      schema: z.object({
        orderId: z.union([z.string(), z.number()]).describe('id del pedido de Mercado Libre (order_id).'),
        itemId: z.union([z.string(), z.number()]).describe('id de la publicación (item_id, ej. MLC123...).'),
        productId: z.number().describe('id del producto del CRM al que corresponde.'),
        quantity: z.number(),
        unitPrice: z.number().describe('precio unitario de la venta en ML.'),
        variantId: z.union([z.string(), z.number()]).optional().describe('Si el producto maneja variantes, id de la variante (cópialo EXACTO de list_products; suele ser texto, ej. "v0-Negro").'),
        saleFee: z.number().optional().describe('comisión REAL total por unidad que entrega ML (sale_fee). Si no la tienes, se estima.'),
        listingTypeId: z.string().optional().describe('tipo de publicación (ej. gold_pro) para estimar comisión si falta saleFee.'),
        shipping: z.number().optional().describe('costo de envío TOTAL del ítem; si falta se usa el del producto.'),
        date: z.string().optional().describe('YYYY-MM-DD del pedido; por defecto hoy.'),
        time: z.string().optional(),
        title: z.string().optional().describe('título de la publicación (respaldo para el nombre).')
      })
    }
  );

  const list_pending_ml_sales = tool(
    async () => {
      const dism = new Set((state.dismissedPending || []).map(String));
      const pend = (state.pendingMappings || []).filter(p => !dism.has(String(p.item_id)));
      const products = Array.isArray(state.products) ? state.products : [];
      return j(pend.map(p => {
        const out = {
          item_id: p.item_id,
          title: p.title,
          price: p.price,
          quantity: p.quantity,
          suggestedProductId: p.suggestedProductId || null,
          suggestedName: p.suggestedName || null,
          suggestedVariantId: p.suggestedVariantId || null,
          suggestedVariantLabel: p.suggestedVariantLabel || null,
          needsVariant: !!p.needsVariant,
          ventasRetenidas: (p.heldSales || []).length || 1,
          fechas: (p.heldSales || []).map(h => h.date).filter(Boolean)
        };
        // Fuzzy match del título contra los productos del CRM (score 0..1, alto = más parecido).
        // > 0.7 → match fuerte (suggestedProduct*/matchScore). 0.4–0.7 → possibleMatches.
        // NUNCA se mezcla automáticamente: MIA debe PREGUNTAR antes de asociar.
        const cands = domain.fuzzyMatchProducts(products, p.title);
        const best = cands[0] || null;
        if (best && best.score > 0.7) {
          out.suggestedProductId = best.productId;
          out.suggestedProductName = best.productName;
          out.matchScore = best.score;
        }
        const possibles = cands.filter(c => c.score >= 0.4 && c.score <= 0.7)
          .map(c => ({ productId: c.productId, productName: c.productName, matchScore: c.score }));
        if (possibles.length) out.possibleMatches = possibles;
        return out;
      }));
    },
    {
      name: 'list_pending_ml_sales',
      description: 'Lista las ventas de Mercado Libre que quedaron EN ESPERA porque su publicación aún no estaba mapeada a un producto del CRM (p. ej. el producto no existía cuando se vendió). Trae el título de la publicación, precio, cantidad, las fechas reales de las ventas retenidas y un FUZZY MATCH contra el catálogo: si hay un parecido fuerte (matchScore > 0.7) lo entrega como suggestedProductId/suggestedProductName/matchScore; los parecidos medios (0.4–0.7) vienen en possibleMatches[]. matchScore va de 0 a 1 (1 = idéntico). ' +
        'NUNCA asocies una pendiente a un producto automáticamente: si hay un suggestedProductName o possibleMatches, PREGÚNTALE al usuario, p. ej.: "La venta pendiente \'[title]\' puede ser el mismo producto que \'[suggestedProductName]\'. ¿Es el mismo? (Sí / No / Ver ambos)". Solo tras un "Sí" llama register_pending_ml_sale con ese productId. ' +
        'Úsala cuando el usuario diga que falta una venta de ML o que vendió algo que no estaba en su catálogo.',
      schema: z.object({})
    }
  );

  const register_pending_ml_sale = tool(
    async (args) => {
      const itemId = String(args.itemId);
      const pending = (state.pendingMappings || []).find(p => String(p.item_id) === itemId);
      if (!pending) return j({ error: 'No hay una venta de ML en espera con ese item_id. Usa list_pending_ml_sales para ver las pendientes.' });
      const product = findProduct(args.productId);
      if (!product) return j({ error: 'No existe ese producto. Créalo con add_product (ponle el COSTO real) y vuelve a llamar register_pending_ml_sale.' });
      // Variante: si el producto la maneja, usar la que indique MIA (variantId) o la
      // resuelta/sugerida en el pending. Si no se puede resolver, pedirla.
      let variantId = null;
      if (product.hasVariants) {
        variantId = (args.variantId != null) ? args.variantId
          : (pending.suggestedVariantId != null ? pending.suggestedVariantId : null);
        if (variantId == null || !domain.findVariant(product, variantId)) {
          return j({ error: 'El producto maneja variantes. Indica variantId (cuál color/talla se vendió).', variantes: variantSummary(product) });
        }
      }
      state.sales = state.sales || [];
      const built = domain.buildMlSalesFromPending(pending, product, {
        baseId: ctx.nextId(), nowIso: ctx.nowIso(), today: ctx.today(), time: ctx.time(), variantId,
        registeredBy: 'mia', registeredAt: ctx.nowIso()
      });
      const nuevas = [];
      for (const sale of built) {
        // Dedupe SIMÉTRICO con el cron (ml-sync.js:325) y ml_register_order: mismo
        // triple criterio source + item_id + id. Antes solo comparaba s.id, lo que era
        // asimétrico y podía dejar pasar/duplicar ventas.
        if (state.sales.some(s => s.source === 'mercadolibre' && String(s.item_id) === String(sale.item_id) && s.id === sale.id)) continue;
        state.sales.push(sale);
        domain.applyStockDelta(product, sale.variantId, -sale.quantity);
        nuevas.push(sale);
      }
      product.lastModified = ctx.nowIso();
      // Mapea la publicación y la saca de pendientes (+ dismissedPending), como la app.
      const _mv = variantId != null ? domain.findVariant(product, variantId) : null;
      state.mappings = state.mappings || {};
      state.mappings[itemId] = { productId: product.id, productName: product.name, title: pending.title, variantId: _mv ? _mv.id : null, variantLabel: _mv ? domain.variantLabelOf(_mv) : '' };
      state.pendingMappings = (state.pendingMappings || []).filter(p => String(p.item_id) !== itemId);
      state.dismissedPending = Array.isArray(state.dismissedPending) ? state.dismissedPending : [];
      if (!state.dismissedPending.map(String).includes(itemId)) state.dismissedPending.push(itemId);
      mark('sales'); mark('products'); mark('mappings'); mark('pendingMappings'); mark('dismissedPending');
      ctx.did.push({ action: 'register_pending_ml_sale', itemId, productName: product.name, registradas: nuevas.length });
      return j({ ok: true, registradas: nuevas.length, ventas: nuevas, mapeado: { itemId, productId: product.id } });
    },
    {
      name: 'register_pending_ml_sale',
      description: 'Registra en el CRM una venta de ML que estaba EN ESPERA (de list_pending_ml_sales), asociándola a un producto. Usa los datos REALES capturados por la sync: fecha real del pedido (aunque sea de días atrás), comisión real (sale_fee) y envío real. Descuenta stock, crea el mapeo y la saca de pendientes. Si el producto no existe aún, primero créalo con add_product (con su costo) y luego llama esto con su id.',
      schema: z.object({
        itemId: z.union([z.string(), z.number()]).describe('item_id de la publicación pendiente (de list_pending_ml_sales).'),
        productId: z.number().describe('id del producto del CRM al que corresponde (créalo antes si no existe).'),
        variantId: z.union([z.string(), z.number()]).optional().describe('si el producto maneja variantes, id de la variante (color/talla) vendida (cópialo EXACTO de list_products; suele ser texto, ej. "v0-Negro"). Si no la das, se usa la sugerida del pending.')
      })
    }
  );

  const manage_task = tool(
    async (args) => {
      state.tasks = state.tasks || [];
      if (args.action === 'add') {
        const task = { id: ctx.nextId(), titulo: args.titulo || 'Tarea', fecha: args.fecha || ctx.today(), prioridad: args.prioridad || 'media', estado: 'pendiente' };
        state.tasks.push(task);
        mark('tasks');
        ctx.did.push({ action: 'task_add', id: task.id, titulo: task.titulo });
        return j({ ok: true, task });
      }
      const idx = state.tasks.findIndex(t => t.id === args.id);
      if (idx < 0) return j({ error: 'No encontré una tarea con ese id.' });
      if (args.action === 'complete') {
        state.tasks[idx].estado = 'hecha';
        mark('tasks');
        ctx.did.push({ action: 'task_complete', id: args.id });
        return j({ ok: true, task: state.tasks[idx] });
      }
      if (args.action === 'delete') {
        const [removed] = state.tasks.splice(idx, 1);
        mark('tasks');
        ctx.did.push({ action: 'task_delete', id: args.id });
        return j({ ok: true, removed });
      }
      return j({ error: 'Acción de tarea no válida.' });
    },
    {
      name: 'manage_task',
      description: 'Gestiona tareas del usuario: action add (crea), complete (marca hecha) o delete (elimina). Para complete/delete pasa el id.',
      schema: z.object({
        action: z.enum(['add', 'complete', 'delete']),
        id: z.number().optional(),
        titulo: z.string().optional(),
        fecha: z.string().optional(),
        prioridad: z.enum(['alta', 'media', 'baja']).optional()
      })
    }
  );

  const save_memory = tool(
    async (args) => {
      const note = String(args.note || '').trim();
      if (!note) return j({ error: 'Nota vacía.' });
      ctx.aiDoc.memory = Array.isArray(ctx.aiDoc.memory) ? ctx.aiDoc.memory : [];
      ctx.aiDoc.memory.push(note);
      if (ctx.aiDoc.memory.length > 50) ctx.aiDoc.memory = ctx.aiDoc.memory.slice(-50);
      ctx.did.push({ action: 'save_memory' });
      return j({ ok: true, recordado: note });
    },
    {
      name: 'save_memory',
      description: 'Guarda una nota durable sobre este usuario/negocio (preferencias, contexto) para recordarla en futuras conversaciones. Úsala cuando el usuario comparta algo que valga la pena recordar.',
      schema: z.object({ note: z.string() })
    }
  );

  const send_report = tool(
    async (args) => {
      const period = args.period === 'mes' ? 'monthly' : 'weekly';
      if (typeof ctx.sendReport !== 'function') return j({ error: 'El envío de reportes no está disponible ahora.' });
      try {
        const r = await ctx.sendReport(period);
        ctx.did.push({ action: 'send_report', period: args.period || 'semana' });
        return j({ ok: true, ...r });
      } catch (e) {
        return j({ error: 'No se pudo enviar el reporte.' });
      }
    },
    {
      name: 'send_report',
      description: 'Envía al correo del usuario un reporte de sus ventas (period: "semana" o "mes").',
      schema: z.object({ period: z.enum(['semana', 'mes']).optional() })
    }
  );

  // ===========================================================================
  // LECTURA (puras, no marcan ctx.changed) — para que MIA "vea" TODO el estado.
  // ===========================================================================

  const list_tasks = tool(
    async (args) => {
      const tasks = Array.isArray(state.tasks) ? state.tasks : [];
      let out = tasks;
      if (args.estado) out = out.filter(t => (t.estado || 'pendiente') === args.estado);
      if (args.from) out = out.filter(t => (t.fecha || '') >= args.from);
      if (args.to) out = out.filter(t => (t.fecha || '') <= args.to);
      return j(out.map(t => ({ id: t.id, titulo: t.titulo, fecha: t.fecha, prioridad: t.prioridad, estado: t.estado || 'pendiente' })));
    },
    {
      name: 'list_tasks',
      description: 'Lista las tareas del usuario (id, título, fecha, prioridad, estado). Filtra por estado (pendiente/hecha) y/o rango de fechas. Úsala ANTES de completar o borrar una tarea para conocer su id.',
      schema: z.object({
        estado: z.enum(['pendiente', 'hecha']).optional(),
        from: z.string().optional().describe('YYYY-MM-DD inclusive'),
        to: z.string().optional().describe('YYYY-MM-DD inclusive')
      })
    }
  );

  const list_expenses = tool(
    async (args) => {
      const all = Array.isArray(state.expenses) ? state.expenses : [];
      const ym = args.month || null;
      const out = ym ? all.filter(e => String(e.fecha || '').slice(0, 7) === ym) : all;
      const total = out.reduce((a, e) => a + (Number(e.monto) || 0), 0);
      return j({ total, count: out.length, expenses: out.map(e => ({ id: e.id, nombre: e.nombre, monto: e.monto, fecha: e.fecha })) });
    },
    {
      name: 'list_expenses',
      description: 'Lista los gastos variables del usuario con su total. month opcional (YYYY-MM) para filtrar por mes.',
      schema: z.object({ month: z.string().optional().describe('YYYY-MM') })
    }
  );

  const list_fixed_expenses = tool(
    async () => {
      const all = Array.isArray(state.gastosFijos) ? state.gastosFijos : [];
      const mensual = all.reduce((a, g) => a + domain.gastoFijoMensual(g), 0);
      return j({ equivalenteMensual: mensual, count: all.length, gastosFijos: all.map(g => ({ id: g.id, nombre: g.nombre, monto: g.monto, frecuencia: g.frecuencia || 'mensual', desde: g.desde })) });
    },
    {
      name: 'list_fixed_expenses',
      description: 'Lista los gastos fijos del usuario (arriendo, servicios, etc.) y su equivalente mensual total.',
      schema: z.object({})
    }
  );

  const get_finance_config = tool(
    async () => {
      const fc = state.finConfig || {};
      return j({
        ivaEnabled: !!fc.ivaEnabled,
        ivaPct: Number(fc.ivaPct) || 0,
        publicidadMensual: fc.publicidadMensual || {},
        ivaMensual: fc.ivaMensual || {}
      });
    },
    {
      name: 'get_finance_config',
      description: 'Configuración financiera del usuario: si cobra IVA, el % de IVA y la publicidad/IVA por mes (YYYY-MM).',
      schema: z.object({})
    }
  );

  const list_channels = tool(
    async () => {
      const propios = Array.isArray(state.customChannels) ? state.customChannels : [];
      return j({ base: ['manual', 'mercadolibre'], propios });
    },
    {
      name: 'list_channels',
      description: 'Lista los canales de venta: los base (manual, mercadolibre) y los canales propios del usuario (customChannels).',
      schema: z.object({})
    }
  );

  const list_notifications = tool(
    async () => {
      const n = Array.isArray(state.notifications) ? state.notifications : [];
      return j(n.map(x => ({ id: x.id, type: x.type, text: x.text, read: !!x.read, createdAt: x.createdAt })));
    },
    {
      name: 'list_notifications',
      description: 'Lista las notificaciones/avisos del chat del usuario (id, tipo, texto, leída).',
      schema: z.object({})
    }
  );

  // ===========================================================================
  // ESCRITURA del resto del estado — para que MIA pueda EDITAR TODA la app.
  // ===========================================================================

  const manage_expense = tool(
    async (args) => {
      state.expenses = Array.isArray(state.expenses) ? state.expenses : [];
      if (args.action === 'add') {
        const e = { id: ctx.nextId(), nombre: args.nombre || 'Gasto', monto: Number(args.monto) || 0, fecha: args.fecha || ctx.today() };
        state.expenses.push(e); mark('expenses');
        ctx.did.push({ action: 'expense_add', id: e.id, nombre: e.nombre, monto: e.monto });
        return j({ ok: true, expense: e });
      }
      const idx = state.expenses.findIndex(e => e.id === args.id);
      if (idx < 0) return j({ error: 'No encontré un gasto con ese id. Usa list_expenses.' });
      if (args.action === 'edit') {
        const e = state.expenses[idx];
        if (args.nombre !== undefined) e.nombre = args.nombre;
        if (args.monto !== undefined) e.monto = Number(args.monto) || 0;
        if (args.fecha !== undefined) e.fecha = args.fecha;
        mark('expenses');
        ctx.did.push({ action: 'expense_edit', id: e.id });
        return j({ ok: true, expense: e });
      }
      if (args.action === 'delete') {
        const [removed] = state.expenses.splice(idx, 1);
        mark('expenses');
        ctx.did.push({ action: 'expense_delete', id: removed.id });
        return j({ ok: true, removed });
      }
      return j({ error: 'Acción no válida.' });
    },
    {
      name: 'manage_expense',
      description: 'Gestiona gastos variables del usuario. action add (crea), edit (cambia campos provistos) o delete (elimina). Para edit/delete pasa el id (de list_expenses).',
      schema: z.object({
        action: z.enum(['add', 'edit', 'delete']),
        id: z.number().optional(),
        nombre: z.string().optional(),
        monto: z.number().min(0, 'El monto del gasto no puede ser negativo.').optional(),
        fecha: z.string().optional().describe('YYYY-MM-DD; por defecto hoy.')
      })
    }
  );

  const manage_fixed_expense = tool(
    async (args) => {
      state.gastosFijos = Array.isArray(state.gastosFijos) ? state.gastosFijos : [];
      if (args.action === 'add') {
        const g = { id: ctx.nextId(), nombre: args.nombre || 'Gasto fijo', monto: Number(args.monto) || 0, frecuencia: args.frecuencia || 'mensual', desde: args.desde || ctx.today().slice(0, 7) };
        state.gastosFijos.push(g); mark('gastosFijos');
        ctx.did.push({ action: 'fixed_expense_add', id: g.id, nombre: g.nombre });
        return j({ ok: true, gastoFijo: g });
      }
      const idx = state.gastosFijos.findIndex(g => g.id === args.id);
      if (idx < 0) return j({ error: 'No encontré un gasto fijo con ese id. Usa list_fixed_expenses.' });
      if (args.action === 'edit') {
        const g = state.gastosFijos[idx];
        if (args.nombre !== undefined) g.nombre = args.nombre;
        if (args.monto !== undefined) g.monto = Number(args.monto) || 0;
        if (args.frecuencia !== undefined) g.frecuencia = args.frecuencia;
        if (args.desde !== undefined) g.desde = args.desde;
        mark('gastosFijos');
        ctx.did.push({ action: 'fixed_expense_edit', id: g.id });
        return j({ ok: true, gastoFijo: g });
      }
      if (args.action === 'delete') {
        const [removed] = state.gastosFijos.splice(idx, 1);
        mark('gastosFijos');
        ctx.did.push({ action: 'fixed_expense_delete', id: removed.id });
        return j({ ok: true, removed });
      }
      return j({ error: 'Acción no válida.' });
    },
    {
      name: 'manage_fixed_expense',
      description: 'Gestiona gastos fijos del usuario (arriendo, servicios...). action add/edit/delete. frecuencia: mensual/semanal/anual. desde: YYYY-MM. Para edit/delete pasa el id.',
      schema: z.object({
        action: z.enum(['add', 'edit', 'delete']),
        id: z.number().optional(),
        nombre: z.string().optional(),
        monto: z.number().min(0, 'El monto del gasto fijo no puede ser negativo.').optional(),
        frecuencia: z.enum(['mensual', 'semanal', 'anual']).optional(),
        desde: z.string().optional().describe('YYYY-MM')
      })
    }
  );

  const set_goal = tool(
    async (args) => {
      state.goals = state.goals || {};
      const mes = args.mes || ctx.today().slice(0, 7);
      state.goals.mensual = {
        objetivo: Number(args.objetivo) || 0,
        mes,
        tipoMeta: args.tipoMeta || (state.goals.mensual && state.goals.mensual.tipoMeta) || 'ganancia'
      };
      mark('goals');
      ctx.did.push({ action: 'set_goal', objetivo: state.goals.mensual.objetivo, tipoMeta: state.goals.mensual.tipoMeta });
      return j({ ok: true, goal: state.goals.mensual });
    },
    {
      name: 'set_goal',
      description: 'Fija o cambia la meta mensual del usuario. objetivo = monto (o cantidad de unidades si tipoMeta="unidades"). ' +
        'tipoMeta: "ganancia" (default; suma la ganancia/profit del mes), "ventas" (suma los INGRESOS/totalPrice del mes) o ' +
        '"unidades" (suma la CANTIDAD de unidades vendidas en el mes). mes opcional (YYYY-MM; por defecto el mes en curso).',
      schema: z.object({
        objetivo: z.number().min(0, 'El objetivo de la meta no puede ser negativo.'),
        tipoMeta: z.enum(['ganancia', 'ventas', 'unidades']).optional()
          .describe('"ganancia" (profit), "ventas" (ingresos) o "unidades" (cantidad vendida).'),
        mes: z.string().optional().describe('YYYY-MM')
      })
    }
  );

  const set_finance_config = tool(
    async (args) => {
      state.finConfig = state.finConfig || {};
      const fc = state.finConfig;
      if (args.ivaEnabled !== undefined) fc.ivaEnabled = !!args.ivaEnabled;
      if (args.ivaPct !== undefined) fc.ivaPct = Number(args.ivaPct) || 0;
      if (args.publicidadMonto !== undefined) {
        fc.publicidadMensual = fc.publicidadMensual || {};
        const mes = args.publicidadMes || ctx.today().slice(0, 7);
        fc.publicidadMensual[mes] = Number(args.publicidadMonto) || 0;
      }
      // IVA manual del SII por mes: merge sin pisar los otros meses.
      if (args.ivaMensualMonto !== undefined) {
        fc.ivaMensual = (fc.ivaMensual && typeof fc.ivaMensual === 'object') ? fc.ivaMensual : {};
        const mesIva = args.ivaMensualMes || ctx.today().slice(0, 7);
        fc.ivaMensual[mesIva] = Number(args.ivaMensualMonto) || 0;
      }
      mark('finConfig');
      ctx.did.push({ action: 'set_finance_config' });
      return j({ ok: true, finConfig: { ivaEnabled: !!fc.ivaEnabled, ivaPct: Number(fc.ivaPct) || 0, publicidadMensual: fc.publicidadMensual || {}, ivaMensual: fc.ivaMensual || {} } });
    },
    {
      name: 'set_finance_config',
      description: 'Ajusta la configuración financiera: ivaEnabled (cobra IVA o no), ivaPct (% de IVA, 0-100), la publicidad de un mes (publicidadMonto + publicidadMes YYYY-MM, por defecto el mes en curso) y el IVA MANUAL del SII de un mes (ivaMensualMonto + ivaMensualMes YYYY-MM). El IVA manual de un mes hace merge sin pisar los demás meses y reemplaza el cálculo automático de ese mes. Solo cambia lo provisto.',
      schema: z.object({
        ivaEnabled: z.boolean().optional(),
        ivaPct: z.number().min(0, 'El % de IVA no puede ser negativo.').max(100, 'El % de IVA no puede superar 100.').optional(),
        publicidadMonto: z.number().min(0, 'La publicidad no puede ser negativa.').optional(),
        publicidadMes: z.string().optional().describe('YYYY-MM'),
        ivaMensualMonto: z.number().min(0, 'El IVA manual no puede ser negativo.').optional().describe('Monto del IVA manual del SII para un mes.'),
        ivaMensualMes: z.string().optional().describe('YYYY-MM del IVA manual (por defecto el mes en curso).')
      })
    }
  );

  const manage_channel = tool(
    async (args) => {
      state.customChannels = Array.isArray(state.customChannels) ? state.customChannels : [];
      const nombre = String(args.nombre || '').trim();
      if (!nombre) return j({ error: 'Indica el nombre del canal.' });
      if (args.action === 'add') {
        if (!state.customChannels.includes(nombre)) state.customChannels.push(nombre);
        mark('customChannels');
        ctx.did.push({ action: 'channel_add', nombre });
        return j({ ok: true, canales: state.customChannels });
      }
      if (args.action === 'delete') {
        state.customChannels = state.customChannels.filter(c => c !== nombre);
        mark('customChannels');
        ctx.did.push({ action: 'channel_delete', nombre });
        return j({ ok: true, canales: state.customChannels });
      }
      return j({ error: 'Acción no válida.' });
    },
    {
      name: 'manage_channel',
      description: 'Gestiona los canales de venta propios del usuario. action add (crea un canal con ese nombre) o delete. Luego puedes usar ese nombre como source en add_sale.',
      schema: z.object({ action: z.enum(['add', 'delete']), nombre: z.string() })
    }
  );

  // ===========================================================================
  // Notificaciones — marcar leída / descartar (mismo array que list_notifications).
  // ===========================================================================

  const mark_notification_read = tool(
    async (args) => {
      const n = Array.isArray(state.notifications) ? state.notifications : [];
      const notif = n.find(x => String(x.id) === String(args.id));
      if (!notif) return j({ error: 'No encontré una notificación con ese id. Usa list_notifications para ver los ids.' });
      notif.read = true;
      mark('notifications');
      ctx.did.push({ action: 'mark_notification_read', id: notif.id });
      return j({ ok: true, notification: { id: notif.id, read: true } });
    },
    {
      name: 'mark_notification_read',
      description: 'Marca como LEÍDA una notificación/aviso del usuario (no la borra). Pasa el id (de list_notifications).',
      schema: z.object({ id: z.union([z.string(), z.number()]) })
    }
  );

  const dismiss_notification = tool(
    async (args) => {
      state.notifications = Array.isArray(state.notifications) ? state.notifications : [];
      const idx = state.notifications.findIndex(x => String(x.id) === String(args.id));
      if (idx < 0) return j({ error: 'No encontré una notificación con ese id. Usa list_notifications para ver los ids.' });
      const [removed] = state.notifications.splice(idx, 1);
      mark('notifications');
      ctx.did.push({ action: 'dismiss_notification', id: removed.id });
      return j({ ok: true, dismissed: { id: removed.id } });
    },
    {
      name: 'dismiss_notification',
      description: 'Descarta (quita del listado) una notificación/aviso del usuario. Pasa el id (de list_notifications). Para solo marcarla leída sin quitarla, usa mark_notification_read.',
      schema: z.object({ id: z.union([z.string(), z.number()]) })
    }
  );

  // ===========================================================================
  // Perfil de negocio (businessProfile en aiDoc) — editar texto o regenerar.
  // ===========================================================================

  const set_business_profile = tool(
    async (args) => {
      const text = String(args.text || '').trim();
      if (!text) return j({ error: 'Indica el texto del perfil de negocio.' });
      ctx.aiDoc.businessProfile = {
        ...(ctx.aiDoc.businessProfile || {}),
        text,
        updatedAt: ctx.nowIso()
      };
      ctx.did.push({ action: 'set_business_profile' });
      return j({ ok: true, businessProfile: ctx.aiDoc.businessProfile });
    },
    {
      name: 'set_business_profile',
      description: 'Edita/fija el TEXTO del perfil durable del negocio (lo que MIA recuerda del usuario entre conversaciones). Úsalo cuando el usuario corrija o complete la descripción de su negocio. Para reconstruirlo automáticamente desde los datos del CRM, usa regenerate_business_profile.',
      schema: z.object({ text: z.string().describe('Texto del perfil de negocio (1-3 frases).') })
    }
  );

  const regenerate_business_profile = tool(
    async () => {
      const fresh = domain.buildBusinessProfile(state);
      ctx.aiDoc.businessProfile = { ...fresh, updatedAt: ctx.nowIso() };
      ctx.did.push({ action: 'regenerate_business_profile' });
      return j({ ok: true, businessProfile: ctx.aiDoc.businessProfile });
    },
    {
      name: 'regenerate_business_profile',
      description: 'Regenera el perfil de negocio desde cero a partir de los datos actuales del CRM (productos activos, top, margen típico, meta y total de ventas). Úsalo cuando el perfil quedó desactualizado y el usuario quiere refrescarlo con los datos reales.',
      schema: z.object({})
    }
  );

  // ===========================================================================
  // Ventas pendientes de ML — descartar / recuperar (gestión de dismissedPending).
  // ===========================================================================

  const dismiss_pending_sale = tool(
    async (args) => {
      const itemId = String(args.itemId);
      const exists = (state.pendingMappings || []).some(p => String(p.item_id) === itemId);
      if (!exists) return j({ error: 'No hay una venta de ML en espera con ese item_id. Usa list_pending_ml_sales para ver las pendientes.' });
      state.dismissedPending = Array.isArray(state.dismissedPending) ? state.dismissedPending : [];
      if (!state.dismissedPending.map(String).includes(itemId)) state.dismissedPending.push(itemId);
      mark('dismissedPending');
      ctx.did.push({ action: 'dismiss_pending_sale', itemId });
      return j({ ok: true, dismissed: itemId, msg: 'Venta pendiente descartada (NO se registró; sigue guardada y puedes recuperarla con restore_pending_sale).' });
    },
    {
      name: 'dismiss_pending_sale',
      description: 'Descarta una venta de ML EN ESPERA (de list_pending_ml_sales) SIN registrarla: la oculta del listado de pendientes pero NO la borra ni la registra como venta. Es reversible con restore_pending_sale. Úsalo cuando el usuario no quiere registrar esa venta pendiente.',
      schema: z.object({ itemId: z.union([z.string(), z.number()]).describe('item_id de la publicación pendiente.') })
    }
  );

  const restore_pending_sale = tool(
    async (args) => {
      const itemId = String(args.itemId);
      state.dismissedPending = Array.isArray(state.dismissedPending) ? state.dismissedPending : [];
      if (!state.dismissedPending.map(String).includes(itemId)) {
        return j({ error: 'Esa venta pendiente no estaba descartada.' });
      }
      state.dismissedPending = state.dismissedPending.filter(x => String(x) !== itemId);
      mark('dismissedPending');
      ctx.did.push({ action: 'restore_pending_sale', itemId });
      return j({ ok: true, restored: itemId, msg: 'Venta pendiente recuperada; vuelve a aparecer en list_pending_ml_sales.' });
    },
    {
      name: 'restore_pending_sale',
      description: 'Recupera una venta de ML pendiente que se había descartado con dismiss_pending_sale: la quita de dismissedPending para que vuelva a aparecer en list_pending_ml_sales.',
      schema: z.object({ itemId: z.union([z.string(), z.number()]).describe('item_id de la publicación pendiente descartada.') })
    }
  );

  // ===========================================================================
  // Mapeos ML → producto — leer y re-mapear manualmente.
  // ===========================================================================

  const list_mappings = tool(
    async () => {
      const m = (state.mappings && typeof state.mappings === 'object') ? state.mappings : {};
      return j(Object.keys(m).map(itemId => ({
        item_id: itemId,
        productId: m[itemId] && m[itemId].productId != null ? m[itemId].productId : null,
        productName: (m[itemId] && m[itemId].productName) || null,
        variantId: (m[itemId] && m[itemId].variantId != null) ? m[itemId].variantId : null,
        variantLabel: (m[itemId] && m[itemId].variantLabel) || null,
        title: (m[itemId] && m[itemId].title) || null
      })));
    },
    {
      name: 'list_mappings',
      description: 'Lista los mapeos de publicaciones de Mercado Libre (item_id) a productos del CRM: qué producto (y variante) tiene asociada cada publicación. Úsalo antes de re-mapear con remap_item.',
      schema: z.object({})
    }
  );

  const remap_item = tool(
    async (args) => {
      const itemId = String(args.itemId);
      const product = findProduct(args.productId);
      if (!product) return j({ error: 'No existe un producto con ese id. Usa list_products para ver los ids.' });
      let variant = null;
      if (args.variantId != null) {
        variant = domain.findVariant(product, args.variantId);
        if (!variant) return j({ error: 'No existe esa variante en el producto.', variantes: variantSummary(product) });
      } else if (product.hasVariants) {
        return j({ error: 'Este producto maneja variantes; indica variantId para mapear la publicación a la variante correcta.', variantes: variantSummary(product) });
      }
      state.mappings = (state.mappings && typeof state.mappings === 'object') ? state.mappings : {};
      const prev = state.mappings[itemId] || null;
      state.mappings[itemId] = {
        productId: product.id,
        productName: product.name,
        variantId: variant ? variant.id : null,
        variantLabel: variant ? domain.variantLabelOf(variant) : '',
        ...(prev && prev.title ? { title: prev.title } : {})
      };
      mark('mappings');
      ctx.did.push({ action: 'remap_item', itemId, productId: product.id, variantId: variant ? variant.id : null });
      return j({ ok: true, mapping: state.mappings[itemId], anterior: prev });
    },
    {
      name: 'remap_item',
      description: 'Re-mapea manualmente una publicación de Mercado Libre (item_id) a otro producto del CRM (y opcionalmente a una variante). Solo cambia el mapeo para futuras ventas; NO toca ventas ya registradas. Si el producto maneja variantes, debes indicar variantId.',
      schema: z.object({
        itemId: z.union([z.string(), z.number()]).describe('item_id de la publicación de ML.'),
        productId: z.number().describe('id del producto del CRM al que apuntar.'),
        variantId: z.union([z.string(), z.number()]).optional().describe('id de la variante (obligatorio si el producto maneja variantes; cópialo EXACTO de list_products).')
      })
    }
  );

  return [
    query_sales, list_products, get_goal_progress, get_finance_summary,
    add_sale, delete_sale, add_product, edit_product, delete_product,
    manage_variant, ml_register_order, list_pending_ml_sales, register_pending_ml_sale,
    manage_task, save_memory, send_report,
    list_tasks, list_expenses, list_fixed_expenses, get_finance_config, list_channels, list_notifications,
    manage_expense, manage_fixed_expense, set_goal, set_finance_config, manage_channel,
    mark_notification_read, dismiss_notification, set_business_profile, regenerate_business_profile,
    dismiss_pending_sale, restore_pending_sale, list_mappings, remap_item
  ];
}

// Helper de test/orquestación: indexa las herramientas por nombre.
export function toolsByName(tools) {
  const m = {};
  for (const t of tools) m[t.name] = t;
  return m;
}
