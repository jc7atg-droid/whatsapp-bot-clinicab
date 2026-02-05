const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys')
const qrcode = require("qrcode-terminal")

const cooldowns = {}

async function startBot() {

  const { state, saveCreds } = await useMultiFileAuthState("./auth")

  const sock = makeWASocket({ auth: state })

  sock.ev.on("creds.update", saveCreds)

  sock.ev.on("connection.update", (update) => {
    const { connection, qr } = update
    if (qr) qrcode.generate(qr, { small: true })
    if (connection === "open") console.log("WhatsApp conectado")
  })

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

    // cooldown 5s
    const now = Date.now()
    if (cooldowns[from] && now - cooldowns[from] < 5000) return
    cooldowns[from] = now

    await sock.sendMessage(from, {
      text: "Hola, soy el asistente automático de la clínica."
    })
  })
}

startBot()
