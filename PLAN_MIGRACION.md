# 📋 Plan de migración y arquitectura — NexSell

> Documento de planificación. NO ejecutar hasta terminar el desarrollo y tener todo
> funcionando sin errores.

---

## 0) Lo que NO se pierde (importante)

- **Datos:** viven en **Firebase Firestore**, NO en Netlify. Migrar Netlify no los toca.
- **Variables de entorno:** todas tienen su valor en archivos locales (no hace falta
  exportarlas del Netlify viejo):

| Variable | Origen del valor |
|---|---|
| `ML_CLIENT_ID` | `.env` |
| `ML_CLIENT_SECRET` | `.env` |
| `GMAIL_USER` | `.env` |
| `GMAIL_APP_PASSWORD` | `.env` |
| `OPENROUTER_API_KEY` | la key de OpenRouter |
| `FIREBASE_SERVICE_ACCOUNT` | `serviceAccountKey.json` (todo el contenido) |

---

## 1) Cómo LISTAR las variables de la cuenta vieja (por si acaso)

En el Netlify viejo: **Project configuration → Environment variables**. Ahí aparecen
las 6 con sus valores (no las marcamos como "secret", así que se ven y se copian).
Pero como ya tienes los valores en local (tabla de arriba), no dependes de eso.

---

## 2) Migración a cuenta NUEVA de Netlify (sin caída ni pérdida)

**Idea:** dejar la cuenta nueva 100% lista ANTES de soltar el nombre `nexsell`.

1. **Cuenta nueva → crear el sitio:** arrastra la carpeta `_subir-a-netlify`. Queda con
   un nombre random (ej. `algo-123.netlify.app`).
2. **Cuenta nueva → variables:** pega las **6 variables** (de la tabla de arriba).
3. **Probar en el dominio temporal:** abre `algo-123.netlify.app` y verifica que la app
   carga. (La conexión de ML aún no se prueba aquí porque el redirect apunta a
   `nexsell.netlify.app`; eso se valida tras el cambio de nombre.)
4. **Cuenta vieja → liberar el nombre:** Site configuration → **Change site name** →
   renombra `nexsell` a otra cosa (ej. `nexsell-old`). Eso libera el nombre `nexsell`.
5. **Cuenta nueva → reclamar el nombre:** Change site name → ponle **`nexsell`**.
   Ahora `nexsell.netlify.app` apunta a la cuenta nueva.
6. **Verificar:** abre `nexsell.netlify.app` (Ctrl+F5), prueba: chat IA (ai-proxy),
   registro con código, y "Conectar con Mercado Libre".

**Sobre Mercado Libre developers:** el redirect URI
`https://nexsell.netlify.app/.netlify/functions/ml-callback` **NO cambia** (la URL es la
misma). No hay que tocar nada en developers.

**Caída:** solo los segundos entre el paso 4 y 5. Si el nombre `nexsell` no queda libre
al instante, espera un poco y reintenta el paso 5.

---

## 3) IDEA: mover el backend pesado a Render

### ¿Es posible? Sí.
La lógica de sync y de correos es Node puro (fetch, crypto, tls) → portable a Render.

### Qué se mueve y qué se queda

| Pieza | Hoy (Netlify) | Propuesta |
|---|---|---|
| Frontend `index.html` | Netlify | **Netlify** (igual) |
| `ai-proxy` (IA) | Netlify Function (HTTP) | **Netlify** (se usa solo al chatear) |
| `email-verify-start/check` (registro) | Netlify Function (HTTP) | **Netlify** (se usa al registrarse) |
| `ml-login` / `ml-callback` (conectar ML) | Netlify Function (HTTP) | **Netlify** (se usa al conectar) |
| **`ml-sync`** (motor de ventas) | Netlify **programada cada 30 min** | **Render (cron job)** ← el que gasta |
| **`ml-emails`** (correos/avisos) | Netlify **programada cada 30 min** | **Render (cron job)** ← el que gasta |

> **Clave:** lo que agota los créditos de Netlify son las **funciones programadas**
> (corren 24/7). Las funciones HTTP casi no gastan (solo cuando un usuario actúa).
> Por eso a Render se mueven SOLO esas dos.

### Reparto de variables de entorno

**Render** (para `ml-sync` + `ml-emails`):
- `ML_CLIENT_ID`, `ML_CLIENT_SECRET` (refrescar token de ML)
- `FIREBASE_SERVICE_ACCOUNT` (leer tokens, escribir ventas)
- `GMAIL_USER`, `GMAIL_APP_PASSWORD` (enviar correos)

**Netlify** (para lo que queda):
- `OPENROUTER_API_KEY` (solo ai-proxy) ← esta NO va a Render
- `ML_CLIENT_ID`, `ML_CLIENT_SECRET` (ml-login/ml-callback)
- `FIREBASE_SERVICE_ACCOUNT` (ml-callback + email-verify)
- `GMAIL_USER`, `GMAIL_APP_PASSWORD` (email-verify-start)

(Algunas se repiten en ambos lados: es normal y no hay problema.)

### Trabajo de adaptación (cuando lo hagamos)
- `ml-sync.js` y `ml-emails.js` están en formato "Netlify Function"
  (`exports.handler`). Para Render hay que envolverlos como **script Node normal**
  que corre y termina (la lógica interna se reusa casi tal cual). En Render SÍ se puede
  `npm install`, así que incluso se puede usar `firebase-admin` + `nodemailer` (más
  simple que las versiones sin librerías).
- En Render se configura como **Cron Job** con horario (ej. cada 30 min).

### Ojo (verificar antes)
- Revisar el plan gratis de **Render** para Cron Jobs (puede pedir tarjeta o tener
  límites). Alternativa gratis: un cron externo (ej. cron-job.org) que "pinchee" una
  URL cada 30 min.

---

## 4) Recomendación

Mover los 2 cron a **Render resuelve la RAÍZ** (el gasto constante de Netlify). Si se
hace eso, **probablemente NO haga falta migrar de cuenta Netlify**, porque la actual
quedaría muy por debajo del límite (solo funciones HTTP livianas).

Orden sugerido:
1. Terminar el desarrollo (lo que estamos haciendo).
2. Decidir:
   - **Rápido / corto plazo:** migrar a cuenta nueva de Netlify (créditos frescos).
   - **Definitivo:** mover los 2 cron a Render → la cuenta Netlify actual sobrevive.
