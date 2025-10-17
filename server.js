import path from 'path';
import express from 'express';
import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import { customAlphabet } from 'nanoid';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import { WebMOpusExtractor, OggOpusWrapper } from './audio-processor.js';

const port = Number(process.env.PORT || 3000);
const browserPath = '/browser';
const pluginPath = '/plugin';

const app = express();
const server = createServer(app);
const generateCode = customAlphabet('0123456789', 6);
const SESSION_CODE_PATTERN = /^\d{6}$/;

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

app.use(express.static(path.join(__dirname, 'public')));

const browserSessions = new Map();
const pluginClients = new Set();

// Audio processor instances
const webmExtractor = new WebMOpusExtractor();
const oggWrapper = new OggOpusWrapper();

const MAX_FRAMES_PER_CHUNK = Number(process.env.VOICEBED_FRAMES_PER_CHUNK || 4);
const MAX_CHUNK_DELAY_MS = Number(process.env.VOICEBED_CHUNK_DELAY_MS || 60);
const speakerFrameBuffers = new Map();
const PCM_FRAME_SIZE = 960;

const getSpeakerKey = (sessionCode, speaker = {}) => {
  const identity = speaker.uuid || speaker.name || 'unknown';
  return `${sessionCode}:${identity}`;
};

const clearSpeakerBuffersForSession = (sessionCode) => {
  for (const key of speakerFrameBuffers.keys()) {
    if (key.startsWith(`${sessionCode}:`)) {
      const entry = speakerFrameBuffers.get(key);
      if (entry?.timeout) {
        clearTimeout(entry.timeout);
      }
      speakerFrameBuffers.delete(key);
    }
  }
};

const flushSpeakerBuffer = (key) => {
  const entry = speakerFrameBuffers.get(key);
  if (!entry) {
    return;
  }

  if (entry.timeout) {
    clearTimeout(entry.timeout);
    entry.timeout = null;
  }

  if (!entry.frames.length) {
    return;
  }

  const session = browserSessions.get(entry.sessionCode);
  if (!session || session.ws.readyState !== session.ws.OPEN) {
    speakerFrameBuffers.delete(key);
    return;
  }

  let framesToSend = [];
  try {
    framesToSend = entry.frames.splice(0);

    const oggData = oggWrapper.wrapInOgg(framesToSend, 48000);
    const oggBase64 = oggData.toString('base64');

    sendJson(session.ws, {
      type: 'voice_audio',
      speaker: entry.speaker,
      data: oggBase64,
      timestamp: entry.lastTimestamp,
      format: 'ogg_opus',
    });

    console.info('[plugin] voice_audio flushed to browser', {
      code: entry.sessionCode,
      speaker: entry.speaker?.name,
      frames: framesToSend.length,
      oggLength: oggData.length,
    });
  } catch (error) {
    console.error('[plugin] Error flushing buffered voice audio', error);
    entry.frames.unshift(...framesToSend);
  }
};

const enqueueSpeakerFrame = (session, message, rawOpus) => {
  const key = getSpeakerKey(session.code, message.speaker);
  let entry = speakerFrameBuffers.get(key);
  if (!entry) {
    entry = {
      frames: [],
      speaker: message.speaker,
      lastTimestamp: message.timestamp,
      sessionCode: session.code,
      timeout: null,
    };
    speakerFrameBuffers.set(key, entry);
  }

  entry.frames.push(rawOpus);
  entry.speaker = message.speaker;
  entry.lastTimestamp = message.timestamp;

  if (entry.timeout) {
    clearTimeout(entry.timeout);
  }

  if (entry.frames.length >= MAX_FRAMES_PER_CHUNK) {
    flushSpeakerBuffer(key);
  } else {
    entry.timeout = setTimeout(() => flushSpeakerBuffer(key), MAX_CHUNK_DELAY_MS);
  }
};

function isValidSessionCode(code) {
  return typeof code === 'string' && SESSION_CODE_PATTERN.test(code);
}

function extractCookieSessionCode(cookieHeader) {
  if (!cookieHeader) {
    return null;
  }
  const cookies = cookieHeader.split(';').map((entry) => entry.trim());
  for (const cookie of cookies) {
    const [name, ...rest] = cookie.split('=');
    if (name === 'voicebed_code') {
      return decodeURIComponent(rest.join('='));
    }
  }
  return null;
}

function reserveFreshCode() {
  let code = generateCode();
  while (browserSessions.has(code)) {
    code = generateCode();
  }
  return code;
}

function updateSessionCode(session, newCode, { resetLink } = { resetLink: true }) {
  if (!isValidSessionCode(newCode)) {
    return false;
  }
  const currentCode = session.code;
  if (currentCode === newCode) {
    if (resetLink) {
      session.player = null;
      session.pluginClient = null;
    }
    return true;
  }
  const conflict = browserSessions.get(newCode);
  if (conflict && conflict !== session) {
    return false;
  }
  browserSessions.delete(currentCode);
  session.code = newCode;
  session.createdAt = Date.now();
  if (resetLink) {
    session.player = null;
    session.pluginClient = null;
  }
  browserSessions.set(newCode, session);
  return true;
}

function createBrowserSession(ws, requestedCode) {
  const session = {
    code: reserveFreshCode(),
    ws,
    createdAt: Date.now(),
    player: null,
    pluginClient: null,
  };
  browserSessions.set(session.code, session);
  if (isValidSessionCode(requestedCode)) {
    updateSessionCode(session, requestedCode, { resetLink: true });
  }
  return session;
}

function sendJson(ws, payload) {
  if (ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify(payload));
  }
}

function linkSessionWithPlayer(session, message, pluginClient) {
  session.player = message.player;
  session.pluginClient = pluginClient;
  console.info('[plugin] session linked', {
    code: session.code,
    clientId: pluginClient.id,
    player: message.player,
  });
  sendJson(pluginClient.ws, { type: 'link_ack', code: session.code, status: 'linked' });
  sendJson(session.ws, { type: 'session_linked', player: message.player });
}

function handleRerollRequest(session) {
  const oldCode = session.code;
  const pluginClient = session.pluginClient;
  const newCode = reserveFreshCode();
  updateSessionCode(session, newCode, { resetLink: true });

  if (pluginClient) {
    sendJson(pluginClient.ws, {
      type: 'session_reset',
      code: oldCode,
      newCode,
      reason: 'reroll',
    });
  }

  sendJson(session.ws, {
    type: 'session_code',
    code: session.code,
    previousCode: oldCode,
    reason: 'reroll',
  });
}

async function handleBrowserMessage(session, data) {
  // Convert Buffer to string if needed
  let dataString;
  if (typeof data === 'string') {
    dataString = data;
  } else if (Buffer.isBuffer(data)) {
    dataString = data.toString('utf8');
  } else if (data instanceof ArrayBuffer) {
    dataString = Buffer.from(data).toString('utf8');
  } else {
    console.warn('[browser] received unsupported data type', { 
      code: session.code,
      type: typeof data 
    });
    return;
  }
  
  let message;
  try {
    message = JSON.parse(dataString);
  } catch (error) {
    console.warn('Failed to parse browser message', { code: session.code, error });
    return;
  }

  switch (message.type) {
    case 'ping':
      sendJson(session.ws, { type: 'pong' });
      break;
    case 'audio_chunk':
      console.info('[browser] audio_chunk received', { 
        code: session.code, 
        hasData: !!message.data,
        dataLength: message.data?.length || 0,
        hasPlugin: !!session.pluginClient 
      });
      if (session.pluginClient) {
        try {
          // Decode base64 WebM data
          const webmData = Buffer.from(message.data, 'base64');
          console.info('[browser] WebM data decoded', { size: webmData.length });
          
          // Extract raw Opus frames from WebM container
          const opusFrames = await webmExtractor.extractOpusFrames(webmData);
          console.info('[browser] Extracted Opus frames', { count: opusFrames.length });
          
          // Send each Opus frame to plugin
          // Filter out invalid frames (valid Opus voice frames are 60-960 bytes)
          const validFrames = opusFrames.filter(frame => frame.length > 0 && frame.length <= 1500);

          if (validFrames.length !== opusFrames.length) {
            console.warn('[browser] Filtered out Opus frames that looked suspicious', {
              removed: opusFrames.length - validFrames.length,
              smallest: Math.min(...opusFrames.map(f => f.length)),
              largest: Math.max(...opusFrames.map(f => f.length))
            });
          }

          if (validFrames.length > 0) {
            console.info('[browser] Opus frames ready for plugin', {
              code: session.code,
              lengths: validFrames.map(frame => frame.length)
            });
          }
          
          for (const opusFrame of validFrames) {
            const payload = {
              type: 'audio_chunk',
              code: session.code,
              data: opusFrame.toString('base64'),
              timestamp: Date.now(),
            };
            sendJson(session.pluginClient.ws, payload);
          }
          
          if (validFrames.length > 0) {
            console.info('[browser] audio_chunk forwarded to plugin', { 
              code: session.code,
              pluginId: session.pluginClient.id,
              opusFrames: validFrames.length,
              totalExtracted: opusFrames.length,
              filteredOut: opusFrames.length - validFrames.length
            });
          } else {
            console.warn('[browser] No valid Opus frames (min 20 bytes)', {
              extracted: opusFrames.length
            });
          }
        } catch (error) {
          console.error('[browser] Error processing audio:', error);
        }
      } else {
        console.warn('[browser] audio_chunk dropped: no plugin client', { code: session.code });
      }
      break;
    case 'pcm_chunk':
      if (!message.data) {
        console.warn('[browser] pcm_chunk missing data', { code: session.code });
        return;
      }
      if (!session.pluginClient) {
        console.warn('[browser] pcm_chunk dropped: no plugin client', { code: session.code });
        return;
      }
      console.info('[browser] forwarding pcm_chunk to plugin', {
        code: session.code,
        samples: message.samples,
        sampleRate: message.sampleRate,
        dataLength: message.data?.length
      });
      sendJson(session.pluginClient.ws, {
        type: 'audio_chunk',
        code: session.code,
        data: message.data,
        timestamp: message.timestamp ?? Date.now(),
        format: 'pcm16',
        samples: message.samples ?? PCM_FRAME_SIZE,
        sampleRate: message.sampleRate ?? 48000,
      });
      break;
    case 'reroll_request':
      handleRerollRequest(session);
      break;
    default:
      console.warn('Unhandled message from browser', message);
  }
}

function handlePluginMessage(pluginClient, rawData) {
  // Convert Buffer to string if needed
  let dataString;
  if (typeof rawData === 'string') {
    dataString = rawData;
  } else if (Buffer.isBuffer(rawData)) {
    dataString = rawData.toString('utf8');
  } else if (rawData instanceof ArrayBuffer) {
    dataString = Buffer.from(rawData).toString('utf8');
  } else {
    console.warn('[plugin] received unsupported data type', { 
      clientId: pluginClient.id, 
      type: typeof rawData,
      constructor: rawData?.constructor?.name 
    });
    return;
  }
  
  console.info('[plugin] raw message received', { clientId: pluginClient.id, length: dataString.length });
  let message;
  try {
    message = JSON.parse(dataString);
  } catch (error) {
    console.warn('Received invalid JSON from plugin', { clientId: pluginClient.id, error, rawData: dataString.substring(0, 200) });
    return;
  }

  console.info('[plugin] parsed message', { clientId: pluginClient.id, type: message.type });

  switch (message.type) {
    case 'plugin_hello':
      sendJson(pluginClient.ws, {
        type: 'plugin_welcome',
        message: 'Voicebed gateway ready',
        activeSessions: browserSessions.size,
      });
      break;
    case 'link_request': {
      const code = message.code;
      console.info('[plugin] link_request received', {
        clientId: pluginClient.id,
        code,
        player: message.player,
      });
      if (!code || !browserSessions.has(code)) {
        sendJson(pluginClient.ws, {
          type: 'link_ack',
          status: 'not_found',
          code,
          error: 'Session code not recognised',
        });
        console.warn('[plugin] link_request rejected: session not found', {
          code,
          clientId: pluginClient.id,
        });
        return;
      }
      const session = browserSessions.get(code);
      if (session.pluginClient && session.pluginClient !== pluginClient) {
        sendJson(pluginClient.ws, {
          type: 'link_ack',
          status: 'conflict',
          code,
          error: 'Session already claimed by another plugin connection',
        });
        console.warn('[plugin] link_request rejected: conflict', {
          code,
          clientId: pluginClient.id,
          currentHolder: session.pluginClient?.id,
        });
        return;
      }
      linkSessionWithPlayer(session, message, pluginClient);
      break;
    }
    case 'voice_credentials': {
      const code = message.code;
      if (!code || !browserSessions.has(code)) {
        sendJson(pluginClient.ws, {
          type: 'voice_credentials_ack',
          status: 'not_found',
          code,
        });
        return;
      }
      const session = browserSessions.get(code);
      const { ws } = session;
      if (ws.readyState !== ws.OPEN) {
        sendJson(pluginClient.ws, {
          type: 'voice_credentials_ack',
          status: 'browser_disconnected',
          code,
        });
        browserSessions.delete(code);
        return;
      }
      sendJson(ws, {
        type: 'voice_credentials',
        payload: {
          status: message.status,
          secret: message.secret,
          voiceHost: message.voiceHost,
          voicePort: message.voicePort,
          secretTtlSeconds: message.secretTtlSeconds,
          player: message.player,
          error: message.error,
        },
      });
      sendJson(pluginClient.ws, {
        type: 'voice_credentials_ack',
        status: 'delivered',
        code,
      });
      if (message.status !== 'ok') {
        browserSessions.delete(code);
      }
      break;
    }
    case 'pong':
      pluginClient.isAlive = true;
      break;
    case 'voice_audio': {
      // Forward audio from Java player to browser
      const code = message.code;
      if (!code || !browserSessions.has(code)) {
        console.warn('[plugin] voice_audio for unknown session', { code });
        return;
      }
      const session = browserSessions.get(code);
      if (session.ws.readyState === session.ws.OPEN) {
        try {
          // Decode raw Opus data from base64
          const rawOpus = Buffer.from(message.data, 'base64');
          
          if (rawOpus.length === 0) {
            console.warn('[plugin] Empty Opus data received');
            return;
          }
          
          // Validate Opus frame size
          if (rawOpus.length < 60 || rawOpus.length > 1500) {
            console.warn('[plugin] Invalid Opus frame size', { 
              size: rawOpus.length,
              speaker: message.speaker?.name 
            });
            return;
          }
          
          enqueueSpeakerFrame(session, message, rawOpus);
          
          const bufferEntry = speakerFrameBuffers.get(getSpeakerKey(code, message.speaker));
          console.info('[plugin] voice_audio buffered', {
            code,
            speaker: message.speaker?.name,
            rawOpusLength: rawOpus.length,
            bufferedFrames: bufferEntry?.frames?.length || 0,
          });
        } catch (error) {
          console.error('[plugin] Error processing voice audio:', error);
        }
      }
      break;
    }
    default:
      console.warn('Unhandled message from plugin', message);
  }
}

function setupBrowserWss() {
  const wss = new WebSocketServer({ noServer: true });

  wss.on('connection', (ws, request) => {
    const requestedCode = extractCookieSessionCode(request?.headers?.cookie);
    const session = createBrowserSession(ws, requestedCode);
    console.info('[browser] connected with code', session.code);

    let reason = 'initial';
    let previousCode;
    if (isValidSessionCode(requestedCode)) {
      if (session.code === requestedCode) {
        reason = 'resume';
      } else {
        reason = 'resume_conflict';
        previousCode = requestedCode;
      }
    }

    const payload = { type: 'session_code', code: session.code, reason };
    if (previousCode) {
      payload.previousCode = previousCode;
    }
    sendJson(ws, payload);

    ws.on('message', (data) => {
      handleBrowserMessage(session, data).catch((error) => {
        console.error('[browser] message handler error', error);
      });
    });
    ws.on('close', () => {
      const code = session.code;
      console.info('[browser] disconnected', code);
      browserSessions.delete(code);
      clearSpeakerBuffersForSession(code);
      if (session.pluginClient) {
        sendJson(session.pluginClient.ws, {
          type: 'session_closed',
          code,
        });
      }
    });
  });

  return wss;
}

function setupPluginWss() {
  const wss = new WebSocketServer({ noServer: true });

  wss.on('connection', (ws) => {
    const pluginClient = {
      ws,
      isAlive: true,
      id: `${Date.now().toString(36)}-${Math.random().toString(16).slice(2, 8)}`,
    };
    pluginClients.add(pluginClient);
    console.info('[plugin] connected', { clientId: pluginClient.id });

    sendJson(ws, {
      type: 'gateway_ready',
      supportedMessages: ['link_request', 'voice_credentials', 'session_reset'],
    });

    ws.on('message', (data) => handlePluginMessage(pluginClient, data));
    ws.on('close', () => {
  pluginClients.delete(pluginClient);
  console.info('[plugin] disconnected', { clientId: pluginClient.id });
      for (const session of browserSessions.values()) {
        if (session.pluginClient === pluginClient) {
          session.pluginClient = null;
          sendJson(session.ws, { type: 'plugin_disconnected' });
        }
      }
    });
    ws.on('error', (error) => {
      console.error('Plugin socket error', { clientId: pluginClient.id, error });
    });
  });

  return wss;
}

const browserWss = setupBrowserWss();
const pluginWss = setupPluginWss();

server.on('upgrade', (request, socket, head) => {
  if (request.url === browserPath) {
    browserWss.handleUpgrade(request, socket, head, (ws) => {
      browserWss.emit('connection', ws, request);
    });
  } else if (request.url === pluginPath) {
    pluginWss.handleUpgrade(request, socket, head, (ws) => {
      pluginWss.emit('connection', ws, request);
    });
  } else {
    socket.destroy();
  }
});

const heartbeatInterval = Number(process.env.GATEWAY_HEARTBEAT_SECONDS || 30) * 1000;

setInterval(() => {
  for (const client of pluginClients) {
    if (!client.isAlive) {
      client.ws.terminate();
      pluginClients.delete(client);
      continue;
    }
    client.isAlive = false;
    sendJson(client.ws, { type: 'ping' });
  }
}, heartbeatInterval);

server.listen(port, () => {
  console.log(`Voicebed gateway listening on http://localhost:${port}`);
});
