# CLAUDE.md — Nexsell (ml-crm-app)

Guía de orientación del repositorio para Claude Code. **Nexsell** es un CRM que
sincroniza ventas de Mercado Libre hacia Firebase, las muestra en una interfaz
web y permite importar/exportar en Excel.

## Qué hace el proyecto

- **Frontend:** una sola página (`index.html`) servida estáticamente (Vercel /
  Netlify). No hay build; el HTML se publica tal cual.
- **Sincronización:** `sync-ml.js` (proceso Node) baja ventas de Mercado Libre y
  las escribe en Firebase. Es el `main` del `package.json`.
- **API serverless:** funciones en `api/` (envío de correo, diagnósticos).

## Estructura de carpetas

```
ml-crm-app/
├── index.html              # App completa (frontend, una sola página)
├── sync-ml.js              # Sincronización ML → Firebase (main / npm scripts)
├── email-templates.js      # Plantillas de correo (require'd por sync-ml.js)
├── export-ventas.js        # Script operativo: exportar ventas
├── import-ventas.js        # Script operativo: importar ventas
├── build-min.js            # Utilidad de build/minificado
│
├── api/                    # Funciones serverless Vercel (send-mail.js, diag-smtp.js)
├── render-backend/         # Backend desplegado en Render
├── netlify/                # Configuración / funciones de Netlify
│
└── node_modules/           # Dependencias
```

> Se eliminó la carpeta `docs/` (reportes y auditorías antiguas) y los mockups.
> No recrearla: la documentación viva es este `CLAUDE.md`.

### Configuración y deploy (raíz)

- `package.json` — scripts: `auth`, `start`, `once` (todos sobre `sync-ml.js`).
- `vercel.json` — sirve `index.html` con rewrites; deja pasar `/api/`.
- `netlify.toml` — configuración de Netlify.
- `firestore.rules` — reglas de seguridad de Firestore.

### Secretos y archivos sensibles (NO subir, ya en `.gitignore`)

`.env`, `tokens.json`, `serviceAccountKey.json`, `.ml-sync-state.json`.
Estos los lee la app en tiempo de ejecución; **no borrar**. Las notas sueltas con
tokens/ENV para pegar se eliminaron (los secretos reales viven en `.env` y en los
paneles de deploy).

## Comandos

```bash
npm run auth     # Autenticación inicial con Mercado Libre
npm start        # Sincronización continua
npm run once     # Una sola corrida de sincronización
```

## Reglas para trabajar en este repo

- **No mover** `index.html`, `sync-ml.js`, `email-templates.js`, los archivos de
  config ni la carpeta `api/`: están referenciados por rutas y deploys.
- **Documentación:** mantenerla en este `CLAUDE.md`. No recrear la carpeta `docs/`
  con reportes/auditorías de un solo uso.
- **No commitear secretos**: cualquier token/clave va al `.gitignore`.
- El frontend es un único `index.html` muy grande; editar con búsquedas dirigidas.
