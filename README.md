# NexSell — CRM de Mercado Libre

CRM multiusuario que conecta cuentas de **Mercado Libre** y sincroniza ventas sobre **Firebase (Firestore)**, con chat de IA, verificación de correo y envío de reportes.

## Arquitectura

| Capa | Tecnología | Despliegue |
|------|------------|------------|
| **Frontend** | `index.html` estático (sin framework de build); Firebase Web SDK, Chart.js, DOMPurify, Lucide por CDN | **Vercel** |
| **Backend / API** | Servidor Node nativo (`render-backend/server.js`) que expone `/api/*` (login ML, chat IA, auth, verificación de correo, reportes) y `/run-sync` + `/run-emails` para el cron | **Render** |
| **Base de datos** | Cloud Firestore (reglas en `firestore.rules`) | Firebase |
| **Cron** | Servicio externo (p. ej. cron-job.org) que pega a `/run-sync` y `/run-emails` con `?key=RUN_SECRET` | externo |

El frontend habla con el backend mediante la constante `API_BASE` definida en `index.html`, que apunta a la URL pública de Render (`https://<app>.onrender.com`). Todas las rutas del backend cuelgan de `/api/`.

## Estructura del repo

```
index.html                 Frontend completo (estático)
render-backend/
  server.js                Router HTTP: /api/* + /run-sync + /run-emails
  api/                     Funciones de la API (módulos nativos de Node)
    lib/_core.js           Utilidades compartidas (Firestore REST, SMTP, JWT, etc.)
  ml-sync.js / ml-emails.js  Tareas pesadas del cron
firestore.rules            Reglas de seguridad de Firestore
vercel.json                Config del front estático en Vercel
.env.example               Plantilla de variables de entorno
```

## Variables de entorno (en Render → Environment)

Ver `.env.example` para la lista completa. Resumen:

- **Mercado Libre**: `ML_CLIENT_ID`, `ML_CLIENT_SECRET`, `ML_AUTH_DOMAIN`, `ML_API`
- **URLs**: `URL` (URL pública de Render), `APP_URL` (URL del front en Vercel — a donde vuelve el usuario tras conectar ML)
- **Firebase**: `FIREBASE_SERVICE_ACCOUNT` (JSON del service account en una sola línea)
- **Correo**: `GMAIL_USER`, `GMAIL_APP_PASSWORD`, `EMAIL_FROM_NAME`, `OWNER_EMAIL`
- **IA**: `OPENROUTER_API_KEY`
- **Cron**: `RUN_SECRET`

> Los secretos (`.env`, `serviceAccountKey.json`, `tokens.json`) están en `.gitignore` y **no** se versionan.

## Desarrollo local

```bash
cd render-backend
npm install          # sin dependencias externas
node server.js       # levanta el backend en http://localhost:3000
```

Abre `index.html` directamente o sírvelo con cualquier servidor estático. Para apuntar a un backend local, ajusta `API_BASE` en `index.html`.

## Despliegue

### Backend (Render)
1. Nuevo **Web Service** desde este repo, *Root Directory* = `render-backend`.
2. Build: `npm install` · Start: `node server.js`.
3. Cargar las variables de entorno listadas arriba.
4. Registrar el `redirect_uri` `https://<app>.onrender.com/api/ml-callback` en developers.mercadolibre.cl.

### Frontend (Vercel)
1. Importar el repo. *Framework Preset* = **Other**, sin build command.
2. `vercel.json` sirve el `index.html` estático.
3. Asegurarse de que `API_BASE` en `index.html` apunte a la URL de Render.

### Cron
Configurar el servicio externo para visitar cada ~30 min:
`https://<app>.onrender.com/run-sync?key=RUN_SECRET` y `.../run-emails?key=RUN_SECRET`.
