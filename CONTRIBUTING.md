# Convenciones de desarrollo — NexSell

## Flujo de ramas (cuando se use Git)

> Nota: hoy el **frontend** se despliega arrastrando la carpeta `_subir-a-netlify`
> a Netlify (no por Git). El **backend pesado** (`render-backend/`) sí vive en un
> repo de GitHub conectado a Render. Estas convenciones aplican a cualquier repo
> Git del proyecto.

| Prefijo | Para qué |
|---|---|
| `feat/nombre`     | Funciones nuevas |
| `fix/nombre`      | Correcciones de bugs |
| `hotfix/nombre`   | Bugs críticos en producción |
| `refactor/nombre` | Reorganización de código (sin cambiar comportamiento) |

**Regla de oro:** nunca trabajar directo sobre `main`. Crear una rama, hacer el
cambio, commit descriptivo y luego mezclar a `main`.

```bash
git checkout -b fix/mi-correccion
# ...cambios...
git commit -m "descripción corta y clara del cambio"
git checkout main
git merge fix/mi-correccion
```

## Mensajes de commit
- En español, claros, en minúscula, describiendo el QUÉ.
- Ejemplos:
  - `mover email de owner a variable de entorno`
  - `reemplazar verificación de admin por custom claims`
  - `agregar honeypot y límite por IP en registro`

## Build del frontend
El `index.html` (raíz) es la **fuente legible**. Para generar la versión pública
ofuscada que se sube a Netlify:

```bash
node build-min.js   # genera _subir-a-netlify/index.html ofuscado
```

## Reglas de arquitectura
- Toda **función nueva** que toque datos sensibles debe ser una **Netlify Function**
  (backend), no lógica directa contra Firestore en el navegador. Ver plantilla en
  `netlify/functions/_template.js`.
- Los **secretos** (keys, contraseñas) van SIEMPRE en variables de entorno
  (Netlify / Render), nunca en el código del frontend.
