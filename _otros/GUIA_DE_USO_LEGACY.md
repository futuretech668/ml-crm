# 📱 GUÍA DE USO - ML Manager CRM

**Versión:** 1.0  
**Última actualización:** 13/06/2026  
**Estado:** ✅ Operacional

---

## 🚀 INICIO RÁPIDO

### Abrir la aplicación
1. Descarga todos los archivos en la carpeta `ml-crm-app`
2. Abre `index.html` en tu navegador
3. ¡Listo! La app se cargará

### Primeros pasos
1. Crea un producto en la sección **Productos**
2. Registra una venta en **Ventas**
3. Mira cómo se actualiza todo en el **Dashboard**

---

## 📊 SECCIONES PRINCIPALES

### 1️⃣ DASHBOARD
**¿Qué es?** Centro de control con métricas principales

**KPIs que ves:**
- 💰 **Ganancia:** Total de ganancias
- 💵 **Ingresos:** Total de ventas
- 📦 **Unidades:** Cantidad vendida
- 📈 **Precio promedio:** Promedio por unidad

**Gráficas:**
- 🏆 **Top 5 Productos:** Los más vendidos
- 📉 **Stock Bajo:** Productos con menos inventario
- 📊 **Ingresos vs Costo:** Comparativa
- 📈 **Margen %:** Rentabilidad por producto

**Alertas:**
- ⚠️ Productos con stock bajo (≤50%)
- 🔴 Productos críticos (≤25%)

**Período:**
- 📅 Filtra por: Hoy / Este mes / Este año / TODO

---

### 2️⃣ VENTAS
**¿Qué es?** Registro y historial de todas tus ventas

**Registrar venta:**
1. Elige **Fecha** y **Hora** (prerellenadas)
2. Selecciona **Producto** del dropdown
3. Ingresa **Cantidad** (máximo: stock disponible)
4. Presiona **Guardar Venta**
5. ✅ Se actualiza: Dashboard, Inventario, Análisis, Alertas

**Historial:**
- Tabla con TODAS las ventas
- Ver: Fecha, Hora, Producto, Cantidad, Precios, Ganancia
- 🗑️ Botón para **Eliminar venta** (devuelve stock)

**Período:**
- 📅 Filtra por: Hoy / Este mes / Este año / TODO

**Validaciones:**
- ❌ No puede vender más que el stock
- ❌ No puede usar fecha futura
- ⚠️ Si el margen es negativo, pide confirmación

---

### 3️⃣ PRODUCTOS
**¿Qué es?** Gestión de tu catálogo de productos

**Crear producto:**
1. Rellena **Nombre** (ej: "iPhone 13")
2. **Precio compra:** Cuánto pagaste (ej: 800000)
3. **Precio venta:** A cuánto lo vendes (ej: 1200000)
4. **Stock inicial:** Cuánto tienes (ej: 10)
5. **Tipo de comisión:** % o Fijo
6. **Comisión:** Valor (ej: 13% o 15000)
7. **Envío:** Costo por unidad (ej: 5000)
8. Presiona **Guardar**

**Margen calculado automáticamente:**
```
Ganancia = Precio venta - Precio compra - Comisión - Envío
```

**Lista de productos:**
- Ver: Nombre, Stock, Precio, Ganancia/unidad
- ✏️ **Editar:** Cambiar datos
- 🗑️ **Archivar:** Ocultar (no eliminar)

**Validaciones:**
- ❌ Precio venta debe ser ≥ precio compra
- ❌ Comisión % entre 0-100
- ⚠️ Si ganancia es negativa, pide confirmación

---

### 4️⃣ INVENTARIO
**¿Qué es?** Control de stock en tiempo real

**Tabla muestra:**
- 📦 **Producto:** Nombre
- 📊 **Stock actual:** Cuánto tienes ahora
- 🎯 **Stock inicial:** Referencia
- 📈 **Porcentaje:** Stock actual / Stock inicial
- 🟢 **Estado:** OK / BAJO / CRÍTICO

**Actualizar stock:**
1. Haz clic en el campo de stock
2. Cambia el valor
3. Presiona **Guardar**
4. ✅ Se actualiza: Dashboard, Análisis, Alertas

**Estados:**
- 🟢 **OK:** > 50% del stock inicial
- 🟡 **BAJO:** 26-50% del stock inicial
- 🔴 **CRÍTICO:** ≤ 25% del stock inicial

---

### 5️⃣ ANÁLISIS
**¿Qué es?** Análisis profundo de rendimiento

**KPIs totales:**
- 💰 **Ingresos totales:** De todas las ventas
- 📊 **Costo total:** Costo de lo vendido
- 💵 **Ganancia neta:** Ingresos - Costo
- 📈 **Promedio/venta:** Ganancia / Número de ventas

**Tabla detallada por producto:**
- Nombre del producto
- Número de ventas
- Ingresos generados
- Ganancia total
- Margen %

**Top 3 productos:**
- Los 3 con MAYOR GANANCIA TOTAL
- Muestra: Ganancia, Ingresos, Ventas

---

### 6️⃣ ALERTAS
**¿Qué es?** Centro de alertas de stock bajo

**Tipos de alertas:**
- 🔴 **CRÍTICO:** Stock ≤ 25% del inicial
- 🟡 **BAJO:** Stock 26-50% del inicial

**Información:**
- Nombre del producto
- Stock actual
- Porcentaje actual

**Acción:**
- Ve a **Inventario** para actualizar stock
- O ve a **Productos** para reabastecer

---

### 7️⃣ CONFIGURACIÓN
**¿Qué es?** Backup, restore y limpieza

#### 📤 Exportar datos
- Botón **"📥 Exportar datos"**
- Descarga archivo `ml-backup-YYYY-MM-DD.json`
- Contiene: Todos los productos y ventas
- Úsalo para: Backup, compartir, migrar

#### 📥 Importar datos
- Botón **"📤 Importar datos"**
- Selecciona archivo `.json` guardado
- Restaura: Productos y ventas
- ⚠️ Sobrescribe datos actuales

#### 📥 Importar desde Mercado Libre
- Botón **"📦 Importar ventas de ML"**
- Formatos soportados: CSV o JSON
- CSV esperado: `producto,precio,cantidad`
- Resultado: Crea productos, agrega historial

#### 🗑️ Limpiar TODO
- Botón **"🗑️ LIMPIAR TODO"** (Rojo)
- Elimina: Todos los productos y ventas
- ⚠️ **NO se puede deshacer**
- Pide confirmación doble

---

## 🎯 FLUJOS DE TRABAJO COMUNES

### Workflow 1: Día típico
```
1. Mañana: Ve al Dashboard para ver estado
   └─ ¿Stock bajo? → Ve a Inventario
   
2. Durante el día: Registra ventas en Ventas
   └─ Dashboard se actualiza automáticamente
   
3. Fin de día: Exporta datos como backup
   └─ Botón en Configuración → Exportar
```

### Workflow 2: Agregar stock
```
1. Sección Inventario
2. Haz clic en el stock del producto
3. Cambia el número
4. Presiona Guardar
5. ✅ Dashboard, Análisis y Alertas se actualizan
```

### Workflow 3: Arreglar error
```
1. Registraste venta por error
2. Ve a Ventas → Tabla
3. Encuentra la venta → Botón 🗑️
4. Confirma eliminación
5. ✅ Stock se devuelve automáticamente
```

### Workflow 4: Cambiar período
```
1. En Dashboard o Ventas
2. Haz clic en período deseado:
   - "Hoy" → ventas de hoy
   - "Este mes" → ventas del mes
   - "Este año" → ventas del año
   - "TODO" → todas las ventas
3. ✅ KPIs y tabla se filtran
```

---

## 💡 CONSEJOS

### Comisión
- **% es común** en Mercado Libre (ej: 13%)
- **Fijo** si tienes acuerdo especial (ej: $15,000)
- Cambia tipo en dropdown: "Porcentaje" o "Fijo"

### Margen negativo
- Si después de restar comisión + envío quedan pérdidas
- La app te lo advierte
- Puedes continuar, pero **revisa tus precios**

### Stock inicial
- Referencia para calcular alertas
- Si actualizas stock, usa "Stock inicial" como referencia
- Alertas se basan en: Stock actual / Stock inicial

### Backup
- Exporta al menos 1 vez por semana
- Guarda en carpeta segura o cloud
- Puedes restaurar en cualquier momento

### Importar de ML
- Descarga tus ventas de Mercado Libre
- Formatea como CSV: producto,precio,cantidad
- La app crea los productos automáticamente
- ¡Todos los datos se sincronizan!

---

## ⚡ ATAJOS

| Tarea | Sección | Botón |
|-------|---------|-------|
| Ver resumen | Dashboard | Inicio |
| Registrar venta | Ventas | 💳 |
| Crear producto | Productos | 📦 |
| Cambiar stock | Inventario | 🏭 |
| Ver análisis | Análisis | 📈 |
| Ver alertas | Alertas | ⚠️ |
| Backup/Restore | Configuración | ⚙️ |

---

## 🐛 TROUBLESHOOTING

### El app no carga
- **Solución:** Actualiza la página (F5 o Cmd+R)
- Limpia caché: Ctrl+Shift+Del (Chrome) o Cmd+Shift+Del (Mac)

### Los datos no se guardan
- **Verificar:** ¿Aceptó el navegador almacenar datos?
- **Solución:** Verifica que localStorage esté habilitado
- Algunos navegadores en "modo privado" no guardan

### Un gráfico no muestra
- **Solución:** Crea más productos con ventas
- Los gráficos vacíos muestran "Sin datos"

### Números se ven raros
- **Nota:** Formato es CLP (Chilean Pesos)
- $1.000.000 = un millón
- . es separador de miles, no decimales

### Cambié período pero datos no cambian
- **Verificar:** ¿Estás en Dashboard o Ventas?
- Solo esas secciones filtran por período
- Análisis y Alertas siempre muestran TODO

### Quiero restaurar datos viejos
- **Paso 1:** Configuración → Importar datos
- **Paso 2:** Selecciona backup `.json`
- **Paso 3:** Se restauran todos los datos
- ⚠️ Sobrescribe datos actuales

---

## 📱 EN MÓVIL

### Abrir menú
- Presiona botón ☰ en la esquina superior izquierda
- Selecciona sección
- Menú se cierra automáticamente

### Usar formularios
- Todo es tocable (botones, inputs, gráficos)
- Swipe para scroll horizontal en tablas
- Pinch para zoom en gráficos (algunos)

### Ver tablas
- Desliza hacia los lados para ver más columnas
- Botones accesibles para eliminar/editar

---

## 🎨 TEMA

- **Bot☀️n en sidebar (bottom):** Cambia entre modo oscuro (🌙) y claro (☀️)
- Se guarda tu preferencia
- Por defecto: Modo oscuro

---

## 📞 SOPORTE

Si algo no funciona:
1. Intenta actualizar la página
2. Limpia caché del navegador
3. Revisa la consola (F12) por errores
4. Intenta en otro navegador

---

## 🎉 ¡Listo!

Ya tienes todo lo que necesitas. La app es:
- ✅ **Fácil de usar**
- ✅ **Rápida**
- ✅ **Segura** (datos locales)
- ✅ **Sin conexión** (funciona offline)
- ✅ **Exportable/Importable**

¡Empieza a registrar tus ventas! 🚀

