const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys')
const qrcode = require("qrcode-terminal")

async function start() {

  const { state, saveCreds } = await useMultiFileAuthState("./auth")

  const sock = makeWASocket({
    auth: state,
    keepAliveIntervalMs: 10000,
    connectTimeoutMs: 60000
  })

  sock.ev.on("creds.update", saveCreds)

  sock.ev.on("connection.update", (update) => {
    const { connection, qr, lastDisconnect } = update

    if (qr) {
      qrcode.generate(qr, { small: true })
    }

    if (connection === "close") {
      const shouldReconnect =
        lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut

      if (shouldReconnect) {
        console.log("Reconectando...")
        start()
      }
    }

    if (connection === "open") {
      console.log("WhatsApp conectado correctamente")
    }
  })

const cooldowns = {}

sock.ev.on("messages.upsert", async ({ messages }) => {

  const msg = messages[0]
  if (!msg.message) return

  // ❌ no responderse a sí mismo
  if (msg.key.fromMe) return

  const from = msg.key.remoteJid

  const text =
    msg.message.conversation ||
    msg.message.extendedTextMessage?.text ||
    ""

  if (!text) return

  // ⏱️ COOLDOWN (5 segundos por chat)
  const now = Date.now()

  if (cooldowns[from] && now - cooldowns[from] < 5000) {
    return   // ignora si escribe muy rápido
  }

  cooldowns[from] = now

  console.log("MENSAJE:", text)

  await sock.sendMessage(from, {
    text: "Hola, soy el asistente automático de la clínica."
  })
})

start()
