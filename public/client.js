(() => {
  console.log('Voicebed client build 2025-10-17T15:30Z');

  const sessionCodeEl = document.getElementById('session-code');
  const linkStatusEl = document.getElementById('link-status');
  const playerLabelEl = document.getElementById('player-label');
  const rerollButtonEl = document.getElementById('reroll-button');
  const microphoneStatusEl = document.getElementById('microphone-status');
  const debugLogEl = document.getElementById('debug-log');

  let socket;
  let mediaStream;
  let currentSecret;
  let currentVoiceConfig;
  let currentSessionCode;
  let micPermissionGranted = false;
  let audioContext;
  let voicePlaybackCursor = 0;
  let voiceMasterGain;
  let activeSpeakers = new Map(); // Track active speakers for audio playback
  let reconnectAttempts = 0;
  let maxReconnectAttempts = 10;
  let heartbeatInterval = null;
  let micSource;
  let micProcessor;
  let captureSilenceGain;
  let pcmAccumulator = [];

  const COOKIE_NAME = 'voicebed_code';
  const COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 14; // 14 hari
  const VOICE_MIN_QUEUE_AHEAD = 0.06; // seconds
  const VOICE_VOLUME_BOOST = 1.6;
  const VOICE_FADE_TIME = 0.004;
  const PCM_SAMPLE_RATE = 48000;
  const PCM_FRAME_SIZE = 960; // 20ms @ 48kHz

  const formatTime = () => new Date().toLocaleTimeString();

  const log = (message, payload) => {
    const lines = [`[${formatTime()}] ${message}`];
    if (payload) {
      lines.push(JSON.stringify(payload, null, 2));
    }
    debugLogEl.textContent = `${lines.join('\n')}\n${debugLogEl.textContent}`;
  };

  const persistSessionCookie = (code) => {
    if (!code) {
      return;
    }
    document.cookie = `${COOKIE_NAME}=${encodeURIComponent(code)}; Max-Age=${COOKIE_MAX_AGE_SECONDS}; Path=/; SameSite=Lax`;
  };

  const clearSessionCookie = () => {
    document.cookie = `${COOKIE_NAME}=; Max-Age=0; Path=/; SameSite=Lax`;
  };

  const readSessionCookie = () => {
    const cookies = document.cookie.split(';').map((entry) => entry.trim());
    for (const cookie of cookies) {
      if (!cookie) {
        continue;
      }
      const [name, ...rest] = cookie.split('=');
      if (name === COOKIE_NAME) {
        return decodeURIComponent(rest.join('='));
      }
    }
    return undefined;
  };

  const resetSessionState = () => {
    // Stop and cleanup any active microphone stream
    stopStreamingAudio();
    if (mediaStream) {
      mediaStream.getTracks().forEach(track => track.stop());
      mediaStream = null;
    }
    
    microphoneStatusEl.textContent = '';
    playerLabelEl.textContent = 'Belum tersambung ke pemain.';
    currentSecret = undefined;
    currentVoiceConfig = undefined;
  micSource = null;
  micProcessor = null;
  };

  const updateSessionCode = ({ code, reason, previousCode }) => {
    if (!code) {
      return;
    }
    currentSessionCode = code;
    sessionCodeEl.textContent = code.match(/.{1,2}/g)?.join(' ') ?? code;
    persistSessionCookie(code);
    resetSessionState();
    rerollButtonEl.disabled = false;

    const statusByReason = {
      initial: 'Masukkan kode ini dari dalam gim untuk melanjutkan.',
      reroll: 'Kode diperbarui. Masukkan kode baru ini dari dalam gim.',
      resume: 'Menggunakan kode sesi tersimpan. Jalankan /voicebed jika diperlukan.',
      resume_conflict: 'Kode tersimpan sudah dipakai. Menggunakan kode baru.',
    };

    linkStatusEl.textContent = statusByReason[reason] ?? statusByReason.initial;

    const logPayload = { code };
    if (previousCode && previousCode !== code) {
      logPayload.previousCode = previousCode;
    }
    if (reason) {
      logPayload.reason = reason;
    }
    log('Kode sesi diperbarui', logPayload);
  };

  const handleSessionLinked = async ({ player }) => {
    linkStatusEl.textContent = `Terhubung dengan ${player?.name ?? 'pemain tidak dikenal'}.`;
    playerLabelEl.textContent = `Pemain: ${player?.name ?? 'Tidak diketahui'} (${player?.uuid ?? '-'})`;
  };

  const handlePluginDisconnected = () => {
    linkStatusEl.textContent = 'Koneksi plugin terputus. Menunggu sambungan ulang…';
    currentSecret = undefined;
    resetSessionState();
  };

  const handleVoiceCredentials = async (payload) => {
    currentSecret = payload.secret;
    currentVoiceConfig = payload;
    if (payload.status === 'ok') {
      linkStatusEl.textContent = 'Kredensial suara diterima. Memulai mikrofon otomatis…';
      log('Voice credentials delivered', payload);
      
      // Auto-start microphone when credentials received
      if (micPermissionGranted) {
        await startStreamingAudio();
      } else {
        linkStatusEl.textContent = 'Izin mikrofon diperlukan. Mohon izinkan akses mikrofon.';
      }
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
    rerollButtonEl.disabled = true;

    socket.addEventListener('open', () => {
      log('Browser socket connected');
      reconnectAttempts = 0; // Reset counter on successful connection
      
      // Start heartbeat to keep connection alive
      if (heartbeatInterval) {
        clearInterval(heartbeatInterval);
      }
      heartbeatInterval = setInterval(() => {
        if (socket?.readyState === WebSocket.OPEN) {
          sendMessage({ type: 'ping' });
        }
      }, 30000); // Ping every 30 seconds
      
      // Check if we have a previous session to restore
      const savedCode = readSessionCookie();
      if (savedCode && savedCode === currentSessionCode) {
        // We were already in a session before disconnect
        linkStatusEl.textContent = 'Koneksi dipulihkan. Menunggu sinkronisasi...';
        log('Reconnected with existing session', { code: savedCode });
        
        // Restart audio streaming if we had voice config
        if (currentVoiceConfig && micPermissionGranted && !micProcessor) {
          startStreamingAudio().catch(err => {
            log('Failed to restart audio after reconnect', { error: err.message });
          });
        }
      } else {
        linkStatusEl.textContent = 'Menunggu perintah /voicebed dari dalam gim…';
      }
    });

    socket.addEventListener('message', (event) => {
      try {
        const message = JSON.parse(event.data);
        log('Incoming message', message);
        switch (message.type) {
          case 'session_code':
            updateSessionCode(message);
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
            rerollButtonEl.disabled = true;
            clearSessionCookie();
            currentSessionCode = undefined;
            resetSessionState();
            break;
          case 'voice_audio':
            handleVoiceAudio(message);
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

    socket.addEventListener('close', (event) => {
      log('Browser socket closed', { code: event.code, reason: event.reason });
      rerollButtonEl.disabled = true;
      
      // Clear heartbeat
      if (heartbeatInterval) {
        clearInterval(heartbeatInterval);
        heartbeatInterval = null;
      }
      
      // Stop media recorder but keep stream alive for reconnection
      stopStreamingAudio();
      
      // Check if we should attempt reconnection
      if (reconnectAttempts < maxReconnectAttempts) {
        reconnectAttempts++;
        const delay = Math.min(2000 * reconnectAttempts, 10000); // Max 10s delay
        
        setTimeout(() => {
          log('Attempting to reconnect...', { attempt: reconnectAttempts });
          linkStatusEl.textContent = `Koneksi terputus. Mencoba menyambung kembali (${reconnectAttempts}/${maxReconnectAttempts})...`;
          connect();
        }, delay);
      } else {
        linkStatusEl.textContent = 'Koneksi gagal. Silakan refresh halaman.';
        log('Max reconnection attempts reached');
        resetSessionState();
      }
    });

    socket.addEventListener('error', (error) => {
      console.error('WebSocket error', error);
      log('WebSocket error occurred');
    });
  };

  const uint8ToBase64 = (bytes) => {
    let binary = '';
    const chunkSize = 0x8000;
    for (let i = 0; i < bytes.length; i += chunkSize) {
      const chunk = bytes.subarray(i, i + chunkSize);
      binary += String.fromCharCode(...chunk);
    }
    return btoa(binary);
  };

  const resampleBuffer = (buffer, inputRate, outputRate) => {
    if (inputRate === outputRate) {
      return buffer;
    }
    const sampleRatio = inputRate / outputRate;
    const newLength = Math.max(1, Math.round(buffer.length / sampleRatio));
    const output = new Float32Array(newLength);
    for (let i = 0; i < newLength; i++) {
      const position = i * sampleRatio;
      const index = Math.floor(position);
      const fraction = position - index;
      const sample1 = buffer[index] || 0;
      const sample2 = buffer[Math.min(index + 1, buffer.length - 1)] || 0;
      output[i] = sample1 + (sample2 - sample1) * fraction;
    }
    return output;
  };

  const floatToInt16 = (floatBuffer) => {
    const int16 = new Int16Array(floatBuffer.length);
    for (let i = 0; i < floatBuffer.length; i++) {
      const s = Math.max(-1, Math.min(1, floatBuffer[i]));
      int16[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
    }
    return int16;
  };

  const sendPcmFrame = (buffer) => {
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      return;
    }
    const frameBuffer = new ArrayBuffer(buffer.length * 2);
    const view = new DataView(frameBuffer);
    for (let i = 0; i < buffer.length; i++) {
      view.setInt16(i * 2, buffer[i], true);
    }
    const base64 = uint8ToBase64(new Uint8Array(frameBuffer));
    sendMessage({
      type: 'pcm_chunk',
      data: base64,
      samples: buffer.length,
      sampleRate: PCM_SAMPLE_RATE,
      timestamp: Date.now(),
    });
  };

  const ensureAudioContext = async () => {
    if (!audioContext) {
      audioContext = new (window.AudioContext || window.webkitAudioContext)({
        sampleRate: PCM_SAMPLE_RATE,
      });
      voiceMasterGain = audioContext.createGain();
      voiceMasterGain.gain.value = 1.0;
      voiceMasterGain.connect(audioContext.destination);
      voicePlaybackCursor = audioContext.currentTime;
      log('AudioContext initialized', { sampleRate: audioContext.sampleRate });
    }
    if (!captureSilenceGain) {
      captureSilenceGain = audioContext.createGain();
      captureSilenceGain.gain.value = 0;
      captureSilenceGain.connect(audioContext.destination);
    }
    if (audioContext.state === 'suspended') {
      await audioContext.resume();
    }
    return audioContext;
  };

  const startStreamingAudio = async () => {
    if (micProcessor) {
      log('Audio already streaming, skipping start');
      return;
    }

    try {
      const ctx = await ensureAudioContext();

      if (!mediaStream) {
        mediaStream = await navigator.mediaDevices.getUserMedia({
          audio: {
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
            sampleRate: PCM_SAMPLE_RATE,
            channelCount: 1,
          },
        });
        micPermissionGranted = true;
        log('Microphone started');
      }

      microphoneStatusEl.textContent = 'Mikrofon aktif. Mengirim audio ke gateway…';

      pcmAccumulator = [];

      micSource = ctx.createMediaStreamSource(mediaStream);
      const bufferSize = 2048;
      micProcessor = ctx.createScriptProcessor(bufferSize, 1, 1);
      micProcessor.onaudioprocess = (event) => {
        const inputBuffer = event.inputBuffer.getChannelData(0);
        const normalized = resampleBuffer(inputBuffer, ctx.sampleRate, PCM_SAMPLE_RATE);
        const int16Chunk = floatToInt16(normalized);
        for (let i = 0; i < int16Chunk.length; i++) {
          pcmAccumulator.push(int16Chunk[i]);
        }
        while (pcmAccumulator.length >= PCM_FRAME_SIZE) {
          const frame = pcmAccumulator.splice(0, PCM_FRAME_SIZE);
          sendPcmFrame(Int16Array.from(frame));
        }
        // Prevent unbounded growth
        if (pcmAccumulator.length > PCM_FRAME_SIZE * 10) {
          pcmAccumulator.splice(0, pcmAccumulator.length - PCM_FRAME_SIZE * 5);
        }
      };

      micSource.connect(micProcessor);
      micProcessor.connect(captureSilenceGain ?? ctx.destination);
    } catch (error) {
      micPermissionGranted = false;
      microphoneStatusEl.textContent = 'Izin mikrofon ditolak atau tidak tersedia.';
      log('Microphone error', { message: error.message });
      stopStreamingAudio();
      if (mediaStream) {
        mediaStream.getTracks().forEach(track => track.stop());
        mediaStream = null;
      }
    }
  };

  const stopStreamingAudio = () => {
    pcmAccumulator = [];
    if (micProcessor) {
      try {
        micProcessor.disconnect();
      } catch (err) {
        /* noop */
      }
      micProcessor.onaudioprocess = null;
      micProcessor = null;
    }
    if (micSource) {
      try {
        micSource.disconnect();
      } catch (err) {
        /* noop */
      }
      micSource = null;
    }
  };

  const handleVoiceAudio = async (message) => {
    if (!message.data || !message.speaker) {
      console.warn('Invalid voice_audio message', { hasData: !!message.data, hasSpeaker: !!message.speaker });
      return;
    }

    try {
      // Decode base64 audio data
      const binaryString = atob(message.data);
      const bytes = new Uint8Array(binaryString.length);
      for (let i = 0; i < binaryString.length; i++) {
        bytes[i] = binaryString.charCodeAt(i);
      }

      console.log('Received voice audio', { 
        speaker: message.speaker.name, 
        dataSize: bytes.length,
        format: message.format 
      });

      // Check format
      if (message.format === 'ogg_opus') {
        // Use Web Audio API to decode and play Opus audio; fall back to <audio> element if decoding fails
        const ctx = await ensureAudioContext();
        const arrayBuffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);

        const playFallbackElement = async () => {
          try {
            const blob = new Blob([arrayBuffer.slice(0)], { type: 'audio/ogg; codecs=opus' });
            const url = URL.createObjectURL(blob);
            const el = new Audio(url);
            const baseVolume = Math.min(1.0, message.speaker.volume || 1.0);
            el.volume = Math.min(1.0, baseVolume * VOICE_VOLUME_BOOST);
            await el.play();
            console.warn('🔁 Playing audio via fallback <audio> element', {
              speaker: message.speaker.name,
              volume: el.volume
            });
            el.onended = () => {
              URL.revokeObjectURL(url);
            };
          } catch (fallbackError) {
            console.error('Fallback audio playback failed', fallbackError);
          }
        };

        try {
          if (ctx.state === 'suspended') {
            await ctx.resume();
          }

          const audioBuffer = await ctx.decodeAudioData(arrayBuffer.slice(0));

          console.log('✅ Audio decoded successfully', {
            speaker: message.speaker.name,
            duration: audioBuffer.duration,
            channels: audioBuffer.numberOfChannels,
            sampleRate: audioBuffer.sampleRate
          });

          const source = ctx.createBufferSource();
          source.buffer = audioBuffer;

          const gainNode = ctx.createGain();
          const baseVolume = Math.min(1.0, message.speaker.volume || 1.0);
          const effectiveGain = Math.min(2.0, baseVolume * VOICE_VOLUME_BOOST);

          voicePlaybackCursor = Math.max(
            voicePlaybackCursor,
            ctx.currentTime + VOICE_MIN_QUEUE_AHEAD
          );

          source.connect(gainNode);
          gainNode.connect(voiceMasterGain ?? ctx.destination);

          const startTime = voicePlaybackCursor;
          const fadeInEnd = startTime + Math.min(VOICE_FADE_TIME, audioBuffer.duration / 2);
          const fadeOutStart = Math.max(startTime, startTime + audioBuffer.duration - VOICE_FADE_TIME);
          gainNode.gain.setValueAtTime(0, startTime);
          gainNode.gain.linearRampToValueAtTime(effectiveGain, fadeInEnd);
          gainNode.gain.setValueAtTime(effectiveGain, fadeOutStart);
          gainNode.gain.linearRampToValueAtTime(0, startTime + audioBuffer.duration);

          source.start(startTime);
          voicePlaybackCursor += audioBuffer.duration;

          source.onended = () => {
            try {
              source.disconnect();
            } catch (err) {
              /* noop */
            }
            try {
              gainNode.disconnect();
            } catch (err) {
              /* noop */
            }
          };

          console.log('🔊 Scheduled playback via Web Audio API', {
            speaker: message.speaker.name,
            baseVolume,
            effectiveGain,
            startTime,
            queueAhead: (startTime - ctx.currentTime).toFixed(3),
            duration: audioBuffer.duration
          });

          if (!window._voiceAudioPlayed) {
            window._voiceAudioPlayed = true;
            log('✅ Menerima dan memutar audio dari Java players', {
              speaker: message.speaker.name,
              distance: message.speaker.distance.toFixed(2),
              volume: message.speaker.volume.toFixed(2),
              format: 'Ogg Opus (Web Audio API)'
            });
          }
        } catch (decodeError) {
          console.error('Audio decode error:', {
            speaker: message.speaker.name,
            error: decodeError.message,
            dataSize: bytes.length,
            firstBytes: Array.from(bytes.slice(0, 16)).map(b => b.toString(16).padStart(2, '0')).join(' ')
          });
          await playFallbackElement();
        }
      } else {
        // Log unsupported format once
        if (!window._voiceAudioLogged) {
          window._voiceAudioLogged = true;
          log('⚠️ Menerima audio dengan format tidak didukung', {
            format: message.format || 'unknown',
            info: 'Audio harus dalam format Ogg Opus untuk browser'
          });
        }
      }
      
    } catch (error) {
      console.error('Error handling voice audio', error);
    }
  };

  rerollButtonEl.addEventListener('click', () => {
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      return;
    }
    rerollButtonEl.disabled = true;
    
    // Reset everything before requesting new code
    resetSessionState();
    clearSessionCookie();
    
    log('Meminta kode sesi baru dari gateway…', { previousCode: currentSessionCode });
    sendMessage({ type: 'reroll_request', previousCode: currentSessionCode ?? null });
    
    currentSessionCode = null;
  });

  const storedCode = readSessionCookie();
  if (storedCode) {
    log('Memuat kode sesi tersimpan', { code: storedCode });
  }

  // Request microphone permission on page load
  (async () => {
    try {
      linkStatusEl.textContent = 'Meminta izin akses mikrofon…';
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      micPermissionGranted = true;
      stream.getTracks().forEach(track => track.stop()); // Stop immediately, we'll start when credentials arrive
      linkStatusEl.textContent = 'Izin mikrofon diberikan. Menunggu koneksi…';
      log('Microphone permission granted');
    } catch (error) {
      micPermissionGranted = false;
      linkStatusEl.textContent = 'Izin mikrofon diperlukan untuk melanjutkan.';
      log('Microphone permission denied', { error: error.message });
    }
  })();

  rerollButtonEl.disabled = true;
  connect();
  
  // Cleanup on page unload
  window.addEventListener('beforeunload', () => {
    if (heartbeatInterval) {
      clearInterval(heartbeatInterval);
    }
    stopStreamingAudio();
    if (mediaStream) {
      mediaStream.getTracks().forEach(track => track.stop());
    }
    if (socket && socket.readyState === WebSocket.OPEN) {
      socket.close();
    }
    // Cleanup all active audio
    activeSpeakers.forEach(audio => {
      audio.pause();
      audio.src = '';
    });
    activeSpeakers.clear();
  });
})();
