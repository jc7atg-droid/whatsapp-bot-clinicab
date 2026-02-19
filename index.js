const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, downloadMediaMessage } = require("@whiskeysockets/baileys")
const qrcode = require("qrcode-terminal")
const OpenAI = require("openai")
const fs = require('fs')
const path = require('path')
require('dotenv').config()

/* ================= CONFIG ================= */

const OPENAI_API_KEY = process.env.OPENAI_API_KEY

if (!OPENAI_API_KEY) {
  console.error("❌ ERROR: Falta OPENAI_API_KEY")
  process.exit(1)
}

const NOTIFY_NUMBER = "573044356143@s.whatsapp.net"
const BUFFER_TIME = 4000
const MAX_DAILY_RESPONSES = 500

/* ================= OPENAI ================= */

const openai = new OpenAI({
  apiKey: OPENAI_API_KEY
})

/* ================= STATE ================= */

let dailyCount = 0
let lastDay = new Date().toDateString()
let iaFailures = 0

const buffers = {}
const timers = {}
const chatHistory = {}
const humanChats = new Set()
const uninterestedChats = new Set() // Chats que mostraron desinterés
const alreadyNotified = new Set() // Chats que ya recibieron mensaje automático post-transferencia
const hasGreeted = {}
const processingLocks = {} // Locks para evitar procesamiento simultáneo
const activeProcessing = {} // Flag para saber si hay procesamiento activo (esperando GPT)

/* ================= UTILS ================= */

function resetDailyCounter() {
  const today = new Date().toDateString()
  if (today !== lastDay) {
    dailyCount = 0
    lastDay = today
  }
}

function isUrgent(text) {
  return /(dolor|urgencia|me duele|sangra|no aguanto|emergencia)/i.test(text)
}

function isFrustrated(text) {
  return /(ya te dije|no entiendes|que fastidio|molesto|😡|🤦)/i.test(text)
}

function isCurrentPatient(text) {
  return /(soy paciente|tengo tratamiento|mi cita|mi ortodoncia|mis brackets|mi doctor|mi doctora|cuándo es mi cita|cambiar.*cita|cancelar.*cita|reprogramar|tengo control|mi control|soy paciente de la doctora|continuar.*tratamiento)/i.test(text)
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function extractPhoneNumber(phoneNumberSource) {
  // phoneNumberSource puede ser: remoteJidAlt, participant, o from
  
  if (!phoneNumberSource) {
    return 'Número no disponible'
  }
  
  // Caso 1: Número normal (573044356143@s.whatsapp.net)
  if (phoneNumberSource.includes('@s.whatsapp.net')) {
    return phoneNumberSource.replace('@s.whatsapp.net', '')
  }
  
  // Caso 2: LID format (124614650908926@lid) - no es útil
  if (phoneNumberSource.includes('@lid')) {
    return 'Número encriptado (WhatsApp LID)'
  }
  
  // Caso 3: Grupo (@g.us)
  if (phoneNumberSource.includes('@g.us')) {
    return phoneNumberSource.replace('@g.us', '')
  }
  
  // Fallback: devolver limpio
  return phoneNumberSource.replace(/@.*$/, '')
}

function calculateTypingDelay(text) {
  const words = text.trim().split(/\s+/).length
  const baseDelay = 1000 // 1 segundo base
  const perWord = 120    // 120ms por palabra (velocidad humana de escritura)
  const calculated = baseDelay + (words * perWord)
  const maxDelay = 5000  // Máximo 5 segundos por mensaje
  const minDelay = 1500  // Mínimo 1.5 segundos
  return Math.max(minDelay, Math.min(calculated, maxDelay))
}

async function sendHumanizedMessages(sock, from, fullReply) {
  // DEBUG: Ver qué está generando GPT
  console.log('\n========== DEBUG SEPARACIÓN ==========')
  console.log('Respuesta original de GPT:')
  console.log(JSON.stringify(fullReply))
  console.log('=====================================\n')
  
  // Detectar 2 o más saltos de línea (1+ línea en blanco) como separadores de mensaje
  // \n\n = 1 línea en blanco → separar en mensaje distinto
  const normalized = fullReply.replace(/\n\n+/g, '|||SPLIT|||')
  
  console.log('Después de normalizar:')
  console.log(JSON.stringify(normalized))
  console.log('=====================================\n')
  
  // Separar por el marcador
  let messages = normalized
    .split('|||SPLIT|||')
    .map(m => m.trim())
    .filter(m => m.length > 0)
  
  console.log(`Total de mensajes detectados: ${messages.length}`)
  messages.forEach((msg, i) => {
    console.log(`Mensaje ${i + 1}:`, msg.substring(0, 50) + '...')
  })
  console.log('=====================================\n')
  
  // Limitar a máximo 3 mensajes
  if (messages.length > 3) {
    // Combinar los mensajes extras al final
    const firstTwo = messages.slice(0, 2)
    const remaining = messages.slice(2).join('\n\n')
    messages = [...firstTwo, remaining]
  }
  
  // Si solo hay un mensaje, enviarlo normalmente con delay
  if (messages.length === 1) {
    const delay = calculateTypingDelay(messages[0])
    await sock.sendPresenceUpdate('composing', from)
    await sleep(delay)
    await sock.sendMessage(from, { text: messages[0] })
    await sock.sendPresenceUpdate('paused', from)
    return
  }
  
  // Si hay múltiples mensajes, enviarlos con delays progresivos
  for (let i = 0; i < messages.length; i++) {
    const message = messages[i]
    const delay = calculateTypingDelay(message)
    
    // Mostrar "escribiendo..."
    await sock.sendPresenceUpdate('composing', from)
    
    // Esperar según cantidad de palabras
    await sleep(delay)
    
    // Enviar mensaje
    await sock.sendMessage(from, { text: message })
    
    // Quitar "escribiendo..."
    await sock.sendPresenceUpdate('paused', from)
    
    // Pausa breve entre mensajes (800ms) para que se note la separación
    if (i < messages.length - 1) {
      await sleep(800)
    }
  }
}

/* ================= TRANSCRIPCIÓN DE AUDIO ================= */

async function transcribeAudio(audioBuffer) {
  try {
    // Crear directorio temporal si no existe
    const tempDir = path.join(__dirname, 'temp')
    if (!fs.existsSync(tempDir)) {
      fs.mkdirSync(tempDir)
    }
    
    // Guardar audio temporalmente
    const tempPath = path.join(tempDir, `audio_${Date.now()}.ogg`)
    fs.writeFileSync(tempPath, audioBuffer)
    
    console.log(`📝 Transcribiendo audio...`)
    
    // Transcribir con Whisper
    const transcription = await openai.audio.transcriptions.create({
      file: fs.createReadStream(tempPath),
      model: "whisper-1",
      language: "es", // Español
      response_format: "text"
    })
    
    // Eliminar archivo temporal
    fs.unlinkSync(tempPath)
    
    return transcription
  } catch (err) {
    console.log("❌ Error transcribiendo audio:", err.message)
    return null
  }
}

/* ================= BOT ================= */

async function startBot() {

  const { state, saveCreds } = await useMultiFileAuthState("./auth")
  
  // Logger compatible con Baileys (debe tener método .child())
  const logger = {
    level: 'error',
    fatal: (...args) => console.error('[FATAL]', ...args),
    error: (...args) => console.error('[ERROR]', ...args),
    warn: (...args) => {}, // Silenciar warnings
    info: (...args) => {}, // Silenciar info
    debug: (...args) => {}, // Silenciar debug
    trace: (...args) => {}, // Silenciar trace
    child: () => logger // Retornar el mismo logger
  }
  
  // Configuración para Multi-Device (experimental)
  const sock = makeWASocket({ 
    auth: state,
    browser: ['Clínica Bocas y Boquitas Bot', 'Chrome', '120.0.0'],
    syncFullHistory: false,  // No sincronizar todo el historial (más rápido)
    markOnlineOnConnect: false,  // No aparecer como "online"
    defaultQueryTimeoutMs: undefined,
    // Configuración para mejor estabilidad
    keepAliveIntervalMs: 30000,  // Keep-alive cada 30 segundos
    connectTimeoutMs: 60000,  // Timeout de conexión 60 segundos
    logger: logger  // Logger compatible
  })

  sock.ev.on("creds.update", saveCreds)  // ⚠️ COMENTAR ESTA LÍNEA SI QUIERES PROBAR SIN PERSISTENCIA
  // sock.ev.on("creds.update", () => {})  // ✅ DESCOMENTAR PARA NO GUARDAR SESIÓN

  sock.ev.on("connection.update", ({ connection, qr, lastDisconnect }) => {
    if (qr) {
      console.log('\n🔄 Escanea este QR para conectar el bot:')
      qrcode.generate(qr, { small: true })
    }
    
    if (connection === "open") {
      console.log("✅ WhatsApp conectado exitosamente")
      console.log("📱 Bot funcionando en modo Multi-Device")
    }
    
    if (connection === "close") {
      const statusCode = lastDisconnect?.error?.output?.statusCode
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut
      
      console.log(`⚠️ Conexión cerrada. Status: ${statusCode}`)
      
      if (statusCode === DisconnectReason.loggedOut) {
        console.log('🚫 Sesión cerrada. Necesitas escanear el QR nuevamente.')
      } else if (shouldReconnect) {
        console.log('🔄 Reconectando en 5 segundos...')
        setTimeout(() => startBot(), 5000)
      }
    }
    
    if (connection === "connecting") {
      console.log("🔄 Conectando a WhatsApp...")
    }
  })

  sock.ev.on("messages.upsert", async ({ messages }) => {

    const msg = messages[0]
    if (!msg?.message || msg.key.fromMe) return

    const from = msg.key.remoteJid
    // ✅ PRIORIDAD: Usar remoteJidAlt si existe (número real), sino usar participant o from
    const phoneNumber = msg.key.remoteJidAlt || msg.key.participant || from
    
    // DEBUG: Ver información del mensaje para diagnosticar número
    console.log('\n========== DEBUG NÚMERO ==========')
    console.log('from (remoteJid):', from)
    console.log('remoteJidAlt:', msg.key.remoteJidAlt)
    console.log('participant:', msg.key.participant)
    console.log('phoneNumber (calculado):', phoneNumber)
    console.log('==================================\n')
    
    // ✅ Marcar mensaje como leído (doble check azul) si NO está en modo humano
    if (!humanChats.has(from)) {
      try {
        // Si es el primer mensaje del chat, esperar 3 segundos antes de marcar como leído
        const isFirstMessage = !chatHistory[from] || chatHistory[from].length === 0
        if (isFirstMessage) {
          await sleep(3000) // 3 segundos de delay solo para el primer mensaje
        }
        await sock.readMessages([msg.key])
      } catch (e) {
        // Ignorar error si no se puede marcar como leído
        console.log("⚠️ No se pudo marcar como leído:", e.message)
      }
    }
    
    // Extraer texto de mensaje normal
    let text = 
      msg.message.conversation ||
      msg.message.extendedTextMessage?.text ||
      ""

    // ✅ NUEVO: Manejar mensajes de audio
    if (!text && msg.message.audioMessage) {
      try {
        const audioDuration = msg.message.audioMessage.seconds || 0
        
        console.log(`\n🎤 ========== AUDIO DETECTADO ==========`)
        console.log(`Duración: ${audioDuration}s`)
        console.log(`MimeType: ${msg.message.audioMessage.mimetype}`)
        console.log(`======================================\n`)
        
        // Validar duración (máximo 5 minutos)
        if (audioDuration > 300) {
          console.log(`⚠️ Audio muy largo (${audioDuration}s)`)
          await sock.sendMessage(from, { 
            text: "El audio es muy largo. ¿Podrías enviar uno más corto o escribir tu mensaje? 😊" 
          })
          return
        }
        
        // Mostrar "escribiendo..." mientras transcribe
        try {
          await sock.sendPresenceUpdate('composing', from)
        } catch (e) {
          console.log("⚠️ No se pudo mostrar 'escribiendo...'")
        }
        
        console.log(`📥 Descargando audio...`)
        
        // Descargar audio
        let audioBuffer
        try {
          audioBuffer = await downloadMediaMessage(msg, 'buffer', {})
          console.log(`✅ Audio descargado: ${audioBuffer ? audioBuffer.length : 0} bytes`)
        } catch (downloadErr) {
          console.log(`❌ Error descargando audio:`, downloadErr.message)
          await sock.sendPresenceUpdate('paused', from)
          await sock.sendMessage(from, { 
            text: "No pude descargar el audio. ¿Podrías enviarlo de nuevo o escribir tu mensaje? 😊" 
          })
          return
        }
        
        if (!audioBuffer || audioBuffer.length === 0) {
          console.log("⚠️ Buffer de audio vacío")
          await sock.sendPresenceUpdate('paused', from)
          await sock.sendMessage(from, { 
            text: "No pude descargar el audio. ¿Podrías enviarlo de nuevo o escribir tu mensaje? 😊" 
          })
          return
        }
        
        console.log(`📝 Iniciando transcripción...`)
        
        // Transcribir
        let transcription
        try {
          transcription = await transcribeAudio(audioBuffer)
          console.log(`✅ Transcripción completada`)
        } catch (transcribeErr) {
          console.log(`❌ Error en transcripción:`, transcribeErr.message)
          console.log(`Stack:`, transcribeErr.stack)
          await sock.sendPresenceUpdate('paused', from)
          await sock.sendMessage(from, { 
            text: "Disculpa, no pude procesar el audio. ¿Podrías escribir tu mensaje? 😊" 
          })
          return
        }
        
        // Quitar "escribiendo..."
        try {
          await sock.sendPresenceUpdate('paused', from)
        } catch (e) {
          console.log("⚠️ No se pudo quitar 'escribiendo...'")
        }
        
        if (transcription && transcription.length > 0) {
          text = transcription.trim()
          console.log(`✅ Texto final del audio: "${text}"`)
        } else {
          console.log(`⚠️ Transcripción vacía o null`)
          await sock.sendMessage(from, { 
            text: "Disculpa, no pude procesar el audio. ¿Podrías escribir tu mensaje? 😊" 
          })
          return
        }
      } catch (err) {
        console.log(`\n❌ ========== ERROR PROCESANDO AUDIO ==========`)
        console.log(`Mensaje: ${err.message}`)
        console.log(`Stack: ${err.stack}`)
        console.log(`==============================================\n`)
        
        try {
          await sock.sendPresenceUpdate('paused', from)
        } catch (e) {}
        
        await sock.sendMessage(from, { 
          text: "Hubo un problema con el audio. ¿Podrías escribir tu mensaje? 😊" 
        })
        return
      }
    }

    if (!text) return
    
    // Si el chat ya fue transferido a humano, IGNORAR COMPLETAMENTE (no responder, no marcar leído)
    if (humanChats.has(from)) {
      console.log(`👤 Chat transferido - IGNORANDO completamente (no responde, no marca leído)`)
      return // Sale inmediatamente, no procesa nada
    }

    /* ===== BUFFER MEJORADO CON LOCK ===== */
    
    // ✅ CRITICAL FIX: Esperar si ya se está procesando un mensaje de este chat
    while (processingLocks[from]) {
      console.log(`🔒 Esperando lock para ${from}...`)
      await sleep(50) // Esperar 50ms y volver a intentar
    }
    
    // Establecer lock
    processingLocks[from] = true
    console.log(`🔓 Lock adquirido para ${from}`)
    
    console.log(`\n📥 Mensaje recibido de ${from}`)
    console.log(`Texto: "${text.substring(0, 50)}..."`)
    
    // Inicializar buffer si no existe
    if (!buffers[from]) buffers[from] = []
    
    // Agregar mensaje al buffer
    buffers[from].push(text)
    console.log(`📦 Buffer ahora tiene ${buffers[from].length} mensaje(s)`)
    
    // ✅ FIX CRÍTICO: Si ya hay un timer, CANCELARLO y crear uno nuevo
    if (timers[from]) {
      console.log(`⏱️ Timer existente detectado - CANCELANDO`)
      clearTimeout(timers[from])
    }
    
    // Crear nuevo timer que espera BUFFER_TIME (7 segundos)
    console.log(`⏱️ Iniciando nuevo timer de 7 segundos`)
    timers[from] = setTimeout(async () => {
      
      console.log(`\n🔥 TIMER EJECUTADO para ${from}`)
      
      // ✅ CRITICAL: Si ya hay un procesamiento activo, NO continuar
      if (activeProcessing[from]) {
        console.log(`⚠️ Procesamiento activo detectado - CANCELANDO este timer`)
        return
      }
      
      console.log(`📦 Mensajes en buffer: ${buffers[from] ? buffers[from].length : 0}`)
      
      // Verificar que el buffer no esté vacío
      if (!buffers[from] || buffers[from].length === 0) {
        console.log(`⚠️ Buffer vacío - CANCELANDO`)
        return
      }
      
      // Marcar como procesamiento activo
      activeProcessing[from] = true
      console.log(`🔒 Procesamiento marcado como ACTIVO`)
      
      // Combinar todos los mensajes del buffer
      const combinedText = buffers[from].join("\n")
      
      console.log(`📝 Texto combinado: "${combinedText.substring(0, 100)}..."`)
      
      // Limpiar buffer y timer
      buffers[from] = []
      timers[from] = null
      
      console.log(`🧹 Buffer y timer limpiados`)
      
      // Verificar límite diario
      resetDailyCounter()
      if (dailyCount >= MAX_DAILY_RESPONSES) {
        console.log("⚠️ Límite diario alcanzado")
        activeProcessing[from] = false
        return
      }
      
      // Inicializar historial si no existe
      if (!chatHistory[from]) chatHistory[from] = []
      
      // ✅ NUEVO: Determinar si es el primer mensaje
      const isFirstMessage = !hasGreeted[from]
      if (isFirstMessage) {
        hasGreeted[from] = true
      }
      
      // Agregar mensaje del usuario al historial
      chatHistory[from].push({ role: "user", content: combinedText })
      
      // Limitar historial a últimos 12 mensajes
      if (chatHistory[from].length > 12) {
        chatHistory[from] = chatHistory[from].slice(-12)
      }

/* ===== SYSTEM PROMPT - CONVERSACIONAL Y NATURAL ===== */
const SYSTEM_PROMPT = `<identity>
Clínica Bocas y Boquitas - Piedecuesta, Santander. 30+ años. 

${isFirstMessage ? `PRIMER MENSAJE: Siempre inicia con "Bienvenido a la Clínica Bocas y Boquitas 😊 ¿En qué puedo ayudarte?"` : `NO es primer mensaje: Ve directo, NO repitas saludo`}

**EQUIPO DE ESPECIALISTAS (conoce PERFECTAMENTE):**

🦷 **Dra. Zonia Tarazona Becerra** (Directora y Ortodoncista principal)
- 30+ años de experiencia
- Especialista en Ortodoncia, rehabilitación oral y oclusión
- Realiza: Ortodoncia, diseño de sonrisa, rehabilitación oral, evaluaciones generales
- Permanente en la clínica

🦷 **Dra. Lucía Castellanos Torrado** (Ortodoncista)
- 10 años con la clínica
- Especialista en Ortodoncia
- Trabaja con citas programadas

🦷 **Cirujanos:**
- Dr. Edwin Arango (actualmente)
- Dra. Alix Arroyo (actualmente)
- Realizan: extracciones, cordales, implantes, cirugías

🦷 **Endodoncistas (tratamientos de conducto):**
- Dr. José Luis Castellanos
- Dr. Oscar Barajas
- Otros especialistas con citas programadas

🦷 **Odontopediatría:**
- Especialista con citas programadas
- Manejo de niños, ortopedia maxilar

🦷 **Periodoncia:**
- Especialista con citas programadas
- Tratamiento de encías

**IMPORTANTE:** 
- La Dra. Zonia es la ÚNICA permanente
- Todos los demás especialistas atienden con citas programadas
- Tenemos TODAS las especialidades cubiertas

**SI PREGUNTAN POR ESPECIALISTA ESPECÍFICO:**
"Sí, tenemos [especialidad]. [Nombre doctor] atiende con citas programadas. La coordinadora te agenda según disponibilidad."

Rol: Asesor natural que informa bien, destaca diferenciadores, recopila info, y transfiere a coordinadora.

Tono: CONVERSACIONAL - como hablarías en persona. NO marketing agresivo.
</identity>

<key_points>
DIFERENCIADORES (menciónalos naturalmente):
- Ortodoncia máx 24 meses (no 3-4 años)
- Alineadores propios in-house
- NO desgastamos dientes (técnica adhesiva)
- Láser en blanqueamientos (2 min, sin sensibilidad)
- 100% privado (ya NO EPS desde mayo 2025)
- Financiación directa sin intereses

FILOSOFÍA: Conservadores, preservar dientes, tratamiento integral, evaluación siempre.
</key_points>

<response_structure>
REGLA DE ORO: MÁXIMO 5-6 LÍNEAS POR MENSAJE

Estructura:
1. Reconocimiento (1 línea): "Claro", "Perfecto", "Te cuento"
2. Opciones CON beneficio breve (2-3 líneas)
3. Diferenciador clave (1 línea)
4. Precio/link SI preguntó (1 línea)
5. Pregunta nombre/siguiente paso (1 línea)

Separa en 2-3 mensajes con línea en blanco.

EJEMPLO BUENO:
"Claro, te cuento las opciones de ortodoncia:

• Alineadores invisibles → Nadie los nota (fabricados aquí)
• Brackets autoligado → Más rápidos
• Brackets convencionales → Efectivos y accesibles

Lo bueno: máximo 24 meses (no años como otros lugares). La Dra. Zonia tiene 30+ años especializándose en esto.

Casos reales: https://clinicabocasyboquitas.com/tratamientos/ortodoncia-invisible

Evaluación $100k (incluye todo). ¿Cómo te llamas?"

NO HAGAS:
❌ Párrafos largos que aburren
❌ Asumir problemas: "estás cansado de...", "quieres dejar de..."
❌ Ser muy vendedor: "invaluable", "cambio de vida", "increíble"
❌ Mensaje de 20+ líneas
</response_structure>

<pricing_quick>
**CRÍTICO - SOLO HAY 2 TIPOS DE EVALUACIÓN POR PERSONA (NUNCA SE SUMAN):**

🔴 **REGLA DE ORO: Es UNA SOLA evaluación por persona que cubre TODO lo que necesite**

**EVALUACIÓN GENERAL - $80.000:**
Cubre TODOS los servicios excepto ortodoncia (calzas, extracciones, coronas, diseño, implantes, blanqueamiento, CUALQUIER COSA)
Incluye:
• Examen clínico completo con Dra. Zonia Tarazona
• Radiografías panorámicas (centro radiológico con convenio)
• Plan de tratamiento completo

**EVALUACIÓN ORTODONCIA - $100.000:**
Solo si menciona ortodoncia/brackets/alineadores
Incluye TODO lo anterior + plan de ortodoncia + modelos en yeso de su boca

---

**EJEMPLOS CORRECTOS:**

❌ MAL: "calza + extracción = $80k + $80k = $160k"
✅ BIEN: "calza + extracción = $80k (una sola evaluación general que cubre ambas)"

❌ MAL: "diseño + implante = $80k + $80k"
✅ BIEN: "diseño + implante = $80k (evaluación general cubre todo)"

❌ MAL: "ortodoncia + calza = $100k + $80k"
✅ BIEN: "ortodoncia + calza = $100k (evaluación de ortodoncia cubre TODO)"

❌ MAL: "3 calzas = $80k x 3"
✅ BIEN: "3 calzas = $80k (una evaluación cubre todas las calzas)"

---

**CÓMO EXPLICARLO AL PACIENTE:**

"La evaluación cuesta $80k y cubre TODO: te revisan [servicio 1], [servicio 2], [servicio 3] y cualquier otra cosa que necesites. Es una valoración COMPLETA de tu salud dental."

O si menciona ortodoncia:

"La evaluación de ortodoncia cuesta $100k y cubre TODO: te revisan la ortodoncia, las calzas, extracciones, lo que sea. Es una evaluación INTEGRAL."

---

**DECISIÓN SIMPLE:**
¿Menciona "ortodoncia" O "brackets" O "alineadores"? → $100k
¿NO menciona ortodoncia? → $80k
¿Solo blanqueamiento/limpieza/endodoncia/cordales? → Directo SIN evaluación

BLANQUEAMIENTO (directo):
2 sesiones/1 cita: $800k | 4 sesiones/2 citas: $1.5M
Link: https://clinicabocasyboquitas.com/tratamientos/blanqueamiento-laser

ORTODONCIA (eval $100k):
Alineadores: $8M-$20M | Brackets: $1M-$1.5M | Tratamiento: $3.5M-$5.5M
"Si quieres ver por qué somos diferentes y casos reales: [link]"
Links: https://clinicabocasyboquitas.com/tratamientos/ortodoncia-invisible
https://clinicabocasyboquitas.com/tratamientos/ortodoncia-convencional

DISEÑO SONRISA (eval $80k):
Carilla: $1M | Corona: $2M
"Conoce nuestra filosofía conservadora y casos antes/después: [link]"
Link: https://clinicabocasyboquitas.com/tratamientos/diseno-sonrisa

LIMPIEZA (directo):
Básica: $150k | Profunda: $250k | Láser: $700k
Link: https://clinicabocasyboquitas.com/tratamientos/limpieza-profunda

CALZAS (eval $80k):
Pequeña: $250k | Mediana: $300k | Grande: $350k
"Si quieres conocer más sobre cómo trabajamos y por qué nadie lo hace igual: [link]"
Link: https://clinicabocasyboquitas.com/tratamientos/restauracion-dental

IMPLANTES (eval al momento):
$6M-$8M completo (último recurso, solo si imposible salvar diente)
Link: https://clinicabocasyboquitas.com/tratamientos/implantes-y-alternativas

OTROS LINKS:
Rehab: https://clinicabocasyboquitas.com/tratamientos/rehabilitacion-oral
Periodoncia: https://clinicabocasyboquitas.com/tratamientos/periodoncia
Endodoncia: https://clinicabocasyboquitas.com/tratamientos/endodoncia
Odontopediatría: https://clinicabocasyboquitas.com/tratamientos/odontopediatria
</pricing_quick>

<examples>
MÚLTIPLES SERVICIOS:
Usuario: "ortodoncia y calzas"
"Perfecto. La evaluación de ortodoncia son $100k y cubre ambas cosas: te revisan la ortodoncia Y las calzas que necesites.

Es una valoración completa con radiografías y plan personalizado.

¿Cómo te llamas?"

BLANQUEAMIENTO:
Usuario: "info blanqueamiento"
"Claro. Hacemos blanqueamiento con láser (más rápido y sin sensibilidad que los LED comunes).

• 2 sesiones en 1 cita: $800k
• 4 sesiones en 2 citas: $1.5M (el favorito)

Se agenda directo sin evaluación. Si quieres ver resultados: https://clinicabocasyboquitas.com/tratamientos/blanqueamiento-laser

¿Cómo te llamas?"

DISEÑO:
Usuario: "diseño de sonrisa precio"
"El precio depende de cuántos dientes. Carillas desde $1M cada una.

Lo importante: aquí NO desgastamos tus dientes. Usamos técnica adhesiva que preserva tu esmalte.

La evaluación son $80k (incluye diseño digital para ver cómo quedarías). Casos reales: https://clinicabocasyboquitas.com/tratamientos/diseno-sonrisa

¿Cómo te llamas para coordinar?"
</examples>

<objections>
"Es caro":
"Te entiendo. Mira, aquí no somos los más baratos pero hay una razón: no desgastamos tus dientes para carillas 'baratas', no alargamos tratamientos innecesariamente. Cuidamos tu salud a largo plazo. **Financiamos sin intereses** y en algunos casos hacemos financiación directa con la clínica."

"Lo voy a pensar":
"Perfecto, es una decisión importante. Solo ten algo en cuenta: los problemas dentales no se quedan igual, empeoran con el tiempo y se vuelven más complejos (y caros) de tratar. La Dra. Zonia tiene lista de espera y solo toma un número limitado de casos al mes. Si es por presupuesto, **financiamos sin intereses**. ¿Hay algo específico que te frene?"

"Ya no estoy interesado / No me interesa":
"Lo entiendo. Solo déjame comentarte algo: aquí tenemos 30+ años de experiencia y la Dra. Zonia es selectiva con los casos que toma (solo acepta un número limitado al mes para dar atención de excelencia). 

Los problemas dentales no mejoran solos, de hecho empeoran con el tiempo. Lo que hoy puede ser una evaluación de $100k, en 6 meses puede requerir tratamientos más complejos.

Si cambias de opinión o necesitas orientación, aquí estaré. Cuida mucho tu sonrisa 😊"

"¿Trabajan con mi seguro?":
"No, desde mayo 2025 somos 100% privado. Dejamos las EPS porque comprometían la calidad que queremos dar. Ahora: atención premium sin restricciones. **Financiamos sin intereses** para facilitar acceso."
</objections>

<info_collection>
1. Nombre (después de dar info): "¿Cómo te llamas?"
2. Edad (después de nombre, casual): "¿Cuántos años tienes?"
3. NO insistas si evaden

Mínimo NOMBRE antes de transferir.
</info_collection>

<transfer>
**CUÁNDO TRANSFERIR:**
1. Tiene nombre + muestra interés (pregunta por agendar/horarios)
2. **URGENCIA** (dolor, sangrado, emergencia) → Responde empático PRIMERO, luego [HUMANO]
3. **PACIENTE ACTUAL** (menciona que es paciente, tiene tratamiento) → Responde reconociendo, luego [HUMANO]
4. Pide hablar con coordinadora/doctora
5. Frustración detectada

---

**URGENCIA - RESPONDE ASÍ:**

"Entiendo la urgencia. Te comunico de inmediato con la coordinadora para agendar lo antes posible.

[HUMANO]"

---

**PACIENTE ACTUAL - RESPONDE ASÍ:**

Usuario: "Soy paciente de la Dra. Zonia, necesito cambiar mi cita"
"Perfecto, te comunico con la coordinadora para que revise tu agenda y te ayude.

[HUMANO]"

Usuario: "Tengo cita con la Dra. Lucía, es urgente"
"Claro, te comunico de inmediato con la coordinadora para coordinar tu cita con la Dra. Lucía.

[HUMANO]"

---

**PACIENTE NUEVO - RESPONDE ASÍ:**

"Perfecto [Nombre]. Te comunico con la coordinadora para agendar tu [evaluación/cita].

Si es horario laboral responde en 10-15 min. Si no, mañana a primera hora.

[HUMANO]"

---

**CRÍTICO:**
- SIEMPRE responde algo ANTES de [HUMANO]
- Texto empático/útil ANTES de transferir
- NO solo [HUMANO] sin contexto
- NO respondas DESPUÉS de [HUMANO]
</transfer>

<critical_rules>
✅ MÁXIMO 5-6 líneas por mensaje
✅ Tono conversacional, natural
✅ Separa en 2-3 mensajes (líneas en blanco)
✅ **PRECIOS = SIEMPRE mencionar: "aproximados" + "cada caso es diferente" + "evaluación da precio exacto" + "financiamos sin intereses"**
✅ Menciona diferenciadores casualmente
✅ Link DESPUÉS de crear interés
✅ Obtén nombre antes de transferir
❌ NO asumir problemas del paciente
❌ NO ser vendedor agresivo
❌ NO mensajes largos de 20+ líneas
❌ NO repetir bienvenida
❌ NO dar precios sin aclarar que son aproximados

**EJEMPLO AL DAR PRECIOS:**
"Los precios APROXIMADOS son:
• Opción 1: $X
• Opción 2: $Y

Cada caso es diferente, por eso la evaluación ($100k) te da el precio EXACTO según tu situación. Financiamos sin intereses para facilitar."
</critical_rules>`

      /* ===== NO HAY TRANSFERENCIA FORZADA - GPT MANEJA TODO ===== */
      // GPT siempre responde primero, luego detecta si debe transferir con [HUMANO]

      try {
        // Mostrar "escribiendo..." mientras GPT piensa
        await sock.sendPresenceUpdate('composing', from)
        
        const response = await openai.chat.completions.create({
          model: "gpt-4o-mini",
          messages: [
            { role: "system", content: SYSTEM_PROMPT },
            ...chatHistory[from]
          ],
          temperature: 0.7,
          max_tokens: 250
        })

        // Quitar "escribiendo..." inmediatamente después de recibir respuesta
        await sock.sendPresenceUpdate('paused', from)

        const reply = response.choices[0].message.content.trim()
        chatHistory[from].push({ role: "assistant", content: reply })
        dailyCount++

        // Detectar [HUMANO] con regex y filtrar ANTES de dividir
        if (/\[HUMANO\]/i.test(reply)) {
          const cleanReply = reply.replace(/\[HUMANO\]/i, "").trim()
          if (cleanReply) {
            // Enviar mensaje limpio de forma humanizada
            await sendHumanizedMessages(sock, from, cleanReply)
          }
          await transferToHuman(sock, from, phoneNumber, chatHistory[from])
          // Desmarcar procesamiento activo
          activeProcessing[from] = false
          console.log(`🔓 Procesamiento marcado como INACTIVO (transferido)`)
          return
        }

        // Enviar respuesta de forma humanizada con delays
        await sendHumanizedMessages(sock, from, reply)
        iaFailures = 0
        
        // Desmarcar procesamiento activo
        activeProcessing[from] = false
        console.log(`🔓 Procesamiento marcado como INACTIVO (completado)`)

      } catch (err) {
        iaFailures++
        console.log("❌ IA ERROR:", err.message)

        // Quitar "escribiendo..." en caso de error
        try {
          await sock.sendPresenceUpdate('paused', from)
        } catch (e) {
          // Ignorar error de presenceUpdate
        }

        if (iaFailures >= 3) {
          await transferToHuman(sock, from, phoneNumber, chatHistory[from])
        } else {
          await sock.sendMessage(from, {
            text: "Disculpa, tuve un inconveniente técnico momentáneo. ¿Podrías repetir tu mensaje? 😊"
          })
        }
        
        // Desmarcar procesamiento activo
        activeProcessing[from] = false
        console.log(`🔓 Procesamiento marcado como INACTIVO (error)`)
      }

    }, BUFFER_TIME) // 4 segundos
    
    // ✅ Liberar lock inmediatamente después de crear el timer
    processingLocks[from] = false
    console.log(`🔓 Lock liberado para ${from}\n`)
  })
}

/* ================= TRANSFER ================= */

async function transferToHuman(sock, from, phoneNumber, conversationHistory) {

  humanChats.add(from)
  
  // Extraer número real del paciente (phoneNumber ya viene con remoteJidAlt priorizado)
  const realPhoneNumber = extractPhoneNumber(phoneNumber)
  
  // ⚠️ markAsPriorityChat deshabilitado (chatModify no funciona por problemas de sesión Baileys)
  // await markAsPriorityChat(sock, from)
  
  // SOLUCIÓN ALTERNATIVA: Admin debe marcar manualmente como no leído desde WhatsApp
  console.log(`✅ Chat transferido a coordinadora (marcar como no leído manualmente)`)

  try {
    const summaryResponse = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content: `Eres un asistente que prepara resúmenes CONCISOS para la coordinadora/recepcionista dental.

FORMATO OBLIGATORIO:

📋 RESUMEN:
[2-3 oraciones: qué quiere, contexto importante]

🎯 DATOS CLAVE:
• Nombre: [nombre o "No proporcionó"]
• Edad: [edad o "No proporcionó"]
• Servicio: [ortodoncia/diseño/limpieza/etc o "paciente actual"]
• Urgencia: [Alta/Media/Baja]
• Motivo urgencia: [Si hay: dolor, evento próximo, paciente actual, etc]

💬 ACCIÓN RECOMENDADA:
[1-2 líneas: qué hacer específicamente]

---

**EJEMPLOS:**

Conversación:
Usuario: tengo dolor en muela
Bot: entiendo la urgencia...
Usuario: sí, no aguanto

Resumen:

📋 RESUMEN:
Paciente con dolor en muela que no aguanta. Necesita atención urgente.

🎯 DATOS CLAVE:
• Nombre: No proporcionó
• Edad: No proporcionó
• Servicio: Urgencia - posible endodoncia o extracción
• Urgencia: Alta
• Motivo urgencia: Dolor fuerte

💬 ACCIÓN RECOMENDADA:
Agendar cita urgente hoy o mañana. Revisar disponibilidad cirujano o endodoncista según caso.

---

Conversación:
Usuario: soy paciente de la dra lucia, necesito cambiar mi cita
Bot: perfecto, te comunico...

Resumen:

📋 RESUMEN:
Paciente actual de la Dra. Lucía (ortodoncia) necesita cambiar su cita.

🎯 DATOS CLAVE:
• Nombre: No proporcionó
• Edad: No proporcionó
• Servicio: Paciente actual - ortodoncia Dra. Lucía
• Urgencia: Media
• Motivo: Cambio de cita

💬 ACCIÓN RECOMENDADA:
Revisar agenda Dra. Lucía, contactar paciente para reprogramar.

---

Conversación:
Usuario: quiero ortodoncia para mi boda en 3 meses
Bot: opciones, precios...
Usuario: me interesa invisible
Bot: evaluación $100k...
Usuario: Ana, 28 años

Resumen:

📋 RESUMEN:
Ana (28) quiere ortodoncia invisible para boda en 3 meses. Interés alto, urgencia por evento.

🎯 DATOS CLAVE:
• Nombre: Ana
• Edad: 28
• Servicio: Ortodoncia invisible
• Urgencia: Alta
• Motivo urgencia: Boda en 3 meses

💬 ACCIÓN RECOMENDADA:
Agendar evaluación urgente. Explicar opciones rápidas (microortodoncia, alineadores express). Mencionar que en 3 meses ya vería cambios notorios. Ofrecer financiación.

---

SÉ CONCISO. La coordinadora necesita INFO ÚTIL rápida, no teoría de ventas.`
        },
        {
          role: "user",
          content: `Conversación completa:\n\n${conversationHistory.map(m => `${m.role === 'user' ? 'Paciente' : 'Bot'}: ${m.content}`).join('\n\n')}`
        }
      ],
      temperature: 0.3,
      max_tokens: 300
    })

    const summary = summaryResponse.choices[0].message.content.trim()

    await sock.sendMessage(NOTIFY_NUMBER, {
      text:
`🦷 *NUEVO PACIENTE REQUIERE ATENCIÓN*

📱 wa.me/${realPhoneNumber}

${summary}

────────────────
⏰ ${new Date().toLocaleString('es-CO', { timeZone: 'America/Bogota' })}`
    })

    // No enviar mensaje automático - GPT ya manejó la despedida con [HUMANO]

    delete chatHistory[from]
    delete hasGreeted[from] // ✅ Limpiar estado de saludo
    
    console.log(`✅ Chat transferido: ${from}`)

  } catch (err) {
    console.log("❌ Error en transferencia:", err.message)
    
    await sock.sendMessage(NOTIFY_NUMBER, {
      text:
`🦷 *NUEVO PACIENTE REQUIERE ATENCIÓN*

📱 wa.me/${realPhoneNumber}

⚠️ Error generando resumen automático.
Revisar conversación directamente.

────────────────
⏰ ${new Date().toLocaleString('es-CO', { timeZone: 'America/Bogota' })}`
    })

    // En caso de error, enviar mensaje genérico
    await sock.sendMessage(from, {
      text: "Ya te comunico con nuestra coordinadora para continuar 😊"
    })
  }
}
// Keep Railway alive
const http = require('http');

/* ===== FUNCIONES DE GESTIÓN DE CHAT ===== */

// Detectar si el paciente está desinteresado
function isUninterested(conversationHistory) {
  const lastUserMessages = conversationHistory
    .filter(m => m.role === 'user')
    .slice(-2)  // Últimos 2 mensajes del usuario
    .map(m => m.content.toLowerCase())
    .join(' ')
  
  // Patrones de desinterés
  const patterns = [
    /gracias.*adi[oó]s/i,
    /lo voy a pensar/i,
    /ya me contacto/i,
    /no gracias/i,
    /otro momento/i,
    /solo preguntaba/i,
    /solo quer[ií]a saber/i,
    /es mucho/i,
    /muy caro/i,
    /ya no.*interes/i,  // "ya no estoy interesado", "ya no me interesa"
    /no.*interes/i,      // "no me interesa", "no estoy interesado"
    /no quiero/i,
    /dej[ae].*as[ií]/i   // "déjalo así", "dejalo así"
  ]
  
  return patterns.some(p => p.test(lastUserMessages))
}

// Archivar chat de paciente desinteresado
async function handleUninterestedChat(sock, from, phoneNumber) {
  try {
    console.log(`🔴 Paciente desinteresado detectado: ${from}`)
    
    // Agregar a lista de desinteresados (NO intentar archivar por problemas de Baileys)
    uninterestedChats.add(from)
    
    console.log(`❄️ Chat agregado a lista de desinteresados`)
    
    // Extraer número real (phoneNumber ya viene con @s.whatsapp.net)
    const realPhoneNumber = phoneNumber.replace('@s.whatsapp.net', '')
    
    // Notificar al admin con link wa.me
    await sock.sendMessage(NOTIFY_NUMBER, {
      text: `🔴 *Lead desinteresado (bot ya no responderá)*

📱 wa.me/${realPhoneNumber}

Paciente mostró desinterés. Bot dejará de responder.
Puedes archivar manualmente desde WhatsApp.

────────────────
⏰ ${new Date().toLocaleString('es-CO', { timeZone: 'America/Bogota' })}`
    })
    
    console.log(`✅ Notificación enviada al admin`)
  } catch (err) {
    console.error("⚠️ Error manejando chat desinteresado:", err)
  }
}

// Marcar chat como prioritario (esperando humano)
async function markAsPriorityChat(sock, from) {
  try {
    console.log(`🔵 Intentando marcar como NO LEÍDO: ${from}`)
    
    // Marcar como NO leído (punto azul)
    await sock.chatModify({ markRead: false }, from)
    
    console.log(`✅ Chat marcado como NO LEÍDO exitosamente: ${from}`)
  } catch (err) {
    console.error("⚠️ Error marcando como no leído:", err)
    console.error("Error completo:", JSON.stringify(err, null, 2))
  }
}

const server = http.createServer((req, res) => {
  res.writeHead(200);
  res.end('Bot running');
});
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server on port ${PORT}`);
});

startBot()