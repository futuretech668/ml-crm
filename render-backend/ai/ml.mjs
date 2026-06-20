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

const j = (o) => JSON.stringify(o);
const NOT_CONNECTED = j({ error: 'no_conectado', msg: 'No estás conectado a Mercado Libre. Conecta tu cuenta para ver pedidos, preguntas y publicaciones.' });

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
    ml_orders, ml_shipment, ml_questions, ml_listing, ml_messages,
    ml_answer_question, ml_update_listing, ml_send_message
  ];
}
