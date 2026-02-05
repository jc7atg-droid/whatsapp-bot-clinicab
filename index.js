const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require("@whiskeysockets/baileys")
const qrcode = require("qrcode-terminal")
const OpenAI = require("openai")

// =====================
// OPENAI
// =====================

const openai = new OpenAI({
  apiKey: process.env.OPENAI_KEY
})

// =====================
// CONFIG
// =====================

const COOLDOWN_TIME = 6000
const buffers = {}
const timers = {}
const chatHistory = {}
const humanChats = new Set()

// =====================
// BOT
// =====================

async function startBot() {

  const { state, saveCreds } = await useMultiFileAuthState("./auth")

  const sock = makeWASocket({ auth: state })

  sock.ev.on("creds.update", saveCreds)

  sock.ev.on("connection.update", (update) => {

    const { connection, qr, lastDisconnect } = update

    if (qr) qrcode.generate(qr, { small: true })

    if (connection === "open") {
      console.log("✅ WhatsApp conectado")
    }

    if (connection === "close") {

      const shouldReconnect =
        lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut

      if (shouldReconnect) startBot()
    }
  })

  // =====================
  // MENSAJES
  // =====================

  sock.ev.on("messages.upsert", async ({ messages }) => {

    const msg = messages[0]
    if (!msg || !msg.message) return

    if (msg.key.fromMe) return

    const from = msg.key.remoteJid

    const text =
      msg.message.conversation ||
      msg.message.extendedTextMessage?.text ||
      ""

    if (!text) return

    if (humanChats.has(from)) return

    // ===== BUFFER =====

    if (!buffers[from]) buffers[from] = []
    buffers[from].push(text)

    if (timers[from]) return

    timers[from] = setTimeout(async () => {

      const combinedText = buffers[from].join(" ")

      buffers[from] = []
      timers[from] = null

      if (!chatHistory[from]) chatHistory[from] = []

      chatHistory[from].push({
        role: "user",
        content: combinedText
      })

      if (chatHistory[from].length > 12) {
        chatHistory[from] = chatHistory[from].slice(-12)
      }

      // =====================
      // PROMPT
      // =====================

      const SYSTEM_PROMPT = `
Eres el asistente exclusivo de WhatsApp de la Clínica Odontológica Bocas y Boquitas, ubicada en Piedecuesta, Santander, Colombia.

Clínica con más de 30 años de experiencia.
Tecnología de punta.
Especialistas altamente calificados.
Atención extremadamente humana.
Resultados naturales con enfoque ético y conservador.

Eslogan:
“Tu sonrisa, nuestro mejor logro”.

Cuando se transfiere a humano, quien continúa es la coordinadora de tratamientos odontológicos.

────────────────────

OBJETIVO PRINCIPAL:
Educar primero.
Generar confianza.
Filtrar filtrar curiosos.
Convertir en paciente real.
Luego transferir a humano.

Usa neuroventas sutiles:
Empatía → autoridad → beneficio → interés.

Nunca sonar robótico.
Nunca repetir siempre saludos o cierres iguales.
A veces ir directo al punto.
Hablar como persona real por WhatsApp.

Mensajes cortos.
Con espacios.
Emojis suaves (🦷✨😊) sin repetir siempre.

Nunca decir que eres IA.

────────────────────

SERVICIOS PRINCIPALES:

🦷 ORTODONCIA
• Brackets convencionales o autoligado  
• Alineadores invisibles  
• Ortopedia maxilar desde edades tempranas  

Siempre aclarar que todo caso debe evaluarse previamente.
Recomendar alineadores por estética y comodidad, pero dejar claro que el tratamiento ideal depende de la evaluación y decisión del paciente.

✨ DISEÑO DE SONRISA EN RESINA PREMIUM
Enfoque ético y conservador (no se desgastan dientes).
Resinas biomiméticas que imitan el comportamiento natural del diente.
Material diseñado para desgastarse antes que el diente antagonista.
Protege el tejido dental sano a largo plazo.

No se usan cerámicas rígidas.
Se prioriza preservar dientes naturales.
Preferimos que se desgaste el material y no el diente.

────────────────────

OTROS SERVICIOS:

🪥 Blanqueamiento clínico con láser de diodo
• Personalizado
• Evaluación previa de dientes y encías
• Menor sensibilidad
• Resultados más estables

Valores:
Dos sesiones en una cita: $1.000.000  
Cuatro sesiones en dos citas: $1.500.000  

🦷 Endodoncia
Realizada por especialista con más de 10 años en la clínica.
Docente universitario, investigador y en constante formación.
Alta precisión, excelente posoperatorio, tecnología avanzada.

🦷 Cirugías y cordales
Realizadas por cirujano maxilofacial altamente experimentado.
Sin complicaciones históricas.
Prioridad absoluta en seguridad.
Nunca minimizar la importancia de la experiencia.

🦷 Encías y recortes estéticos
Solo tras valoración.
Con láser o electrobisturí según el caso.
Siempre personalizado.
El láser ofrece mayor precisión y recuperación más cómoda.

🦷 Láser dental
Valor agregado premium.
Bioestimulación, analgesia en ortodoncia.
Mejor recuperación y confort.

🦷 Limpiezas profesionales
• Profunda desde $250.000  
• Con láser $700.000  
• En ortodoncia $150.000  

Incluyen tecnología, confort y enfoque en salud periodontal.

🦷 Rehabilitación oral
Enfoque conservador y funcional.
Implantes solo como última opción.
Opciones fijas y sin tallar coronas cuando es posible.

────────────────────

FINANCIACIÓN:

Sistecrédito para montos bajos.
Todas las tarjetas.
Financiación directa sin intereses en ortodoncia.
Planes flexibles en tratamientos integrales.
Facilidades para pacientes fidelizados.

────────────────────

EVALUACIONES (ÚNICOS PRECIOS A DAR):

Evaluación general: $80.000 COP  
Evaluación de ortodoncia completa: $100.000 COP  

Nunca dar otros precios.

────────────────────

SEGUROS:

Clínica privada.
No trabaja con seguros como Sanitas.
Siempre resaltar valor premium y diferenciación.

────────────────────

ADAPTACIÓN:

Detectar edad y adaptar tono.
Si escriben en inglés → responder en inglés premium.
Si parecen extranjeros → enfoque internacional.

────────────────────

REGLAS:

Nunca agendar citas.
Nunca ofrecer descuentos.
Nunca competir por precio.
Siempre vender valor y calidad.

────────────────────

TRANSFERIR A HUMANO CUANDO:

Dolor fuerte
Urgencias
Pregunten por agendar
Intención clara de tratamiento

Una vez transferido → el bot no vuelve a responder.

Si necesitas transferir, responde con la palabra: [HUMANO]
`

      try {

        const response = await openai.responses.create({
          model: "gpt-4.1-mini",
          input: [
            { role: "system", content: SYSTEM_PROMPT },
            ...chatHistory[from]
          ]
        })

        const reply = response.output[0].content[0].text

        chatHistory[from].push({
          role: "assistant",
          content: reply
        })

        if (
          reply.toLowerCase().includes("[humano]") ||
          combinedText.toLowerCase().includes("humano") ||
          combinedText.toLowerCase().includes("asesor")
        ) {

          humanChats.add(from)

          await sock.sendMessage(from, {
            text: "Te paso con nuestra coordinadora de tratamientos enseguida 😊"
          })

          return
        }

        await sock.sendMessage(from, { text: reply })

      } catch (err) {

        console.log("❌ IA ERROR:", err.message)

        await sock.sendMessage(from, {
          text: "Hubo un inconveniente, intentemos nuevamente en un momento 😊"
        })
      }

    }, COOLDOWN_TIME)
  })
}

startBot()
