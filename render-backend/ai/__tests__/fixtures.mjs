// Golden fixture: estado CRM conocido para probar la exactitud del dominio.
// Números elegidos a mano para poder afirmar valores EXACTOS en los tests.

export const NOW = new Date('2026-06-20T12:00:00.000Z');

export function goldenState() {
  return {
    products: [
      {
        id: 1, name: 'Audífonos Pro', costPrice: 10000, salePrice: 25000,
        stock: 8, stockInit: 10, stockMin: 5, shipping: 2000,
        commission: 10, commissionType: 'percentage',
        hasVariants: false, variants: [], archived: false,
        createdDate: '2026-01-01T00:00:00.000Z', lastModified: '2026-01-01T00:00:00.000Z'
      },
      {
        id: 2, name: 'Cargador USB-C', costPrice: 2000, salePrice: 6000,
        stock: 3, stockInit: 20, stockMin: 5, shipping: 1000,
        commission: 500, commissionType: 'fixed',
        hasVariants: false, variants: [], archived: false,
        createdDate: '2026-01-01T00:00:00.000Z', lastModified: '2026-01-01T00:00:00.000Z'
      },
      {
        id: 3, name: 'Teclado Viejo', costPrice: 5000, salePrice: 12000,
        stock: 0, stockInit: 5, stockMin: 2, shipping: 1500,
        commission: 10, commissionType: 'percentage',
        hasVariants: false, variants: [], archived: true,
        createdDate: '2025-12-01T00:00:00.000Z', lastModified: '2025-12-01T00:00:00.000Z'
      }
    ],
    sales: [
      {
        id: 101, date: '2026-06-20', time: '10:00', productId: 1, productName: 'Audífonos Pro',
        quantity: 2, salePrice: 25000, costPrice: 10000, commission: 5000,
        commissionType: 'percentage', commissionValue: 10, shipping: 4000,
        totalPrice: 50000, profit: 21000, source: 'mercadolibre', createdAt: '2026-06-20T10:00:00.000Z'
      },
      {
        id: 102, date: '2026-06-10', time: '15:00', productId: 2, productName: 'Cargador USB-C',
        quantity: 3, salePrice: 6000, costPrice: 2000, commission: 1500,
        commissionType: 'fixed', commissionValue: 500, shipping: 3000,
        totalPrice: 18000, profit: 7500, source: 'manual', createdAt: '2026-06-10T15:00:00.000Z'
      },
      {
        id: 103, date: '2026-05-15', time: '09:00', productId: 1, productName: 'Audífonos Pro',
        quantity: 1, salePrice: 25000, costPrice: 10000, commission: 2500,
        commissionType: 'percentage', commissionValue: 10, shipping: 2000,
        totalPrice: 25000, profit: 10500, source: 'manual', createdAt: '2026-05-15T09:00:00.000Z'
      }
    ],
    goals: { mensual: { objetivo: 50000, mes: '2026-06', tipoMeta: 'ganancia' } },
    tasks: [
      { id: 1, titulo: 'Reponer cargadores', fecha: '2026-06-25', prioridad: 'alta', estado: 'pendiente' }
    ],
    expenses: [
      { id: 1, nombre: 'Bencina', monto: 3000, fecha: '2026-06-05' }
    ],
    gastosFijos: [
      { id: 1, nombre: 'Arriendo', monto: 12000, frecuencia: 'mensual', desde: '2026-01' }
    ],
    finConfig: {
      ivaEnabled: true, ivaPct: 19, ivaMensual: {},
      publicidadMensual: { '2026-06': 5000 }
    },
    mappings: {}, pendingMappings: [], notifications: []
  };
}
