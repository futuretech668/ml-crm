# 🚀 Guía de deploy — NexSell (Netlify nuevo + Render)

> Todo el código YA está preparado. Tú solo creas cuentas y arrastras/pegas.
> Hazlo en orden. No te saltes pasos.

---

## Resumen de la nueva arquitectura

| Pieza | Dónde vive | Cómo se sube |
|---|---|---|
| App + funciones livianas (chat IA, verificación correo, conectar ML) | **Netlify (cuenta nueva)** | Arrastrar carpeta `_subir-a-netlify` |
| Sincronización de ventas + correos (los que gastaban) | **Render** (vía GitHub) | Subir carpeta `render-backend` a GitHub |

---

# PARTE 1 — Netlify (cuenta nueva)

**Objetivo:** que la app vuelva a estar online con créditos frescos.

1. Crea una **cuenta nueva de Netlify** (con otro correo).
2. Entra a **Sites → Add new site → Deploy manually** (o Netlify Drop).
3. Arrastra la carpeta **`_subir-a-netlify`**. Queda con un nombre random (ej. `algo-123.netlify.app`).
4. Ve a **Site configuration → Environment variables** y pega estas **6 variables**:

   | Variable | De dónde sale el valor |
   |---|---|
   | `ML_CLIENT_ID` | archivo `.env` |
   | `ML_CLIENT_SECRET` | archivo `.env` |
   | `GMAIL_USER` | archivo `.env` |
   | `GMAIL_APP_PASSWORD` | archivo `.env` |
   | `OPENROUTER_API_KEY` | tu key de OpenRouter |
   | `FIREBASE_SERVICE_ACCOUNT` | TODO el contenido de `serviceAccountKey.json` |

5. Vuelve a desplegar (Trigger deploy) para que tome las variables.
6. Prueba en el dominio temporal: que la app cargue y el chat IA responda.
7. **Reclamar el nombre `nexsell`:**
   - Cuenta VIEJA → Change site name → renombra `nexsell` a `nexsell-old`.
   - Cuenta NUEVA → Change site name → ponle `nexsell`.
8. Abre `nexsell.netlify.app` (Ctrl+F5) y prueba: chat IA, registro con código,
   y "Conectar con Mercado Libre".

> Mercado Libre developers: el redirect NO cambia (la URL sigue siendo
> `nexsell.netlify.app`). No tocar nada ahí.

---

# PARTE 2 — GitHub (subir el backend)

**Objetivo:** dejar el código del backend en GitHub para que Render lo lea.

1. Crea una **cuenta gratis en github.com**.
2. Botón **New repository** → nombre `nexsell-backend` → **Private** → Create.
3. En el repo vacío: **Add file → Upload files**.
4. Arrastra TODO lo que hay **dentro** de la carpeta `render-backend`
   (los archivos `ml-sync.js`, `ml-emails.js`, `run-sync.js`, `run-emails.js`,
   `server.js`, `package.json` y la carpeta `lib`).
5. Abajo, **Commit changes**.

---

# PARTE 3 — Render (correr el backend)

**Objetivo:** que la sincronización y los correos corran solos, sin gastar Netlify.

Tienes 2 opciones. **Opción A es la más simple si Render te deja crear Cron Jobs.**

## Opción A — Cron Jobs de Render (recomendada si está disponible)

1. Crea cuenta en **render.com** (puedes entrar con GitHub).
2. **New → Cron Job** → conecta el repo `nexsell-backend`.
3. Configura el primer cron (ventas):
   - **Build Command:** `npm install`
   - **Command:** `node run-sync.js`
   - **Schedule:** `*/30 * * * *`
4. En **Environment**, agrega estas 5 variables (mismos valores que en Netlify):
   `ML_CLIENT_ID`, `ML_CLIENT_SECRET`, `FIREBASE_SERVICE_ACCOUNT`,
   `GMAIL_USER`, `GMAIL_APP_PASSWORD`.
5. Crea un **segundo Cron Job** igual, pero con **Command:** `node run-emails.js`
   (mismo repo, mismas variables, mismo schedule).

> Si Render te pide tarjeta o cobra por los Cron Jobs, usa la Opción B.

## Opción B — Web Service GRATIS + cron externo (si la A no es gratis)

1. En Render: **New → Web Service** → conecta `nexsell-backend`.
   - **Build Command:** `npm install`
   - **Start Command:** `node server.js`
   - Plan: **Free**.
2. Agrega las 5 variables de arriba **+** una extra `RUN_SECRET` con una clave que
   inventes (ej. `nexsell-2026-xy`).
3. Render te dará una URL, ej. `https://nexsell-backend.onrender.com`.
4. Crea cuenta gratis en **cron-job.org** y crea 2 tareas (cada 30 min):
   - `https://nexsell-backend.onrender.com/run-sync?key=TU_RUN_SECRET`
   - `https://nexsell-backend.onrender.com/run-emails?key=TU_RUN_SECRET`

---

# IMPORTANTE
- Cuando Render/cron ya esté funcionando, la app NO depende de tu PC para nada.
- NO dejes prendido el `sync-ml.js` viejo del terminal (mandaría correos dobles).
- Los datos están en Firebase: nada de esto los toca.
