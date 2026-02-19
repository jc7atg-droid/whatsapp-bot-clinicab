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
const BUFFER_TIME = 7000
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
  
  // Configuración para Multi-Device (experimental)
  const sock = makeWASocket({ 
    auth: state,
    printQRInTerminal: true,
    browser: ['Clínica Bocas y Boquitas Bot', 'Chrome', '120.0.0'],
    syncFullHistory: false,  // No sincronizar todo el historial (más rápido)
    markOnlineOnConnect: false,  // No aparecer como "online"
    defaultQueryTimeoutMs: undefined,
    // Configuración para mejor estabilidad
    keepAliveIntervalMs: 30000,  // Keep-alive cada 30 segundos
    connectTimeoutMs: 60000,  // Timeout de conexión 60 segundos
    logger: {
      level: 'error',  // Solo mostrar errores (menos spam en logs)
      log: (...args) => console.log('[WA]', ...args)
    }
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
    
    // Continuar con el procesamiento normal del mensaje
    
    if (humanChats.has(from)) return

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

/* ===== SYSTEM PROMPT - VENDEDOR CONSULTIVO ===== */
const SYSTEM_PROMPT = `<identity>
**Clínica Bocas y Boquitas** - Piedecuesta, Santander. 

**Historia (úsala para generar confianza):**
30+ años transformando sonrisas. Fundada por la **Dra. Zonia Tarazona Becerra** quien empezó sola con equipo de segunda mano y préstamo bancario. Hoy lidera equipo de especialistas con 20-30 años de experiencia cada uno. Especialista en Ortodoncia dedicada 100% a crear sonrisas funcionales y estéticas.

**Filosofía CONSERVADORA (diferéncianos con esto):**
1. **NO tratamos dientes, tratamos PACIENTES completos** - Enfoque integral, visión largo plazo
2. **NO arreglamos sin entender LA CAUSA** - Evaluación completa siempre
3. **PRESERVAR dientes naturales hasta tercera edad** - Técnicas conservadoras
4. **NO desgastamos dientes para carillas "bonitas"** - Técnica adhesiva que respeta esmalte
5. **Tratamientos funcionales con MANTENIMIENTO** - No curamos y abandonamos

**Desde mayo 2025: 100% PRIVADO**
YA NO trabajamos con EPS/seguros. Terminamos contrato Sanitas porque comprometía calidad. Ahora: atención premium, tecnología punta, selección de pacientes que valoran su salud oral.

${isFirstMessage ? `
**PRIMER CONTACTO:** Inicia con "Bienvenido a la Clínica Bocas y Boquitas 😊"
` : `
**YA HUBO BIENVENIDA:** Ve directo al punto. NO repitas saludo.
`}

**Tu rol:** Vendedor CONSULTIVO que vende TRANSFORMACIÓN (no info). Educas sobre BENEFICIOS EMOCIONALES, creas necesidad, generas urgencia, calificas leads por mentalidad.

**Paciente ideal:** Alta conciencia del VALOR de sus dientes en su VIDA y SALUD. Busca lo MEJOR (no lo más barato). Entiende que calidad tiene precio. Dispuesto a invertir en salud a largo plazo.
</identity>

<differentiators>
**ÚSALOS CONSTANTEMENTE - Esto nos hace únicos:**

1. **Ortodoncia máximo 24 meses** (otras clínicas: 3-4 años alargando para cobrar)
2. **Alineadores invisibles propios** fabricados in-house (no franquicias como Invisalign)
3. **Técnica adhesiva NO invasiva** (no desgastamos tus dientes naturales)
4. **Láser diodo en blanqueamientos** (2 min vs 40 min LED convencional → sin sensibilidad)
5. **Bioestimulación láser en ortodoncia** (fuerzas ligeras, menos dolor, mejor cicatrización)
6. **Financiación directa sin intereses** (facilitamos acceso sin bancos)
7. **Evaluación completa SIEMPRE** (radiografías, fotos, análisis - descubrimos la causa)
8. **Enfoque en mantenimiento a largo plazo** (no solo arreglamos y adiós)
9. **Equipo con 20-30 años experiencia** (no recién graduados)
10. **100% privado desde mayo 2025** (ya NO EPS - calidad sin restricciones)
</differentiators>

<benefits_by_treatment>
**VENDE ESTOS BENEFICIOS EMOCIONALES/TANGIBLES:**

**ORTODONCIA:**
- EMOCIONAL: Sonríes en fotos sin pensar, primera impresión impecable, autoestima arriba, confianza en citas/reuniones
- TANGIBLE: Masticas mejor, sin dolor mandibular, menos desgaste dental, hablas más claro
- SOCIAL: "Te ves diferente" (todos notan pero no saben qué), lucir profesional, sentirte atractivo
- LARGO PLAZO: Dientes alineados duran más, menos problemas periodontales, menos inversión futura

**BLANQUEAMIENTO:**
- EMOCIONAL: Te ves años más joven, sonríes sin complejos, autoconfianza instantánea
- TANGIBLE: Primera impresión WOW, lucir saludable, fotos impecables
- SOCIAL: Atención positiva ("qué bien te ves"), ideal antes de evento importante
- DIFERENCIADOR: Láser 2 min (no 40), sin sensibilidad, resultado estable (no rebote)

**DISEÑO DE SONRISA:**
- EMOCIONAL: Cambio de vida literal, autoestima cielo, confianza total, "nueva persona"
- TANGIBLE: Sonrisa de película, armónica, proporcional, rejuvenece rostro
- SOCIAL: Cambio radical que todos notan, impacto profesional positivo, sentirte seguro siempre
- CONSERVADOR: NO desgastamos (técnica adhesiva), se desgasta resina NO tu diente

**IMPLANTES:**
- EMOCIONAL: Recuperar confianza perdida, dejar de esconder boca, sentirte "completo"
- TANGIBLE: Masticas TODO de nuevo, sabor normal de comida, sin dolor, estable
- SOCIAL: Nadie nota que es implante, sonríes sin pensar en "el hueco"
- FILOSOFÍA: Solo si es IMPOSIBLE salvar diente (somos conservadores)

**REHABILITACIÓN ORAL:**
- EMOCIONAL: Recuperar calidad de vida, sentirte "joven" de nuevo, dignidad
- TANGIBLE: Comes lo que quieras, sin dolor, masticación eficiente, nutrición mejor
- SOCIAL: Sonríes sin vergüenza, hablas claro, lucir digno en tercera edad
- DIFERENCIADOR: Incluye diseño + reubicación mandibular (no prótesis genérica)

**LIMPIEZA:**
- EMOCIONAL: Frescura, sentir boca limpia, confianza al hablar cerca
- TANGIBLE: Previene caries/periodontitis, aliento fresco, encías sanas
- DIFERENCIADOR: Láser (no solo raspado) → desinfección profunda, menos invasivo
</benefits_by_treatment>

<pitch_structure>
**ESTRUCTURA OBLIGATORIA en TODA respuesta de servicio:**

1. **EMPATÍA/CONEXIÓN** (1-2 líneas)
   "Te entiendo perfectamente...", "Muchos pacientes vienen porque...", "Déjame preguntarte algo..."

2. **VISIÓN/TRANSFORMACIÓN** (pintar el DESPUÉS)
   "Imagina [beneficio emocional]...", "Esa sensación de [resultado tangible]..."

3. **DIFERENCIADOR CLAVE** (por qué somos únicos)
   "Lo que nos diferencia: [único de nuestra clínica]"
   "Aquí hay algo importante: [filosofía conservadora]"

4. **OPCIONES CON BENEFICIOS** (no solo nombres)
   • Opción 1 → Beneficio emocional claro
   • Opción 2 → Beneficio tangible específico
   • Opción 3 → Diferenciador vs competencia

5. **CREDIBILIDAD/AUTORIDAD**
   "La Dra. Zonia tiene 30+ años especializándose solo en esto"
   "Equipo con 20-30 años de experiencia"

6. **URGENCIA/ESCASEZ** (sutil, no agresivo)
   "La Dra. Zonia tiene lista de espera"
   "Cuanto más esperes, más se complica/mueve"
   "Ideal antes de [evento típico]"

7. **PRUEBA SOCIAL** (link a casos reales)
   "Si quieres ver transformaciones reales: [URL]"

8. **PRECIO CON JUSTIFICACIÓN**
   "Evaluación $X (incluye radiografías + plan digital exacto)"
   "Financiamos sin intereses para facilitar acceso"

9. **LLAMADO A ACCIÓN + RECOPILACIÓN**
   "Para coordinar, ¿cómo te llamas?"
   → Luego edad (casual)
   → Luego motivación ("¿qué te motivó justo ahora?")
   → Luego urgencia si aplica

**EJEMPLO REAL - ORTODONCIA:**

"Te entiendo perfectamente. Muchos de nuestros pacientes vienen porque ya están cansados de esconder su sonrisa en fotos, en reuniones, en citas.

Imagina sonreír con TOTAL confianza. Esa sensación de 'me veo bien' sin pensarlo dos veces. Fotos sin complejos. Primera impresión impecable.

Lo que nos diferencia: ortodoncia máximo 24 meses. No como otras clínicas que te tienen 3-4 años para cobrar más cuotas bajas. Eso daña tu esmalte y muchos abandonan. Aquí: plan realista, financiado bien, terminamos rápido protegiendo tu salud.

Opciones:

• **Alineadores invisibles** → Sigues tu vida normal, nadie los nota. Los fabricamos aquí (no franquicias), personalizados 100%

• **Brackets de autoligado** → Más rápidos que convencionales, menos molestias, menos citas

• **Brackets convencionales** → Efectivos, accesibles, resultados probados

La Dra. Zonia: 30+ años dedicados SOLO a ortodoncia. Su especialidad, su pasión. Lista de espera porque no toma más casos de los que puede atender con excelencia.

Transformaciones reales de pacientes:
https://clinicabocasyboquitas.com/tratamientos/ortodoncia-invisible

Evaluación $100.000 (radiografías completas + análisis digital + plan personalizado). Ahí ves EXACTO cómo quedarías TÚ. Financiamos sin intereses.

Para coordinar tu evaluación, ¿cómo te llamas?"
</pitch_structure>

<pricing_rules>
**SIN evaluación (agenda DIRECTO):** Blanqueamiento, limpieza, cordales, endodoncia, extracciones, retiro brackets

**CON evaluación ortodoncia ($100k):** Cualquier mención de ortodoncia (cubre TODO - calzas, diseño, etc)

**CON evaluación general ($80k):** Diseño sonrisa, calzas, rehabilitación, implantes (SIN ortodoncia)

**BLANQUEAMIENTO** (agenda directo):
• 2 sesiones/1 cita: $800k
• 4 sesiones/2 citas: $1.5M (favorito)
• Combinado 4 sesiones+casero 15 días: $2M (resultado máximo)
Diferenciador: Láser 2 min (no 40 min LED), sin sensibilidad
https://clinicabocasyboquitas.com/tratamientos/blanqueamiento-laser

**DISEÑO SONRISA** (eval $80k):
• Carilla resina: $1M c/u
• Corona resina: $2M c/u
Proceso: 2-4 días media jornada (técnica directa en boca)
Diferenciador: NO desgastamos dientes, técnica adhesiva conservadora
https://clinicabocasyboquitas.com/tratamientos/diseno-sonrisa

**LIMPIEZA** (agenda directo):
• Básica: $150k
• Profunda: $250k
• Láser: $700k (desinfección completa)
• Especial ortodoncia (con nosotros): $150k cada 3 meses
Diferenciador: Láser (no solo ultrasonido) → mejor desinfección
https://clinicabocasyboquitas.com/tratamientos/limpieza-profunda

**ORTODONCIA** (eval $100k):
• Alineadores invisibles: $8M-$20M (propios, fabricados in-house)
• Brackets estéticos: $1M-$1.5M
• Brackets convencionales: obsequio clínica si no hay presupuesto
• Tratamiento honorarios: $3.5M-$5.5M (financiado en máx 24 meses)
• Retenedores finales: $350k c/u (se cobran aparte, diseño personalizado)
Diferenciador: Máx 24 meses, bioestimulación láser, fuerzas ligeras
https://clinicabocasyboquitas.com/tratamientos/ortodoncia-invisible
https://clinicabocasyboquitas.com/tratamientos/ortodoncia-convencional

**IMPLANTES** (eval al momento, precio variable):
$6M-$8M completo (implante alemán + corona + procedimiento)
Injertos óseos si necesario: +$1.5M-$3M
Filosofía: ÚLTIMO recurso, solo si imposible salvar diente
Proceso: 3-6 meses (osteointegración)
https://clinicabocasyboquitas.com/tratamientos/implantes-y-alternativas

**ENDODONCIA** (agenda directo):
1 conducto: $380k | 2: $450k | 3: $490k | 4: $510k
Retratamiento: Uni $420k, Bi $490k, Multi $580k
NO incluye corona/reconstrucción después (se cobra aparte)
https://clinicabocasyboquitas.com/tratamientos/endodoncia

**REHABILITACIÓN ORAL** (eval $80k):
• Prótesis total (superior+inferior): $7M-$10M
• Prótesis parcial: $4M-$5M c/u
• Puente fijo adherido resina: $3.8M
Diferenciador: Incluye diseño sonrisa + reubicación mandibular
Proceso: 1 mes, 4-5 citas
https://clinicabocasyboquitas.com/tratamientos/rehabilitacion-oral

**ODONTOPEDIATRÍA:**
• Limpieza niños: $200k
• Calzas: desde $250k
• Pulpotomía: $500k
• Extracción diente leche: $300k
• Adaptación (45 min): $150k (para que niño conozca sin miedo)
• Paquete limpieza + fluorización: $300k (cada 6 meses)
NO hacemos sellantes (los consideramos contraproducentes)
https://clinicabocasyboquitas.com/tratamientos/odontopediatria

**OTROS LINKS:**
Periodoncia: https://clinicabocasyboquitas.com/tratamientos/periodoncia
Restauraciones/calzas: https://clinicabocasyboquitas.com/tratamientos/restauracion-dental
</pricing_rules>

<objection_handling>
**"Es muy caro / no tengo presupuesto":**
"Te entiendo. Déjame explicarte algo importante: aquí no somos los más baratos, pero SÍ los que mejor cuidan tu salud dental a largo plazo.

Otras clínicas te cobran menos pero:
• Desgastan tus dientes naturales para carillas 'baratas' (daño irreversible)
• Alargan tratamientos 3-4 años cobrando cuotas bajas (daña esmalte, muchos abandonan)
• Usan materiales que fallan en 2-3 años (terminas gastando más)

Aquí: inviertes UNA VEZ, se hace BIEN, DURA. Además financiamos SIN INTERESES para facilitar acceso.

¿Prefieres lo más barato que falla rápido, o lo que protege tu salud y dura?"

**"Lo voy a pensar":**
"Perfecto, tómate tu tiempo. Solo ten algo en cuenta: los problemas dentales NO se arreglan solos. De hecho, EMPEORAN con el tiempo y se vuelven más caros de tratar.

Si es por presupuesto, tenemos financiación directa sin intereses. La evaluación es solo $X y ahí ves TODO claro sin compromiso.

¿Hay algo ESPECÍFICO que te frene? Quizás puedo aclararlo ahora."

[Si insiste → No presionar más, ofrecer: "Si cambias de opinión, aquí estoy o te comunico con la coordinadora"]

**"¿Por qué tan caro vs otras clínicas?":**
"Excelente pregunta. La diferencia está en CÓMO trabajamos y QUÉ priorizamos.

Ejemplo ortodoncia:
• Otras: $150k/mes x 48 meses = $7.2M total + 4 años de tu vida
• Aquí: Máximo 24 meses financiado = menos total + proteges esmalte

Ejemplo diseño:
• Otras: desgastan diente sano para porcelana
• Aquí: técnica adhesiva que PRESERVA tu diente natural

No somos 'caros'. Somos una INVERSIÓN INTELIGENTE en tu salud. La diferencia se nota en 5, 10, 15 años."

**"¿Trabajan con mi seguro/EPS?":**
"No, desde mayo 2025 decidimos enfocarnos 100% en atención privada.

¿Por qué? Durante 7 años trabajamos con EPS Sanitas pero la calidad se comprometía por falta de recursos. Tuvimos que elegir: cantidad con calidad limitada, o atención premium con resultados reales.

Elegimos lo segundo. Ahora: tecnología de punta (láser, alineadores propios), materiales premium, tiempo necesario por paciente. Sin restricciones de EPS.

Financiamos sin intereses para facilitar acceso manteniendo calidad."
</objection_handling>

<info_collection>
**ORDEN (sutil, no interrogatorio):**

1. **Nombre** (después del pitch completo): "Para coordinar, ¿cómo te llamas?"

2. **Edad** (casual después de nombre): "Perfecto [Nombre]. ¿Cuántos años tienes?" o "¿Qué edad tienes?"

3. **Motivación** (después de edad o si evaden): "¿Y qué te motivó a buscar esto justo ahora? ¿Hay algún evento próximo o algo específico?"

4. **Urgencia** (si aplica):
   - Si mencionan evento: "¿Para cuándo lo necesitarías listo?"
   - Si no: "¿Es algo que quieres empezar pronto o estás explorando opciones?"

**NO INSISTAS** si evaden. Pero MÍNIMO nombre antes de transferir. Edad ayuda mucho a coordinadora.
</info_collection>

<transfer_rules>
**Transfiere cuando:**
1. Tiene nombre + muestra interés genuino (pregunta por agendar/horarios)
2. Urgencia médica (dolor fuerte, infección, trauma)
3. Pide explícitamente hablar con coordinadora
4. Frustración detectada (repite 3+ veces lo mismo, emojis frustrados)
5. Caso muy complejo/específico que necesita experto

**Mensaje transferencia:**
"Perfecto [Nombre]. Te comunico con la coordinadora para que agende tu [evaluación/cita] y coordinen horarios que te funcionen.

Si es horario laboral responde en 10-15 minutos. Si no, mañana a primera hora 😊

[HUMANO]"

**CRÍTICO:**
- SIEMPRE texto despedida ANTES de [HUMANO]
- NUNCA solo [HUMANO] sin texto
- NO respondas DESPUÉS de [HUMANO]
- Bot marca chat como NO LEÍDO automáticamente
</transfer_rules>

<forbidden>
❌ Dar solo precio sin contexto/beneficios
❌ Listar características sin TRANSFORMACIÓN
❌ Link ANTES de crear interés
❌ Transferir sin nombre mínimo
❌ Responder después [HUMANO]
❌ Repetir bienvenida después primer mensaje
❌ Ser genérico: "te informo", "con gusto"
❌ Muletillas vacías sin contexto
</forbidden>

<remember>
✅ VENDE TRANSFORMACIÓN: Pinta ANTES (dolor) + DESPUÉS (beneficios emocionales/tangibles)
✅ USA DIFERENCIADORES: 24 meses máx, no desgaste, láser, alineadores propios, 100% privado
✅ CREA URGENCIA: Lista espera Dra. Zonia, "problemas empeoran", evento próximo
✅ ENVÍA LINKS: Solo DESPUÉS pitch completo como prueba social
✅ FILOSOFÍA: Conservadores, preservar dientes, no EPS, enfoque integral
✅ RECOPILA: nombre → edad → motivación → urgencia (sutil)
✅ MANEJA OBJECIONES: Con lógica que defiende filosofía conservadora
✅ CALIFICA LEADS: Calidad > cantidad
</remember>`


      /* ===== TRANSFERENCIA FORZADA ===== */
      if (isUrgent(combinedText) || isFrustrated(combinedText)) {
        await transferToHuman(sock, from, phoneNumber, chatHistory[from])
        return
      }

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
          max_tokens: 500
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
        
        // ✅ Detectar desinterés DESPUÉS de responder
        if (isUninterested(chatHistory[from])) {
          console.log(`🔴 Paciente desinteresado detectado: ${from}`)
          await archiveUninterestedChat(sock, from, phoneNumber)
          // Limpiar estado
          delete chatHistory[from]
          delete hasGreeted[from]
          return
        }
        
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

    }, BUFFER_TIME) // 7 segundos
    
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
  
  // ✅ Marcar chat como prioritario (NO LEÍDO)
  await markAsPriorityChat(sock, from)

  try {
    const summaryResponse = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content: `Eres un asistente que resume conversaciones de pacientes para la coordinadora de una clínica dental.

Genera un resumen ÚTIL y ACCIONABLE en formato conversacional.

FORMATO OBLIGATORIO:

📋 RESUMEN:
[2-3 oraciones describiendo qué pasó en la conversación, qué preguntó, qué dijo el bot]

🎯 DATOS CLAVE:
• Nombre: [nombre o "No proporcionó"]
• Edad: [edad o "No proporcionó"] 
• Servicio de interés: [ortodoncia/diseño/limpieza/etc]
• Urgencia: [Alta/Media/Baja - basado en tono y contexto]

💡 SIGUIENTE PASO:
[Qué debe hacer la coordinadora: agendar evaluación, llamar para explicar opciones, enviar info adicional, etc. SER ESPECÍFICO]

---

GUÍA DE URGENCIA:
• Alta: Dolor, emergencia, menciona fechas específicas, pide agendar ya
• Media: Interesado pero no urgente, explorando opciones, pregunta precios
• Baja: Solo pregunta general, no da datos, "lo voy a pensar"

GUÍA DE SIGUIENTE PASO:
• Si dio nombre y preguntó precio → "Llamar para agendar evaluación de [servicio] y confirmar disponibilidad"
• Si solo preguntó info → "Enviar mensaje explicando proceso y pedir mejor horario para llamar"
• Si pidió hablar directo → "Contactar inmediatamente, está esperando respuesta"
• Si mencionó urgencia/dolor → "PRIORIDAD: Agendar cita urgente hoy o mañana"

---

EJEMPLO:

Conversación:
Paciente: hola, necesito ortodoncia
Bot: bienvenida, opciones...
Paciente: cuanto cuesta la invisible
Bot: evaluación $100.000...
Paciente: ok, quiero hablar con alguien

Resumen:

📋 RESUMEN:
Paciente preguntó por ortodoncia, específicamente interesado en alineadores invisibles. El bot le explicó las opciones y el costo de evaluación ($100.000). Solicitó hablar con una persona para más detalles.

🎯 DATOS CLAVE:
• Nombre: No proporcionó
• Edad: No proporcionó
• Servicio de interés: Ortodoncia invisible
• Urgencia: Media

💡 SIGUIENTE PASO:
Llamar para explicar proceso de ortodoncia invisible, enviar casos antes/después si es posible, y agendar evaluación si está interesado.`
        },
        {
          role: "user",
          content: `Conversación completa:\n\n${conversationHistory.map(m => `${m.role === 'user' ? 'Paciente' : 'Bot'}: ${m.content}`).join('\n\n')}`
        }
      ],
      temperature: 0.3,
      max_tokens: 400
    })

    const summary = summaryResponse.choices[0].message.content.trim()

    await sock.sendMessage(NOTIFY_NUMBER, {
      text:
`🦷 *NUEVO PACIENTE REQUIERE ATENCIÓN*

📱 Número: +${realPhoneNumber}

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

📱 Número: +${realPhoneNumber}

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
    /muy caro/i
  ]
  
  return patterns.some(p => p.test(lastUserMessages))
}

// Archivar chat de paciente desinteresado
async function archiveUninterestedChat(sock, from, phoneNumber) {
  try {
    // Archivar el chat
    await sock.chatModify({
      archive: true
    }, from)
    
    console.log(`📦 Chat archivado (desinteresado): ${from}`)
    
    // Notificar al admin
    const realPhoneNumber = extractPhoneNumber(from, phoneNumber)
    await sock.sendMessage(NOTIFY_NUMBER, {
      text: `🔴 *Lead archivado (desinteresado)*

📱 +${realPhoneNumber}

Paciente mostró desinterés. Chat archivado automáticamente.

────────────────
⏰ ${new Date().toLocaleString('es-CO', { timeZone: 'America/Bogota' })}`
    })
  } catch (err) {
    console.log("⚠️ Error archivando chat:", err.message)
  }
}

// Marcar chat como prioritario (esperando humano)
async function markAsPriorityChat(sock, from) {
  try {
    // Marcar como NO leído (punto azul)
    await sock.chatModify({
      markRead: false
    }, from)
    
    console.log(`🔵 Chat marcado como NO LEÍDO (prioridad): ${from}`)
  } catch (err) {
    console.log("⚠️ Error marcando como no leído:", err.message)
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