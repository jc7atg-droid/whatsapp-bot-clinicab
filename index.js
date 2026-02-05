const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require("@whiskeysockets/baileys")
const qrcode = require("qrcode-terminal")
const OpenAI = require("openai")

// =====================
// CONFIG
// =====================

const openai = new OpenAI({
  apiKey: process.env.OPENAI_KEY
})

const cooldowns = {}
const humanChats = new Set()

// =====================
// BOT
// =====================

async function startBot() {

  const { state, saveCreds } = await useMultiFileAuthState("./auth")

  const sock = makeWASocket({
    auth: state
  })

  sock.ev.on("creds.update", saveCreds)

  // ---- CONNECTION ----

  sock.ev.on("connection.update", (update) => {

    const { connection, qr, lastDisconnect } = update

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
      }
    }
  })

  // ---- MESSAGES ----

  sock.ev.on("messages.upsert", async ({ messages }) => {

    const msg = messages[0]
    if (!msg || !msg.message) return

    // no responderse a sí mismo
    if (msg.key.fromMe) return

    const from = msg.key.remoteJid

    const text =
      msg.message.conversation ||
      msg.message.extendedTextMessage?.text ||
      ""

    if (!text) return

    // si está en modo humano → bot no responde
    if (humanChats.has(from)) return

    // ---- COOLDOWN 5s ----
    const now = Date.now()

    if (cooldowns[from] && now - cooldowns[from] < 5000) return

    cooldowns[from] = now

    console.log("📩", from, text)

    // ---- PASAR A HUMANO ----
    if (
      text.toLowerCase().includes("humano") ||
      text.toLowerCase().includes("asesor")
    ) {

      humanChats.add(from)

      await sock.sendMessage(from, {
        text: "Te paso con un asesor humano enseguida."
      })

      return
    }

    // =====================
    // IA (API NUEVA)
    // =====================

    try {

      const response = await openai.responses.create({
        model: "gpt-4.1-mini",
        input: text
      })

      const reply =
        response.output[0].content[0].text

      await sock.sendMessage(from, { text: reply })

    } catch (err) {

      console.log("❌ IA ERROR:", err.message)

      await sock.sendMessage(from, {
        text: "Ocurrió un error, intenta de nuevo."
      })
    }
  })
}

startBot()
