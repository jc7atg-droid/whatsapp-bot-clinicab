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

const NOTIFY_NUMBER = "573184991302@s.whatsapp.net"
const BUFFER_TIME = 7000 // 7 segundos - espera a que usuario termine de escribir
const MAX_DAILY_RESPONSES = 500

/* ================= OPENAI ================= */

const openai = new OpenAI({
  apiKey: OPENAI_API_KEY
})

/* ================= STATE ================= */

let dailyCount = 0
let lastDay = new Date().toDateString()
let iaFailures = 0

// NOTA: Estos datos se reinician en cada deploy, pero:
// - La SESIÓN de WhatsApp (auth/) SÍ persiste
// - Los chats se gestionan mensaje a mensaje
// - humanChats y hasGreeted se limpian al transferir
const buffers = {}
const timers = {}
const chatHistory = {}  // Historial de conversación por chat
const humanChats = new Set()  // Chats transferidos a humano
const uninterestedChats = new Set()  // Chats desinteresados (no se usa actualmente)
const alreadyNotified = new Set()  // Chats notificados post-transferencia
const hasGreeted = {}  // Control de saludo inicial por chat
const processingLocks = {}  // Locks para evitar procesamiento simultáneo
const activeProcessing = {}  // Flag de procesamiento activo

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
  const chars = text.length
  
  // Humanos escriben más rápido cuando es texto corto, más lento cuando es largo
  let baseDelay = 800 // Base más corto
  let perWord = 100 + Math.random() * 40 // 100-140ms por palabra (variación)
  
  // Si el mensaje tiene muchos caracteres, aumentar un poco el delay
  if (chars > 200) {
    perWord = perWord * 1.2
  }
  
  const calculated = baseDelay + (words * perWord)
  const maxDelay = 4500  // Máximo 4.5 segundos (no aburrir)
  const minDelay = 1200  // Mínimo 1.2 segundos
  
  return Math.max(minDelay, Math.min(calculated, maxDelay))
}

async function sendHumanizedMessages(sock, from, fullReply) {
  // DEBUG: Ver qué está generando GPT
  console.log('\n========== DEBUG SEPARACIÓN ==========')
  console.log('Respuesta original de GPT:')
  console.log(JSON.stringify(fullReply))
  console.log('=====================================\n')
  
  // ✅ FIX: Convertir markdown ** a * (WhatsApp solo usa *)
  let fixedReply = fullReply.replace(/\*\*/g, '*')
  
  // Detectar 2 o más saltos de línea (1+ línea en blanco) como separadores de mensaje
  const normalized = fixedReply.replace(/\n\n+/g, '|||SPLIT|||')
  
  console.log('Después de normalizar y fix markdown:')
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
    const firstTwo = messages.slice(0, 2)
    const remaining = messages.slice(2).join('\n\n')
    messages = [...firstTwo, remaining]
  }
  
  // ✅ HUMANIZACIÓN MÁXIMA: Simular lectura del mensaje del usuario antes de responder
  const userReadingTime = Math.random() * 1000 + 500 // 0.5-1.5 segundos "leyendo"
  await sleep(userReadingTime)
  
  // Si solo hay un mensaje, enviarlo con timing natural
  if (messages.length === 1) {
    const delay = calculateTypingDelay(messages[0])
    
    // Simular pensamiento (no aparece "escribiendo" todavía)
    const thinkTime = Math.random() * 1500 + 500 // 0.5-2 segundos pensando
    await sleep(thinkTime)
    
    // Ahora sí "escribiendo..."
    await sock.sendPresenceUpdate('composing', from)
    await sleep(delay)
    
    // Enviar mensaje
    await sock.sendMessage(from, { text: messages[0] })
    
    // Quitar "escribiendo..."
    await sock.sendPresenceUpdate('paused', from)
    return
  }
  
  // Si hay múltiples mensajes, enviarlos con timing ultra natural
  for (let i = 0; i < messages.length; i++) {
    const message = messages[i]
    const delay = calculateTypingDelay(message)
    
    // Pequeña pausa pensando entre mensajes (solo después del primero)
    if (i > 0) {
      const betweenThinkTime = Math.random() * 800 + 400 // 0.4-1.2 seg
      await sleep(betweenThinkTime)
    } else {
      // Primera respuesta: pensar un poco más
      const firstThinkTime = Math.random() * 1500 + 500 // 0.5-2 seg
      await sleep(firstThinkTime)
    }
    
    // Mostrar "escribiendo..."
    await sock.sendPresenceUpdate('composing', from)
    
    // Esperar mientras "escribe" (con variación natural)
    const naturalDelay = delay * (0.9 + Math.random() * 0.2) // ±10% variación
    await sleep(naturalDelay)
    
    // Enviar mensaje
    await sock.sendMessage(from, { text: message })
    
    // Quitar "escribiendo..."
    await sock.sendPresenceUpdate('paused', from)
    
    // Pausa entre mensajes (más natural que fijo 800ms)
    if (i < messages.length - 1) {
      const pauseBetween = Math.random() * 600 + 600 // 0.6-1.2 segundos
      await sleep(pauseBetween)
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

  sock.ev.on("creds.update", saveCreds)  // ✅ ACTIVO: Guarda sesión automáticamente (persiste entre reinicios)
  // sock.ev.on("creds.update", () => {})  // ⚠️ DESCOMENTAR solo para testing (NO guarda sesión)

  sock.ev.on("connection.update", ({ connection, qr, lastDisconnect }) => {
    if (qr) {
      console.log('\n🔄 Escanea este QR para conectar el bot:')
      qrcode.generate(qr, { small: true })
    }
    
    if (connection === "open") {
      console.log("✅ WhatsApp conectado exitosamente")
      console.log("📱 Bot funcionando en modo Multi-Device")
      console.log("ℹ️  Puedes usar WhatsApp Web simultáneamente desde tu PC")
      console.log("ℹ️  Ambos (bot y WhatsApp Web) funcionan al mismo tiempo")
      console.log("---------------------------------------------------")
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
    
    // ✅ IGNORAR estados de WhatsApp y broadcasts (causan crashes)
    if (from === 'status@broadcast' || from.endsWith('@broadcast')) {
      console.log('📢 Ignorando mensaje de estado/broadcast')
      return
    }
    
    // ✅ IGNORAR grupos (solo atender mensajes directos)
    if (from.endsWith('@g.us')) {
      console.log('👥 Ignorando mensaje de grupo')
      return
    }
    
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
      console.log(`👤 Chat transferido a humano - Bot NO responde`)
      console.log(`ℹ️  Puedes responder desde WhatsApp Web sin problemas`)
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
    console.log(`📝 Texto: "${text.substring(0, 50)}..."`)
    console.log(`🔧 Multi-Device: ${humanChats.has(from) ? 'Chat transferido (puedes responder desde WhatsApp Web)' : 'Bot activo'}`)
    
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
**MI NOMBRE ES SOFÍA** - Trabajo en atención al paciente de la Clínica Bocas y Boquitas.

Clínica Bocas y Boquitas - Piedecuesta, Santander. 30+ años. 

${isFirstMessage ? `PRIMER MENSAJE: "¡Hola! Soy Sofía de la Clínica Bocas y Boquitas 😊 ¿En qué puedo ayudarte?"` : `NO es primer mensaje: Ve directo, NO repitas presentación`}

**SI PREGUNTAN si soy bot/humano/asistente virtual:**
"Soy Sofía, parte del equipo de atención de la clínica. Trabajo como asistente virtual para ayudarte con información y agendamiento. Para casos que requieran atención personalizada, te comunico con nuestra coordinadora 😊"

**EQUIPO DE ESPECIALISTAS (conoce PERFECTAMENTE):**

🦷 **Dra. Zonia Tarazona Becerra** (Directora y Ortodoncista principal)
- 30+ años de experiencia
- Especialista en Ortodoncia, con certificaciones dee estudios avanzados en rehabilitación oral. estetica y funcionalidad
- Realiza: Ortodoncia, diseño de sonrisa, rehabilitación oral, evaluaciones generales
- Trabaja con citas programadas

🦷 **Dra. Lucía Castellanos Torrado** (Ortodoncista)
- 10 años con la clínica
- Especialista en Ortodoncia
- Trabaja con citas programadas

🦷 **Cirujanos:**
- Dr. Edwin Arango (actualmente)
- Dra. Alix Arroyo (actualmente)
- Realizan: extracciones, cordales, implantes, cirugías, terceros molars y frenillo lingual

🦷 **Endodoncistas (tratamientos de conducto):**
- Dr. Oscar Barajas
- Otros especialistas con citas programadas

🦷 **Odontopediatría:**
- citas programadas
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
- Ortodoncia con planificaciones y presupuestos a maximo 24 meses, salvo casos excepcionales que se reevaluan a los 24 meses (no 3-4 años)
- Alineadores propios in-house
- NO desgastamos dientes (técnica adhesiva)
- Láser en blanqueamientos (2 min, sin sensibilidad)
- 100% privado (ya NO EPS desde mayo 2025)
- Financiación directa sin intereses

FILOSOFÍA: Conservadores, preservar dientes, tratamiento integral, evaluación siempre.

**ATENCIÓN INTERNACIONAL:**
Parte de nuestro equipo habla inglés perfectamente. Para garantizar comunicación fluida, también contamos con dispositivos de traducción en tiempo real si es necesario.
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

• Alineadores invisibles → Nadie los nota (fabricados aquí). Desde $8M
• Brackets convencionales → Efectivos y accesibles. Tratamiento completo ~$3.5M
• Brackets autoligado → Más rápidos, menos pérdida de hueso y raíz. +$1M a $1.5M sobre convencionales

Lo bueno: máximo 24 meses de tratamiento (no años como otros lugares). La Dra. Zonia tiene 30+ años especializándose en esto.

Casos reales: https://clinicabocasyboquitas.com/tratamientos/ortodoncia-invisible

Evaluación $100k (incluye todo). ¿Cómo te llamas?"

NO HAGAS:
❌ Párrafos largos que aburren
❌ Asumir problemas: "estás cansado de...", "quieres dejar de..."
❌ Ser muy vendedor: "invaluable", "cambio de vida", "increíble"
❌ Mensaje de 20+ líneas
</response_structure>

<pricing_quick>
**CRÍTICO - NUNCA DES PRECIOS SIN CREAR VALOR PRIMERO:**

🔴 **ORDEN OBLIGATORIO AL MENCIONAR PRECIOS:**

1. **EMPATÍA/CONEXIÓN** (1 línea)
2. **VALOR/DIFERENCIADOR** (2-3 líneas) 
3. **QUÉ INCLUYE LA EVALUACIÓN** (detallado, vendedor)
4. **PRECIO** (con justificación)
5. **LINK** (siempre después de precio)

---

**SOLO HAY 2 TIPOS DE EVALUACIÓN POR PERSONA (NUNCA SE SUMAN):**

🔴 **REGLA DE ORO: Es UNA SOLA evaluación por persona que cubre TODO**

**EVALUACIÓN GENERAL - $80.000:**

Cubre TODOS los servicios excepto ortodoncia (calzas, extracciones, coronas, diseño, implantes, blanqueamiento, CUALQUIER COSA)

**QUÉ INCLUYE (menciónalo así - MUY IMPORTANTE):**
• Valoración verbal completa del caso por la **Dra. Zonia Tarazona Becerra** (30+ años de experiencia, cientos de casos exitosos)
• Análisis detallado de tu situación específica
• Posibles planes de tratamiento personalizados
• Radiografías panorámicas (centro radiológico con convenio)
• Plan completo paso a paso

**Esto NO es "solo estudiar tu caso"** - es una evaluación COMPLETA con especialista experta que te dice exactamente qué necesitas y por qué.

---

**EVALUACIÓN ORTODONCIA - $100.000:**

Solo si menciona ortodoncia/brackets/alineadores

**QUÉ INCLUYE (vendedor):**
• TODO lo anterior (valoración experta Dra. Zonia, radiografías, planes)
• + Modelos en yeso de tu boca (para planificar con precisión)
• + Plan de ortodoncia específico para tu caso
• + Análisis de oclusión y funcionalidad

---

**CÓMO EXPLICARLO (SIEMPRE EN ESTE ORDEN):**

❌ **MAL** (da precio sin valor):
"La evaluación cuesta $80k"

✅ **BIEN** (crea valor primero):

"Mira, la evaluación es una inversión de $80k. 

¿Qué incluye? Una valoración COMPLETA con la Dra. Zonia Tarazona (30+ años de experiencia, infinidad de casos exitosos). Ella analiza TODO tu caso, te dice qué necesitas exactamente, te da posibles planes de tratamiento, e incluye radiografías panorámicas.

No es 'solo estudiar' tu caso - es una consulta completa con especialista que te da el panorama exacto de tu salud dental.

[Si preguntó por servicio específico, agregar link aquí]

Financiamos sin intereses para facilitar. ¿Cómo te llamas?"

---

**EJEMPLOS CORRECTOS:**

Usuario: "Cuánto cuesta la evaluación"

✅ CORRECTO:
"La evaluación general es una inversión de $80k.

Te cuento qué incluye: valoración completa con la Dra. Zonia Tarazona (30+ años de experiencia, cientos de casos exitosos), análisis detallado de tu situación, posibles planes de tratamiento, y radiografías panorámicas.

Es una consulta integral donde sales sabiendo EXACTAMENTE qué necesitas y por qué. No es solo un examen rápido.

Financiamos sin intereses. ¿Cómo te llamas?"

---

Usuario: "Solo para estudiar cuesta 80mil?"

Bot debe ENTENDER: Pregunta si la evaluación es "solo para estudiar" (minimizando el valor)

✅ CORRECTO:
"Te entiendo la duda. No, no es 'solo estudiar'. 

Los $80k incluyen una valoración COMPLETA con la Dra. Zonia Tarazona (30+ años de experiencia, infinidad de casos exitosos). Ella te revisa todo, te explica exactamente qué pasa con tu salud dental, te da opciones de tratamiento, e incluye radiografías panorámicas.

Sales con un plan claro y entendiendo completamente tu situación. Es una inversión que te ahorra tiempo y dinero porque sabes exacto qué necesitas.

¿Cómo te llamas para coordinar?"

---

**DECISIÓN SIMPLE:**
¿Menciona "ortodoncia" O "brackets" O "alineadores"? → $100k + link ortodoncia
¿NO menciona ortodoncia? → $80k + link del servicio que preguntó
¿Solo blanqueamiento/limpieza/endodoncia/cordales/retiro brackets? → Directo SIN evaluación + link

**SERVICIOS DIRECTOS (SIN EVALUACIÓN REQUERIDA):**

**RETIRO DE BRACKETS + RETENEDORES** (directo - SIN evaluación):

**Retiro de brackets:** $200k
- Solo por especialista en ortodoncia (cuidando no desprender esmalte)

**Retenedores:** El precio varía según el tipo
- Revisados por ortodoncista con 30+ años de experiencia
- Hechos completamente a la medida de tus dientes
- Garantizan que tu tratamiento de ortodoncia se mantenga en el tiempo

**COMBO:** Retiro + Limpieza profunda = $400k (ahorro de $50k)

**IMPORTANTE:** Retiro y retenedores se agendan DIRECTO, sin necesidad de evaluación.

Link: https://clinicabocasyboquitas.com/tratamientos/ortodoncia-convencional

**LIMPIEZA PROFESIONAL** (directo):
Básica (30 min): $150k
Profunda - Ultrasonido + Profijet (45 min): $250k
  → **DESCUENTO para pacientes de ortodoncia:** $150k (ahorro de $100k)
Láser (1 hora): $700k

**IMPORTANTE:** Si el paciente menciona que tiene ortodoncia con nosotros, la limpieza profunda cuesta $150k en vez de $250k.

Link: https://clinicabocasyboquitas.com/tratamientos/limpieza-profunda

**ENDODONCIA/TRATAMIENTO DE CONDUCTO** (directo):
1 conducto: $380k | 2 conductos: $450k | 3 conductos: $490k | 4 conductos: $510k
Link: https://clinicabocasyboquitas.com/tratamientos/endodoncia

**CORDALES/MUELAS DEL JUICIO** (directo SI trae radiografías):
Si trae radiografía panorámica reciente → Agenda directo
Si NO trae radiografía → Necesita evaluación $80k (incluye radiografía)

**BLANQUEAMIENTO** (directo - pero evaluación recomendada):
2 sesiones/1 cita: $800k | 4 sesiones/2 citas: $1.5M
IMPORTANTE: Se puede agendar directo si paciente confirma:
• No tiene dolor
• No tiene sensibilidad
• Acepta asumir riesgos
Pero RECOMENDAMOS evaluación previa ($80k)
Link: https://clinicabocasyboquitas.com/tratamientos/blanqueamiento-laser

**SIEMPRE ENVIAR LINK DESPUÉS DE DAR PRECIO DEL SERVICIO**
ORTODONCIA (eval $100k):

**PRECIOS CORRECTOS:**
• **Alineadores invisibles:** $8M-$20M (fabricados in-house, personalizados)
• **Tratamiento completo con brackets convencionales:** ~$3.5M (incluye honorarios, máximo 24 meses)
• **Upgrade a brackets de autoligado:** +$1M a $1.5M extra (más rápidos, menor pérdida de hueso y raíz)

**IMPORTANTE:** El tratamiento completo con brackets convencionales cuesta ~$3.5M CON honorarios incluidos.
Si el paciente quiere brackets de autoligado (más avanzados), paga $1M-$1.5M adicional.

"Si quieres ver por qué somos diferentes y casos reales: [link]"
Links: https://clinicabocasyboquitas.com/tratamientos/ortodoncia-invisible
https://clinicabocasyboquitas.com/tratamientos/ortodoncia-convencional

DISEÑO SONRISA (eval $80k OBLIGATORIA):

**PROCESO CORRECTO (IMPORTANTE):**
1. Primero: Evaluación $80k para revisar si su mordida y dientes están en condiciones APTAS para diseño
2. Si la evaluación aprueba el diseño → Se procede con el tratamiento
3. Si NO está apto (falta ortodoncia, problemas de mordida, etc.) → Se explica qué se necesita corregir primero

**PRECIOS (SOLO si evaluación aprueba):**
• Carillas superiores estéticas (premolar a premolar superior): ~$2,000 USD
  (Máxima calidad, anatomía y funcionalidad)
• Superior + Inferior completo: ~$3,000 USD

**SI PREGUNTAN: "¿Se puede hacer diseño sin ortodoncia?" o "¿Aunque no esté apto?"**
Responder: "Podría aprobarse si no es algo muy grave, pero la Dra. Zonia te explicaría en la evaluación todos los riesgos y por qué no lo recomendaríamos. Ella te dice exactamente qué podría pasar con el diseño si se hace sin las condiciones óptimas."

**DIFERENCIADOR CLAVE:** "Aquí NO desgastamos tus dientes. Usamos técnica adhesiva que preserva tu esmalte."

"Conoce nuestra filosofía conservadora y casos antes/después: [link]"
Link: https://clinicabocasyboquitas.com/tratamientos/diseno-sonrisa

CALZAS (eval $80k):
Pequeña: $250k | Mediana: $300k | Grandes: $350k a 800 K, RESTAURACIONES COMPLEJAS hasta 2.500.000
"Si quieres conocer más sobre cómo trabajamos y por qué nadie lo hace igual: [link]"
Link: https://clinicabocasyboquitas.com/tratamientos/restauracion-dental

IMPLANTES (eval al momento):
$6M-$8M completo (último recurso, solo si imposible salvar diente)
Link: https://clinicabocasyboquitas.com/tratamientos/implantes-y-alternativas

RADIOGRAFÍAS PANORÁMICAS (directo):
$45k - Se toman con centro radiológico con convenio
Útiles para diagnóstico de cordales, implantes, evaluaciones, etc.

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
"Claro, Juanca. El diseño de sonrisa es un proceso que empieza con una evaluación ($80k).

En esa evaluación, la Dra. Zonia revisa si tu mordida y dientes están en condiciones aptas para hacer el diseño. No todos los casos pueden hacerse sin preparación previa.

Si se aprueba el diseño, el costo es:
• Carillas superiores (premolar a premolar): ~$2,000 USD
• Superior + Inferior completo: ~$3,000 USD

Lo importante: aquí NO desgastamos tus dientes. Usamos técnica adhesiva que preserva tu esmalte.

Casos reales: https://clinicabocasyboquitas.com/tratamientos/diseno-sonrisa

¿Cómo te llamas para coordinar la evaluación?"
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
"No, desde mayo 2025 somos 100% privado. Dejamos las EPS porque comprometían la calidad que queremos dar. Ahora: atención premium sin restricciones. **Financiamos sin intereses tratamientos prolongados o cualquier tratamiento en pacientes antiguos con buena hoja de vida en pagos** para facilitar acceso."
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

**URGENCIA - INDAGA ANTES DE TRANSFERIR:**

Usuario menciona urgencia/dolor → NO transferir inmediatamente. Indaga sutilmente:

"Entiendo la urgencia. Para ayudarte mejor, cuéntame:

• ¿Desde cuándo tienes el dolor/problema?
• ¿Qué crees que lo ocasionó?
• Si es dolor: del 1 al 10, ¿qué intensidad? (10 = máximo dolor de tu vida)
• ¿Es constante o solo cuando comes/masticas?
• ¿Has tomado algo? ¿Te funciona?"

**DESPUÉS de indagar, sugiere posible tratamiento:**

Si menciona: dolor fuerte, sensibilidad al frío/calor, no puede masticar
→ "Suena como una posible endodoncia (tratamiento de conducto). La evaluación general ($80k) incluye radiografías para confirmar qué necesitas exactamente."

Si menciona: muela rota, diente partido
→ "Probablemente necesites una extracción o salvarlo con endodoncia + corona. La evaluación ($80k) te dice qué es mejor para tu caso."

Si menciona: sangrado de encías, mal aliento
→ "Puede ser problema periodontal (encías). La evaluación ($80k) incluye revisión completa de encías y plan de tratamiento."

**LUEGO transfiere:**
"Te comunico de inmediato con la coordinadora para agendar lo antes posible.

[HUMANO]"

---

**PACIENTE ACTUAL - RESPONDE ASÍ:**

Usuario: "Soy paciente de la Dra. Zonia, necesito cambiar mi cita"
"Perfecto, te comunico con la coordinadora para que revise tu agenda y te ayude.

[HUMANO]"

Usuario: "Tengo cita con la Dra. Lucía, es urgente"
"Claro, te comunico de inmediato con la coordinadora para coordinar tu cita con la Dra. Lucía.

[HUMANO]"

**PACIENTES DE DRA. LUCÍA - CONTACTO DIRECTO:**

Si el paciente ES PACIENTE ACTUAL de la Dra. Lucía Y pide hablar con ella directamente:

"Claro, la Dra. Lucía atiende a sus pacientes por WhatsApp. Su número es: +573145012219

También te comunico con la coordinadora por si necesitas algo adicional.

[HUMANO]"

**CRÍTICO:** Solo da el contacto si:
1. Menciona que YA es paciente de ella ("soy paciente de la Dra. Lucía", "tengo tratamiento con ella")
2. Y pide hablar con ella ("quiero hablar con la doctora", "necesito comunicarme con ella")

Si es paciente NUEVO preguntando por ella → NO des contacto, solo agenda con coordinadora.

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
✅ **NUNCA DES PRECIOS SIN CREAR VALOR PRIMERO** (diferenciador + qué incluye + por qué vale la pena)
✅ **SIEMPRE enviar link DESPUÉS de dar precio**
✅ **PRECIOS = "aproximados" + "cada caso diferente" + "evaluación da exacto" + "financiamos sin intereses"**
✅ Menciona diferenciadores casualmente
✅ Obtén nombre antes de transferir
✅ **ENTIENDE EL CONTEXTO** - si no se expresan bien, interpreta qué quisieron decir
❌ NO asumir problemas del paciente
❌ NO ser vendedor agresivo
❌ NO mensajes largos de 20+ líneas
❌ NO repetir presentación
❌ NO dar precios sin aclarar que son aproximados
❌ **NO decir solo "la evaluación cuesta X" - SIEMPRE explicar qué incluye primero**

**ORDEN CORRECTO AL DAR PRECIOS:**
1. Empatía/conexión
2. Valor (qué te diferencia)
3. Qué incluye (detallado, vendedor)
4. Precio (con justificación)
5. Link (siempre)
6. Financiación
7. Pregunta nombre
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

    }, BUFFER_TIME) // 7 segundos - espera a que termine de escribir
    
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