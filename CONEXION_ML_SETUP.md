# 🔗 Conectar Mercado Libre por usuario — Pasos para activar (Fase A)

El código ya está listo. Faltan **3 cosas que solo tú puedes hacer** (en paneles web, no en el código).
Cuando termines estos pasos, el botón **"Conectar con Mercado Libre"** de la sección Configuración ya funcionará.

---

## 1) Registrar el "redirect URI" en tu app de Mercado Libre
1. Entra a https://developers.mercadolibre.cl → **Tus aplicaciones** → tu app.
2. En **"URIs de redirect"** agrega EXACTAMENTE (reemplaza por tu dominio real de Netlify):
   ```
   https://TU-SITIO.netlify.app/.netlify/functions/ml-callback
   ```
3. En **Scopes/Permisos**: marca **read** (y **offline_access** si aparece, para poder refrescar el token).
4. Guarda. Anota tu **App ID (Client ID)** y tu **Client Secret**.

> ⚠️ El redirect tiene que coincidir carácter por carácter con tu dominio de Netlify.

---

## 2) Crear el "service account" de Firebase (para que las funciones escriban en la base)
1. En Firebase: ⚙️ **Configuración del proyecto → Cuentas de servicio**.
2. **"Generar nueva clave privada"** → se descarga un `.json`.
3. Abre ese `.json`, copia **todo** su contenido (lo vas a pegar como una sola variable en el paso 3).

---

## 3) Pegar las variables de entorno en Netlify
En Netlify: **Site settings → Environment variables → Add a variable**. Agrega estas 3:

| Variable | Valor |
|---|---|
| `ML_CLIENT_ID` | tu App ID de Mercado Libre |
| `ML_CLIENT_SECRET` | tu Client Secret de Mercado Libre |
| `FIREBASE_SERVICE_ACCOUNT` | **todo** el contenido del `.json` del paso 2 (pégalo completo) |

> `ML_CLIENT_SECRET` y `FIREBASE_SERVICE_ACCOUNT` son **secretos**: solo viven en Netlify, nunca en el HTML.
> `URL` (la dirección del sitio) la pone Netlify sola, no la tienes que crear.

Después de agregar las variables, haz **"Deploy" / "Clear cache and deploy"** para que tomen efecto.

---

## Cómo probar que quedó bien
1. Abre tu app en el dominio de Netlify e inicia sesión.
2. Ve a **Configuración → Conectar con Mercado Libre** → clic en el botón.
3. Te lleva a Mercado Libre → **Autorizar** → vuelves a la app y debe decir
   **"✅ Mercado Libre conectado"**.
4. En Firebase → Firestore verás un documento nuevo en `crm_ml_tokens/{tu-uid}` con el token.

---

## Qué falta (Fase B — cuando esto ya funcione)
- Función programada `ml-sync` que cada 5 min lea las ventas nuevas de **cada** usuario
  conectado y las escriba en su doc (`crm/state` del dueño o `crm_users/{uid}` de los demás).
  Es el reemplazo en la nube de `sync-ml.js`. La construimos después de confirmar la conexión.
