// Tests del match de variante por SKU (seller_sku de ML == v.sku de la variante).
// El SKU es un atajo de ALTA confianza: si la venta de ML trae un SKU y EXACTAMENTE
// una variante lo tiene, se resuelve directo sin depender del color/talla en el título.
// Cuando no hay SKU (o no calza), debe seguir funcionando el matching por texto.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { suggestVariant, buildVariantPayload } from '../domain.mjs';

// Producto con dos variantes del MISMO color base pero distinto SKU: el texto solo
// NO las desambigua; el SKU sí. Modela el caso real (audífonos LE302, color negro).
function productConSku() {
  return {
    id: 2, name: 'Audifonos LE302', hasVariants: true, archived: false,
    variants: [
      { id: 'v0', color: 'Negro', talla: 'Chico', sku: 'AUD-NEG-S', precioVenta: 20000, precioCosto: 8000, stock: 5 },
      { id: 'v1', color: 'Negro', talla: 'Grande', sku: 'AUD-NEG-L', precioVenta: 20000, precioCosto: 9000, stock: 5 },
      { id: 'v2', color: 'Blanco', talla: 'Chico', sku: 'AUD-BLA-S', precioVenta: 20000, precioCosto: 8000, stock: 5 }
    ]
  };
}

test('suggestVariant resuelve por SKU exacto aunque el título no nombre la variante', () => {
  const p = productConSku();
  // El título no distingue "Chico/Grande"; sin SKU sería ambiguo. Con SKU calza 1-a-1.
  const v = suggestVariant(p, 'Audifonos LE302 negros', 'AUD-NEG-L');
  assert.equal(v && v.id, 'v1');
});

test('match por SKU es case-insensitive y tolera espacios', () => {
  const p = productConSku();
  const v = suggestVariant(p, 'cualquier titulo', '  aud-bla-s ');
  assert.equal(v && v.id, 'v2');
});

test('SKU que no calza con ninguna variante NO inventa match (cae al texto)', () => {
  const p = productConSku();
  // SKU inexistente + título ambiguo (dos variantes "Negro") => null, no fuerza nada.
  const v = suggestVariant(p, 'Audifonos LE302 negros', 'NO-EXISTE');
  assert.equal(v, null);
});

test('sin SKU sigue funcionando el matching por color/talla (sin regresión)', () => {
  const p = productConSku();
  // "blanco chico" identifica inequívocamente a v2 por tokens de color+talla.
  const v = suggestVariant(p, 'Audifonos LE302 blanco chico', '');
  assert.equal(v && v.id, 'v2');
});

test('SKU ambiguo (dos variantes con el mismo sku) NO resuelve por SKU', () => {
  const p = productConSku();
  p.variants[0].sku = 'DUP';
  p.variants[1].sku = 'DUP';
  // Dos calzan por SKU => no se puede decidir; cae al texto, que tampoco distingue => null.
  const v = suggestVariant(p, 'Audifonos LE302 negros', 'DUP');
  assert.equal(v, null);
});

test('buildVariantPayload normaliza el sku (trim, string) y default vacío', () => {
  assert.equal(buildVariantPayload({ color: 'Negro', sku: '  AB-1 ' }, { id: 1 }).sku, 'AB-1');
  assert.equal(buildVariantPayload({ color: 'Negro' }, { id: 1 }).sku, '');
  assert.equal(buildVariantPayload({ color: 'Negro', sku: 123 }, { id: 1 }).sku, '123');
});
