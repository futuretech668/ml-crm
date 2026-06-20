/**
 * email-templates.js — Plantillas HTML profesionales para los correos de "NexSell"
 * ------------------------------------------------------------------------------
 * SOLO se exportan funciones que construyen el HTML de cada tipo de correo.
 * Tema claro, legible, datos en tablas, montos en CLP con el símbolo $.
 *
 * Funciones:
 *   - buildSaleEmail(sale)        -> aviso de venta nueva
 *   - buildLowStockEmail(product) -> aviso de stock bajo / agotado
 *   - buildWeeklyReport(stats)    -> reporte semanal
 *   - buildMonthlyReport(stats)   -> reporte mensual
 *
 * Este archivo es 100% aditivo: no toca ni depende de sync-ml.js.
 */

// Formatea un número como pesos chilenos: 12345 -> "$12.345"
function clp(n) {
    const v = Math.round(Number(n) || 0);
    return '$' + v.toLocaleString('es-CL');
}

// Escapa texto para insertarlo de forma segura dentro del HTML.
function esc(s) {
    return String(s == null ? '' : s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

// Marca de color de "NexSell".
const BRAND = {
    primary: '#2d6cdf',
    primaryDark: '#1f4fa8',
    bg: '#f4f6fb',
    card: '#ffffff',
    text: '#1c2433',
    muted: '#6b7488',
    border: '#e4e8f0',
    good: '#1f9d57',
    warn: '#e09b2d',
    bad: '#d64545'
};

// Envoltorio común: cabecera con la marca, contenido y pie.
function layout(title, accent, innerHtml, subtitle) {
    const accentColor = accent || BRAND.primary;
    return `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${esc(title)}</title>
</head>
<body style="margin:0;padding:0;background:${BRAND.bg};font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:${BRAND.text};">
  <div style="max-width:640px;margin:0 auto;padding:24px 16px;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${BRAND.card};border:1px solid ${BRAND.border};border-radius:14px;overflow:hidden;">
      <tr>
        <td style="background:${accentColor};padding:22px 28px;">
          <div style="font-size:13px;letter-spacing:1.5px;color:rgba(255,255,255,0.82);text-transform:uppercase;font-weight:600;">NexSell</div>
          <div style="font-size:21px;color:#ffffff;font-weight:700;margin-top:4px;">${esc(title)}</div>
          ${subtitle ? `<div style="font-size:13px;color:rgba(255,255,255,0.9);margin-top:6px;">${esc(subtitle)}</div>` : ''}
        </td>
      </tr>
      <tr>
        <td style="padding:28px;">
          ${innerHtml}
        </td>
      </tr>
      <tr>
        <td style="padding:18px 28px;background:${BRAND.bg};border-top:1px solid ${BRAND.border};">
          <div style="font-size:12px;color:${BRAND.muted};line-height:1.5;">
            Este es un mensaje automático de <strong>NexSell</strong>, tu CRM de Mercado Libre.<br>
            Generado el ${esc(new Date().toLocaleString('es-CL'))}.
          </div>
        </td>
      </tr>
    </table>
  </div>
</body>
</html>`;
}

// Una fila clave/valor para las tablas de detalle.
function row(label, value, opts) {
    const o = opts || {};
    const valColor = o.color || BRAND.text;
    const weight = o.strong ? '700' : '500';
    return `<tr>
      <td style="padding:10px 0;border-bottom:1px solid ${BRAND.border};color:${BRAND.muted};font-size:14px;">${esc(label)}</td>
      <td style="padding:10px 0;border-bottom:1px solid ${BRAND.border};color:${valColor};font-size:14px;font-weight:${weight};text-align:right;">${value}</td>
    </tr>`;
}

// =================== VENTA NUEVA ===================
function buildSaleEmail(sale) {
    const s = sale || {};
    const qty = s.quantity || 1;
    const unit = s.salePrice != null ? s.salePrice : (s.totalPrice ? s.totalPrice / qty : 0);
    const total = s.totalPrice != null ? s.totalPrice : unit * qty;
    const profit = s.profit != null ? s.profit : null;
    const profitColor = profit == null ? BRAND.text : (profit >= 0 ? BRAND.good : BRAND.bad);

    const inner = `
      <p style="margin:0 0 18px;font-size:15px;line-height:1.5;color:${BRAND.text};">
        Se registró una <strong>venta nueva</strong> en tu cuenta de Mercado Libre.
      </p>
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;">
        ${row('Producto', esc(s.productName || s.title || 'Producto'), { strong: true })}
        ${row('Cantidad', esc(qty))}
        ${row('Precio unitario', clp(unit))}
        ${row('Total venta', clp(total), { strong: true })}
        ${s.commission != null ? row('Comisión ML', '-' + clp(s.commission), { color: BRAND.bad }) : ''}
        ${s.shipping != null ? row('Envío', '-' + clp(s.shipping), { color: BRAND.bad }) : ''}
        ${profit != null ? row('Ganancia neta', clp(profit), { strong: true, color: profitColor }) : ''}
        ${(s.date || s.time) ? row('Fecha', esc((s.date || '') + ' ' + (s.time || '')).trim()) : ''}
        ${s.order_id ? row('N° de orden', esc(s.order_id)) : ''}
      </table>`;
    return {
        subject: `Nueva venta: ${s.productName || s.title || 'producto'} (${clp(total)})`,
        html: layout('Nueva venta registrada', BRAND.good, inner, clp(total) + ' · ' + qty + ' unidad' + (qty === 1 ? '' : 'es'))
    };
}

// =================== STOCK BAJO / AGOTADO ===================
function buildLowStockEmail(product) {
    const p = product || {};
    const stock = p.stock || 0;
    const isOut = stock <= 0;
    const accent = isOut ? BRAND.bad : BRAND.warn;
    const headline = isOut ? 'Producto agotado' : 'Stock bajo';

    const inner = `
      <p style="margin:0 0 18px;font-size:15px;line-height:1.5;color:${BRAND.text};">
        ${isOut
            ? 'Uno de tus productos se quedó <strong>sin stock</strong>. Repón inventario para no perder ventas.'
            : 'Uno de tus productos alcanzó el <strong>nivel mínimo de stock</strong>. Te conviene reabastecer pronto.'}
      </p>
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;">
        ${row('Producto', esc(p.name || 'Producto'), { strong: true })}
        ${row('Stock actual', esc(stock), { strong: true, color: accent })}
        ${p.stockMin != null ? row('Stock mínimo', esc(p.stockMin)) : ''}
        ${p.costPrice != null ? row('Costo unitario', clp(p.costPrice)) : ''}
        ${(p.salePrice != null || p.price != null) ? row('Precio venta', clp(p.salePrice != null ? p.salePrice : p.price)) : ''}
      </table>`;
    return {
        subject: `${headline}: ${p.name || 'producto'} (${stock} en stock)`,
        html: layout(headline, accent, inner, esc(p.name || 'Producto'))
    };
}

// Construye una tabla de "Top productos" a partir de [{name, qty, revenue}].
function topProductsTable(top) {
    if (!top || !top.length) return '';
    const rows = top.map((t, i) => `
      <tr>
        <td style="padding:9px 0;border-bottom:1px solid ${BRAND.border};color:${BRAND.muted};font-size:13px;width:28px;">${i + 1}.</td>
        <td style="padding:9px 0;border-bottom:1px solid ${BRAND.border};color:${BRAND.text};font-size:14px;">${esc(t.name)}</td>
        <td style="padding:9px 0;border-bottom:1px solid ${BRAND.border};color:${BRAND.muted};font-size:13px;text-align:center;">x${esc(t.qty)}</td>
        <td style="padding:9px 0;border-bottom:1px solid ${BRAND.border};color:${BRAND.text};font-size:14px;text-align:right;font-weight:600;">${clp(t.revenue)}</td>
      </tr>`).join('');
    return `
      <div style="font-size:13px;color:${BRAND.muted};text-transform:uppercase;letter-spacing:.5px;font-weight:600;margin:24px 0 8px;">Productos más vendidos</div>
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;">
        ${rows}
      </table>`;
}

// Bloque de resumen (ventas, ingresos, ganancia, unidades).
function summaryTable(stats) {
    const st = stats || {};
    const profitColor = (st.profit || 0) >= 0 ? BRAND.good : BRAND.bad;
    return `
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;">
        ${row('Ventas', esc(st.count || 0), { strong: true })}
        ${row('Unidades vendidas', esc(st.units || 0))}
        ${row('Ingresos', clp(st.revenue || 0), { strong: true })}
        ${st.commission != null ? row('Comisiones ML', '-' + clp(st.commission), { color: BRAND.bad }) : ''}
        ${st.shipping != null ? row('Envíos', '-' + clp(st.shipping), { color: BRAND.bad }) : ''}
        ${row('Ganancia neta', clp(st.profit || 0), { strong: true, color: profitColor })}
      </table>`;
}

// =================== REPORTE SEMANAL ===================
function buildWeeklyReport(stats) {
    const st = stats || {};
    const inner = `
      <p style="margin:0 0 18px;font-size:15px;line-height:1.5;color:${BRAND.text};">
        Resumen de tu actividad en Mercado Libre durante los <strong>últimos 7 días</strong>${st.periodLabel ? ` (${esc(st.periodLabel)})` : ''}.
      </p>
      ${summaryTable(st)}
      ${topProductsTable(st.top)}`;
    return {
        subject: `Reporte semanal NexSell — ${st.count || 0} ventas, ${clp(st.profit || 0)} de ganancia`,
        html: layout('Reporte semanal', BRAND.primary, inner, st.periodLabel || 'Últimos 7 días')
    };
}

// Bloque comparativo de ganancia vs un periodo previo. Tolerante: si no hay
// datos previos (prev nulo) devuelve string vacío y no rompe la plantilla.
function comparisonBlock(curProfit, prev, prevLabel) {
    if (!prev) return '';
    const prevProfit = Number(prev.profit) || 0;
    const cur = Number(curProfit) || 0;
    const diff = cur - prevProfit;
    const up = diff >= 0;
    const color = up ? BRAND.good : BRAND.bad;
    const arrow = up ? '▲' : '▼';
    let pctTxt = '';
    if (prevProfit !== 0) {
        const pct = (diff / Math.abs(prevProfit)) * 100;
        pctTxt = ` (${up ? '+' : '-'}${Math.abs(pct).toFixed(1)}%)`;
    }
    const label = esc(prevLabel || (prev.label || 'el mes anterior'));
    const detail = prevProfit === 0
        ? `No hay ganancia registrada en ${label} para comparar.`
        : `${up ? 'Más' : 'Menos'} ganancia que ${label} (${clp(prevProfit)}).`;
    return `
      <div style="margin-top:22px;padding:14px 16px;background:${BRAND.bg};border:1px solid ${BRAND.border};border-radius:10px;">
        <div style="font-size:12px;color:${BRAND.muted};text-transform:uppercase;letter-spacing:.5px;font-weight:600;margin-bottom:6px;">Comparativa con el mes anterior</div>
        <div style="font-size:16px;font-weight:700;color:${color};">${arrow} ${clp(Math.abs(diff))}${pctTxt}</div>
        <div style="font-size:13px;color:${BRAND.muted};margin-top:4px;">${detail}</div>
      </div>`;
}

// =================== REPORTE MENSUAL ===================
function buildMonthlyReport(stats) {
    const st = stats || {};
    const starName = (st.top && st.top[0]) ? st.top[0].name : null;
    const starHtml = starName
        ? `<p style="margin:0 0 18px;font-size:14px;line-height:1.5;color:${BRAND.text};">
             Producto estrella del mes: <strong>${esc(starName)}</strong>
             (${esc(st.top[0].qty)} unidad${st.top[0].qty === 1 ? '' : 'es'} · ${clp(st.top[0].revenue)}).
           </p>`
        : '';
    const inner = `
      <p style="margin:0 0 18px;font-size:15px;line-height:1.5;color:${BRAND.text};">
        Resumen de tu actividad en Mercado Libre durante <strong>${esc(st.periodLabel || 'el mes pasado')}</strong>.
      </p>
      ${summaryTable(st)}
      ${starHtml}
      ${topProductsTable(st.top)}
      ${comparisonBlock(st.profit, st.prev, st.prev && st.prev.label)}`;
    return {
        subject: `Reporte mensual NexSell — ${st.periodLabel || ''} (${clp(st.profit || 0)})`.trim(),
        html: layout('Reporte mensual', BRAND.primaryDark, inner, st.periodLabel || 'Mes anterior')
    };
}

// =================== BIENVENIDA (cuenta nueva) ===================
function buildWelcomeEmail(account) {
    const a = account || {};
    const email = a.email || '';
    const inner = `
      <p style="margin:0 0 16px;font-size:15px;line-height:1.6;color:${BRAND.text};">
        ¡Hola! 👋 Tu cuenta de <strong>NexSell</strong> quedó creada con éxito.
      </p>
      <p style="margin:0 0 18px;font-size:15px;line-height:1.6;color:${BRAND.text};">
        Desde ahora puedes gestionar tus ventas de Mercado Libre, controlar inventario,
        finanzas, metas y más — todo en un solo lugar.
      </p>
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;">
        ${row('Correo de la cuenta', esc(email), { strong: true })}
        ${a.createdAt ? row('Creada el', esc(new Date(a.createdAt).toLocaleString('es-CL'))) : ''}
      </table>
      <div style="margin-top:22px;padding:14px 16px;background:${BRAND.bg};border:1px solid ${BRAND.border};border-radius:10px;">
        <div style="font-size:13px;color:${BRAND.muted};line-height:1.6;">
          💡 Consejo: guarda tu <strong>código de recuperación</strong> en un lugar seguro.
          Lo necesitarás si alguna vez olvidas tu contraseña.
        </div>
      </div>`;
    return {
        subject: '¡Bienvenido a NexSell! Tu cuenta está lista',
        html: layout('Bienvenido a NexSell', BRAND.primary, inner, email)
    };
}

// Bloque visual de progreso de la META del mes (barra). Si no hay meta, no muestra nada.
function goalBlock(goal) {
    if (!goal || !goal.objetivo) return '';
    const obj = Number(goal.objetivo) || 0;
    const got = Number(goal.logrado) || 0;
    const pct = obj > 0 ? Math.max(0, Math.min(100, Math.round((got / obj) * 100))) : 0;
    const done = got >= obj && obj > 0;
    const tipoLabel = goal.tipoMeta === 'ganancia' ? 'Ganancia' : (goal.tipoMeta === 'unidades' ? 'Unidades' : 'Monto vendido');
    const fmtVal = (v) => goal.tipoMeta === 'unidades' ? String(Math.round(v)) : clp(v);
    const barColor = done ? BRAND.good : BRAND.primary;
    const faltante = Math.max(0, obj - got);
    return `
      <div style="margin-top:22px;padding:16px;background:${BRAND.bg};border:1px solid ${BRAND.border};border-radius:10px;">
        <div style="font-size:12px;color:${BRAND.muted};text-transform:uppercase;letter-spacing:.5px;font-weight:600;margin-bottom:8px;">Tu meta del mes · ${esc(tipoLabel)}</div>
        <div style="font-size:18px;font-weight:700;color:${barColor};margin-bottom:8px;">${fmtVal(got)} / ${fmtVal(obj)} <span style="font-size:14px;color:${BRAND.muted};font-weight:600;">(${pct}%)</span></div>
        <div style="height:10px;background:${BRAND.border};border-radius:6px;overflow:hidden;">
          <div style="height:10px;width:${pct}%;background:${barColor};border-radius:6px;"></div>
        </div>
        <div style="font-size:13px;color:${BRAND.muted};margin-top:8px;">${done ? '🎉 ¡Meta cumplida! Excelente trabajo.' : `Te falta ${fmtVal(faltante)} para llegar a tu meta.`}</div>
      </div>`;
}

// =================== REPORTE POR USUARIO (resumen + meta) ===================
function buildUserReport(opts) {
    const o = opts || {};
    const rawName = o.name ? String(o.name) : '';
    const name = rawName ? rawName.charAt(0).toUpperCase() + rawName.slice(1) : '';
    const greeting = name ? `Hola ${esc(name)},` : '¡Hola!';
    const inner = `
      <p style="margin:0 0 18px;font-size:15px;line-height:1.5;color:${BRAND.text};">
        ${greeting} este es tu resumen de actividad en NexSell${o.periodLabel ? ` (${esc(o.periodLabel)})` : ''}.
      </p>
      ${summaryTable(o.stats || {})}
      ${goalBlock(o.goal)}
      ${topProductsTable((o.stats || {}).top)}`;
    return {
        subject: `Tu resumen NexSell${o.periodLabel ? ' — ' + o.periodLabel : ''}`,
        html: layout('Tu resumen', BRAND.primary, inner, o.periodLabel || '')
    };
}

module.exports = {
    clp,
    buildSaleEmail,
    buildLowStockEmail,
    buildWeeklyReport,
    buildMonthlyReport,
    buildWelcomeEmail,
    buildUserReport
};
