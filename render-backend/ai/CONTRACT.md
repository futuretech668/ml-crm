# `/api/ai-agent` — Contrato de integración (MIA copiloto)

Fuente de verdad para el frontend. Un **POST** por turno. Todas las ops se
discriminan con el campo `op` del body y se autentican con el **Firebase ID token
real** del usuario.

## Endpoint

```
POST {API_BASE}/api/ai-agent
```

### Headers (todas las ops)

| Header | Valor |
|---|---|
| `Content-Type` | `application/json` |
| `Authorization` | `Bearer <Firebase ID token>` — `await auth.currentUser.getIdToken()` |

> El `uid` se deriva SIEMPRE del token verificado en el servidor. El cliente
> nunca envía `uid` ni selecciona el documento. El doc se elige solo: dueño →
> `crm/state`, resto → `crm_users/{uid}`.

### Preflight

`OPTIONS` → `204` con cabeceras CORS. `GET`/otros → `405`.

### Forma de error (cualquier op)

```json
{ "ok": false, "reason": "no_token" | "bad_token" | "bad_json" | "no_message"
   | "rate" | "config" | "gtoken" | "load" | "server" | "method"
   | "model_unavailable" | "upstream_auth" | "upstream_rate",
  "msg": "texto amable en español (opcional)" }
```

Códigos: `401` (sin token / token inválido), `400` (json/mensaje), `429`
(rate-limit propio o del proveedor de IA → `upstream_rate`), `500`
(config/servidor), `502` (error del proveedor de IA: `model_unavailable` cuando
OpenRouter no tiene endpoints para el modelo configurado, `upstream_auth` cuando
la key del proveedor falla). Nunca devuelve stack traces.

---

## op: `open` — abre/saluda una conversación (Briefing)

Dispara el **briefing** determinista (ventas de hoy, meta del mes, preguntas ML
sin responder, productos bajo stock) y construye el perfil de negocio si falta.

### Request
```json
{ "op": "open" }
```

### Response `200`
```json
{
  "ok": true,
  "threadId": "t_1718900000000_a1b2",
  "reply": "¡Hola! Soy **MIA**... Hoy llevas **1** venta(s) por **$50.000**...",
  "suggestions": [
    "Tienes 2 pregunta(s) sin responder en ML — ¿las revisamos?",
    "1 producto(s) bajo stock — ¿los vemos?"
  ],
  "profileBuilt": true
}
```

| Campo | Tipo | Notas |
|---|---|---|
| `threadId` | string | Id del hilo recién creado. Échalo en cada `send` siguiente. |
| `reply` | string | Mensaje de apertura de MIA (markdown). Renderízalo como su 1er mensaje. |
| `suggestions` | string[] | 1–4 chips de acción proactiva. |
| `profileBuilt` | bool | `true` si se construyó el perfil de negocio en esta apertura. |

---

## op: `send` — un turno del usuario (default)

Es la op por defecto si se omite `op`.

### Request
```json
{
  "op": "send",
  "message": "¿cuánto gané esta semana?",
  "threadId": "t_1718900000000_a1b2",
  "confirmToken": "c_ab12cd34"
}
```

| Campo | Req. | Notas |
|---|---|---|
| `message` | sí | Texto del usuario. Vacío → `400 no_message`. |
| `threadId` | no | Si falta o no existe, el servidor crea uno nuevo y lo devuelve. |
| `confirmToken` | no | Solo para **confirmar** una acción de ML propuesta (ver abajo). |

### Response `200`
```json
{
  "ok": true,
  "reply": "Esta semana llevas **$21.000** de ganancia.",
  "did": [
    { "action": "add_sale", "saleId": 1718900000012, "productName": "Cargador USB-C", "quantity": 1, "totalPrice": 6000, "profit": 3000 }
  ],
  "proposed": [
    {
      "token": "c_ab12cd34",
      "tipo": "ml_answer_question",
      "questionId": "101",
      "text": "Sí, tenemos stock disponible."
    }
  ],
  "threadId": "t_1718900000000_a1b2"
}
```

| Campo | Tipo | Notas |
|---|---|---|
| `reply` | string | Respuesta de MIA (markdown). Siempre presente. |
| `did` | object[] | Acciones YA ejecutadas este turno (escrituras del CRM y, tras confirmar, de ML). Muestra un toast por cada una. Vacío si no hubo escrituras. |
| `proposed` | object[] | Acciones de ML **propuestas** y a la espera de confirmación. Vacío si no hay. |
| `threadId` | string | El hilo usado (puede ser nuevo si no mandaste uno). |

#### `did[]` — formas por acción
- `{ action: "add_sale", saleId, productName, quantity, totalPrice, profit }`
- `{ action: "delete_sale", saleId, productName }`
- `{ action: "add_product", productId, name }`
- `{ action: "edit_product", productId, name }`
- `{ action: "task_add", id, titulo }` · `{ action: "task_complete", id }` · `{ action: "task_delete", id }`
- `{ action: "save_memory" }`
- `{ action: "send_report", period }`
- `{ action: "ml_answer_question", questionId }`
- `{ action: "ml_update_listing", itemId, cambios }`
- `{ action: "ml_send_message", orderId }`

#### `proposed[]` — confirm-gate de acciones de Mercado Libre (HACIA AFUERA)
Las acciones que afectan a compradores reales (`ml_answer_question`,
`ml_update_listing`, `ml_send_message`) **no se ejecutan** en el turno que se
piden: el servidor devuelve una **propuesta** con un `token`. Cada item:

| Campo | Siempre | Notas |
|---|---|---|
| `token` | sí | Reenvíalo como `confirmToken` para ejecutar. |
| `tipo` | sí | `ml_answer_question` \| `ml_update_listing` \| `ml_send_message`. |
| `questionId` + `text` | answer | Pregunta y texto exacto de la respuesta. |
| `itemId` + `cambios` | update | `cambios` = `{ price?, available_quantity?, status? }`. |
| `orderId` + `text` | message | Pedido y texto del mensaje. |

**UI de aprobación:** por cada `proposed[]`, muestra una tarjeta con el preview
(`text`/`cambios`) y botones **Confirmar / Cancelar**.
- **Confirmar** → reenvía un `send` con el MISMO `threadId` y `confirmToken: <token>`
  (un mensaje del usuario como "confirmo"). El servidor ejecuta SOLO si pasó un
  turno humano real desde la propuesta y la firma de la acción no cambió; al
  ejecutar, la acción aparece en `did[]`.
- **Cancelar** → no reenvíes nada (la propuesta caduca sola).

> Importante: confirmar requiere **otro POST `send`** (turno posterior). El mismo
> turno nunca puede auto-aprobarse.

---

## op: `list` — directorio de conversaciones ("chats antiguos")

### Request
```json
{ "op": "list" }
```
### Response `200`
```json
{
  "ok": true,
  "threads": [
    { "id": "t_1718900000000_a1b2", "title": "¿cuánto gané esta semana?",
      "createdAt": "2026-06-20T12:00:00.000Z", "updatedAt": "2026-06-20T12:03:00.000Z",
      "preview": "Esta semana llevas $21.000 de ganancia." }
  ]
}
```
`threads` viene ordenado del más reciente al más antiguo (máx ~25). Úsalo para el
panel de historial sin cargar los cuerpos de los mensajes.

---

## op: `get` — carga una conversación pasada

### Request
```json
{ "op": "get", "threadId": "t_1718900000000_a1b2" }
```
### Response `200`
```json
{
  "ok": true,
  "threadId": "t_1718900000000_a1b2",
  "messages": [
    { "role": "assistant", "content": "¡Hola! Soy MIA..." },
    { "role": "user", "content": "¿cuánto gané esta semana?" },
    { "role": "assistant", "content": "Esta semana llevas $21.000..." }
  ]
}
```
`messages[]` = `{ role: "user" | "assistant", content: string }` en orden
cronológico (máx ~40 turnos). Si el hilo no existe, `messages` es `[]`.

---

## op: `delete` — elimina una conversación

### Request
```json
{ "op": "delete", "threadId": "t_1718900000000_a1b2" }
```
### Response `200`
```json
{ "ok": true, "deleted": "t_1718900000000_a1b2" }
```

---

## Flujo de referencia (frontend)

1. Al abrir el widget → `open` → pinta `reply` como primer mensaje + `suggestions`
   como chips. Guarda `threadId`.
2. Cada mensaje del usuario → `send { message, threadId }` → pinta `reply`, toasts
   por `did[]`, tarjetas de aprobación por `proposed[]`.
3. Confirmar una propuesta → `send { message:"confirmo", threadId, confirmToken }`.
4. Botón historial (🕘) → `list`; al elegir uno → `get`; "＋ Nueva" → `open`.

> El cliente ya NO arma el system prompt ni el blob de stats: el servidor hace el
> grounding. `/api/ai-proxy` (visión) queda intacto y se sigue usando aparte.
