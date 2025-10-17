(() => {
  const sessionCodeEl = document.getElementById('session-code');
  const linkStatusEl = document.getElementById('link-status');
  const playerLabelEl = document.getElementById('player-label');
  const startButtonEl = document.getElementById('start-button');
  const microphoneStatusEl = document.getElementById('microphone-status');
  const debugLogEl = document.getElementById('debug-log');

  let socket;
  let mediaRecorder;
  let currentSecret;
  let currentVoiceConfig;

  const formatTime = () => new Date().toLocaleTimeString();

  const log = (message, payload) => {
    const lines = [
      `[${formatTime()}] ${message}`,
    ];
    if (payload) {
      lines.push(JSON.stringify(payload, null, 2));
    }
    debugLogEl.textContent = `${lines.join('\n')}\n${debugLogEl.textContent}`;
  };

  const updateSessionCode = (code) => {
    sessionCodeEl.textContent = code.match(/.{1,2}/g)?.join(' ') ?? code;
    linkStatusEl.textContent = 'Masukkan kode ini dari dalam gim untuk melanjutkan.';
    startButtonEl.disabled = true;
  };

  const handleSessionLinked = ({ player }) => {
    linkStatusEl.textContent = `Terhubung dengan ${player?.name ?? 'pemain tidak dikenal'}.`;
    playerLabelEl.textContent = `Pemain: ${player?.name ?? 'Tidak diketahui'} (${player?.uuid ?? '-'})`;
    startButtonEl.disabled = false;
  };

  const handlePluginDisconnected = () => {
    linkStatusEl.textContent = 'Koneksi plugin terputus. Menunggu sambungan ulang…';
    startButtonEl.disabled = true;
  };

  const handleVoiceCredentials = (payload) => {
    currentSecret = payload.secret;
    currentVoiceConfig = payload;
    if (payload.status === 'ok') {
      linkStatusEl.textContent = 'Kredensial suara diterima. Siap mengirim audio.';
      log('Voice credentials delivered', payload);
    } else {
      linkStatusEl.textContent = `Gagal mendapatkan kredensial suara: ${payload.error ?? 'Unknown error'}`;
      log('Voice credential delivery failed', payload);
    }
  };

  const sendMessage = (message) => {
    if (socket?.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify(message));
    }
  };

  const connect = () => {
    const protocol = location.protocol === 'https:' ? 'wss' : 'ws';
    socket = new WebSocket(`${protocol}://${location.host}/browser`);

    socket.addEventListener('open', () => {
      log('Browser socket connected');
      linkStatusEl.textContent = 'Menunggu perintah /voicebed dari dalam gim…';
    });

    socket.addEventListener('message', (event) => {
      try {
        const message = JSON.parse(event.data);
        log('Incoming message', message);
        switch (message.type) {
          case 'session_code':
            updateSessionCode(message.code);
            break;
          case 'session_linked':
            handleSessionLinked(message);
            break;
          case 'voice_credentials':
            handleVoiceCredentials(message.payload ?? {});
            break;
          case 'plugin_disconnected':
            handlePluginDisconnected();
            break;
          case 'session_closed':
            linkStatusEl.textContent = 'Sesi berakhir.';
            startButtonEl.disabled = true;
            break;
          case 'pong':
            break;
          default:
            log(`Unhandled message type ${message.type}`);
        }
      } catch (error) {
        console.error('Failed to parse message', error);
      }
    });

    socket.addEventListener('close', () => {
      log('Browser socket closed, retrying in 3s');
      startButtonEl.disabled = true;
      setTimeout(connect, 3000);
    });

    socket.addEventListener('error', (error) => {
      console.error('WebSocket error', error);
    });
  };

  const blobToBase64 = (blob) => new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result.split(',')[1]);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });

  const startStreamingAudio = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      microphoneStatusEl.textContent = 'Mikrofon aktif. Mengirim audio ke gateway…';
      mediaRecorder = new MediaRecorder(stream, { mimeType: 'audio/webm' });
      mediaRecorder.ondataavailable = async (event) => {
        if (event.data.size === 0) {
          return;
        }
        const payload = await blobToBase64(event.data);
        sendMessage({
          type: 'audio_chunk',
          data: payload,
        });
      };
      mediaRecorder.start(500);
    } catch (error) {
      microphoneStatusEl.textContent = 'Izin mikrofon ditolak atau tidak tersedia.';
      log('Microphone error', { message: error.message });
    }
  };

  startButtonEl.addEventListener('click', async () => {
    if (!currentSecret) {
      log('Voice credentials belum diterima. Tidak dapat memulai.');
      return;
    }
    startButtonEl.disabled = true;
    await startStreamingAudio();
  });

  connect();
})();
