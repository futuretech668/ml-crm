# 📘 ML Manager — Guía paso a paso

Esta guía te lleva desde la app actual hasta tener: base de datos en la nube,
chat con IA, y sincronización automática de ventas de Mercado Libre.

> Archivos en esta carpeta:
> - `index.html` — la app (un solo archivo, deployable en Netlify)
> - `sync-ml.js` — script de sincronización con Mercado Libre (Node)
> - `package.json`, `.env.example`, `.gitignore`

---

## ✅ PASO 0 — Revisión y corrección (HECHO)

Ya corregí estos errores **sin cambiar diseño ni funcionalidad**:

1. **Datos no aparecían al recargar**: las listas de Productos, Ventas, Inventario
   y el selector de productos se renderizaban *antes* de cargar los datos. Ahora se
   refrescan tras cargar (local o nube) y al navegar entre secciones.
2. **3 etiquetas `</div>` sobrantes** al final del HTML → eliminadas.
3. **Llave CSS `}` huérfana** → eliminada.
4. **Función `invalidateCache()` duplicada** → quitada la versión muerta.
5. **IDs decimales en importación de ML** (`Date.now()+Math.random()`) que impedían
   vender esos productos → ahora son enteros y con todos los campos.

**Dos cosas que NO toqué (para no alterar tu app) y debes decidir:**
- 🟡 Los grids están forzados a **1 columna en todas las pantallas** (un bloque CSS
  quedó fuera de su `@media`). Es tu diseño actual. Si quieres multi-columna en
  desktop, avísame y lo envuelvo en su media query.
- 🟡 El KPI **"Ganancia Neta"** del dashboard hace `ingresos − comisiones − envíos`
  pero **no resta el costo de compra**. Puede ser intencional (lo que te deposita ML)
  o un error. Dime si quieres que reste también el costo.

---

## 🔥 PASO 1 — Firebase (base de datos en la nube)

### 1.1 Crear cuenta y proyecto
1. Entra a https://console.firebase.google.com e inicia sesión con tu cuenta Google.
2. Clic en **"Crear un proyecto"** → ponle un nombre (ej. `ml-manager`) → Continuar.
3. Puedes **desactivar Google Analytics** (no es necesario) → **Crear proyecto**.

### 1.2 Crear la base de datos Firestore
1. En el menú izquierdo: **Compilación → Firestore Database**.
2. Clic en **"Crear base de datos"**.
3. Elige **modo de producción** (o de prueba) y una ubicación (ej. `us-central`) → Habilitar.
4. Ve a la pestaña **"Reglas"** y pega esto para uso personal (sin login):
   ```
   rules_version = '2';
   service cloud.firestore {
     match /databases/{database}/documents {
       match /{document=**} {
         allow read, write: if true;
       }
     }
   }
   ```
   > ⚠️ Esto deja la base **abierta**. Sirve para uso personal. Si quieres más
   > seguridad después, podemos agregar login con Firebase Auth.
5. Clic en **"Publicar"**.

### 1.3 Obtener la configuración web
1. Icono de engranaje ⚙️ (arriba izq.) → **Configuración del proyecto**.
2. Baja hasta **"Tus apps"** → clic en el icono **`</>`** (Web).
3. Pon un apodo (ej. `web`) → **Registrar app**.
4. Te mostrará un objeto `firebaseConfig = { ... }`. **Copia esos valores.**

### 1.4 Pegar la config en la app
1. Abre `index.html`.
2. Busca el bloque marcado `🔥 FIREBASE` cerca del inicio (líneas ~17 en adelante).
3. Reemplaza los `PEGA_AQUI_...` por los valores reales de tu `firebaseConfig`.
4. Guarda. ¡Listo! Al abrir la app verás en la consola `🔥 Firebase conectado`.

**Cómo funciona:** la app guarda todo en Firestore (doc `crm/state`) y escucha
cambios en tiempo real, así se sincroniza entre todos tus dispositivos. Si no hay
internet o no configuras Firebase, sigue funcionando con **localStorage** (fallback).

---

## 💬 PASO 2 — Chat con IA (YA FUNCIONA)

- Ya está integrado el **botón flotante 💬** abajo a la derecha.
- Usa **OpenRouter** con el modelo **`xiaomi/mimo-v2.5`** y tu API key (ya hardcodeada).
- El chat conoce tus productos, ventas, stock, comisiones y ganancias.
- Pruébalo con: *"¿Cuánto gané esta semana?"*, *"¿Qué producto tiene más margen?"*,
  *"¿Cuál es mi stock más bajo?"*.

No necesitas configurar nada para el chat. Si quieres, puedes cambiar la API key o el
modelo en el objeto `CHAT` dentro de `index.html`.

---

## 🔄 PASO 3 — Sincronización con Mercado Libre (`sync-ml.js`)

Este script corre en tu computador (terminal) y empuja las ventas a Firebase.

### 3.1 Instalar Node y dependencias
1. Instala **Node.js 18+** desde https://nodejs.org (si no lo tienes).
2. Abre una terminal en esta carpeta (`C:\claude code\ml-crm-app`) y ejecuta:
   ```
   npm install
   ```

### 3.2 Descargar la clave de servicio de Firebase
1. En Firebase: ⚙️ **Configuración del proyecto → Cuentas de servicio**.
2. Clic en **"Generar nueva clave privada"** → se descarga un `.json`.
3. **Renómbralo** a `serviceAccountKey.json` y ponlo en esta carpeta.
   > Este archivo es secreto; ya está en `.gitignore`.

### 3.3 Crear tu app en Mercado Libre y obtener credenciales
1. Entra a https://developers.mercadolibre.cl e inicia sesión con tu cuenta de ML.
2. Menú **"Tus aplicaciones" → "Crear aplicación nueva"**.
3. Completa:
   - **Nombre** y **descripción** (lo que quieras).
   - **URI de redirect**: pon exactamente `http://localhost:3000/callback`
   - **Scopes/Permisos**: marca **read** (y **offline_access** si aparece, para
     poder refrescar el token).
   - Tópicos/notificaciones: puedes dejarlos vacíos.
4. Guarda. Te dará un **App ID (Client ID)** y un **Client Secret (Clave secreta)**.

### 3.4 Configurar el `.env`
1. Copia `.env.example` y renómbralo a `.env`.
2. Rellena:
   ```
   ML_CLIENT_ID=tu_app_id
   ML_CLIENT_SECRET=tu_client_secret
   ML_REDIRECT_URI=http://localhost:3000/callback
   ML_AUTH_DOMAIN=https://auth.mercadolibre.cl
   ```

### 3.5 Autorizar tu cuenta (una sola vez)
```
npm run auth
```
- Te imprime una URL → ábrela en el navegador → **Autorizar**.
- Serás redirigido a `localhost:3000` y verás "Autorización exitosa".
- Se crea `tokens.json` con tu refresh token (no lo compartas).

### 3.6 Iniciar la sincronización
```
npm start
```
- Revisa ventas nuevas **cada 5 minutos** (configurable con `POLL_MINUTES`).
- Para una sola revisión de prueba: `npm run once`.

**Qué registra por cada venta:** precio real de la publicación, comisión según tipo
(**Clásica 13.5%** / **Premium 16.5%**), cantidad, envío y **ganancia neta**.

---

## 🔗 PASO 4 — Mapeo de publicaciones (automático con confirmación)

- Cada publicación de ML (`item_id`) se vincula a un producto de tu app. Ese mapeo
  se guarda en Firebase (`crm/state.mappings`).
- La **primera vez** que llega una venta de una publicación desconocida, `sync-ml.js`
  usa **fuse.js** para adivinar el producto por el título y crea un *pendiente*.
- En la app, el **chat** te avisa: título, precio y a qué producto cree que corresponde.
- Tú **confirmas o corriges en lenguaje natural**, por ejemplo:
  - *"sí, es ese"*
  - *"es el cargador de 65w"*
- La IA entiende, guarda el mapeo y **registra la venta retenida** con el producto correcto.
- **Desde la segunda venta** de esa publicación, se registra **automáticamente** sin preguntar.

---

## 🔔 PASO 5 — Notificaciones en el chat

- **Venta conocida** → mensaje en el chat: `✅ Venta registrada: [producto] x[cant] - $[precio]`.
- **Publicación nueva** → el chat pide confirmación (ver PASO 4).
- El **badge rojo** del botón 💬 muestra cuántas novedades hay sin leer.
- Como todo pasa por Firebase, las notificaciones llegan aunque la venta la haya
  detectado el script mientras la app estaba cerrada: aparecen al abrir el chat.

---

## 🚀 Deploy en Netlify

- `index.html` sigue siendo **un solo archivo**. Puedes arrastrarlo a Netlify
  (https://app.netlify.com/drop) o conectar un repo.
- ⚠️ `sync-ml.js` **NO** se sube a Netlify: corre en tu PC (o un servidor/Raspberry)
  porque necesita estar prendido para revisar ventas cada 5 minutos.

---

## 🧪 Cómo probar rápido sin Mercado Libre
1. Configura Firebase (PASO 1) y abre `index.html` en dos navegadores/dispositivos:
   crea un producto en uno y verás que aparece en el otro (sync en tiempo real).
2. Abre el chat y pregunta por tus ganancias.
3. Para simular una venta de ML, puedes editar el doc `crm/state` en la consola de
   Firestore agregando un objeto a `pendingMappings`; el chat te pedirá confirmarlo.

---

### Resumen de archivos secretos (no compartir / no subir a git)
`.env` · `tokens.json` · `serviceAccountKey.json` · `.ml-sync-state.json`
