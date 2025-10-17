import path from 'path';
import express from 'express';
import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import { customAlphabet } from 'nanoid';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const port = Number(process.env.PORT || 3000);
const browserPath = '/browser';
const pluginPath = '/plugin';

const app = express();
const server = createServer(app);
const generateCode = customAlphabet('0123456789', 6);

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

app.use(express.static(path.join(__dirname, 'public')));

const browserSessions = new Map();
const pluginClients = new Set();

function createBrowserSession(ws) {
  let code = generateCode();
  while (browserSessions.has(code)) {
    code = generateCode();
  }
  const session = {
    code,
    ws,
    createdAt: Date.now(),
    player: null,
    pluginClient: null,
  };
  browserSessions.set(code, session);
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
  sendJson(pluginClient.ws, { type: 'link_ack', code: session.code, status: 'linked' });
  sendJson(session.ws, { type: 'session_linked', player: message.player });
}

function handleBrowserMessage(session, data) {
  if (typeof data === 'string') {
    try {
      const message = JSON.parse(data);
      if (message.type === 'ping') {
        sendJson(session.ws, { type: 'pong' });
      }
      if (message.type === 'audio_chunk' && session.pluginClient) {
        // Forward to plugin for optional processing / debugging.
        sendJson(session.pluginClient.ws, {
          type: 'audio_chunk',
          code: session.code,
          data: message.data,
          timestamp: Date.now(),
        });
      }
    } catch (error) {
      console.warn('Failed to parse browser message', error);
    }
  }
}

function handlePluginMessage(pluginClient, rawData) {
  if (typeof rawData !== 'string') {
    return;
  }
  let message;
  try {
    message = JSON.parse(rawData);
  } catch (error) {
    console.warn('Received invalid JSON from plugin', error);
    return;
  }

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
      if (!code || !browserSessions.has(code)) {
        sendJson(pluginClient.ws, {
          type: 'link_ack',
          status: 'not_found',
          code,
          error: 'Session code not recognised',
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
    default:
      console.warn('Unhandled message from plugin', message);
  }
}

function setupBrowserWss() {
  const wss = new WebSocketServer({ noServer: true });

  wss.on('connection', (ws) => {
    const session = createBrowserSession(ws);
    console.info('[browser] connected with code', session.code);
    sendJson(ws, { type: 'session_code', code: session.code });

    ws.on('message', (data) => handleBrowserMessage(session, data));
    ws.on('close', () => {
      console.info('[browser] disconnected', session.code);
      browserSessions.delete(session.code);
      if (session.pluginClient) {
        sendJson(session.pluginClient.ws, {
          type: 'session_closed',
          code: session.code,
        });
      }
    });
  });

  return wss;
}

function setupPluginWss() {
  const wss = new WebSocketServer({ noServer: true });

  wss.on('connection', (ws) => {
    const pluginClient = { ws, isAlive: true };
    pluginClients.add(pluginClient);
    console.info('[plugin] connected');

    sendJson(ws, {
      type: 'gateway_ready',
      supportedMessages: ['link_request', 'voice_credentials'],
    });

    ws.on('message', (data) => handlePluginMessage(pluginClient, data));
    ws.on('close', () => {
      pluginClients.delete(pluginClient);
      console.info('[plugin] disconnected');
      for (const session of browserSessions.values()) {
        if (session.pluginClient === pluginClient) {
          session.pluginClient = null;
          sendJson(session.ws, { type: 'plugin_disconnected' });
        }
      }
    });
    ws.on('error', (error) => {
      console.error('Plugin socket error', error);
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
