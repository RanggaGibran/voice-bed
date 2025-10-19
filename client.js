(() => {
  console.log('Voicebed client build 2025-10-17T15:30Z');

  const sessionCodeEl = document.getElementById('session-code');
  const linkStatusEl = document.getElementById('link-status');
  const playerLabelEl = document.getElementById('player-label');
  const rerollButtonEl = document.getElementById('reroll-button');
  const microphoneStatusEl = document.getElementById('microphone-status');
  const audioUnlockButtonEl = document.getElementById('audio-unlock-button');
  const debugLogEl = document.getElementById('debug-log');
  const debugPanelEl = document.getElementById('debug-panel');
  const debugToggleButtonEl = document.getElementById('debug-toggle-button');
  const connectionPillEl = document.getElementById('connection-pill');
  const copyCodeButtonEl = document.getElementById('copy-code-button');
  const installButtonEl = document.getElementById('install-button');
  const installHintEl = document.getElementById('install-hint');
  const installCardEl = document.getElementById('install-card');

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
  let micRecorder;
  let micRecorderActive = false;
  let captureSilenceGain;
  let pcmAccumulator = [];
  let audioUnlocked = false;
  let wakeLock; // Screen Wake Lock sentinel to keep mobile screens awake
  let trackProcessor;
  let trackProcessorReader;
  let trackProcessorActive = false;
  let trackProcessorStatusMessage;
  let pendingMicChunks = [];
  let pendingMicFlushInterval;

  const COOKIE_NAME = 'voicebed_code';
  const COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 14; // 14 hari
  const VOICE_MIN_QUEUE_AHEAD = 0.05; // seconds
  const VOICE_VOLUME_BOOST = 1.6;
  const VOICE_FADE_TIME = 0.004;
  const PCM_SAMPLE_RATE = 48000;
  const PCM_FRAME_SIZE = 960; // 20ms @ 48kHz
  const PENDING_MIC_MAX_BUFFER = PCM_FRAME_SIZE * 12;
  const PENDING_MIC_FLUSH_DELAY_MS = 45;
  const MOBILE_USER_AGENT = /android|iphone|ipad|ipod/i;
  const SESSION_CODE_PLACEHOLDER = '------';
  const MEDIA_RECORDER_TIMESLICE = 240;
  const MEDIA_RECORDER_BITRATE = 64000;
  const MEDIA_RECORDER_MIME_TYPES = [
    'audio/webm;codecs=opus',
    'audio/ogg;codecs=opus',
    'audio/webm'
  ];
  const LOCAL_STORAGE_GATEWAY_KEY = 'voicebed.gatewayOrigin';
  const INSTALL_INSTRUCTIONS_LABEL = 'Lihat cara memasang';
  const MEDIA_RECORDER_MAX_DECODE_FAILURES = 3;

  const defaultCopyButtonLabel = copyCodeButtonEl?.textContent?.trim() || 'Salin';
  const defaultInstallButtonLabel = installButtonEl?.textContent?.trim() || 'Pasang sebagai Aplikasi';

  const formatTime = () => new Date().toLocaleTimeString();
  const raf = window.requestAnimationFrame ? (cb) => window.requestAnimationFrame(cb) : (cb) => setTimeout(cb, 16);
  const DEBUG_HISTORY_LIMIT = 120;
  const debugMessages = [];
  let debugRenderScheduled = false;
  let copyFeedbackTimeout;
  let deferredInstallPrompt = null;
  let installButtonMode = 'hidden';
  let mediaRecorderDecodeFailures = 0;
  let mediaRecorderDisabled = false;

  const updateSessionCodeDisplay = (code) => {
    if (!sessionCodeEl) {
      return;
    }
    resetCopyButtonLabel();
    if (code) {
      sessionCodeEl.textContent = code;
      copyCodeButtonEl?.removeAttribute('disabled');
    } else {
      sessionCodeEl.textContent = SESSION_CODE_PLACEHOLDER;
      copyCodeButtonEl?.setAttribute('disabled', 'true');
    }
  };

  const renderDebugLog = () => {
    if (!debugLogEl) {
      debugRenderScheduled = false;
      return;
    }
    if (debugPanelEl?.classList.contains('collapsed')) {
      debugRenderScheduled = false;
      return;
    }
    debugLogEl.textContent = debugMessages.join('\n\n');
    debugLogEl.scrollTop = 0;
    debugRenderScheduled = false;
  };

  const scheduleDebugRender = () => {
    if (debugRenderScheduled) {
      return;
    }
    debugRenderScheduled = true;
    raf(renderDebugLog);
  };

  const log = (message, payload) => {
    if (!debugLogEl) {
      return;
    }
    const lines = [`[${formatTime()}] ${message}`];
    if (payload) {
      lines.push(JSON.stringify(payload, null, 2));
    }
    debugMessages.unshift(lines.join('\n'));
    if (debugMessages.length > DEBUG_HISTORY_LIMIT) {
      debugMessages.length = DEBUG_HISTORY_LIMIT;
    }
    scheduleDebugRender();
  };

  const isStandaloneDisplay = () => {
    try {
      if (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) {
        return true;
      }
    } catch (error) {
      // ignore
    }
    if (window.navigator?.standalone) {
      return true;
    }
    if (document.referrer?.startsWith('android-app://')) {
      return true;
    }
    return false;
  };

  const highlightInstallCard = () => {
    if (!installCardEl) {
      return;
    }
    installCardEl.classList.add('highlight');
    installCardEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
    window.setTimeout(() => installCardEl.classList.remove('highlight'), 1600);
  };

  const showInstallButton = (label) => {
    if (!installButtonEl) {
      return;
    }
    installButtonEl.textContent = label ?? defaultInstallButtonLabel;
    installButtonEl.classList.remove('hidden');
  };

  const hideInstallButton = () => {
    if (!installButtonEl) {
      return;
    }
    installButtonEl.classList.add('hidden');
  };

  const updateInstallButtonState = () => {
    if (!installButtonEl) {
      return;
    }
    if (isStandaloneDisplay()) {
      hideInstallButton();
      installButtonMode = 'hidden';
      installHintEl?.classList.add('hidden');
      return;
    }
    if (deferredInstallPrompt) {
      showInstallButton(defaultInstallButtonLabel);
      installButtonMode = 'prompt';
      installHintEl?.classList.remove('hidden');
      return;
    }
    installButtonMode = 'instructions';
    showInstallButton(INSTALL_INSTRUCTIONS_LABEL);
    installHintEl?.classList.remove('hidden');
  };

  const reportInstallEvent = (payload) => {
    log('Status pemasangan PWA', payload);
  };

  const safeLocalStorageSet = (key, value) => {
    try {
      if (!window.localStorage) {
        return;
      }
      if (value) {
        window.localStorage.setItem(key, value);
      } else {
        window.localStorage.removeItem(key);
      }
    } catch (error) {
      console.warn('Local storage access failed', { message: error?.message });
    }
  };

  const normalizeGatewayOrigin = (value) => {
    if (!value || typeof value !== 'string') {
      return undefined;
    }
    const trimmed = value.trim();
    if (!trimmed) {
      return undefined;
    }
    try {
      const parsed = new URL(trimmed);
      if (!/^https?:$/i.test(parsed.protocol)) {
        return undefined;
      }
      return parsed.origin;
    } catch (error) {
      return undefined;
    }
  };

  const readGatewayOverrideFromQuery = () => {
    try {
      if (!location.search) {
        return undefined;
      }
      const params = new URLSearchParams(location.search);
      return params.get('gateway');
    } catch (error) {
      return undefined;
    }
  };

  const detectNativeConfig = () => {
    try {
      if (window.voicebedNativeConfig && typeof window.voicebedNativeConfig === 'object') {
        return window.voicebedNativeConfig;
      }
    } catch (error) {
      // ignore
    }
    try {
      if (window.VoicebedNativeBridge?.getConfig) {
        const raw = window.VoicebedNativeBridge.getConfig();
        if (typeof raw === 'string' && raw.length > 0) {
          const parsed = JSON.parse(raw);
          if (parsed && typeof parsed === 'object') {
            return parsed;
          }
        }
      }
    } catch (error) {
      console.warn('Gagal membaca konfigurasi native', error);
    }
    return {};
  };

  const nativeConfig = detectNativeConfig();

  const getConfiguredGatewayOrigin = () => {
    const nativeOrigin = normalizeGatewayOrigin(nativeConfig.gatewayOrigin);
    if (nativeOrigin) {
      return nativeOrigin;
    }

    const queryOverride = normalizeGatewayOrigin(readGatewayOverrideFromQuery());
    if (queryOverride) {
      safeLocalStorageSet(LOCAL_STORAGE_GATEWAY_KEY, queryOverride);
      return queryOverride;
    }

    try {
      const stored = window.localStorage?.getItem(LOCAL_STORAGE_GATEWAY_KEY);
      const normalized = normalizeGatewayOrigin(stored);
      if (normalized) {
        return normalized;
      }
    } catch (error) {
      console.warn('Gagal membaca gateway dari penyimpanan lokal', error);
    }

    if (location.origin && /^https?:$/i.test(location.protocol)) {
      return location.origin;
    }
    return undefined;
  };

  const resolveWebSocketUrl = () => {
    const origin = getConfiguredGatewayOrigin();
    if (!origin) {
      return undefined;
    }
    try {
      const base = new URL(origin);
      const endpoint = new URL('/browser', base);
      endpoint.protocol = base.protocol === 'https:' ? 'wss:' : 'ws:';
      return endpoint.toString();
    } catch (error) {
      log('Gateway origin tidak valid', { origin, error: error.message });
      return undefined;
    }
  };

  const requestNativeGatewaySettings = () => {
    try {
      if (typeof window.VoicebedNativeBridge?.openGatewaySettings === 'function') {
        window.VoicebedNativeBridge.openGatewaySettings();
      }
    } catch (error) {
      console.warn('Gagal membuka pengaturan gateway native', error);
    }
  };

  const serviceWorkerEnabled = nativeConfig.serviceWorkerEnabled !== false;

  const setConnectionState = (state, label) => {
    if (!connectionPillEl) {
      return;
    }
    connectionPillEl.dataset.state = state;
    connectionPillEl.textContent = label;
    connectionPillEl.classList.toggle('live', state === 'connected');
  };

  const updateMediaSessionState = (state) => {
    if (!('mediaSession' in navigator)) {
      return;
    }
    try {
      if ('MediaMetadata' in window) {
        navigator.mediaSession.metadata = new MediaMetadata({
          title: 'Voicebed Bridge',
          artist: 'Voice Chat',
          album: 'Minecraft Server'
        });
      }
    } catch (error) {
      // Ignore metadata errors on unsupported platforms
    }
    try {
      navigator.mediaSession.playbackState = state ? 'playing' : 'none';
    } catch (error) {
      // ignore
    }
  };

  const resetCopyButtonLabel = () => {
    if (!copyCodeButtonEl) {
      return;
    }
    copyCodeButtonEl.textContent = defaultCopyButtonLabel;
    copyCodeButtonEl.classList.remove('copied', 'error');
  };

  const showCopyFeedback = (message, variant) => {
    if (!copyCodeButtonEl) {
      return;
    }
    clearTimeout(copyFeedbackTimeout);
    copyCodeButtonEl.textContent = message;
    copyCodeButtonEl.classList.remove('copied', 'error');
    if (variant === 'copied') {
      copyCodeButtonEl.classList.add('copied');
    } else if (variant === 'error') {
      copyCodeButtonEl.classList.add('error');
    }
    copyFeedbackTimeout = window.setTimeout(() => {
      resetCopyButtonLabel();
    }, 2000);
  };

  const pickRecorderMimeType = () => {
    if (typeof MediaRecorder === 'undefined') {
      return undefined;
    }
    for (const type of MEDIA_RECORDER_MIME_TYPES) {
      try {
        if (MediaRecorder.isTypeSupported(type)) {
          return type;
        }
      } catch (error) {
        // Ignore and continue testing other types
      }
    }
    return undefined;
  };

  const stopMediaRecorder = () => {
    if (!micRecorder) {
      return;
    }
    try {
      if (micRecorder.state !== 'inactive') {
        micRecorder.stop();
      }
    } catch (error) {
      // ignore
    }
    micRecorder = null;
    micRecorderActive = false;
    updateMediaSessionState(false);
  };

  const stopTrackProcessorPipeline = () => {
    trackProcessorActive = false;
    if (trackProcessorReader) {
      try {
        trackProcessorReader.cancel();
      } catch (error) {
        // ignore cancel errors
      }
    }
    trackProcessorReader = null;
    trackProcessor = null;
    trackProcessorStatusMessage = undefined;
  };

  const ensureTrackProcessorPipeline = () => {
    if (!mediaStream) {
      return false;
    }
    if (trackProcessorActive) {
      return true;
    }
    const TrackProcessorCtor = window.MediaStreamTrackProcessor;
    if (typeof TrackProcessorCtor !== 'function' || typeof window.AudioData !== 'function') {
      return false;
    }
    const [track] = mediaStream.getAudioTracks();
    if (!track) {
      return false;
    }

    try {
      trackProcessor = new TrackProcessorCtor({ track });
      trackProcessorReader = trackProcessor.readable.getReader();
    } catch (error) {
      log('Gagal memulai jalur MediaStreamTrackProcessor', { error: error.message });
      stopTrackProcessorPipeline();
      return false;
    }

    trackProcessorActive = true;

    const processFrames = async () => {
      log('MediaStreamTrackProcessor pipeline aktif');
      const silentBatch = new Float32Array(PCM_FRAME_SIZE);
      while (trackProcessorActive) {
        try {
          const { value, done } = await trackProcessorReader.read();
          if (done) {
            break;
          }
          const audioData = value;
          try {
            const frameCount = audioData?.numberOfFrames ?? 0;
            if (frameCount > 0) {
              const sampleRate = audioData.sampleRate || PCM_SAMPLE_RATE;
              const channelData = new Float32Array(frameCount);
              await audioData.copyTo(channelData, { planeIndex: 0, format: 'f32' });
              appendPcmSamples(channelData, sampleRate);
            } else {
              appendPcmSamples(silentBatch, PCM_SAMPLE_RATE);
            }
          } finally {
            try {
              audioData?.close();
            } catch (error) {
              // ignore close errors
            }
          }
        } catch (error) {
          if (error?.name === 'AbortError') {
            break;
          }
          log('Kesalahan membaca frame dari MediaStreamTrackProcessor', { error: error.message });
          try {
            await new Promise((resolve) => setTimeout(resolve, 50));
          } catch (waitError) {
            // ignore sleep errors
          }
        }
      }
      stopTrackProcessorPipeline();
      log('MediaStreamTrackProcessor pipeline berhenti');
    };

    processFrames().catch((error) => {
      log('Loop MediaStreamTrackProcessor gagal', { error: error.message });
      stopTrackProcessorPipeline();
    });

    return true;
  };

  const updateTrackProcessorStatus = (contextRunning) => {
    const message = contextRunning
      ? 'Mikrofon aktif. Mengirim audio ke gateway…'
      : 'Mikrofon aktif di latar belakang. Audio Java akan terdengar setelah Anda mengaktifkan audio.';
    if (trackProcessorStatusMessage !== message) {
      microphoneStatusEl.textContent = message;
      trackProcessorStatusMessage = message;
    }
    if (!contextRunning) {
      showAudioUnlockPrompt('playback_pending_unlock');
    }
    pcmAccumulator = [];
  };

  const processMediaRecorderBlob = async (blob) => {
    if (!blob || blob.size === 0) {
      return;
    }
    try {
      const arrayBuffer = await blob.arrayBuffer();
      const ctx = await ensureAudioContext();
      if (ctx.state === 'suspended') {
        try {
          await ctx.resume();
        } catch (error) {
          log('AudioContext masih tersuspensi sebelum decode blob', { error: error.message });
          throw error;
        }
      }

      let audioBuffer;
      try {
        audioBuffer = await decodeAudioDataCompat(ctx, arrayBuffer);
      } catch (decodeError) {
        mediaRecorderDecodeFailures += 1;
        try {
          decodeError.__voicebedMediaRecorderCounted = true;
        } catch (markError) {
          // ignore write failures on readonly errors
        }
        log('Gagal decode MediaRecorder chunk', {
          error: decodeError?.message ?? String(decodeError),
          size: arrayBuffer?.byteLength ?? 0,
        });
        // Fallback: kirim sebagai chunk Opus langsung ke plugin
        if (arrayBuffer && arrayBuffer.byteLength > 0) {
          const frame = new Uint8Array(arrayBuffer.slice(0));
          if (frame.length >= 20 && frame.length <= 1500) {
            log('Mengirim fallback Opus frame ke gateway', { bytes: frame.length });
            sendMessage({
              type: 'audio_chunk',
              data: uint8ToBase64(frame),
              format: 'ogg_opus_fallback',
              timestamp: Date.now(),
            });
            if (mediaRecorderDecodeFailures >= MEDIA_RECORDER_MAX_DECODE_FAILURES) {
              log('Terlalu banyak kegagalan decode. Beralih ke mode kompatibilitas.', {
                failures: mediaRecorderDecodeFailures,
              });
              stopMediaRecorder();
              mediaRecorderDisabled = true;
              mediaRecorderDecodeFailures = 0;
              if (ensureTrackProcessorPipeline()) {
                microphoneStatusEl.textContent = 'Mode kompatibilitas aktif. Menggunakan jalur PCM langsung.';
                return;
              }
              if (ctx.state !== 'running') {
                microphoneStatusEl.textContent = 'Mode kompatibilitas siap. Sentuh "Aktifkan Audio" agar jalur PCM berjalan.';
                showAudioUnlockPrompt('compatibility_requires_unlock');
                return;
              }
              microphoneStatusEl.textContent = 'Mode kompatibilitas aktif. Menggunakan jalur PCM langsung.';
              ensureScriptProcessorPipeline(ctx);
            }
            return;
          }
        }
        if (mediaRecorderDecodeFailures >= MEDIA_RECORDER_MAX_DECODE_FAILURES) {
          log('Terlalu banyak kegagalan decode. Beralih ke mode kompatibilitas.', {
            failures: mediaRecorderDecodeFailures,
          });
          stopMediaRecorder();
          mediaRecorderDisabled = true;
          mediaRecorderDecodeFailures = 0;
          if (ensureTrackProcessorPipeline()) {
            microphoneStatusEl.textContent = 'Mode kompatibilitas aktif. Menggunakan jalur PCM langsung.';
            return;
          }
          if (ctx.state !== 'running') {
            microphoneStatusEl.textContent = 'Mode kompatibilitas siap. Sentuh "Aktifkan Audio" agar jalur PCM berjalan.';
            showAudioUnlockPrompt('compatibility_requires_unlock');
            return;
          }
          microphoneStatusEl.textContent = 'Mode kompatibilitas aktif. Menggunakan jalur PCM langsung.';
          ensureScriptProcessorPipeline(ctx);
          return;
        }
        throw decodeError;
      }

      if (!audioBuffer || audioBuffer.numberOfChannels === 0) {
        log('Chunk media recorder tidak memiliki data audio');
        return;
      }

      const channelData = audioBuffer.getChannelData(0);
      appendPcmSamples(channelData, audioBuffer.sampleRate);
    } catch (error) {
      log('Gagal memproses chunk MediaRecorder', { error: error.message });
      if (!error?.__voicebedMediaRecorderCounted) {
        mediaRecorderDecodeFailures += 1;
      }
      if (mediaRecorderDecodeFailures >= MEDIA_RECORDER_MAX_DECODE_FAILURES) {
        try {
          const ctx = await ensureAudioContext();
          log('Terlalu banyak kegagalan proses. Mematikan MediaRecorder.', {
            failures: mediaRecorderDecodeFailures,
          });
          stopMediaRecorder();
          mediaRecorderDisabled = true;
          mediaRecorderDecodeFailures = 0;
          if (ensureTrackProcessorPipeline()) {
            microphoneStatusEl.textContent = 'Mode kompatibilitas aktif. Menggunakan jalur PCM langsung.';
            return;
          }
          if (ctx.state !== 'running') {
            microphoneStatusEl.textContent = 'Mode kompatibilitas siap. Sentuh "Aktifkan Audio" agar jalur PCM berjalan.';
            showAudioUnlockPrompt('compatibility_requires_unlock');
            return;
          }
          microphoneStatusEl.textContent = 'Mode kompatibilitas aktif. Menggunakan jalur PCM langsung.';
          ensureScriptProcessorPipeline(ctx);
        } catch (ctxError) {
          log('Gagal mengaktifkan mode kompatibilitas', { error: ctxError.message });
        }
      }
    }
  };

  const startMediaRecorder = () => {
    if (mediaRecorderDisabled) {
      log('MediaRecorder dinonaktifkan; melewati pipeline ini');
      return false;
    }
    const mimeType = pickRecorderMimeType();
    if (!mimeType || !mediaStream) {
      return false;
    }
    try {
      micRecorder = new MediaRecorder(mediaStream, {
        mimeType,
        audioBitsPerSecond: MEDIA_RECORDER_BITRATE,
      });
    } catch (error) {
      log('MediaRecorder gagal dibuat', { error: error.message });
      micRecorder = null;
      return false;
    }

    micRecorderActive = true;

    micRecorder.addEventListener('dataavailable', (event) => {
      processMediaRecorderBlob(event.data);
    });

    micRecorder.addEventListener('stop', () => {
      micRecorderActive = false;
    });

    try {
      micRecorder.start(MEDIA_RECORDER_TIMESLICE);
      log('MediaRecorder dimulai', { mimeType, timeslice: MEDIA_RECORDER_TIMESLICE });
      updateMediaSessionState(true);
      microphoneStatusEl.textContent = 'Mikrofon aktif. Audio tetap berjalan meski aplikasi lain dibuka.';
      mediaRecorderDecodeFailures = 0;
      return true;
    } catch (error) {
      log('MediaRecorder gagal di-start', { error: error.message });
      stopMediaRecorder();
      return false;
    }
  };

  debugToggleButtonEl?.addEventListener('click', () => {
    debugPanelEl?.classList.toggle('collapsed');
    const collapsed = !!debugPanelEl?.classList.contains('collapsed');
    debugToggleButtonEl.textContent = collapsed ? 'Tampilkan debug log' : 'Sembunyikan debug log';
    debugToggleButtonEl.setAttribute('aria-expanded', String(!collapsed));
    if (!collapsed) {
      scheduleDebugRender();
      raf(() => {
        if (debugLogEl) {
          debugLogEl.scrollTop = 0;
        }
      });
    }
  });

  copyCodeButtonEl?.addEventListener('click', async () => {
    if (!currentSessionCode) {
      showCopyFeedback('Tidak ada kode', 'error');
      return;
    }

    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(currentSessionCode);
      } else {
        const fallback = document.createElement('textarea');
        fallback.value = currentSessionCode;
        fallback.setAttribute('readonly', '');
        fallback.style.position = 'absolute';
        fallback.style.left = '-9999px';
        document.body.appendChild(fallback);
        fallback.select();
        document.execCommand('copy');
        document.body.removeChild(fallback);
      }
      showCopyFeedback('Tersalin!', 'copied');
    } catch (error) {
      console.error('Failed to copy session code', error);
      showCopyFeedback('Gagal menyalin', 'error');
      log('Gagal menyalin kode sesi', { error: error.message });
    }
  });

  document.addEventListener('visibilitychange', async () => {
    if (!document.hidden) {
      try {
        if (audioContext?.state === 'suspended') {
          await audioContext.resume();
        }
      } catch (error) {
        // ignore resume errors
      }
      if (micRecorderActive) {
        updateMediaSessionState(true);
      }
    }
  });

  window.addEventListener('beforeinstallprompt', (event) => {
    event.preventDefault();
    deferredInstallPrompt = event;
    reportInstallEvent({ stage: 'prompt_ready' });
    updateInstallButtonState();
  });

  window.addEventListener('appinstalled', () => {
    deferredInstallPrompt = null;
    reportInstallEvent({ stage: 'installed' });
    updateInstallButtonState();
  });

  installButtonEl?.addEventListener('click', async () => {
    if (installButtonMode === 'prompt' && deferredInstallPrompt) {
      try {
        deferredInstallPrompt.prompt();
        const choice = await deferredInstallPrompt.userChoice;
        reportInstallEvent({ stage: 'prompt_choice', outcome: choice?.outcome });
      } catch (error) {
        log('Gagal menampilkan prompt instalasi', { error: error.message });
      } finally {
        deferredInstallPrompt = null;
        updateInstallButtonState();
      }
      return;
    }
    reportInstallEvent({ stage: 'instructions_shown' });
    highlightInstallCard();
  });

  try {
    const standaloneQuery = window.matchMedia?.('(display-mode: standalone)');
    if (standaloneQuery?.addEventListener) {
      standaloneQuery.addEventListener('change', updateInstallButtonState);
    } else if (standaloneQuery?.addListener) {
      standaloneQuery.addListener(updateInstallButtonState);
    }
  } catch (error) {
    // ignore matchMedia listener errors
  }

  updateInstallButtonState();

  setConnectionState('idle', 'Menunggu koneksi…');
  updateSessionCodeDisplay();

  const showAudioUnlockPrompt = (reason) => {
    if (!audioUnlockButtonEl) {
      return;
    }
    if (reason) {
      log('Audio unlock diperlukan', { reason });
    }
    audioUnlockButtonEl.classList.remove('hidden');
  };

  const requestWakeLock = async () => {
    if (!('wakeLock' in navigator)) {
      return;
    }
    try {
      if (!wakeLock) {
        wakeLock = await navigator.wakeLock.request('screen');
        wakeLock.addEventListener('release', () => {
          wakeLock = undefined;
          log('Screen wake lock released');
        });
        log('Screen wake lock acquired');
      }
    } catch (error) {
      log('Failed to acquire wake lock', { error: error.message });
    }
  };

  const releaseWakeLock = async () => {
    try {
      await wakeLock?.release();
    } catch (error) {
      // ignore
    }
    wakeLock = undefined;
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
    audioUnlocked = false;
    audioUnlockButtonEl?.classList.add('hidden');
    releaseWakeLock();
  };

  const updateSessionCode = ({ code, reason, previousCode }) => {
    if (!code) {
      return;
    }
    currentSessionCode = code;
    updateSessionCodeDisplay(code);
    persistSessionCookie(code);
    resetSessionState();
    setConnectionState('idle', 'Menunggu pemain…');
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
    setConnectionState('connected', 'Sesi tertaut');
  };

  const handlePluginDisconnected = () => {
    linkStatusEl.textContent = 'Koneksi plugin terputus. Menunggu sambungan ulang…';
    currentSecret = undefined;
    resetSessionState();
    setConnectionState('warning', 'Plugin terputus');
  };

  const handleVoiceCredentials = async (payload) => {
    currentSecret = payload.secret;
    currentVoiceConfig = payload;
    if (payload.status === 'ok') {
      linkStatusEl.textContent = 'Kredensial suara diterima. Memulai mikrofon otomatis…';
      log('Voice credentials delivered', payload);
      setConnectionState('connected', 'Siap digunakan');
      
      // Auto-start microphone when credentials received
      if (micPermissionGranted) {
        if (MOBILE_USER_AGENT.test(navigator.userAgent)) {
          await requestWakeLock();
        }

        const ctx = await ensureAudioContext();

        if (MOBILE_USER_AGENT.test(navigator.userAgent) && ctx.state !== 'running') {
          microphoneStatusEl.textContent = 'Sentuh layar sekali lalu lanjutkan kembali ke gim agar audio tetap aktif.';
          showAudioUnlockPrompt('mobile_background_policy');
          return;
        }

        await startStreamingAudio();

        if (MOBILE_USER_AGENT.test(navigator.userAgent) && ctx.state === 'running') {
          audioUnlocked = true;
          audioUnlockButtonEl?.classList.add('hidden');
        }
      } else {
        linkStatusEl.textContent = 'Izin mikrofon diperlukan. Mohon izinkan akses mikrofon.';
      }
    } else {
      linkStatusEl.textContent = `Gagal mendapatkan kredensial suara: ${payload.error ?? 'Unknown error'}`;
      log('Voice credential delivery failed', payload);
      setConnectionState('error', 'Kredensial gagal');
    }
  };

  const flushPendingMicChunks = () => {
    if (!pendingMicChunks.length) {
      return;
    }
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      return;
    }
    const chunks = pendingMicChunks.splice(0);
    chunks.forEach((chunk) => {
      try {
        socket.send(JSON.stringify(chunk));
      } catch (error) {
        log('Gagal mengirim chunk mikrofon yang tertahan', { error: error.message });
      }
    });
    if (!pendingMicChunks.length && pendingMicFlushInterval) {
      clearInterval(pendingMicFlushInterval);
      pendingMicFlushInterval = undefined;
    }
  };

  const enqueuePendingMicChunk = (chunk) => {
    pendingMicChunks.push(chunk);
    if (pendingMicChunks.length > PENDING_MIC_MAX_BUFFER) {
      pendingMicChunks.splice(0, pendingMicChunks.length - PENDING_MIC_MAX_BUFFER);
    }
    if (!pendingMicFlushInterval) {
      pendingMicFlushInterval = setInterval(flushPendingMicChunks, PENDING_MIC_FLUSH_DELAY_MS);
    }
  };

  const sendMessage = (message) => {
    if (socket?.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify(message));
      return;
    }
    if (message.type === 'pcm_chunk') {
      enqueuePendingMicChunk(message);
    }
  };

  let activeGatewayOrigin = getConfiguredGatewayOrigin();

  const connect = () => {
    const wsUrl = resolveWebSocketUrl();
    if (!wsUrl) {
      linkStatusEl.textContent = 'Gateway belum dikonfigurasi. Buka pengaturan Voicebed untuk memasukkan URL gateway.';
      setConnectionState('error', 'Gateway belum diatur');
      log('Koneksi dibatalkan karena gateway origin tidak tersedia');
      requestNativeGatewaySettings();
      rerollButtonEl.disabled = true;
      return;
    }

    activeGatewayOrigin = getConfiguredGatewayOrigin();
    setConnectionState('connecting', 'Menghubungkan…');
    rerollButtonEl.disabled = true;
    if (activeGatewayOrigin) {
      try {
        const hostLabel = new URL(activeGatewayOrigin).host;
        linkStatusEl.textContent = `Menghubungkan ke gateway ${hostLabel}…`;
      } catch (error) {
        linkStatusEl.textContent = 'Menghubungkan ke gateway…';
      }
    } else {
      linkStatusEl.textContent = 'Menghubungkan ke gateway…';
    }
    log('Membuka koneksi WebSocket', { url: wsUrl, origin: activeGatewayOrigin });

    socket = new WebSocket(wsUrl);

    socket.addEventListener('open', () => {
      setConnectionState('connected', 'Browser terhubung');
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

      flushPendingMicChunks();
      
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
            updateSessionCodeDisplay();
            setConnectionState('warning', 'Sesi ditutup');
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
      setConnectionState('warning', 'Koneksi terputus');
      
      // Check if we should attempt reconnection
      if (reconnectAttempts < maxReconnectAttempts) {
        reconnectAttempts++;
        const delay = Math.min(2000 * reconnectAttempts, 10000); // Max 10s delay
        
        setTimeout(() => {
          log('Attempting to reconnect...', { attempt: reconnectAttempts });
          linkStatusEl.textContent = `Koneksi terputus. Mencoba menyambung kembali (${reconnectAttempts}/${maxReconnectAttempts})...`;
          setConnectionState('warning', `Menyambungkan ulang (${reconnectAttempts}/${maxReconnectAttempts})`);
          connect();
        }, delay);
      } else {
        linkStatusEl.textContent = 'Koneksi gagal. Silakan refresh halaman.';
        log('Max reconnection attempts reached');
        setConnectionState('error', 'Koneksi gagal');
        resetSessionState();
      }
    });

    socket.addEventListener('error', (error) => {
      console.error('WebSocket error', error);
      log('WebSocket error occurred');
      setConnectionState('error', 'Kesalahan koneksi');
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

  const decodeAudioDataCompat = (ctx, arrayBuffer) => new Promise((resolve, reject) => {
    let settled = false;
    const onSuccess = (buffer) => {
      if (!settled) {
        settled = true;
        resolve(buffer);
      }
    };
    const onError = (error) => {
      if (!settled) {
        settled = true;
        reject(error);
      }
    };

    try {
      const copy = arrayBuffer.slice(0);
      const result = ctx.decodeAudioData(copy, onSuccess, onError);
      if (result && typeof result.then === 'function') {
        result.then(onSuccess).catch(onError);
      }
    } catch (error) {
      try {
        ctx.decodeAudioData(arrayBuffer.slice(0), onSuccess, onError);
      } catch (fallbackError) {
        onError(fallbackError);
      }
    }
  });

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

  const appendPcmSamples = (floatBuffer, sourceSampleRate = PCM_SAMPLE_RATE) => {
    if (!floatBuffer || floatBuffer.length === 0) {
      return;
    }
    const normalized = resampleBuffer(floatBuffer, sourceSampleRate, PCM_SAMPLE_RATE);
    const int16Chunk = floatToInt16(normalized);
    for (let i = 0; i < int16Chunk.length; i++) {
      pcmAccumulator.push(int16Chunk[i]);
    }
    while (pcmAccumulator.length >= PCM_FRAME_SIZE) {
      const frame = pcmAccumulator.splice(0, PCM_FRAME_SIZE);
      sendPcmFrame(Int16Array.from(frame));
    }
    if (pcmAccumulator.length > PCM_FRAME_SIZE * 10) {
      pcmAccumulator.splice(0, pcmAccumulator.length - PCM_FRAME_SIZE * 5);
    }
  };

  const ensureScriptProcessorPipeline = (ctx) => {
    if (!mediaStream) {
      return;
    }

    stopTrackProcessorPipeline();

    if (!micSource) {
      micSource = ctx.createMediaStreamSource(mediaStream);
    }

    if (!micProcessor) {
      const bufferSize = 2048;
      micProcessor = ctx.createScriptProcessor(bufferSize, 1, 1);
      micProcessor.onaudioprocess = (event) => {
        const inputBuffer = event.inputBuffer.getChannelData(0);
        appendPcmSamples(inputBuffer, ctx.sampleRate);
      };

      try {
        micSource.connect(micProcessor);
      } catch (error) {
        // ignore connect errors if already connected
      }

      try {
        micProcessor.connect(captureSilenceGain ?? ctx.destination);
      } catch (error) {
        // ignore
      }

      log('ScriptProcessor pipeline aktif', { bufferSize });
    }
  };

  const ensureAudioContext = async (fromUserGesture = false) => {
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
      try {
        await audioContext.resume();
      } catch (err) {
        if (!fromUserGesture) {
          showAudioUnlockPrompt('resume_error');
        }
        throw err;
      }
    }
    if (audioContext.state !== 'running') {
      if (!fromUserGesture) {
        showAudioUnlockPrompt('resume_blocked');
      }
    } else {
      audioUnlocked = true;
      audioUnlockButtonEl?.classList.add('hidden');
    }
    return audioContext;
  };

  const startStreamingAudio = async ({ fromUserGesture = false } = {}) => {
    if (micProcessor || micRecorderActive || trackProcessorActive) {
      log('Audio already streaming, skipping start');
      return;
    }

    try {
      const ctx = await ensureAudioContext(fromUserGesture).catch((error) => {
        log('AudioContext belum aktif, melanjutkan capture', { error: error?.message });
        return audioContext ?? null;
      });
      const contextRunning = ctx?.state === 'running';

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

      if (startMediaRecorder()) {
        pcmAccumulator = [];
        if (!contextRunning) {
          microphoneStatusEl.textContent = 'Mikrofon aktif. Audio dari Java akan terdengar setelah Anda mengaktifkan audio.';
          showAudioUnlockPrompt('playback_pending_unlock');
        }
        return;
      }

      if (ensureTrackProcessorPipeline()) {
        updateTrackProcessorStatus(contextRunning);
        return;
      }

      if (!contextRunning) {
        microphoneStatusEl.textContent = 'Mikrofon siap. Sentuh tombol "Aktifkan Audio" agar mode kompatibilitas berjalan.';
        showAudioUnlockPrompt('script_processor_requires_unlock');
        return;
      }

      microphoneStatusEl.textContent = 'Mikrofon aktif. Mengirim audio ke gateway…';

      pcmAccumulator = [];
      ensureScriptProcessorPipeline(ctx);
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
    stopMediaRecorder();
    mediaRecorderDecodeFailures = 0;
    stopTrackProcessorPipeline();
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
    if (pendingMicFlushInterval) {
      clearInterval(pendingMicFlushInterval);
      pendingMicFlushInterval = undefined;
    }
    pendingMicChunks = [];
    releaseWakeLock();
  };

  audioUnlockButtonEl?.addEventListener('click', async () => {
    try {
      const ctx = await ensureAudioContext(true);
      if (ctx.state !== 'running') {
        microphoneStatusEl.textContent = 'Browser masih memblokir audio. Mohon sentuh layar sekali lagi atau buka halaman ini di depan.';
        showAudioUnlockPrompt('still_suspended');
        return;
      }
      audioUnlocked = true;
      audioUnlockButtonEl.classList.add('hidden');
      microphoneStatusEl.textContent = 'Audio aktif. Anda dapat kembali ke gim.';
      log('Audio context unlocked via user interaction');
      if (micPermissionGranted && currentVoiceConfig && !micProcessor) {
        await startStreamingAudio({ fromUserGesture: true });
      }
    } catch (error) {
      log('Gagal mengaktifkan audio', { error: error.message });
      showAudioUnlockPrompt('unlock_failed');
    }
  });

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
      const originalArrayBuffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
      const getArrayBuffer = () => originalArrayBuffer.slice(0);

      // Check format
      if (message.format === 'ogg_opus') {
        // Use Web Audio API to decode and play Opus audio; fall back to <audio> element if decoding fails
        const ctx = await ensureAudioContext();
        if (ctx.state !== 'running') {
          showAudioUnlockPrompt('playback_blocked');
          return;
        }

        const playFallbackElement = async () => {
          try {
            const blob = new Blob([getArrayBuffer()], { type: 'audio/ogg; codecs=opus' });
            const url = URL.createObjectURL(blob);
            const el = new Audio(url);
            el.autoplay = true;
            el.playsInline = true;
            el.preload = 'auto';
            try {
              document.body?.appendChild(el);
            } catch (_) {
              /* noop */
            }
            const baseVolume = Math.min(1.0, message.speaker.volume || 1.0);
            el.volume = Math.min(1.0, baseVolume * VOICE_VOLUME_BOOST);
            try {
              await el.play();
              console.warn('🔁 Playing audio via fallback <audio> element', {
                speaker: message.speaker.name,
                volume: el.volume
              });
            } catch (playError) {
              showAudioUnlockPrompt('fallback_play_blocked');
              try {
                URL.revokeObjectURL(url);
                el.remove();
              } catch (_) {
                /* noop */
              }
              throw playError;
            }
            el.addEventListener('ended', () => {
              URL.revokeObjectURL(url);
              el.remove();
            }, { once: true });
          } catch (fallbackError) {
            console.error('Fallback audio playback failed', fallbackError);
          }
        };

        try {
          if (ctx.state === 'suspended') {
            await ctx.resume();
          }

          const decodedBuffer = await decodeAudioDataCompat(ctx, getArrayBuffer());
          const audioBuffer = decodedBuffer;

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
    updateSessionCodeDisplay();
  });

  const storedCode = readSessionCookie();
  if (storedCode) {
    log('Memuat kode sesi tersimpan', { code: storedCode });
  }

  // Request microphone permission on page load
  (async () => {
    try {
      linkStatusEl.textContent = 'Meminta izin akses mikrofon…';
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
      log('Microphone permission granted & stream acquired');
      await startStreamingAudio();
      if (trackProcessorActive) {
        linkStatusEl.textContent = 'Mikrofon siap di latar belakang. Jalankan /voicebed dari dalam gim.';
      } else {
        linkStatusEl.textContent = 'Izin mikrofon diberikan. Menunggu koneksi…';
      }
    } catch (error) {
      micPermissionGranted = false;
      mediaStream = null;
      linkStatusEl.textContent = 'Izin mikrofon diperlukan untuk melanjutkan.';
      log('Microphone permission denied', { error: error.message });
    }
  })();

  rerollButtonEl.disabled = true;
  connect();

  if (serviceWorkerEnabled && 'serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').then(() => {
      log('Service worker terdaftar');
    }).catch((error) => {
      log('Gagal mendaftarkan service worker', { error: error.message });
    });
  } else if (!serviceWorkerEnabled) {
    log('Service worker dinonaktifkan oleh konfigurasi native');
  }
  
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
