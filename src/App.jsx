import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowUp,
  CaretLeft,
  CaretRight,
  ChartLineUp,
  ChatCircleDots,
  Check,
  Clock,
  Copy,
  Crown,
  DotsThree,
  Flame,
  GearSix,
  Hexagon,
  Lightbulb,
  List,
  MagnifyingGlass,
  Microphone,
  Pause,
  Play,
  Plus,
  SlidersHorizontal,
  Sparkle,
  SpeakerHigh,
  ShieldCheck,
  Target,
  TextT,
  UserCircle,
  Waveform,
  X,
} from '@phosphor-icons/react';

const SETTINGS_KEY = 'argue-ai-settings';
const VOICE_PLAYBACK_RATE = 1.5;
const LIVE_INPUT_SAMPLE_RATE = 16000;
const LIVE_OUTPUT_SAMPLE_RATE = 24000;
const LIVE_API_VERSION = 'v1alpha';

const defaultSettings = {
  autoPlayVoice: true,
  selectedVoice: 'Nova',
  speakingSpeed: String(VOICE_PLAYBACK_RATE),
  hapticsEnabled: true,
  compactTranscript: false,
  reducedMotion: false,
};

const initialMessages = [
  {
    id: 'm1',
    role: 'user',
    time: '9:41 AM',
    text: 'Remote work makes people more productive.',
  },
  {
    id: 'm2',
    role: 'assistant',
    time: '9:41 AM',
    text: 'Sometimes. Flexibility helps, but isolation and blurred boundaries can erase the gain.',
  },
];

const historyItems = [
  {
    title: 'Is Remote Work Better?',
    mode: 'Argue',
    date: 'Today',
    preview: 'Remote work makes people more productive…',
    count: 8,
    messages: initialMessages,
  },
  {
    title: 'AI Fitness App Idea',
    mode: 'Brainstorm',
    date: 'Yesterday',
    preview: 'I want to build an AI fitness application.',
    count: 12,
    messages: [
      { id: 'fitness-1', role: 'user', time: '6:14 PM', text: 'I want to build an AI fitness application.' },
      { id: 'fitness-2', role: 'assistant', time: '6:14 PM', text: 'That category is crowded, so the first challenge is choosing a specific user whose problem is still poorly served. Which group do you understand best?' },
    ],
  },
  {
    title: 'Should College Be Free?',
    mode: 'Argue',
    date: 'Previous 7 Days',
    preview: 'Free tuition could make education more accessible…',
    count: 6,
    messages: [
      { id: 'college-1', role: 'user', time: '8:22 PM', text: 'Public college should be free for everyone.' },
      { id: 'college-2', role: 'assistant', time: '8:22 PM', text: 'Universal free tuition may also subsidize families who can already afford college while leaving living costs and limited seats unresolved. Would targeted support produce a fairer result?' },
    ],
  },
];

const voiceButtonLabels = {
  listening: 'STOP',
  transcribing: 'PROCESS',
  thinking: 'THINK',
  generating: 'VOICE',
  speaking: 'SPEAK',
  error: 'RETRY',
};

const voiceStatusCopy = {
  idle: 'Tap ARGUE to speak · tap again to send',
  listening: 'Listening · tap ARGUE when you’re done',
  transcribing: 'Turning your voice into text',
  thinking: 'Building the sharpest counterpoint',
  generating: 'Generating the voice response',
  speaking: 'Reading the response back to you',
  error: 'Voice playback failed · tap ARGUE to retry',
};

voiceStatusCopy.listening = 'Listening - pause to send automatically';

async function requestJson(path, options) {
  const response = await fetch(path, options);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || 'The AI service is unavailable right now.');
  return data;
}

async function requestLiveToken(mode, signal) {
  const response = await fetch('/api/live-token', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ mode }),
    signal,
  });

  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new Error(data.error || 'Gemini Live is unavailable right now.');
  }

  const data = await response.json().catch(() => null);
  if (!data?.token || !data?.model) throw new Error('Gemini Live returned an invalid session token.');
  return data;
}

function arrayBufferToBase64(value) {
  const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
  let binary = '';
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}

function base64ToBytes(value) {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function downsampleToPcm16(input, inputSampleRate) {
  if (inputSampleRate === LIVE_INPUT_SAMPLE_RATE) {
    const pcm = new Int16Array(input.length);
    for (let index = 0; index < input.length; index += 1) {
      const sample = Math.max(-1, Math.min(1, input[index]));
      pcm[index] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
    }
    return pcm;
  }

  const ratio = inputSampleRate / LIVE_INPUT_SAMPLE_RATE;
  const outputLength = Math.max(1, Math.round(input.length / ratio));
  const pcm = new Int16Array(outputLength);
  for (let outputIndex = 0; outputIndex < outputLength; outputIndex += 1) {
    const start = Math.floor(outputIndex * ratio);
    const end = Math.min(input.length, Math.max(start + 1, Math.floor((outputIndex + 1) * ratio)));
    let total = 0;
    for (let inputIndex = start; inputIndex < end; inputIndex += 1) total += input[inputIndex];
    const sample = Math.max(-1, Math.min(1, total / (end - start)));
    pcm[outputIndex] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
  }
  return pcm;
}

function pcm16ToFloat32(bytes) {
  const sampleCount = Math.floor(bytes.byteLength / 2);
  const view = new DataView(bytes.buffer, bytes.byteOffset, sampleCount * 2);
  const samples = new Float32Array(sampleCount);
  for (let index = 0; index < sampleCount; index += 1) samples[index] = view.getInt16(index * 2, true) / 0x8000;
  return samples;
}

function parseSampleRate(mimeType) {
  const match = typeof mimeType === 'string' ? mimeType.match(/rate=(\d+)/i) : null;
  const sampleRate = match ? Number(match[1]) : LIVE_OUTPUT_SAMPLE_RATE;
  return Number.isFinite(sampleRate) && sampleRate > 0 ? sampleRate : LIVE_OUTPUT_SAMPLE_RATE;
}

function getPlaybackErrorMessage(error) {
  if (error?.name === 'NotAllowedError') return 'The browser blocked automatic playback. Tap Replay to hear it.';
  if (error?.name === 'AbortError') return 'Voice playback was cancelled.';
  return error?.message || 'Voice playback failed. Please try again.';
}

let fallbackId = 0;

function createId(prefix = 'message') {
  if (globalThis.crypto?.randomUUID) return `${prefix}-${globalThis.crypto.randomUUID()}`;
  fallbackId += 1;
  return `${prefix}-${Date.now()}-${fallbackId}`;
}

function getCurrentTime() {
  return new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit' }).format(new Date());
}

function createAssistantResponse(mode, input) {
  if (mode === 'Brainstorm') {
    return `The idea has potential, but “${input}” is still broad. The biggest early risk is building before identifying the specific user with the strongest unmet need. Who feels this problem most urgently?`;
  }

  return `That claim may be too broad because it assumes the same conditions apply in every case. What evidence would change your mind about “${input}”?`;
}

function liveSystemInstruction(mode) {
  if (mode === 'Brainstorm') {
    return 'You are Argue AI in Brainstorm mode: a serious, sharp thinking partner. Keep replies compact, usually 2 or 3 short sentences. Surface the strongest insight, one meaningful risk or tradeoff, and one practical next step. Stay constructive and smart. Skip jokes, fluff, headings, and long explanations. Do not claim to browse or know current facts unless they are provided.';
  }

  return 'You are Argue AI in Argue mode: a witty, rigorous debate partner. Keep replies short and punchy. Challenge the claim, add one concrete twist or tradeoff, and end with one crisp question only when it moves the debate forward. Use a clever, good-natured joke when it fits, never force humor, mock the user, or target sensitive groups. Stay fair and intellectually honest. Do not invent sources or claim current web data.';
}

function loadSettings() {
  try {
    const saved = window.localStorage.getItem(SETTINGS_KEY);
    return saved ? { ...defaultSettings, ...JSON.parse(saved), speakingSpeed: String(VOICE_PLAYBACK_RATE) } : defaultSettings;
  } catch {
    return defaultSettings;
  }
}

function SplashScreen() {
  return (
    <div className="splash-screen" role="status" aria-label="Opening Argue AI">
      <div className="splash-backdrop" aria-hidden="true">
        <span className="splash-grid" />
        <span className="splash-halo" />
      </div>
      <div className="splash-content">
        <div className="splash-core" aria-hidden="true"><Waveform size={32} weight="bold" /></div>
        <div className="splash-brand" aria-label="Argue AI"><span>Argue</span><b>AI</b></div>
        <span className="splash-divider" aria-hidden="true" />
        <p className="splash-tagline">Make the case.</p>
      </div>
      <div className="splash-footer" aria-hidden="true">
        <span className="splash-status-dot" />
        <span>READY WHEN YOU ARE</span>
        <span className="splash-progress" />
      </div>
    </div>
  );
}

export function App() {
  const [showSplash, setShowSplash] = useState(() => import.meta.env.MODE !== 'test');
  const [mode, setMode] = useState('Argue');
  const [inputMode, setInputMode] = useState('voice');
  const [activeNav, setActiveNav] = useState('Argue');
  const [voiceState, setVoiceState] = useState('idle');
  const [messages, setMessages] = useState(initialMessages);
  const [draft, setDraft] = useState('');
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsSection, setSettingsSection] = useState('voice');
  const [settings, setSettings] = useState(loadSettings);
  const [copiedId, setCopiedId] = useState(null);
  const [playingMessageId, setPlayingMessageId] = useState(null);
  const [notice, setNotice] = useState('');
  const liveSocket = useRef(null);
  const liveStream = useRef(null);
  const liveSessionId = useRef(0);
  const liveTokenAbort = useRef(null);
  const liveMicContext = useRef(null);
  const liveMicSource = useRef(null);
  const liveMicProcessor = useRef(null);
  const liveMicSilence = useRef(null);
  const liveOutputContext = useRef(null);
  const liveOutputSources = useRef(new Set());
  const liveOutputNextTime = useRef(0);
  const liveOutputPendingTurn = useRef(false);
  const liveInputTranscript = useRef('');
  const liveOutputTranscript = useRef('');
  const liveUserMessageId = useRef(null);
  const liveAssistantMessageId = useRef(null);
  const speechUtterance = useRef(null);
  const voiceStatusTimer = useRef(null);
  const copyTimer = useRef(null);
  const noticeTimer = useRef(null);
  const settingsTrigger = useRef(null);

  useEffect(() => {
    if (!showSplash) return undefined;
    const reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches || loadSettings().reducedMotion;
    const timer = window.setTimeout(() => setShowSplash(false), reducedMotion ? 250 : 4200);
    return () => window.clearTimeout(timer);
  }, [showSplash]);

  const showNotice = useCallback((message) => {
    if (noticeTimer.current) window.clearTimeout(noticeTimer.current);
    setNotice(message);
    noticeTimer.current = window.setTimeout(() => setNotice(''), 2600);
  }, []);

  const haptic = useCallback(() => {
    if (settings.hapticsEnabled && navigator.vibrate) navigator.vibrate(10);
  }, [settings.hapticsEnabled]);

  const showVoiceError = useCallback((error) => {
    setVoiceState('error');
    showNotice(getPlaybackErrorMessage(error));
    if (voiceStatusTimer.current) window.clearTimeout(voiceStatusTimer.current);
    voiceStatusTimer.current = window.setTimeout(() => {
      voiceStatusTimer.current = null;
      setVoiceState('idle');
    }, 2200);
  }, [showNotice]);

  const stopSpeechPlayback = useCallback(() => {
    window.speechSynthesis?.cancel?.();
    speechUtterance.current = null;
  }, []);

  const stopLiveAudio = useCallback(() => {
    for (const source of liveOutputSources.current) {
      source.onended = null;
      try {
        source.stop();
      } catch {
        // The source may already have ended.
      }
      source.disconnect?.();
    }
    liveOutputSources.current.clear();
    liveOutputNextTime.current = 0;
    liveOutputPendingTurn.current = false;
    const context = liveOutputContext.current;
    liveOutputContext.current = null;
    if (context && context.state !== 'closed') {
      const closing = context.close?.();
      closing?.catch?.(() => {});
    }
  }, []);

  const stopLiveMicrophone = useCallback(() => {
    const processor = liveMicProcessor.current;
    if (processor) {
      processor.onaudioprocess = null;
      processor.disconnect?.();
    }
    liveMicSource.current?.disconnect?.();
    liveMicSilence.current?.disconnect?.();
    liveMicProcessor.current = null;
    liveMicSource.current = null;
    liveMicSilence.current = null;
    const context = liveMicContext.current;
    liveMicContext.current = null;
    if (context && context.state !== 'closed') {
      const closing = context.close?.();
      closing?.catch?.(() => {});
    }
    liveStream.current?.getTracks?.().forEach((track) => track.stop());
    liveStream.current = null;
  }, []);

  const upsertLiveMessage = useCallback((role, text) => {
    const content = text.trim();
    if (!content) return;
    const idRef = role === 'user' ? liveUserMessageId : liveAssistantMessageId;
    let id = idRef.current;
    if (!id) {
      id = createId(role === 'user' ? 'live-user' : 'live-ai');
      idRef.current = id;
    }

    setMessages((current) => {
      const existing = current.find((message) => message.id === id);
      if (existing) return current.map((message) => message.id === id ? { ...message, text: content } : message);
      return [...current, { id, role, time: getCurrentTime(), text: content }];
    });
  }, []);

  const finalizeLiveTurn = useCallback(() => {
    upsertLiveMessage('user', liveInputTranscript.current);
    upsertLiveMessage('assistant', liveOutputTranscript.current);
    liveInputTranscript.current = '';
    liveOutputTranscript.current = '';
    liveUserMessageId.current = null;
    liveAssistantMessageId.current = null;
  }, [upsertLiveMessage]);

  const queueLiveAudio = useCallback((base64Audio, mimeType, sessionId) => {
    if (liveSessionId.current !== sessionId || !settings.autoPlayVoice) return;
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (typeof AudioContextClass !== 'function') throw new Error('Live audio is not supported in this browser.');

    let context = liveOutputContext.current;
    if (!context) {
      context = new AudioContextClass();
      liveOutputContext.current = context;
    }
    context.resume?.().catch?.(() => {});

    const bytes = base64ToBytes(base64Audio);
    const samples = pcm16ToFloat32(bytes);
    if (!samples.length) return;
    const audioBuffer = context.createBuffer(1, samples.length, parseSampleRate(mimeType));
    if (typeof audioBuffer.copyToChannel === 'function') audioBuffer.copyToChannel(samples, 0);
    else audioBuffer.getChannelData(0).set(samples);
    const source = context.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(context.destination);
    const now = Number.isFinite(context.currentTime) ? context.currentTime : 0;
    const startAt = Math.max(now + 0.02, liveOutputNextTime.current || 0);
    liveOutputNextTime.current = startAt + audioBuffer.duration;
    liveOutputSources.current.add(source);
    source.onended = () => {
      liveOutputSources.current.delete(source);
      source.disconnect?.();
      if (liveOutputPendingTurn.current && liveOutputSources.current.size === 0) {
        liveOutputPendingTurn.current = false;
        setVoiceState('listening');
      }
    };
    source.start(startAt);
    setVoiceState('speaking');
  }, [settings.autoPlayVoice]);

  const handleLiveMessage = useCallback((event, sessionId) => {
    if (liveSessionId.current !== sessionId) return;

    let payload;
    try {
      const raw = typeof event.data === 'string' ? event.data : new TextDecoder().decode(event.data);
      payload = JSON.parse(raw);
    } catch {
      return;
    }

    const serverContent = payload?.serverContent;
    if (!serverContent) return;

    if (serverContent.interrupted) {
      stopLiveAudio();
      finalizeLiveTurn();
      setVoiceState('listening');
      return;
    }

    const inputText = serverContent.inputTranscription?.text;
    if (typeof inputText === 'string' && inputText.trim()) {
      liveInputTranscript.current += `${inputText} `;
      upsertLiveMessage('user', liveInputTranscript.current);
    }

    const outputText = serverContent.outputTranscription?.text;
    if (typeof outputText === 'string' && outputText.trim()) {
      liveOutputTranscript.current += `${outputText} `;
      upsertLiveMessage('assistant', liveOutputTranscript.current);
      setVoiceState((current) => current === 'speaking' ? current : 'generating');
    }

    for (const part of serverContent.modelTurn?.parts || []) {
      const inlineData = part?.inlineData || part?.inline_data;
      if (inlineData?.data) queueLiveAudio(inlineData.data, inlineData.mimeType || inlineData.mime_type, sessionId);
      if (!outputText && typeof part?.text === 'string' && part.text.trim()) {
        liveOutputTranscript.current += `${part.text} `;
        upsertLiveMessage('assistant', liveOutputTranscript.current);
        setVoiceState('generating');
      }
    }

    if (serverContent.turnComplete) {
      finalizeLiveTurn();
      liveOutputPendingTurn.current = true;
      if (liveOutputSources.current.size === 0) {
        liveOutputPendingTurn.current = false;
        setVoiceState('listening');
      }
    }
  }, [finalizeLiveTurn, queueLiveAudio, stopLiveAudio, upsertLiveMessage]);

  const stopLiveSession = useCallback((announce = true) => {
    liveSessionId.current += 1;
    liveTokenAbort.current?.abort();
    liveTokenAbort.current = null;
    const socket = liveSocket.current;
    liveSocket.current = null;
    if (socket && (socket.readyState === window.WebSocket.OPEN || socket.readyState === window.WebSocket.CONNECTING)) socket.close(1000, 'Session stopped');
    stopLiveMicrophone();
    stopLiveAudio();
    liveInputTranscript.current = '';
    liveOutputTranscript.current = '';
    liveUserMessageId.current = null;
    liveAssistantMessageId.current = null;
    setPlayingMessageId(null);
    setVoiceState('idle');
    if (announce) showNotice('Voice session stopped.');
  }, [showNotice, stopLiveAudio, stopLiveMicrophone]);

  const startLiveMicrophone = useCallback((stream, socket, sessionId) => {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (typeof AudioContextClass !== 'function') throw new Error('Live audio is not supported in this browser.');
    if (typeof AudioContextClass.prototype?.createScriptProcessor !== 'function') throw new Error('Live microphone capture is not supported in this browser.');

    const context = new AudioContextClass();
    const source = context.createMediaStreamSource(stream);
    const processor = context.createScriptProcessor(4096, 1, 1);
    const silence = context.createGain();
    silence.gain.value = 0;
    processor.onaudioprocess = (event) => {
      if (liveSessionId.current !== sessionId || socket.readyState !== window.WebSocket.OPEN) return;
      const input = event.inputBuffer.getChannelData(0);
      const pcm = downsampleToPcm16(input, context.sampleRate || LIVE_INPUT_SAMPLE_RATE);
      socket.send(JSON.stringify({
        realtimeInput: {
          audio: {
            data: arrayBufferToBase64(pcm.buffer),
            mimeType: `audio/pcm;rate=${LIVE_INPUT_SAMPLE_RATE}`,
          },
        },
      }));
    };
    source.connect(processor);
    processor.connect(silence);
    silence.connect(context.destination);
    context.resume?.().catch?.(() => {});
    liveMicContext.current = context;
    liveMicSource.current = source;
    liveMicProcessor.current = processor;
    liveMicSilence.current = silence;
  }, []);

  useEffect(() => {
    try {
      window.localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
    } catch {
      // The app remains usable when browser storage is unavailable.
    }
  }, [settings]);

  useEffect(() => () => {
    stopLiveSession(false);
    stopSpeechPlayback();
    if (voiceStatusTimer.current) {
      window.clearTimeout(voiceStatusTimer.current);
      voiceStatusTimer.current = null;
    }
    setPlayingMessageId(null);
    if (copyTimer.current) window.clearTimeout(copyTimer.current);
    if (noticeTimer.current) window.clearTimeout(noticeTimer.current);
  }, [stopLiveSession, stopSpeechPlayback]);

  const stopConversation = useCallback((announce = true) => {
    stopLiveSession(announce);
    stopSpeechPlayback();
    if (voiceStatusTimer.current) {
      window.clearTimeout(voiceStatusTimer.current);
      voiceStatusTimer.current = null;
    }
  }, [stopLiveSession, stopSpeechPlayback]);

  const startVoiceSession = async () => {
    if (liveSocket.current || liveTokenAbort.current || voiceState !== 'idle') {
      haptic();
      stopConversation();
      return;
    }

    if (!navigator.mediaDevices?.getUserMedia || typeof window.WebSocket !== 'function') {
      showNotice('Live voice is not supported in this browser.');
      return;
    }

    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (typeof AudioContextClass !== 'function') {
      showNotice('Live audio is not supported in this browser.');
      return;
    }

    const sessionId = liveSessionId.current + 1;
    liveSessionId.current = sessionId;
    const controller = new AbortController();
    liveTokenAbort.current = controller;

    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
      if (liveSessionId.current !== sessionId) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }

      liveStream.current = stream;
      const outputContext = new AudioContextClass();
      liveOutputContext.current = outputContext;
      await outputContext.resume?.();
      setVoiceState('thinking');
      haptic();

      const token = await requestLiveToken(mode, controller.signal);
      if (liveSessionId.current !== sessionId) {
        stream.getTracks().forEach((track) => track.stop());
        stopLiveAudio();
        return;
      }

      const apiVersion = token.apiVersion || LIVE_API_VERSION;
      const socket = new window.WebSocket(`wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.${apiVersion}.GenerativeService.BidiGenerateContentConstrained?access_token=${encodeURIComponent(token.token)}`);
      liveSocket.current = socket;
      socket.onopen = () => {
        if (liveSessionId.current !== sessionId) return;
        try {
          socket.send(JSON.stringify({
            setup: {
              model: `models/${token.model}`,
              responseModalities: ['AUDIO'],
              inputAudioTranscription: {},
              outputAudioTranscription: {},
              systemInstruction: { parts: [{ text: liveSystemInstruction(mode) }] },
              speechConfig: {
                voiceConfig: { prebuiltVoiceConfig: { voiceName: token.voice || 'Kore' } },
              },
              thinkingConfig: { thinkingLevel: 'low' },
              realtimeInputConfig: {
                automaticActivityDetection: {
                  disabled: false,
                  prefixPaddingMs: 250,
                  silenceDurationMs: 700,
                },
              },
            },
          }));
          startLiveMicrophone(stream, socket, sessionId);
          setVoiceState('listening');
        } catch (error) {
          stopLiveSession(false);
          showVoiceError(error);
        }
      };
      socket.onmessage = (event) => handleLiveMessage(event, sessionId);
      socket.onerror = () => {
        if (liveSessionId.current !== sessionId) return;
        stopLiveSession(false);
        showVoiceError(new Error('Gemini Live connection failed.'));
      };
      socket.onclose = (event) => {
        if (liveSessionId.current !== sessionId) return;
        stopLiveSession(false);
        if (event.code !== 1000) showVoiceError(new Error('Gemini Live disconnected.'));
      };
    } catch (error) {
      if (liveSessionId.current !== sessionId) return;
      stopLiveSession(false);
      if (error?.name !== 'AbortError') showVoiceError(error);
    } finally {
      if (liveTokenAbort.current === controller) liveTokenAbort.current = null;
    }
  };

  const sendDraft = async (event) => {
    event?.preventDefault();
    const value = draft.trim();
    if (!value || voiceState !== 'idle') return;

    haptic();
    const sessionMode = mode;
    const userMessage = { id: createId('text-user'), role: 'user', time: getCurrentTime(), text: value };
    const nextMessages = [...messages, userMessage];
    setMessages(nextMessages);
    setDraft('');
    setVoiceState('thinking');

    try {
      const response = await requestJson('/api/chat', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ mode: sessionMode, input: value, messages: nextMessages }),
      });
      setMessages((current) => [...current, { id: createId('text-ai'), role: 'assistant', time: getCurrentTime(), text: response.reply }]);
    } catch (error) {
      showNotice(error.message);
    } finally {
      setVoiceState('idle');
    }
  };

  const copyMessage = async (message) => {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(message.text);
      } else {
        const copyField = document.createElement('textarea');
        copyField.value = message.text;
        copyField.setAttribute('readonly', '');
        copyField.style.position = 'fixed';
        copyField.style.opacity = '0';
        document.body.appendChild(copyField);
        copyField.select();
        const copied = document.execCommand?.('copy');
        copyField.remove();
        if (!copied) throw new Error('Clipboard unavailable');
      }

      setCopiedId(message.id);
      if (copyTimer.current) window.clearTimeout(copyTimer.current);
      copyTimer.current = window.setTimeout(() => setCopiedId(null), 1400);
    } catch {
      showNotice('Could not copy that response.');
    }
  };

  const replayMessage = (message) => {
    if (playingMessageId === message.id) {
      stopSpeechPlayback();
      setPlayingMessageId(null);
      showNotice('Playback stopped.');
      return;
    }

    stopSpeechPlayback();
    const Utterance = window.SpeechSynthesisUtterance;
    if (!window.speechSynthesis || typeof Utterance !== 'function') {
      showNotice('Replay is not supported in this browser.');
      return;
    }

    const utterance = new Utterance(message.text);
    utterance.rate = VOICE_PLAYBACK_RATE;
    const availableVoices = window.speechSynthesis.getVoices?.() || [];
    const preferredVoice = availableVoices.find((voice) => voice.name.toLowerCase().includes(settings.selectedVoice.toLowerCase()));
    if (preferredVoice) utterance.voice = preferredVoice;
    utterance.onend = () => {
      if (speechUtterance.current === utterance) speechUtterance.current = null;
      setPlayingMessageId(null);
    };
    utterance.onerror = (event) => {
      if (speechUtterance.current !== utterance) return;
      speechUtterance.current = null;
      setPlayingMessageId(null);
      if (event.error !== 'canceled') showNotice(getPlaybackErrorMessage(new Error('Replay failed.')));
    };
    speechUtterance.current = utterance;
    setPlayingMessageId(message.id);
    window.speechSynthesis.speak(utterance);
  };

  const openSettings = (section = 'voice') => {
    settingsTrigger.current = document.activeElement;
    setSettingsSection(section);
    setSettingsOpen(true);
  };

  const closeSettings = useCallback(() => {
    setSettingsOpen(false);
    window.setTimeout(() => settingsTrigger.current?.focus?.(), 0);
  }, []);

  const updateSettings = (changes) => {
    setSettings((current) => ({ ...current, ...changes }));
  };

  const navigate = (destination) => {
    haptic();
    if (destination !== activeNav && voiceState !== 'idle') stopConversation(false);
    stopSpeechPlayback();
    setPlayingMessageId(null);
    setActiveNav(destination);
  };

  const openConversation = (conversation) => {
    stopConversation(false);
    setMode(conversation.mode);
    setInputMode('text');
    setMessages(conversation.messages);
    setActiveNav('Argue');
  };

  const startNewConversation = () => {
    stopConversation(false);
    setMessages([]);
    setDraft('');
    setActiveNav('Argue');
  };

  return (
    <>
      {showSplash && <SplashScreen />}
      <main aria-hidden={showSplash ? 'true' : undefined} className={settings.reducedMotion ? 'app-stage reduced-motion' : 'app-stage'}>
      <section className="device-frame" aria-label="Argue AI responsive workspace">
        <div className="device-screen">
          <div className="status-bar" aria-hidden="true">
            <span>9:41</span>
            <div className="status-icons">
              <span className="signal"><i /><i /><i /><i /></span>
              <span className="wifi" />
              <span className="battery"><span /></span>
            </div>
          </div>

          <div className="desktop-layout">
            <DesktopSidebar activeNav={activeNav} onNavigate={navigate} />
            <div className="desktop-main">
              <div className="app-content">
                {activeNav === 'Argue' && (
                  <HomeScreen
                    mode={mode}
                    setMode={setMode}
                    inputMode={inputMode}
                    setInputMode={setInputMode}
                    voiceState={voiceState}
                    startVoiceSession={startVoiceSession}
                    messages={messages}
                    messageLimit={settings.compactTranscript ? 2 : 4}
                    draft={draft}
                    setDraft={setDraft}
                    sendDraft={sendDraft}
                    copyMessage={copyMessage}
                    copiedId={copiedId}
                    playingMessageId={playingMessageId}
                    replayMessage={replayMessage}
                    openSettings={openSettings}
                  />
                )}
                {activeNav === 'History' && (
                  <HistoryScreen
                    conversations={historyItems}
                    onOpenConversation={openConversation}
                    onStartNew={startNewConversation}
                  />
                )}
                {activeNav === 'Profile' && (
                  <ProfileScreen
                    onOpenSettings={openSettings}
                    onAction={showNotice}
                  />
                )}
              </div>

              <BottomNav activeNav={activeNav} onNavigate={navigate} />
            </div>
          </div>
          <div className="home-indicator" aria-hidden="true" />
        </div>
      </section>

      {settingsOpen && (
        <SettingsSheet
          section={settingsSection}
          settings={settings}
          onChange={updateSettings}
          onClose={closeSettings}
        />
      )}
      {notice && <div className="app-toast" role="status">{notice}</div>}
      </main>
    </>
  );
}

function HomeScreen({ mode, setMode, inputMode, setInputMode, voiceState, startVoiceSession, messages, messageLimit, draft, setDraft, sendDraft, copyMessage, copiedId, playingMessageId, replayMessage, openSettings }) {
  const activeState = ['transcribing', 'thinking', 'generating'].includes(voiceState) ? 'thinking' : voiceState;
  const isBusy = voiceState !== 'idle';
  const transcriptRef = useRef(null);
  const inputRef = useRef(null);
  const visibleMessages = messages.slice(-messageLimit);
  const buttonText = isBusy ? voiceButtonLabels[voiceState] : mode.toUpperCase();
  const compactButtonText = buttonText.length > 8;

  useEffect(() => {
    const transcript = transcriptRef.current;
    if (!transcript) return;
    if (typeof transcript.scrollTo === 'function') {
      transcript.scrollTo({ top: transcript.scrollHeight, behavior: 'smooth' });
    } else {
      transcript.scrollTop = transcript.scrollHeight;
    }
  }, [messages]);

  useEffect(() => {
    if (!draft && inputRef.current) inputRef.current.style.height = 'auto';
  }, [draft]);

  const updateDraft = (event) => {
    const field = event.currentTarget;
    setDraft(field.value);
    field.style.height = 'auto';
    field.style.height = `${Math.min(field.scrollHeight, 78)}px`;
  };

  const handleInputKeyDown = (event) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      sendDraft(event);
    }
  };

  return (
    <div className={inputMode === 'voice' ? 'home-screen voice-mode' : 'home-screen text-mode'}>
      <header className="top-header">
        <div className="brand-lockup" aria-label="Argue AI">
          <span>Argue</span><b>AI</b>
        </div>
        <button className="icon-button header-action" type="button" aria-label="Open voice settings" onClick={() => openSettings('voice')}>
          <Waveform size={21} weight="bold" />
        </button>
        <button className="icon-button desktop-settings-action" type="button" aria-label="Open app preferences" onClick={() => openSettings('app')}>
          <GearSix size={21} weight="regular" />
        </button>
      </header>

      <div className="mode-switcher" role="tablist" aria-label="Conversation mode">
        <button className={mode === 'Argue' ? 'mode-tab active' : 'mode-tab'} disabled={isBusy} onClick={() => setMode('Argue')} role="tab" aria-selected={mode === 'Argue'} type="button">
          <ChatCircleDots size={27} weight="regular" />
          <span>Argue</span>
        </button>
        <button className={mode === 'Brainstorm' ? 'mode-tab active' : 'mode-tab'} disabled={isBusy} onClick={() => setMode('Brainstorm')} role="tab" aria-selected={mode === 'Brainstorm'} type="button">
          <Lightbulb size={26} weight="regular" />
          <span>Brainstorm</span>
        </button>
      </div>

      <p className="tagline">{mode === 'Argue' ? 'Make the case.' : 'Build the idea.'}</p>
      <p className="desktop-subtitle">Argue your point. Defend your ideas. Win the discussion.</p>

      <div className="input-mode-switcher" role="tablist" aria-label="Input mode">
        <button className={inputMode === 'voice' ? 'input-mode-tab active' : 'input-mode-tab'} disabled={isBusy} onClick={() => setInputMode('voice')} role="tab" aria-selected={inputMode === 'voice'} aria-label="Voice input" type="button">
          <Microphone size={17} weight="bold" />
          <span>Voice</span>
        </button>
        <button className={inputMode === 'text' ? 'input-mode-tab active' : 'input-mode-tab'} disabled={isBusy} onClick={() => setInputMode('text')} role="tab" aria-selected={inputMode === 'text'} aria-label="Text input" type="button">
          <TextT size={18} weight="bold" />
          <span>Text</span>
        </button>
      </div>

      {inputMode === 'voice' && (
        <section className={isBusy ? 'voice-zone busy' : 'voice-zone'} aria-label="Voice conversation control">
          <div className="desktop-waveform-backdrop" aria-hidden="true" />
          <button className="voice-orbit" type="button" onClick={startVoiceSession} aria-label={isBusy ? 'Stop voice session' : 'Start voice session'}>
            <span className="voice-core">
              <Waveform className="core-waveform" size={45} weight="bold" />
              <strong className={compactButtonText ? 'compact-label' : ''}>{buttonText}</strong>
            </span>
          </button>

          <div className="state-row">
            <StateItem icon={<UserCircle size={25} weight="regular" />} label="Listening" active={activeState === 'listening'} />
            <StateItem icon={<Sparkle size={23} weight="fill" />} label="Thinking" active={activeState === 'thinking'} />
            <StateItem icon={<Waveform size={24} weight="bold" />} label="Speaking" active={activeState === 'speaking'} />
          </div>
          <p className="voice-caption">{voiceStatusCopy[voiceState]}</p>
          <div className="desktop-feature-grid" aria-label="Argue AI benefits">
            <FeatureCard icon={<ShieldCheck size={22} weight="fill" />} title="Defend your point" copy="Build stronger arguments" />
            <FeatureCard icon={<Target size={22} weight="fill" />} title="Win the discussion" copy="Counter with confidence" />
            <FeatureCard icon={<ChartLineUp size={22} weight="fill" />} title="Track your progress" copy="Improve over time" />
          </div>
          <span className="sr-only" role="status">Voice status: {voiceState}</span>
        </section>
      )}

      {inputMode === 'text' && (
        <section className="transcript-panel" aria-label="Conversation transcript">
          <div className="transcript-scroll" ref={transcriptRef}>
            {visibleMessages.length ? visibleMessages.map((message) => (
              <TranscriptCard
                key={message.id}
                message={message}
                onCopy={copyMessage}
                copied={copiedId === message.id}
                playing={playingMessageId === message.id}
                onReplay={replayMessage}
              />
            )) : (
              <div className="empty-transcript">
                <ChatCircleDots size={25} />
                <p>Your next argument will appear here.</p>
              </div>
            )}
          </div>
        </section>
      )}

      {inputMode === 'text' && (
        <form className="argument-input" onSubmit={sendDraft}>
          <TextT className="input-text-icon" size={23} weight="regular" aria-hidden="true" />
          <textarea
            ref={inputRef}
            value={draft}
            onChange={updateDraft}
            onKeyDown={handleInputKeyDown}
            placeholder="Type your argument"
            aria-label="Add your argument"
            maxLength={1000}
            rows={1}
          />
          <button className={draft.trim() ? 'send-button ready' : 'send-button'} type="submit" disabled={!draft.trim() || isBusy} aria-label="Send argument">
            <ArrowUp size={25} weight="bold" />
          </button>
        </form>
      )}
    </div>
  );
}

function FeatureCard({ icon, title, copy }) {
  return (
    <article className="desktop-feature-card">
      <span className="desktop-feature-icon" aria-hidden="true">{icon}</span>
      <div><strong>{title}</strong><span>{copy}</span></div>
    </article>
  );
}

function StateItem({ icon, label, active }) {
  return <div className={active ? 'state-item active' : 'state-item'} aria-current={active ? 'step' : undefined}>{icon}<span className="state-dot" /> <span>{label}</span></div>;
}

function TranscriptCard({ message, onCopy, copied, playing, onReplay }) {
  const isUser = message.role === 'user';
  const [showActions, setShowActions] = useState(false);
  const actionsId = `${message.id}-actions`;

  return (
    <article className={isUser ? 'transcript-card user-card' : 'transcript-card ai-card'}>
      <div className="message-avatar" aria-hidden="true">{isUser ? <UserCircle size={27} weight="fill" /> : <Sparkle size={25} weight="fill" />}</div>
      <div className="message-body">
        <div className="message-meta">
          <strong>{isUser ? 'YOU' : 'ARGUE AI'}</strong>
          <div className="message-meta-tail">
            <time>{message.time}</time>
            {!isUser && (
              <button className="message-menu-button" type="button" aria-label="Show response actions" aria-expanded={showActions} aria-controls={actionsId} onClick={() => setShowActions((visible) => !visible)}>
                <DotsThree size={18} weight="bold" />
              </button>
            )}
          </div>
        </div>
        <p>{message.text}</p>
        {!isUser && showActions && (
          <div className="message-actions" id={actionsId}>
            <button type="button" onClick={() => onCopy(message)} aria-label={copied ? 'Copied response' : 'Copy response'}>{copied ? <Check size={14} /> : <Copy size={14} />} {copied ? 'Copied' : 'Copy'}</button>
            <button type="button" onClick={() => onReplay(message)} aria-label={playing ? 'Pause response' : 'Replay response'}>{playing ? <Pause size={14} /> : <Play size={14} />} {playing ? 'Pause' : 'Replay'}</button>
          </div>
        )}
      </div>
    </article>
  );
}

function BottomNav({ activeNav, onNavigate }) {
  const items = [
    { label: 'Argue', icon: ChatCircleDots },
    { label: 'History', icon: Clock },
    { label: 'Profile', icon: UserCircle },
  ];

  return (
    <nav className="bottom-nav" aria-label="Primary navigation">
      {items.map(({ label, icon: Icon }) => (
        <button key={label} type="button" className={activeNav === label ? 'nav-item active' : 'nav-item'} aria-current={activeNav === label ? 'page' : undefined} onClick={() => onNavigate(label)}>
          <Icon size={29} weight={activeNav === label ? 'fill' : 'regular'} />
          <span>{label}</span>
        </button>
      ))}
    </nav>
  );
}

function DesktopSidebar({ activeNav, onNavigate }) {
  const items = [
    { label: 'Argue', icon: ChatCircleDots },
    { label: 'History', icon: Clock },
    { label: 'Profile', icon: UserCircle },
  ];

  return (
    <aside className="desktop-sidebar" aria-label="Desktop sidebar">
      <div className="desktop-sidebar-header">
        <div className="desktop-sidebar-brand" aria-label="Argue AI"><span>Argue</span><b>AI</b></div>
        <button className="desktop-collapse-button" type="button" aria-label="Collapse sidebar"><CaretLeft size={19} weight="bold" /></button>
      </div>
      <nav className="desktop-sidebar-nav" aria-label="Desktop navigation">
        {items.map(({ label, icon: Icon }) => (
          <button key={label} type="button" className={activeNav === label ? 'desktop-sidebar-item active' : 'desktop-sidebar-item'} aria-label={`Desktop ${label}`} aria-current={activeNav === label ? 'page' : undefined} onClick={() => onNavigate(label)}>
            <Icon size={23} weight={activeNav === label ? 'fill' : 'regular'} />
            <span>{label}</span>
          </button>
        ))}
      </nav>
      <div className="desktop-sidebar-footer">
        <div className="desktop-stat-card">
          <span className="desktop-stat-icon"><Flame size={20} weight="fill" /></span>
          <div><span>Daily Streak</span><strong>7 days</strong></div>
        </div>
        <div className="desktop-stat-card">
          <span className="desktop-stat-icon"><Hexagon size={20} weight="regular" /></span>
          <div><span>Total Arguments</span><strong>24</strong></div>
        </div>
        <div className="desktop-pro-card">
          <Crown className="desktop-pro-crown" size={22} weight="fill" />
          <h3>Go Pro</h3>
          <p>Unlock unlimited arguments, advanced insights, and more.</p>
          <button type="button" onClick={() => onNavigate('Profile')}>Upgrade</button>
        </div>
      </div>
    </aside>
  );
}

function HistoryScreen({ conversations, onOpenConversation, onStartNew }) {
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState('All');
  const [compact, setCompact] = useState(false);
  const filteredConversations = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    return conversations.filter((conversation) => {
      const matchesMode = filter === 'All' || conversation.mode === filter;
      const matchesQuery = !normalizedQuery || `${conversation.title} ${conversation.preview}`.toLowerCase().includes(normalizedQuery);
      return matchesMode && matchesQuery;
    });
  }, [conversations, filter, query]);

  return (
    <div className="secondary-screen history-screen">
      <header className="secondary-header">
        <div><span className="eyebrow">YOUR SESSIONS</span><h1>History</h1></div>
        <button className="icon-button" type="button" aria-label="Toggle compact history view" aria-pressed={compact} onClick={() => setCompact((value) => !value)}><List size={22} /></button>
      </header>
      <label className="search-field">
        <MagnifyingGlass size={18} aria-hidden="true" />
        <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search conversations" aria-label="Search conversations" />
      </label>
      <div className="filter-row" role="group" aria-label="Filter conversations">
        {['All', 'Argue', 'Brainstorm'].map((option) => (
          <button key={option} type="button" className={filter === option ? 'filter-pill active' : 'filter-pill'} aria-pressed={filter === option} onClick={() => setFilter(option)}>{option}</button>
        ))}
      </div>
      <div className={compact ? 'history-list compact' : 'history-list'}>
        {filteredConversations.length ? filteredConversations.map((item) => (
          <button className="history-item" type="button" key={item.title} onClick={() => onOpenConversation(item)}>
            <div className="history-icon" aria-hidden="true">{item.mode === 'Argue' ? <ChatCircleDots size={20} /> : <Lightbulb size={20} />}</div>
            <div className="history-copy">
              <div className="history-title"><strong>{item.title}</strong><span>{item.date}</span></div>
              <p>{item.preview}</p>
              <small>{item.count} messages · {item.mode}</small>
            </div>
          </button>
        )) : (
          <div className="history-empty">No conversations match that search.</div>
        )}
      </div>
      <button className="new-session" type="button" onClick={onStartNew}><Plus size={18} weight="bold" /> New conversation</button>
    </div>
  );
}

function ProfileScreen({ onOpenSettings, onAction }) {
  return (
    <div className="secondary-screen profile-screen">
      <header className="secondary-header">
        <div><span className="eyebrow">YOUR SPACE</span><h1>Profile</h1></div>
        <button className="icon-button" type="button" aria-label="Open app preferences" onClick={() => onOpenSettings('app')}><GearSix size={22} /></button>
      </header>
      <section className="profile-card">
        <div className="profile-avatar" aria-hidden="true"><UserCircle size={49} weight="fill" /></div>
        <div><strong>Alex Morgan</strong><span>Guest account</span></div>
        <button type="button" aria-label="Edit profile" onClick={() => onAction('Profile editing is not connected in this prototype.')}><SlidersHorizontal size={19} /></button>
      </section>
      <div className="usage-card"><div><span className="eyebrow">THIS MONTH</span><strong>12 / 20</strong><p>conversations used</p></div><div className="usage-ring"><span>60%</span></div></div>
      <div className="settings-list">
        <button type="button" onClick={() => onOpenSettings('voice')}><Waveform size={21} /><span>Voice settings</span><CaretRight size={17} /></button>
        <button type="button" onClick={() => onOpenSettings('app')}><GearSix size={21} /><span>App preferences</span><CaretRight size={17} /></button>
        <button type="button" onClick={() => onAction('Support: hello@argue.ai')}><SpeakerHigh size={21} /><span>Feedback & support</span><CaretRight size={17} /></button>
      </div>
      <button className="guest-cta" type="button" onClick={() => onAction('Account creation is not connected in this prototype.')}>Create an account <ArrowUp size={18} /></button>
    </div>
  );
}

function SettingsSheet({ section, settings, onChange, onClose }) {
  const sheetRef = useRef(null);
  const closeButtonRef = useRef(null);
  const title = section === 'voice' ? 'Voice settings' : 'App preferences';

  useEffect(() => {
    closeButtonRef.current?.focus();

    const handleKeyDown = (event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== 'Tab') return;

      const focusable = sheetRef.current?.querySelectorAll('button, select, input, textarea, [tabindex]:not([tabindex="-1"])');
      if (!focusable?.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  return (
    <div className="sheet-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <aside className="settings-sheet" ref={sheetRef} role="dialog" aria-modal="true" aria-labelledby="settings-title">
        <div className="sheet-handle" aria-hidden="true" />
        <div className="sheet-header">
          <div><span className="eyebrow">PREFERENCES</span><h2 id="settings-title">{title}</h2></div>
          <button className="icon-button" type="button" ref={closeButtonRef} aria-label="Close settings" onClick={onClose}><X size={21} /></button>
        </div>
        {section === 'voice' ? (
          <>
            <div className="sheet-setting">
              <div><strong>Automatic playback</strong><span>Speak AI responses after they are ready</span></div>
              <button className={settings.autoPlayVoice ? 'toggle on' : 'toggle'} type="button" role="switch" aria-checked={settings.autoPlayVoice} aria-label="Automatic voice playback" onClick={() => onChange({ autoPlayVoice: !settings.autoPlayVoice })}><span /></button>
            </div>
            <label className="sheet-setting">
              <div><strong>AI voice</strong><span>Choose the response voice</span></div>
              <select className="setting-select" value={settings.selectedVoice} onChange={(event) => onChange({ selectedVoice: event.target.value })} aria-label="AI voice">
                <option>Nova</option><option>Ember</option>
              </select>
            </label>
            {false && (
            <label className="sheet-setting">
              <div><strong>Speaking speed</strong><span>Control response playback speed</span></div>
              <select className="setting-select" value={settings.speakingSpeed} onChange={(event) => onChange({ speakingSpeed: event.target.value })} aria-label="Speaking speed">
                <option value="0.8">0.8×</option><option value="1.0">1.0×</option><option value="1.2">1.2×</option>
              </select>
            </label>
            )}
          </>
        ) : (
          <>
            <div className="sheet-setting">
              <div><strong>Haptic feedback</strong><span>Use subtle feedback on primary actions</span></div>
              <button className={settings.hapticsEnabled ? 'toggle on' : 'toggle'} type="button" role="switch" aria-checked={settings.hapticsEnabled} aria-label="Haptic feedback" onClick={() => onChange({ hapticsEnabled: !settings.hapticsEnabled })}><span /></button>
            </div>
            <div className="sheet-setting">
              <div><strong>Compact transcript</strong><span>Show only the two newest messages in Text mode</span></div>
              <button className={settings.compactTranscript ? 'toggle on' : 'toggle'} type="button" role="switch" aria-checked={settings.compactTranscript} aria-label="Compact transcript" onClick={() => onChange({ compactTranscript: !settings.compactTranscript })}><span /></button>
            </div>
            <div className="sheet-setting">
              <div><strong>Reduce motion</strong><span>Minimize animations and transitions</span></div>
              <button className={settings.reducedMotion ? 'toggle on' : 'toggle'} type="button" role="switch" aria-checked={settings.reducedMotion} aria-label="Reduce motion" onClick={() => onChange({ reducedMotion: !settings.reducedMotion })}><span /></button>
            </div>
          </>
        )}
        <button className="sheet-done" type="button" onClick={onClose}>Done</button>
      </aside>
    </div>
  );
}
