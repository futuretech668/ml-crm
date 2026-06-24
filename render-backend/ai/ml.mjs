// ============================================================================
// ml.mjs — Herramientas LangChain en vivo de Mercado Libre.
//
// · Lecturas: ml_orders, ml_shipment, ml_questions, ml_listing, ml_messages.
// · Escrituras HACIA AFUERA (afectan a compradores reales): ml_answer_question,
//   ml_update_listing, ml_send_message — TODAS con CONFIRM-GATE de dos fases,
//   reforzado en el servidor (no solo por prompt). Ver B.3 del plan.
//
// El cliente de ML se construye PEREZOSAMENTE: solo cuando una herramienta ml_*
// se ejecuta. Si el usuario no tiene cuenta conectada, devuelve un mensaje
// amable ("no estás conectado") sin romper la conversación.
//
// Reusa makeMlClient (ml-sync.js) para refresco de token + backoff.
// ============================================================================

import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import * as domain from './domain.mjs';

const j = (o) => JSON.stringify(o);
const NOT_CONNECTED = j({ error: 'no_conectado', msg: 'No estás conectado a Mercado Libre. Conecta tu cuenta para ver pedidos, preguntas y publicaciones.' });

// Costo de envío REAL de un envío de ML (port de ml-sync.js:232-241).
async function getShip(c, shippingId) {
  if (!shippingId) return null;
  try {
    const costs = await c.get('/shipments/' + shippingId + '/costs', { allow404: true, headers: { 'x-format-new': 'true' } });
    if (!costs) return null;
    if (Array.isArray(costs.senders) && costs.senders.length && typeof costs.senders[0].cost === 'number') return costs.senders[0].cost;
    if (typeof costs.gross_amount === 'number') return costs.gross_amount;
    return null;
  } catch (e) { return null; }
}

// ---- Normalizadores (respuestas crudas de ML → forma estable) ----
function normOrder(o) {
  const items = (o.order_items || []).map(it => ({
    itemId: String(it.item && it.item.id || ''),
    title: (it.item && it.item.title) || '',
    quantity: it.quantity || 1,
    unitPrice: it.unit_price || 0
  }));
  const buyer = o.buyer ? (o.buyer.nickname || (o.buyer.first_name ? (o.buyer.first_name + ' ' + (o.buyer.last_name || '')).trim() : '') || String(o.buyer.id || '')) : '';
  return {
    id: String(o.id),
    date: (o.date_created || '').slice(0, 10),
    buyer,
    items,
    total: o.total_amount != null ? o.total_amount : items.reduce((a, x) => a + x.unitPrice * x.quantity, 0),
    status: o.status || '',
    shipmentId: o.shipping && o.shipping.id != null ? String(o.shipping.id) : null
  };
}
function normQuestion(q) {
  return {
    questionId: String(q.id),
    itemId: String(q.item_id || ''),
    text: q.text || '',
    date: (q.date_created || '').slice(0, 10),
    status: q.status || '',
    from: q.from && q.from.id != null ? String(q.from.id) : ''
  };
}
function normListing(it) {
  return {
    id: String(it.id),
    title: it.title || '',
    price: it.price,
    available_quantity: it.available_quantity,
    status: it.status || '',
    permalink: it.permalink || ''
  };
}

// ---- Confirm-gate (dos fases, server-side) ----
// sig: firma estable de la acción+args. confirmToken: presente => intento de ejecución.
async function confirmGate(ctx, sig, confirmToken, preview, execFn) {
  const pend = ctx.thread.pendingConfirms = ctx.thread.pendingConfirms || [];
  if (confirmToken) {
    const found = pend.find(p => p.token === confirmToken);
    // Solo ejecuta si: token existe, la firma coincide con los args actuales, y
    // pasó un turno HUMANO real desde la propuesta (issuedAtTurn < turno actual).
    if (found && found.actionSig === sig && found.issuedAtTurn < ctx.currentTurn) {
      ctx.thread.pendingConfirms = pend.filter(p => p.token !== confirmToken);
      return execFn();
    }
    // token forjado / firma cambiada / mismo turno → NO ejecuta, re-propone.
  }
  const token = ctx.mintToken();
  pend.push({ token, actionSig: sig, issuedAtTurn: ctx.currentTurn });
  ctx.proposed.push({ token, ...preview });
  return j({
    proposed: true,
    confirmToken: token,
    preview,
    msg: 'Esta acción afecta a un cliente real. Muéstrale al usuario EXACTAMENTE esto y pide confirmación. ' +
      'Para ejecutarla, vuelve a llamar esta misma herramienta con confirmToken="' + token + '" SOLO cuando el usuario confirme (en un mensaje posterior).'
  });
}

// Cliente ML perezoso + cacheado por turno en ctx._client (un solo memoizador,
// una sola política de error: null si no conectado). Compartido con agent.mjs.
export async function cachedClient(ctx) {
  if (ctx._client !== undefined) return ctx._client;
  ctx._client = (typeof ctx.getClient === 'function') ? await ctx.getClient() : null;
  return ctx._client;
}

export function buildMlTools(ctx) {
  const client = () => cachedClient(ctx);
  const sellerId = async () => { const c = await client(); return c ? (c.state().userId) : null; };

  const ml_orders = tool(
    async (args) => {
      const c = await client(); if (!c) return NOT_CONNECTED;
      const status = args.status === 'all' ? 'paid' : (args.status || 'paid');
      const limit = Math.min(Math.max(Number(args.limit) || 20, 1), 50);
      const orders = await c.fetchOrders(status, args.from || null);
      return j(orders.slice(0, limit).map(normOrder));
    },
    {
      name: 'ml_orders',
      description: 'Pedidos en vivo de la cuenta de Mercado Libre del usuario (normalizados). status paid/cancelled/all; from YYYY-MM-DD; limit.',
      schema: z.object({
        status: z.enum(['paid', 'cancelled', 'all']).optional(),
        from: z.string().optional(),
        limit: z.number().optional()
      })
    }
  );

  const ml_register_order_by_id = tool(
    async (args) => {
      const c = await client(); if (!c) return NOT_CONNECTED;
      const state = ctx.state || {};
      const mark = (f) => ctx.changed.add(f);
      const findProduct = (id) => (state.products || []).find(p => p.id === id);
      const orderId = String(args.orderId);
      const order = await c.get('/orders/' + encodeURIComponent(orderId), { allow404: true });
      if (!order || !order.id) return j({ error: 'no_encontrado', msg: 'No encontré el pedido ' + orderId + ' en tu cuenta de Mercado Libre.' });
      const items = order.order_items || [];
      if (!items.length) return j({ error: 'sin_items', msg: 'El pedido ' + orderId + ' no tiene ítems.' });
      const totalQty = items.reduce((s, it) => s + (it.quantity || 1), 0) || 1;
      const iso = order.date_created || ctx.nowIso();
      const date = iso.slice(0, 10);
      const time = (iso.split('T')[1] || '00:00').slice(0, 5);
      const realShip = await getShip(c, order.shipping && order.shipping.id);

      state.sales = state.sales || [];
      state.products = state.products || [];
      state.mappings = state.mappings || {};
      const registradas = [], pendingItems = [], yaRegistradas = [];

      for (const it of items) {
        const itemId = String((it.item && it.item.id) || '');
        const title = (it.item && it.item.title) || itemId;
        const qty = it.quantity || 1;
        const unitPrice = it.unit_price || 0;
        const saleFee = (typeof it.sale_fee === 'number') ? it.sale_fee : undefined;
        const listingTypeId = it.listing_type_id;

        // Resolver producto: mapeo previo → auto-mapeo por nombre (>80%).
        let mapping = state.mappings[itemId];
        let product = mapping ? findProduct(mapping.productId) : null;
        if (!product) {
          const auto = domain.suggestProduct(state.products, title, 0.8);
          if (auto && !auto.hasVariants) {
            product = auto; state.mappings[itemId] = { productId: auto.id, productName: auto.name }; mark('mappings');
          } else if (auto && auto.hasVariants) {
            // Producto claro con variantes: solo auto-mapear si la variante es CLARA.
            const av = domain.suggestVariant(auto, title);
            if (av) { product = auto; mapping = { productId: auto.id, productName: auto.name, variantId: av.id, variantLabel: domain.variantLabelOf(av) }; state.mappings[itemId] = mapping; mark('mappings'); }
            else {
              // variante ambigua -> a pendiente para que se elija
              pendingItems.push({ itemId, title, unitPrice, saleFee: saleFee != null ? saleFee : null, quantity: qty, sugerencia: { productId: auto.id, name: auto.name, variantId: null, variantLabel: null, needsVariant: true } });
              continue;
            }
          }
        }
        if (!product) {
          const sug = domain.suggestProduct(state.products, title, 0.4);
          const sv = (sug && sug.hasVariants) ? domain.suggestVariant(sug, title) : null;
          pendingItems.push({ itemId, title, unitPrice, saleFee: saleFee != null ? saleFee : null, quantity: qty, sugerencia: sug ? { productId: sug.id, name: sug.name, variantId: sv ? sv.id : null, variantLabel: sv ? domain.variantLabelOf(sv) : null, needsVariant: !!sug.hasVariants } : null });
          continue;
        }
        // Variante para el descuento/venta: del mapeo, o resolver por título si es clara.
        let variantId = (mapping && mapping.variantId != null) ? mapping.variantId : null;
        if (product.hasVariants && variantId == null) {
          const av = domain.suggestVariant(product, title);
          if (av) { variantId = av.id; state.mappings[itemId] = { productId: product.id, productName: product.name, variantId: av.id, variantLabel: domain.variantLabelOf(av) }; mark('mappings'); }
          else {
            pendingItems.push({ itemId, title, unitPrice, saleFee: saleFee != null ? saleFee : null, quantity: qty, sugerencia: { productId: product.id, name: product.name, variantId: null, variantLabel: null, needsVariant: true } });
            continue;
          }
        }
        const _variant = variantId != null ? domain.findVariant(product, variantId) : null;

        const saleId = domain.saleIdFor({ id: orderId }, itemId);
        if (state.sales.some(s => s.source === 'mercadolibre' && String(s.item_id) === itemId && s.id === saleId)) {
          yaRegistradas.push({ itemId, saleId });
          continue;
        }
        const comm = domain.unitCommissionFor({ sale_fee: saleFee, unit_price: unitPrice, listing_type_id: listingTypeId });
        const commissionPerUnit = +comm.perUnit.toFixed(2);
        const commission = +(commissionPerUnit * qty).toFixed(2);
        const lineShip = realShip != null ? +(realShip * (qty / totalQty)).toFixed(2) : (Number(product.shipping) || 0) * qty;
        const totalPrice = unitPrice * qty;
        const costPrice = _variant ? (Number(_variant.precioCosto) || 0) : (Number(product.costPrice) || 0);
        const profit = totalPrice - costPrice * qty - commission - lineShip;
        const sale = {
          id: saleId, date, time,
          productId: product.id, productName: _variant ? `${product.name} (${domain.variantLabelOf(_variant)})` : product.name,
          quantity: qty, salePrice: unitPrice, costPrice, commission,
          commissionType: 'percentage',
          commissionValue: unitPrice > 0 ? +((commissionPerUnit / unitPrice) * 100).toFixed(2) : 0,
          shipping: lineShip, totalPrice, profit, createdAt: ctx.nowIso(),
          source: 'mercadolibre', item_id: itemId, order_id: orderId,
          feeSource: comm.source, shippingSource: realShip != null ? 'ml' : 'local',
          variantId: _variant ? _variant.id : null, variantLabel: _variant ? domain.variantLabelOf(_variant) : ''
        };
        state.sales.push(sale);
        domain.applyStockDelta(product, sale.variantId, -qty);
        product.lastModified = ctx.nowIso();
        state.mappings[itemId] = { productId: product.id, productName: product.name, variantId: _variant ? _variant.id : null, variantLabel: _variant ? domain.variantLabelOf(_variant) : '' };
        if (Array.isArray(state.pendingMappings)) state.pendingMappings = state.pendingMappings.filter(p => String(p.item_id) !== itemId);
        if (Array.isArray(state.dismissedPending)) state.dismissedPending = state.dismissedPending.filter(x => String(x) !== itemId);
        registradas.push(sale);
      }

      if (registradas.length) { mark('sales'); mark('products'); mark('mappings'); mark('pendingMappings'); if (state.dismissedPending) mark('dismissedPending'); }
      ctx.did.push({ action: 'ml_register_order_by_id', orderId, registradas: registradas.length, pendientes: pendingItems.length });
      return j({
        ok: true, orderId, registradas: registradas.length, ventas: registradas,
        pendingItems, yaRegistradas,
        msg: pendingItems.length
          ? 'Hay ítems sin producto en el CRM. Pídele al usuario el COSTO de cada uno, créalos con add_product y vuelve a llamar ml_register_order_by_id.'
          : undefined
      });
    },
    {
      name: 'ml_register_order_by_id',
      description: 'Registra en el CRM una venta de Mercado Libre indicando SOLO el número de pedido (order_id). Trae automáticamente de ML la comisión REAL (sale_fee) y el envío REAL, descuenta stock, mapea la publicación y evita duplicados (mismo id que el cron). Úsala cuando el usuario diga "agrega/registra la venta de ML <número>". Si devuelve pendingItems (productos que no existen en el CRM), pídele el COSTO al usuario, créalos con add_product y vuelve a llamarla.',
      schema: z.object({ orderId: z.union([z.string(), z.number()]).describe('Número/ID del pedido de Mercado Libre.') })
    }
  );

  const ml_shipment = tool(
    async (args) => {
      const c = await client(); if (!c) return NOT_CONNECTED;
      const s = await c.get('/shipments/' + encodeURIComponent(args.shipmentId), { allow404: true });
      if (!s) return j({ error: 'no_encontrado' });
      return j({ status: s.status || '', substatus: s.substatus || '', tracking: s.tracking_number || '', eta: (s.lead_time && s.lead_time.estimated_delivery_final && s.lead_time.estimated_delivery_final.date) || '' });
    },
    {
      name: 'ml_shipment',
      description: 'Estado de un envío de Mercado Libre por shipmentId (status, substatus, tracking, ETA).',
      schema: z.object({ shipmentId: z.string() })
    }
  );

  const ml_questions = tool(
    async (args) => {
      const c = await client(); if (!c) return NOT_CONNECTED;
      const sid = await sellerId();
      const status = args.status || 'UNANSWERED';
      const qp = status === 'ALL' ? '' : '&status=' + status;
      const data = await c.get('/questions/search?seller_id=' + sid + qp + '&sort_fields=date_created&sort_types=DESC');
      const qs = (data && data.questions) || [];
      return j(qs.map(normQuestion));
    },
    {
      name: 'ml_questions',
      description: 'Preguntas de compradores en las publicaciones del usuario. status UNANSWERED (por defecto), ANSWERED o ALL.',
      schema: z.object({ status: z.enum(['UNANSWERED', 'ANSWERED', 'ALL']).optional() })
    }
  );

  const ml_listing = tool(
    async (args) => {
      const c = await client(); if (!c) return NOT_CONNECTED;
      const it = await c.get('/items/' + encodeURIComponent(args.itemId), { allow404: true });
      if (!it) return j({ error: 'no_encontrado' });
      return j(normListing(it));
    },
    {
      name: 'ml_listing',
      description: 'Datos en vivo de una publicación (id, título, precio, stock disponible, estado, permalink).',
      schema: z.object({ itemId: z.string() })
    }
  );

  const ml_messages = tool(
    async (args) => {
      const c = await client(); if (!c) return NOT_CONNECTED;
      const sid = await sellerId();
      const data = await c.get('/messages/packs/' + encodeURIComponent(args.orderId) + '/sellers/' + sid, { allow404: true, headers: { 'x-format-new': 'true' } });
      const msgs = (data && data.messages) || [];
      return j(msgs.map(m => ({
        from: m.from && m.from.user_id != null ? String(m.from.user_id) : '',
        text: (m.text && (m.text.plain || m.text)) || m.message || '',
        date: (m.message_date && (m.message_date.created || m.message_date)) || ''
      })));
    },
    {
      name: 'ml_messages',
      description: 'Hilo de mensajes con el comprador de un pedido (orderId / pack id).',
      schema: z.object({ orderId: z.string() })
    }
  );

  // ----- Escrituras confirm-gated -----

  const ml_answer_question = tool(
    async (args) => {
      const c = await client(); if (!c) return NOT_CONNECTED;
      const sig = 'answer:' + args.questionId + ':' + args.text;
      return confirmGate(ctx, sig, args.confirmToken,
        { tipo: 'ml_answer_question', questionId: args.questionId, text: args.text },
        async () => {
          await c.request('POST', '/answers', { question_id: Number(args.questionId), text: args.text });
          ctx.did.push({ action: 'ml_answer_question', questionId: args.questionId });
          return j({ ok: true, answered: args.questionId });
        });
    },
    {
      name: 'ml_answer_question',
      description: 'Responde una pregunta de un comprador en ML. ACCIÓN HACIA AFUERA: confirm-gated. Sin confirmToken solo PROPONE (muestra el texto y pide confirmación); con confirmToken válido (turno posterior) ejecuta.',
      schema: z.object({ questionId: z.string(), text: z.string(), confirmToken: z.string().optional() })
    }
  );

  const ml_update_listing = tool(
    async (args) => {
      const c = await client(); if (!c) return NOT_CONNECTED;
      const body = {};
      if (args.price != null) body.price = args.price;
      if (args.available_quantity != null) body.available_quantity = args.available_quantity;
      if (args.status != null) body.status = args.status;
      const sig = 'item:' + args.itemId + ':' + JSON.stringify(body);
      return confirmGate(ctx, sig, args.confirmToken,
        { tipo: 'ml_update_listing', itemId: args.itemId, cambios: body },
        async () => {
          await c.request('PUT', '/items/' + encodeURIComponent(args.itemId), body);
          ctx.did.push({ action: 'ml_update_listing', itemId: args.itemId, cambios: body });
          return j({ ok: true, updated: args.itemId, cambios: body });
        });
    },
    {
      name: 'ml_update_listing',
      description: 'Modifica una publicación (precio, stock disponible, estado active/paused). ACCIÓN HACIA AFUERA: confirm-gated.',
      schema: z.object({
        itemId: z.string(),
        price: z.number().optional(),
        available_quantity: z.number().optional(),
        status: z.enum(['active', 'paused']).optional(),
        confirmToken: z.string().optional()
      })
    }
  );

  const ml_send_message = tool(
    async (args) => {
      const c = await client(); if (!c) return NOT_CONNECTED;
      const sid = await sellerId();
      const sig = 'msg:' + args.orderId + ':' + args.text;
      return confirmGate(ctx, sig, args.confirmToken,
        { tipo: 'ml_send_message', orderId: args.orderId, text: args.text },
        async () => {
          await c.request('POST', '/messages/packs/' + encodeURIComponent(args.orderId) + '/sellers/' + sid,
            { from: { user_id: sid }, text: args.text }, { headers: { 'x-format-new': 'true' } });
          ctx.did.push({ action: 'ml_send_message', orderId: args.orderId });
          return j({ ok: true, sent: args.orderId });
        });
    },
    {
      name: 'ml_send_message',
      description: 'Envía un mensaje al comprador de un pedido. ACCIÓN HACIA AFUERA: confirm-gated.',
      schema: z.object({ orderId: z.string(), text: z.string(), confirmToken: z.string().optional() })
    }
  );

  return [
    ml_orders, ml_register_order_by_id, ml_shipment, ml_questions, ml_listing, ml_messages,
    ml_answer_question, ml_update_listing, ml_send_message
  ];
}
