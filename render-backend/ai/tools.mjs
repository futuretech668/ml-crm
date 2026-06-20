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

  const add_sale = tool(
    async (args) => {
      const product = findProduct(args.productId);
      if (!product) return j({ error: 'No existe un producto con ese id. Usa list_products para ver los ids.' });
      const sale = domain.buildSalePayload(product, args, {
        id: ctx.nextId(), today: ctx.today(), time: ctx.time(), nowIso: ctx.nowIso()
      });
      state.sales = state.sales || [];
      state.sales.push(sale);
      product.stock = Math.max(0, (product.stock || 0) - sale.quantity);
      mark('sales'); mark('products');
      ctx.did.push({ action: 'add_sale', saleId: sale.id, productName: sale.productName, quantity: sale.quantity, totalPrice: sale.totalPrice, profit: sale.profit });
      return j({ ok: true, sale });
    },
    {
      name: 'add_sale',
      description: 'Registra una venta en el CRM del usuario. profit = total − costo·cantidad − comisión − envío. Descuenta el stock del producto. salePrice/costPrice por defecto son los del producto.',
      schema: z.object({
        productId: z.number(),
        quantity: z.number(),
        salePrice: z.number().optional(),
        costPrice: z.number().optional(),
        commission: z.number().optional(),
        commissionType: z.enum(['fixed', 'percentage']).optional(),
        shipping: z.number().optional(),
        date: z.string().optional().describe('YYYY-MM-DD; por defecto hoy.'),
        source: z.enum(['manual', 'mercadolibre', 'otro']).optional()
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
      if (product) product.stock = (product.stock || 0) + (removed.quantity || 0);
      mark('sales'); if (product) mark('products');
      ctx.did.push({ action: 'delete_sale', saleId: removed.id, productName: removed.productName });
      return j({ ok: true, removed });
    },
    {
      name: 'delete_sale',
      description: 'Elimina una venta del CRM por id y restaura el stock del producto.',
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
      description: 'Crea un producto en el CRM con la forma exacta de la app.',
      schema: z.object({
        name: z.string(),
        costPrice: z.number(),
        salePrice: z.number(),
        stock: z.number(),
        stockMin: z.number().optional(),
        shipping: z.number().optional(),
        commission: z.number().optional(),
        commissionType: z.enum(['fixed', 'percentage']).optional()
      })
    }
  );

  const edit_product = tool(
    async (args) => {
      const product = findProduct(args.id);
      if (!product) return j({ error: 'No existe un producto con ese id.' });
      const fields = ['name', 'costPrice', 'salePrice', 'stock', 'stockMin', 'shipping', 'commission', 'commissionType'];
      for (const f of fields) if (args[f] !== undefined) product[f] = args[f];
      product.lastModified = ctx.nowIso();
      mark('products');
      ctx.did.push({ action: 'edit_product', productId: product.id, name: product.name });
      return j({ ok: true, product });
    },
    {
      name: 'edit_product',
      description: 'Edita campos de un producto existente (por id). Solo cambia los campos provistos.',
      schema: z.object({
        id: z.number(),
        name: z.string().optional(),
        costPrice: z.number().optional(),
        salePrice: z.number().optional(),
        stock: z.number().optional(),
        stockMin: z.number().optional(),
        shipping: z.number().optional(),
        commission: z.number().optional(),
        commissionType: z.enum(['fixed', 'percentage']).optional()
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

  return [
    query_sales, list_products, get_goal_progress, get_finance_summary,
    add_sale, delete_sale, add_product, edit_product, manage_task,
    save_memory, send_report
  ];
}

// Helper de test/orquestación: indexa las herramientas por nombre.
export function toolsByName(tools) {
  const m = {};
  for (const t of tools) m[t.name] = t;
  return m;
}
