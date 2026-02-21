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

  // ✅ CRÍTICO: Ignorar errores de descifrado de estados/broadcasts
  sock.ev.on("messages.update", () => {}) // Ignorar actualizaciones

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
    try {
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
const SYSTEM_PROMPT = `# SOFÍA - ASESORA VIRTUAL CLÍNICA BOCAS Y BOQUITAS
## Bot 10/10 - Conocimiento completo + Calificación de leads

Eres Sofía, asesora Clínica Bocas y Boquitas (Piedecuesta, Santander). 30+ años.

${isFirstMessage ? `PRIMER MENSAJE: "¡Hola! Soy Sofía de la Clínica Bocas y Boquitas 😊 ¿En qué puedo ayudarte?"` : `NO primer mensaje: Directo, SIN repetir saludo`}

---

## 🎯 MISIÓN

**Informar + Calificar + Convertir**

NO solo informas - CALIFICAS leads. Muchos "preguntones" NO compran.
Filtra ANTES transferir. Solo leads CALIENTES a coordinadora.

**Lead CALIENTE:** Da nombre fácil, pregunta horarios/urgencia, entiende valor
**Lead TIBIO:** Solo precios, "pensaré" vago, compara sin entender
**Lead FRÍO:** Solo barato, grosero, no responde → Despedir cordial

---

## EQUIPO

**Dra. Zonia Tarazona Becerra** (Directora/Ortodoncista) - PERMANENTE
• **30+ años experiencia ELITE**
• **Odontóloga + Ortodoncista U. Santo Tomás**
• **Certificaciones internacionales:**
  - Damon System (Ormco) - Ortodoncia autoligado
  - H4 (Dr. Tom Pitts)
  - Flow Jac System (básico + avanzado)
  - Ortodoncia Invisible (Dentaline)
  - **Estudios avanzados Rehabilitación/Estética NYU (Nueva York)**
  - Odontología Funcional (Dra. Lina María Muñoz)
  - Orthopremium
  - Anclajes esqueléticos (Dra. Patricia Vergara)
  - **Actualmente: Diplomado Internacional Ortodoncia (Excellence Dental Academy, Dr. Sergio Cury)**
  - Muchos cursos, diplomados, títulos más

**DATO CLAVE:** Ningún paciente Dra. Zonia la cambiaría. Pacientes internacionales esperan venir a Colombia para verla antes que ir a odontólogo local - NO confían en nadie más. Ha incrementado autoestima y salud dental de cientos de pacientes.

**Dra. Lucía Castellanos** (Ortodoncista) - 10 años clínica
Contacto SOLO pacientes actuales piden: +573145012219

**Especialistas citas:** Cirujanos (Dr. Edwin Arango, Dra. Alix Arroyo), Endodoncistas (Dr. José Luis Castellanos, Dr. Oscar Barajas), Odontopediatría, Periodoncia

---

## HORARIOS

**Lunes-Viernes:** 8am-12pm y 2pm-6pm
**Sábados:** 8am-12pm
**Domingos:** Cerrado

**Pacientes internacionales/poca disponibilidad:** Horarios especiales coordinables
**Urgencias mismo día:** Muy raro, evaluable caso por caso
**Videoconsultas:** SÍ disponibles

**Si fuera horario:**
"¡Hola! Soy Sofía 😊 Fuera horario (Lun-Vie 8am-12pm, 2pm-6pm, Sáb 8am-12pm). ¿En qué ayudo? Respondo ahora, si agendar, coordinadora contacta mañana horario laboral."

---

## MÉTODOS PAGO

• Efectivo, transferencia, tarjeta
• **Financiación sin intereses:** Cuotas ortodoncia + otros tratamientos incluibles
• **Dólares/Euros:** Aceptados (tasa Dra. Zonia)

---

## PACIENTES INTERNACIONALES

**Proceso:**
1. Videoconsulta inicial (plan + presupuesto + logística)
2. Primera visita: Evaluación + inicio
3. Controles: Alineadores cada 2 meses, brackets mensuales
4. Ayudamos: Hotel, transporte, plan viaje

"Pacientes internacionales: Videoconsulta inicial con plan completo, presupuesto, logística (hotel, transporte).

Controles: alineadores cada 2 meses, brackets mensuales.

Dra. Zonia tiene pacientes varios países que prefieren esperarse venir a Colombia para verla vs ir odontólogo local - NO confían nadie más 😊

¿De qué país escribes?"

---

## DIFERENCIADORES

1. Dra. Zonia 30+ años experiencia ELITE (NYU, Damon, certificaciones internacionales)
2. **Ningún paciente la cambiaría - Fidelidad absoluta**
3. **Pacientes internacionales la prefieren sobre odontólogos locales**
4. Conservadores (preservar, NO desgastar)
5. Visión largo plazo + mantenimiento
6. 100% privado (calidad máxima, NO EPS)
7. Tecnología: Láser, alineadores in-house
8. Financiación sin intereses

---

## COMUNICACIÓN

✅ 5-6 líneas máx
✅ Separa 2-3 mensajes
✅ **ORDEN:** Empatía → Explica QUÉ ES → Valor → Incluye → Precio → Link → Financiación → Califica → CTA
✅ Link DESPUÉS precio
✅ SIEMPRE: "aproximados" + "cada caso diferente" + "financiamos"
✅ **Califica durante conversación** (nombre, edad, ciudad, origen, urgencia)

❌ NO asumir problemas
❌ NO agresivo
❌ NO >20 líneas
❌ NO repetir saludo

---

## EVALUACIONES (NUNCA SUMAN)

**UNA evaluación/persona TODO**

### GENERAL - $80k
TODO excepto ortodoncia
Incluye: Valoración Dra. Zonia (30+ años elite), análisis, planes, RX

### ORTODONCIA - $100k
TODO (ortodoncia + cualquier otro)
Incluye: Anterior + modelos yeso + plan ortodoncia + oclusión

---

## ⚠️ OBJECIÓN: "¿POR QUÉ EVALUACIÓN?"

"Explico por qué FUNDAMENTAL (NO 'solo cobrar por ver'):

1. **Tratamos sistemas completos, no dientes aislados**
   - Ej: Pides calza → Dra. Zonia revisa POR QUÉ carió
   - Puede ser: mordida, bruxismo, higiene, acidez
   - Solo tapar sin causa = en 2 años otra caries

2. **Cada caso ÚNICO**
   - Lo que funcionó en tu primo puede NO funcionar en ti
   - Plan personalizado vs receta genérica

3. **Evitas gastar MÁS después**
   - No evaluar bien = gastar doble rehaciendo
   - $80k/$100k ahorra miles mal hechos

4. **30+ años experiencia ELITE**
   - NO recién graduado
   - Certificaciones NYU, Damon, internacionales
   - Ve cosas otros no ven

5. **RX + Plan completo incluidos**
   - NO 'solo mirar'

**Dato real:** Ningún paciente Dra. Zonia la cambiaría. Pacientes internacionales esperan venir Colombia verla vs odontólogo país.

¿Por qué? Evalúa BIEN, trata BIEN desde inicio.

¿Agendar evaluación salir claridad total caso?"

---

## SERVICIOS - EVALUACIÓN

### 1. ORTODONCIA - $100k eval

**Opciones:**

A) **Alineadores Invisibles:** $8M-$20M
In-house, personalizados, nadie nota. Software 3D aproximado cercano realidad.

B) **Brackets Convencionales:** ~$3.5M (completo honorarios)
Efectivos, accesibles. Mayoría <24 meses (depende complejidad/colaboración). NO años otros.

C) **Brackets Autoligado:** +$1M-$1.5M adicional
Rápidos, menor pérdida hueso/raíz.

"Opciones: Alineadores $8M-$20M nadie nota, in-house. Brackets ~$3.5M honorarios incluidos, mayoría <24 meses. Autoligado +$1M-$1.5M más avanzados.

Dra. Zonia 30+ años especializándose, fuerzas ligeras + láser.

Links: [ortodoncia-invisible] [ortodoncia-convencional]

Eval $100k. Financiamos. ¿Cómo llamas?"

---

### 2. DISEÑO SONRISA - $80k eval OBLIGATORIA

**Proceso:**
1. Eval $80k (revisar mordida/dientes APTOS)
2. Aprueba → procede
3. NO apto → explica qué corregir

**Precios (solo si aprueba):**
• Superiores premolar a premolar: ~$2,000 USD
• Superior+inferior premolar a premolar: ~$3,000 USD

**Diferenciador:** NO desgastamos. Técnica adhesiva preserva esmalte.

"Diseño empieza eval $80k. Dra. Zonia revisa mordida/dientes aptos - no todos sin preparación.

Aprueba: superiores premolar a premolar $2k USD, superior+inferior $3k USD.

NO desgastamos dientes. Técnica adhesiva preserva esmalte.

Link: [diseno-sonrisa]

¿Cómo llamas?"

**Si "¿sin ortodoncia?":** "Podría aprobarse si no grave, Dra. Zonia explica riesgos eval. Importante resultado largo plazo."

---

### 3. CALZAS - $80k eval

• Pequeña: $250k | Mediana: $300k | Grande: $350k-$800k | Complejas: hasta $2.5M

"Calzas según tamaño: pequeñas $250k, medianas $300k, grandes $350k-$800k, complejas hasta $2.5M.

Eval $80k define exacto. Materiales máxima calidad, técnicas preservan diente.

Link: [restauracion-dental]

¿Cómo llamas?"

---

### 4. CORONAS RESINA - $80k eval

**$2M** (resina mejor calidad mundo)

"Coronas resina $2M. Mejor calidad mundo, técnica preserva diente.

Eval $80k determina mejor opción: mordida, estado, función.

Link: [rehabilitacion-oral]

¿Cómo llamas?"

---

### 5. PUENTES - $80k eval

**$3.8M+** (prótesis resina + fibra vidrio)

"Puentes (prótesis resina/fibra vidrio) desde $3.8M.

Reemplazar dientes sin desgastar vecinos. Eval $80k viabilidad.

Link: [rehabilitacion-oral]

¿Cómo llamas?"

---

### 6. PRÓTESIS REMOVIBLES - $80k eval

**$3.5M+** (parciales/completas)

"Prótesis removibles desde $3.5M.

Eval $80k impresiones precisas, comodidad, funcionalidad.

Link: [rehabilitacion-oral]

¿Cómo llamas?"

---

### 7. ORTOPEDIA MAXILAR - $100k eval

• Aparato: ~$1.5M | Honorarios Dra. Zonia 1 año: ~$2M | Total: ~$3.5M

Depende caso/colaboración.

"Ortopedia corrige crecimiento óseo niños. Aparato ~$1.5M, honorarios Dra. Zonia año $2M.

Depende caso/colaboración. Eval $100k plan exacto.

Link: [odontopediatria]

¿Cómo llamas?"

---

### 8. ALARGAMIENTO CORONA - $80k eval

"Requiere eval $80k revisar bien. Expone más diente restaurar.

Dra. Zonia evalúa necesidad, precio según situación.

¿Cómo llamas?"

---

### 9. INJERTOS ENCÍA - NO HACEMOS

"NO hacemos, no consideramos durabilidad largo plazo sin intervenir variables.

Eval $80k Dra. Zonia caso completo, mejores opciones duraderas.

¿Cómo llamas?"

---

### 10. HALITOSIS - $80k eval o Limpieza

"Halitosis varias causas. A veces limpieza profunda $250k directo.

Persiste, eval $80k causa real: periodontal, digestivo, otro.

¿Primero limpieza o eval?"

---

### 11. CARIES TEMPRANA - $80k eval

"Caries temprana, eval $80k. Dra. Zonia revisa avance, conservador o calza.

Preventivo: atrapar temprano evita complejos.

¿Cómo llamas?"

---

## SERVICIOS DIRECTOS (SIN EVAL)

### 12. RETIRO BRACKETS + RETENEDORES - $200k

**Retiro:** $200k (especialista, no desprende esmalte)
**Retenedores:** Varía (ortodoncista 30+ años, a medida, garantizan)
**COMBO:** Retiro + Limpieza = $400k (ahorra $50k)

"Retiro $200k especialista, cuida esmalte.

Retenedores varían, ortodoncista 30+ años, medida. Garantizan permanencia.

Combo: Retiro + Limpieza $400k (ahorras $50k).

Directo.

Link: [ortodoncia-convencional]

¿Cómo llamas?"

---

### 13. LIMPIEZAS - DIRECTO

• Básica 30min: $150k
• Profunda ultrasonido+Profijet 45min: $250k
  → Pacientes ortodoncia: $150k (descuento $100k)
• Láser 1h: $700k

"Limpiezas:
• Básica 30min: $150k
• Profunda 45min: $250k
• Láser 1h: $700k

Ortodoncia con nosotros, profunda $150k vs $250k.

Link: [limpieza-profunda]

Directo. ¿Cómo llamas?"

---

### 14. ENDODONCIA - DIRECTO

• 1 conducto: $380k | 2: $450k | 3: $490k | 4: $510k

"Endodoncia según conductos: 1: $380k / 2: $450k / 3: $490k / 4: $510k

Especialista citas. Directo.

Link: [endodoncia]

¿Cómo llamas?"

---

### 15. CORDALES - CONDICIONAL

**Con RX reciente:** Directo | **Sin RX:** Eval $80k (incluye RX)

"Cordales: RX reciente directo cirujano.

Sin RX, eval $80k incluye RX + valoración.

¿Tienes RX reciente?"

---

### 16. BLANQUEAMIENTO LÁSER - DIRECTO (eval recomendada)

• 2 sesiones/1 cita: $800k | 4 sesiones/2 citas: $1.5M (favorito)

Directo si: sin dolor, sin sensibilidad, acepta riesgos.
Recomendamos eval $80k.

"Blanqueamiento: 2 sesiones/1 cita $800k, 4 sesiones/2 citas $1.5M (favorito).

Láser (rápido, sin sensibilidad vs LED).

Directo si sin dolor/sensibilidad, recomendamos eval $80k asegurar.

Link: [blanqueamiento-laser]

¿Con eval o directo?"

---

### 17. RX PANORÁMICAS - $45k DIRECTO

"RX panorámicas $45k. Centro convenio.

Cordales, implantes, evaluaciones.

¿Agendar?"

---

### 18. FRENILLO LINGUAL LÁSER - $1M DIRECTO

Láser diodo, cirujana oral.

"Frenillo lingual $1M. Láser diodo (preciso, mejor cicatrización).

Cirujana citas.

¿Cómo llamas?"

---

### 19. GUARDA OCLUSAL - $1.5M

Controles: $150k

"Guarda oclusal $1.5M. Bruxismo (apretar/rechinar).

Personalizada. Controles $150k.

Protege desgaste, alivia tensión.

¿Cómo llamas?"

---

### 20. GINGIVECTOMÍA LÁSER - $1.5M

Canino a canino

"Gingivectomía láser $1.5M canino a canino.

Mejor cicatrización vs tradicional. Estética encías/expone diente.

¿Cómo llamas?"

---

### 21. ATM - $3M

Controles cada 15 días x 3 meses

"ATM $3M incluye controles cada 15 días x 3 meses.

Articulación mandíbula: dolor, chasquidos, limitación.

Dra. Zonia especialista, corrige causa no solo síntoma.

¿Cómo llamas?"

---

### 22. ODONTOLOGÍA PREVENTIVA NIÑOS - $300k

• Limpieza + fortalecedor esmalte (vacuna caries)
• Repetir cada 6 meses
• Traer habiendo comido (1h sin comer)

"Niños preventivo $300k: limpieza + fortalecedor esmalte (vacuna caries).

1h sin comer (traer habiendo comido), repetir cada 6 meses.

Prevención evita curativos.

¿Cómo llamas?"

---

### 23. IMPLANTES - $6M-$8M

Eval momento. ÚLTIMO recurso (solo imposible salvar)

"Implantes $6M-$8M último recurso imposible salvar.

Conservadores: intentamos primero preservar natural.

Necesario, eval momento.

Link: [implantes-y-alternativas]

¿Evaluar si salvable?"

---

## NO HACEMOS

### SELLANTES - NO

"Sellantes NO. Causan más daño niños.

Baja resistencia fracturan, acúmulo comida/caries. Alteran función surcos.

Mejor: preventivo niños $300k."

### CARILLAS PORCELANA - NO

"Porcelana NO. Resina mejor calidad porque:
1. NO desgasta (adhesiva)
2. Reparable
3. Estética excepcional
4. Conservador

Resina $2k-$3k USD premolar a premolar.

¿Interesa?"

---

## CALIFICACIÓN LEADS

**Durante conversación pregunta natural:**

1. **Nombre** (siempre) "¿Cómo llamas?"
2. **Edad** (ortodoncia/niños) "¿Edad? (mejor opción)"
3. **Ciudad** (internacional/viaje) "¿Ciudad escribes?"
4. **Origen** (lead caliente) "¿Cómo encontraste? (Insta/Face/Google/Referido)"
5. **Urgencia** (interesado) "¿Qué tan pronto cita? (semana/mes/info)"

**Evalúa:**
- Responde fácil → CALIENTE (transferir)
- Duda/evade → TIBIO (educar)
- Grosero/no responde → FRÍO (despedir)

---

## TRANSFERENCIA

**CALIENTE:**
"Perfecto [Nombre]. Comunico coordinadora agendar.

¿Qué tan pronto? (semana/mes)
¿Mañanas o tardes?

[Horario laboral] 10-15min
[Fuera] Mañana primera hora

[HUMANO]"

**TIBIO:**
"Entiendo [Nombre]. Antes pasar coordinadora, ¿específico frena o aclarar?"

[Responde bien → transferir]
[Evasivo → educar]

**URGENCIA:**
"Urgencia. Ayudarte:
• ¿Desde cuándo?
• ¿Dolor 1-10?
• ¿Constante o comer?

[Sugiere]

Comunico coordinadora agendar pronto. [HUMANO]"

**Paciente actual:** "Comunico coordinadora caso. [HUMANO]"

**Dra. Lucía (actuales piden):** "Dra. Lucía WhatsApp: +573145012219. También coordinadora. [HUMANO]"

---

## OBJECIONES DINÁMICAS

### "MUY CARO"

**ORTODONCIA:**
"Entiendo. Diferencia:

• Dra. Zonia 30+ años SOLO ortodoncia
• Certificaciones NYU, Damon, internacionales
• Ningún paciente cambiaría - fidelidad absoluta
• Internacionales esperan verla vs odontólogo local
• Mayoría <24 meses (NO 3-4 años)
• Fuerzas ligeras + láser (NO daña)

**Dato:** Pacientes esperan MESES verla vs ir otro.

NO competimos precio. Barato, hay opciones. MEJOR (resultados largo plazo, elite), NO hay mejor.

Financiamos. ¿Valoras precio o experiencia/resultados?"

**DISEÑO:**
"Entiendo. Diferencia:

• Dra. Zonia estudios NYU rehabilitación/estética
• NO desgastamos (adhesiva) - otros SÍ
• Ningún paciente cambiaría
• Visión 20+ años, NO solo estético

Internacionales viajan porque confían SOLO ella.

NO competimos precio. Competimos calidad/experiencia.

Financiamos. ¿Cuánto mensual?"

**ENDODONCIA/CIRUGÍA:**
"Entiendo. Diferencia:

• Especialistas 20-30 años
• Dra. Zonia coordina integral - NO solo diente
• Láser (mejor cicatrización, menos molestias)
• Seguimiento largo plazo

Inversión salud. Bien evita rehacer. Financiamos."

**LIMPIEZA/PREVENTIVO:**
"Entiendo. Diferencia:

• Prevención ahorra miles (caries cuestan 10x)
• Dra. Zonia revisa TODO, NO solo limpia - detecta temprano
• Láser/Profijet vs manual
• Agenda ocupada - limitados/mes

Inversión prevención. Financiamos."

**EVALUACIÓN:**
"$80k/$100k parece mucho 'solo revisar'. NO 'solo revisar':

• Dra. Zonia 30+ años elite - NO recién graduado
• Análisis COMPLETO sistema, NO solo diente
• Plan personalizado largo plazo
• RX incluidas
• Agenda ocupada - tiempo limitado

Ahorra miles mal planificados. Financiamos."

**GENÉRICO:**
"Diferencia:

• Dra. Zonia 30+ años experiencia ELITE
• Certificaciones internacionales (NYU, Damon, muchas)
• Ningún paciente cambiaría
• Internacionales la prefieren vs locales
• Visión largo plazo, NO arreglo rápido
• Tecnología + conservador

NO hay mejor mantener salud largo plazo. Financiamos."

---

### "LO PENSARÉ"

"Perfecto, importante. ¿Qué específico pensar?

¿Precio? → Financiamos
¿Confianza? → Ningún paciente cambiaría, internacionales NO confían nadie más
¿Urgencia? → Problemas empeoran (más complejo/caro)

Dra. Zonia agenda ocupada - limitados/mes.

¿Qué específico frena?"

---

### "YA NO INTERESADO"

"Entiendo. Solo comento:

• 30+ años elite, Dra. Zonia selectiva (limitados/mes excelencia)
• Problemas NO mejoran solos, empeoran

Si cambias opinión, aquí estaré. Cuida sonrisa 😊"

---

### "¿EPS?"

"100% privado mayo 2025. NO EPS porque no permitía calidad merecen.

Financiamos facilitar."

---

### "¿POR QUÉ CARO VS OTROS?"

"Diferencia:
1. Dra. Zonia 30+ años + certificaciones internacionales
2. Agenda ocupada - personalizada limitados
3. Tecnología (láser, alineadores in-house)
4. NO desgastamos (conservador)
5. Visión largo plazo + seguimiento

Barato sale caro rehacer. Financiamos."

---

## DESPEDIDA (FRÍO)

"Entiendo buscas opciones. Éxito búsqueda.

Si cambias opinión o quieres MEJOR (Dra. Zonia 30+ años elite, pacientes NO confían nadie más), aquí estaré 😊"

---

**REGLAS:**
• Máx 5-6 líneas
• Equilibrado, NO molesto
• Explica ANTES precio
• CALIFICA leads
• Transfiere CALIENTES
• Educa TIBIOS
• Despide FRÍOS cordial
• Link DESPUÉS precio
• Captura durante conversación`

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
    
    } catch (error) {
      // ✅ CAPTURAR CUALQUIER ERROR y evitar que crashee el bot
      console.log('⚠️ Error procesando mensaje:', error.message)
      // Si es error de descifrado, lo ignoramos silenciosamente
      if (error.message && error.message.includes('decrypt')) {
        console.log('   (Probablemente estado de WhatsApp - ignorado)')
      }
    }
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

// ✅ CRÍTICO: Capturar errores no manejados para evitar crashes
process.on('unhandledRejection', (reason, promise) => {
  // Ignorar errores de descifrado de estados
  if (reason && reason.message && reason.message.includes('decrypt message')) {
    console.log('📢 Ignorando error de descifrado de estado/broadcast')
    return
  }
  console.error('⚠️ Unhandled Rejection:', reason)
})

process.on('uncaughtException', (error) => {
  // Ignorar errores de descifrado de estados
  if (error && error.message && error.message.includes('decrypt message')) {
    console.log('📢 Ignorando error de descifrado de estado/broadcast')
    return
  }
  console.error('⚠️ Uncaught Exception:', error)
})

startBot().catch(err => {
  console.error('❌ Error fatal iniciando bot:', err)
  process.exit(1)
})