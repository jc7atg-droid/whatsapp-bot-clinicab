const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys')
const qrcode = require("qrcode-terminal")

// cooldown por chat
const cooldowns = {}

async function startBot() {

  const { state, saveCreds } = await useMultiFileAuthState("./auth")

  const sock = makeWASocket({
    auth: state,
    keepAliveIntervalMs: 10000,
    connectTimeoutMs: 60000
  })

  sock.ev.on("creds.update", saveCreds)

  // conexión + QR
  sock.ev.on("connection.update", (update) => {

    const { connection, lastDisconnect, qr } = update

    if (qr) {
      qrcode.generate(qr, { small: true })
    }

    if (connection === "open") {
      console.log("✅ WhatsApp conectado")
    }

    if (connection === "close") {

      const shouldReconnect =
        lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut

      if (shouldReconnect) {
        console.log("🔄 Reconectando...")
        startBot()
      } else {
        console.log("❌ Sesión cerrada")
      }
    }
  })

  // MENSAJES
  sock.ev.on("messages.upsert", async ({ messages }) => {

    const msg = messages[0]
    if (!msg || !msg.message) return

    // ❌ no responder mensajes del propio bot
    if (msg.key.fromMe) return

    const from = msg.key.remoteJid

    const text =
      msg.message.conversation ||
      msg.message.extendedTextMessage?.text ||
      ""

    if (!text) return

    // ⏱️ COOLDOWN 5s
    const now = Date.now()

    if (cooldowns[from] && now - cooldowns[from] < 5000) {
      return
    }

    cooldowns[from] = now

    console.log("📩", from, ":", text)

    // RESPUESTA (luego metes tu IA aquí)
    await sock.sendMessage(from, {
      text: "Hola, soy el asistente automático de la clínica."
    })
  })
}

startBot()
