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
  Sparkle,
  ShieldCheck,
  Target,
  TextT,
  UserCircle,
  Waveform,
  X,
} from '@phosphor-icons/react';
import { apiJson } from './lib/apiClient';
import { supabase } from './lib/supabase';
import { PricingModal } from './components/PricingModal';
import {
  createConversation,
  getMessages,
  listConversations,
  messageForUi,
} from './services/conversationService';

const SETTINGS_KEY = 'argue-ai-settings';
const SETTINGS_VERSION = 2;
const SHOW_DEMO_DATA = import.meta.env.MODE === 'test';
const VOICE_PLAYBACK_RATE = 1.5;
const LIVE_INPUT_SAMPLE_RATE = 16000;
const LIVE_OUTPUT_SAMPLE_RATE = 24000;
const LIVE_API_VERSION = 'v1beta';
const LIVE_SPEECH_RMS_THRESHOLD = 0.02;
const LIVE_TOKEN_TIMEOUT_MS = 8 * 1000;
const LIVE_SOCKET_TIMEOUT_MS = 8 * 1000;
const LIVE_SETUP_TIMEOUT_MS = 8 * 1000;
const LIVE_FIRST_CHUNK_TIMEOUT_MS = 4 * 1000;
const LIVE_NO_AUDIO_TIMEOUT_MS = 3 * 1000;
const LIVE_RESPONSE_TIMEOUT_MS = 15 * 1000;
const VOICE_PHASES = [
  'idle',
  'requesting-permission',
  'requesting-token',
  'opening-socket',
  'sending-setup',
  'waiting-for-setup',
  'starting-microphone',
  'listening',
  'speech-detected',
  'waiting-for-response',
  'receiving-audio',
  'playing',
  'error',
  'stopped',
];

function voiceUiStateForPhase(phase) {
  if (phase === 'error') return 'error';
  if (phase === 'playing') return 'speaking';
  if (phase === 'receiving-audio') return 'generating';
  if (phase === 'speech-detected') return 'listening';
  if (phase === 'listening') return 'listening';
  if (phase === 'idle' || phase === 'stopped') return 'idle';
  return 'thinking';
}

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
  transcribing: 'STOP',
  thinking: 'STOP',
  generating: 'STOP',
  speaking: 'STOP',
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
voiceStatusCopy.idle = 'Tap ARGUE to speak';
voiceStatusCopy.listening = 'Listening - pause to send automatically - tap ARGUE to stop';
voiceStatusCopy.thinking = 'Thinking - tap ARGUE to stop';
voiceStatusCopy.generating = 'Generating the voice response - tap ARGUE to stop';
voiceStatusCopy.speaking = 'Speaking - tap ARGUE to stop';

async function requestLiveToken(mode, signal) {
  voiceDebug('token requested', { mode });
  const data = await apiJson('/api/live/token', {
    method: 'POST',
    body: JSON.stringify({ mode }),
    signal,
  });
  if (!data?.token || !data?.model) throw new Error('Gemini Live returned an invalid session token.');
  voiceDebug('token received', { model: data.model, apiVersion: data.apiVersion || LIVE_API_VERSION });
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

async function createAudioWorkletCapture(context, stream, onSamples) {
  const AudioWorkletNodeClass = window.AudioWorkletNode;
  const audioWorklet = context.audioWorklet;
  const urlApi = window.URL;
  if (
    typeof AudioWorkletNodeClass !== 'function'
    || !audioWorklet?.addModule
    || typeof Blob !== 'function'
    || typeof urlApi?.createObjectURL !== 'function'
  ) return null;

  const moduleUrl = urlApi.createObjectURL(new Blob([`
    class ArgueMicCapture extends AudioWorkletProcessor {
      process(inputs, outputs) {
        const input = inputs[0]?.[0];
        if (input) this.port.postMessage(new Float32Array(input));
        for (const channel of outputs[0] || []) channel.fill(0);
        return true;
      }
    }
    registerProcessor('argue-mic-capture', ArgueMicCapture);
  `], { type: 'application/javascript' }));

  try {
    await audioWorklet.addModule(moduleUrl);
  } catch {
    return null;
  } finally {
    urlApi.revokeObjectURL?.(moduleUrl);
  }

  const source = context.createMediaStreamSource(stream);
  const processor = new AudioWorkletNodeClass(context, 'argue-mic-capture', {
    numberOfInputs: 1,
    numberOfOutputs: 1,
    channelCount: 1,
  });
  const silence = context.createGain();
  silence.gain.value = 0;
  processor.port.onmessage = (event) => {
    const samples = event.data instanceof Float32Array ? event.data : new Float32Array(event.data);
    onSamples(samples);
  };
  source.connect(processor);
  processor.connect(silence);
  silence.connect(context.destination);
  return { source, processor, silence };
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

function getVoiceErrorMessage(error, stage) {
  if (stage === 'requesting-permission' && error?.name === 'NotAllowedError') return 'Microphone permission was denied. Allow microphone access and try again.';
  if (stage === 'requesting-permission' && error?.name === 'NotFoundError') return 'No microphone was found on this device.';
  if (stage === 'requesting-permission' && error?.name === 'NotReadableError') return 'The microphone is busy in another app.';
  if (stage === 'requesting-permission' && error?.name === 'SecurityError') return 'Microphone access requires a secure HTTPS connection.';
  return getPlaybackErrorMessage(error);
}

function voiceDebug(stage, details) {
  const productionDebug = typeof window !== 'undefined'
    && new URLSearchParams(window.location.search).get('voiceDebug') === '1';
  if (!import.meta.env?.DEV && !productionDebug) return;
  const safeDetails = details && typeof details === 'object' ? { ...details } : details || '';
  if (safeDetails && typeof safeDetails === 'object') {
    delete safeDetails.token;
    delete safeDetails.accessToken;
    delete safeDetails.audio;
    delete safeDetails.base64Audio;
    delete safeDetails.transcript;
  }
  console.debug(`[Argue AI voice] ${stage}`, safeDetails);
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
    return 'You are Argue AI in Brainstorm mode: a serious, sharp thinking partner. Reply in one to three short sentences, normally under 90 words. Lead with the strongest insight, then give one meaningful risk or tradeoff and one practical next step. Stay constructive and smart. Skip jokes, headings, filler, repetition, and long explanations. Do not claim to browse or know current facts unless they are provided.';
  }

  if (mode === 'Roast') {
    return 'You are Argue AI in Roast mode: a sharply funny critic. Reply in one to three short sentences, normally under 90 words. Land one specific, clever punchline on the claim\'s biggest flaw, then make the critique clear. Roast the idea, never the person; no slurs, threats, or attacks on identity, appearance, intelligence, mental health, or worth. Skip headings, filler, repetition, and long explanations. Do not invent facts, sources, or current web knowledge.';
  }

  return 'You are Argue AI in Argue mode: a witty, rigorous debate partner. Reply in one to three short sentences, normally under 90 words. Challenge the claim, add one concrete twist or tradeoff, and ask one crisp question only when it moves the debate forward. Use a clever, good-natured joke when it fits, never force humor, mock the user, or target sensitive groups. Skip headings, filler, repetition, and long explanations. Stay fair and intellectually honest. Do not invent sources or claim current web data.';
}

function loadSettings() {
  try {
    const saved = window.localStorage.getItem(SETTINGS_KEY);
    if (!saved) return { ...defaultSettings, settingsVersion: SETTINGS_VERSION };
    const parsed = JSON.parse(saved);
    const selectedVoice = ['Nova', 'Ember'].includes(parsed.selectedVoice) ? parsed.selectedVoice : defaultSettings.selectedVoice;
    return { ...defaultSettings, ...parsed, selectedVoice, speakingSpeed: String(VOICE_PLAYBACK_RATE), settingsVersion: SETTINGS_VERSION };
  } catch {
    return { ...defaultSettings, settingsVersion: SETTINGS_VERSION };
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

function messageFromApi(message) {
  return messageForUi({
    ...message,
    created_at: message.createdAt || message.created_at || new Date().toISOString(),
  });
}

export function App({ user = null, onLogout, onDeleteAccount }) {
  const [showSplash, setShowSplash] = useState(() => import.meta.env.MODE !== 'test');
  const [mode, setMode] = useState('Argue');
  const [inputMode, setInputMode] = useState('voice');
  const [activeNav, setActiveNav] = useState('Argue');
  const [voicePhase, setVoicePhase] = useState('idle');
  const voiceState = voiceUiStateForPhase(voicePhase);
  const [lastVoiceError, setLastVoiceError] = useState('');
  const [hasPendingAudio, setHasPendingAudio] = useState(false);
  const [audioPlaybackBlocked, setAudioPlaybackBlocked] = useState(false);
  const [messages, setMessages] = useState(() => (!user && SHOW_DEMO_DATA ? initialMessages : []));
  const [conversations, setConversations] = useState(() => (!user && SHOW_DEMO_DATA ? historyItems : []));
  const [activeConversationId, setActiveConversationId] = useState(null);
  const [historyLoading, setHistoryLoading] = useState(Boolean(user));
  const [draft, setDraft] = useState('');
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsSection, setSettingsSection] = useState('voice');
  const [settings, setSettings] = useState(loadSettings);
  const [copiedId, setCopiedId] = useState(null);
  const [playingMessageId, setPlayingMessageId] = useState(null);
  const [notice, setNotice] = useState('');
  const [usage, setUsage] = useState(null);
  const [pricingOpen, setPricingOpen] = useState(false);
  const liveSocket = useRef(null);
  const stopLiveSessionRef = useRef(null);
  const liveStream = useRef(null);
  const liveSessionId = useRef(0);
  const liveTokenAbort = useRef(null);
  const liveMicContext = useRef(null);
  const liveMicSource = useRef(null);
  const liveMicProcessor = useRef(null);
  const liveMicSilence = useRef(null);
  const liveStartPromise = useRef(null);
  const liveTimeouts = useRef(new Map());
  const liveAudioMetrics = useRef({ chunksSent: 0, bytesSent: 0, chunksReceived: 0, bytesReceived: 0, rms: 0, speechDetected: false });
  const livePendingAudio = useRef([]);
  const liveOutputContext = useRef(null);
  const liveOutputSources = useRef(new Set());
  const liveOutputNextTime = useRef(0);
  const liveOutputPendingTurn = useRef(false);
  const liveSetupReady = useRef(false);
  const liveInputTranscript = useRef('');
  const liveOutputTranscript = useRef('');
  const liveUserMessageId = useRef(null);
  const liveAssistantMessageId = useRef(null);
  const liveReservationId = useRef(null);
  const liveReservationStartedAt = useRef(0);
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

  const refreshUsage = useCallback(async () => {
    if (!user) return;

    try {
      setUsage(await apiJson('/api/me/usage'));
    } catch {
      // The dashboard is supplemental UI and should not interrupt a conversation.
    }
  }, [user]);

  const refreshConversations = useCallback(async () => {
    if (!user) return;
    setHistoryLoading(true);
    try {
      setConversations(await listConversations());
    } catch (error) {
      showNotice(error.message || 'Conversation history could not be loaded.');
    } finally {
      setHistoryLoading(false);
    }
  }, [showNotice, user]);

  useEffect(() => {
    void refreshConversations();
  }, [refreshConversations]);

  useEffect(() => {
    void refreshUsage();
  }, [refreshUsage]);

  useEffect(() => {
    if (!user || !supabase) return undefined;
    let active = true;
    supabase.from('user_preferences').select('*').eq('user_id', user.id).maybeSingle().then(({ data, error }) => {
      if (!active || error || !data) return;
      setMode(data.default_mode === 'brainstorm' ? 'Brainstorm' : data.default_mode === 'roast' ? 'Roast' : 'Argue');
      setInputMode(data.input_mode === 'text' ? 'text' : 'voice');
      setSettings((current) => ({
        ...current,
        autoPlayVoice: data.autoplay_voice,
        selectedVoice: data.replay_voice || current.selectedVoice,
        hapticsEnabled: data.haptics_enabled,
        compactTranscript: data.compact_transcript,
        reducedMotion: data.reduced_motion,
      }));
    });
    return () => { active = false; };
  }, [user]);

  const ensureActiveConversation = useCallback(async (sessionMode) => {
    if (!user) return 'demo-conversation';
    if (activeConversationId) return activeConversationId;
    const conversation = await createConversation(sessionMode);
    setActiveConversationId(conversation.id);
    setConversations((current) => [conversation, ...current]);
    return conversation.id;
  }, [activeConversationId, user]);

  const haptic = useCallback(() => {
    if (settings.hapticsEnabled && navigator.vibrate) navigator.vibrate(10);
  }, [settings.hapticsEnabled]);

  const clearLiveTimeouts = useCallback(() => {
    for (const timer of liveTimeouts.current.values()) window.clearTimeout(timer);
    liveTimeouts.current.clear();
  }, []);

  const scheduleLiveTimeout = useCallback((name, delay, sessionId, callback) => {
    const existing = liveTimeouts.current.get(name);
    if (existing) window.clearTimeout(existing);
    const timer = window.setTimeout(() => {
      liveTimeouts.current.delete(name);
      if (liveSessionId.current === sessionId) callback();
    }, delay);
    liveTimeouts.current.set(name, timer);
  }, []);

  const clearLiveTimeout = useCallback((name) => {
    const timer = liveTimeouts.current.get(name);
    if (timer) window.clearTimeout(timer);
    liveTimeouts.current.delete(name);
  }, []);

  const showVoiceError = useCallback((error, stage = voicePhase) => {
    const message = getVoiceErrorMessage(error, stage);
    setLastVoiceError(message);
    setVoicePhase('error');
    voiceDebug('error', { phase: stage, message, name: error?.name || 'Error' });
  }, [voicePhase]);

  useEffect(() => {
    if (!VOICE_PHASES.includes(voicePhase)) return;
    voiceDebug('phase', { phase: voicePhase, sessionId: liveSessionId.current });
  }, [voicePhase]);

  const stopSpeechPlayback = useCallback(() => {
    window.speechSynthesis?.cancel?.();
    speechUtterance.current = null;
  }, []);

  const clearLiveAudioQueue = useCallback(() => {
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
  }, []);

  const closeLiveOutputContext = useCallback(() => {
    clearLiveAudioQueue();
    const context = liveOutputContext.current;
    liveOutputContext.current = null;
    if (context && context.state !== 'closed') {
      const closing = context.close?.();
      closing?.catch?.(() => {});
    }
  }, [clearLiveAudioQueue]);

  const stopLiveMicrophone = useCallback(() => {
    const processor = liveMicProcessor.current;
    if (processor) {
      processor.onaudioprocess = null;
      processor.port?.close?.();
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
    const confirmedMessages = [
      { role: 'user', content: liveInputTranscript.current.trim() },
      { role: 'assistant', content: liveOutputTranscript.current.trim() },
    ].filter((message) => message.content);
    for (const message of confirmedMessages) upsertLiveMessage(message.role, message.content);
    if (user && confirmedMessages.length) {
      void ensureActiveConversation(mode)
        .then((conversationId) => Promise.all(confirmedMessages.map((message) => apiJson('/api/messages', {
          method: 'POST',
          body: JSON.stringify({ conversationId, role: message.role, content: message.content }),
        }))))
        .then(() => refreshConversations())
        .catch((error) => showNotice(error.message || 'Voice transcript could not be saved.'));
    }
    liveInputTranscript.current = '';
    liveOutputTranscript.current = '';
    liveUserMessageId.current = null;
    liveAssistantMessageId.current = null;
  }, [ensureActiveConversation, mode, refreshConversations, showNotice, upsertLiveMessage, user]);

  const storeLiveAudio = useCallback((base64Audio, mimeType) => {
    const currentSize = livePendingAudio.current.reduce((total, item) => total + item.base64Audio.length, 0);
    if (currentSize + base64Audio.length > 8 * 1024 * 1024) return;
    livePendingAudio.current.push({ base64Audio, mimeType });
    setHasPendingAudio(true);
  }, []);

  const queueLiveAudio = useCallback(async (base64Audio, mimeType, sessionId, forcePlay = false, fromPending = false) => {
    if (liveSessionId.current !== sessionId || !base64Audio) return;
    if (!fromPending) {
      const estimatedBytes = Math.max(0, Math.floor(base64Audio.length * 0.75));
      liveAudioMetrics.current.chunksReceived += 1;
      liveAudioMetrics.current.bytesReceived += estimatedBytes;
      voiceDebug('audio received', { bytes: estimatedBytes });
    }
    if (!forcePlay && !settings.autoPlayVoice) {
      storeLiveAudio(base64Audio, mimeType);
      voiceDebug('audio queued', { autoplay: false });
      return;
    }
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (typeof AudioContextClass !== 'function') {
      storeLiveAudio(base64Audio, mimeType);
      setAudioPlaybackBlocked(true);
      return;
    }

    let context = liveOutputContext.current;
    if (!context || context.state === 'closed') {
      storeLiveAudio(base64Audio, mimeType);
      setAudioPlaybackBlocked(true);
      return;
    }
    try {
      if (context.state === 'suspended') await context.resume?.();
    } catch {
      // The browser may require a user gesture to resume output audio.
    }
    if (liveSessionId.current !== sessionId) return;
    if (context.state !== 'running') {
      storeLiveAudio(base64Audio, mimeType);
      setAudioPlaybackBlocked(true);
      voiceDebug('output context suspended', { state: context.state });
      return;
    }

    try {
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
          setVoicePhase('listening');
        }
      };
      source.start(startAt);
      setAudioPlaybackBlocked(false);
      voiceDebug('audio queued', { bytes: bytes.byteLength, outputState: context.state });
      setVoicePhase('playing');
    } catch (error) {
      storeLiveAudio(base64Audio, mimeType);
      setAudioPlaybackBlocked(true);
      voiceDebug('audio playback failed', { name: error?.name || 'Error' });
    }
  }, [settings.autoPlayVoice, storeLiveAudio]);

  const playPendingResponse = useCallback(async () => {
    const pending = livePendingAudio.current.splice(0);
    if (!pending.length) return;
    setHasPendingAudio(false);
    setAudioPlaybackBlocked(false);
    const sessionId = liveSessionId.current;
    for (const item of pending) await queueLiveAudio(item.base64Audio, item.mimeType, sessionId, true, true);
  }, [queueLiveAudio]);

  const handleLiveMessage = useCallback((event, sessionId) => {
    if (liveSessionId.current !== sessionId) return;
    clearLiveTimeout('setup');

    let payload;
    try {
      const raw = typeof event.data === 'string' ? event.data : new TextDecoder().decode(event.data);
      payload = JSON.parse(raw);
    } catch {
      return;
    }

    voiceDebug('server message', { type: Object.keys(payload || {})[0] || 'unknown' });
    const serverContent = payload?.serverContent;
    if (!serverContent) {
      if (payload?.goAway) voiceDebug('goAway', { timeLeft: payload.goAway.timeLeft || '' });
      if (payload?.sessionResumptionUpdate) voiceDebug('sessionResumptionUpdate');
      if (payload?.toolCall) voiceDebug('toolCall');
      if (payload?.toolCallCancellation) voiceDebug('toolCallCancellation');
      if (payload?.usageMetadata) voiceDebug('usageMetadata', { totalTokenCount: payload.usageMetadata.totalTokenCount });
      return;
    }
    voiceDebug('response received');

    if (serverContent.interrupted) {
      clearLiveAudioQueue();
      finalizeLiveTurn();
      setVoicePhase('listening');
      return;
    }

    const inputText = serverContent.inputTranscription?.text;
    if (typeof inputText === 'string' && inputText.trim()) {
      clearLiveTimeout('response');
      liveInputTranscript.current += `${inputText} `;
      upsertLiveMessage('user', liveInputTranscript.current);
      setVoicePhase('speech-detected');
      scheduleLiveTimeout('response', LIVE_RESPONSE_TIMEOUT_MS, sessionId, () => {
        stopLiveSessionRef.current?.(false);
        showVoiceError(new Error('Gemini did not respond after your speech.'), 'waiting-for-response');
      });
    }

    const outputText = serverContent.outputTranscription?.text;
    if (typeof outputText === 'string' && outputText.trim()) {
      clearLiveTimeout('response');
      liveOutputTranscript.current += `${outputText} `;
      upsertLiveMessage('assistant', liveOutputTranscript.current);
      setVoicePhase('receiving-audio');
    }

    for (const part of serverContent.modelTurn?.parts || []) {
      const inlineData = part?.inlineData || part?.inline_data;
      if (inlineData?.data) {
        clearLiveTimeout('response');
        void queueLiveAudio(inlineData.data, inlineData.mimeType || inlineData.mime_type, sessionId);
        setVoicePhase('receiving-audio');
      }
      if (!outputText && typeof part?.text === 'string' && part.text.trim()) {
        liveOutputTranscript.current += `${part.text} `;
        upsertLiveMessage('assistant', liveOutputTranscript.current);
        setVoicePhase('receiving-audio');
      }
    }

    if (serverContent.turnComplete || serverContent.generationComplete) {
      voiceDebug('turn complete');
      clearLiveTimeout('response');
      finalizeLiveTurn();
      liveOutputPendingTurn.current = true;
      if (liveOutputSources.current.size === 0) {
        liveOutputPendingTurn.current = false;
        setVoicePhase('listening');
      }
    }
  }, [clearLiveAudioQueue, clearLiveTimeout, finalizeLiveTurn, queueLiveAudio, scheduleLiveTimeout, showVoiceError, upsertLiveMessage]);

  const stopLiveSession = useCallback((announce = true) => {
    liveSessionId.current += 1;
    clearLiveTimeouts();
    liveSetupReady.current = false;
    liveTokenAbort.current?.abort();
    liveTokenAbort.current = null;
    const reservationId = liveReservationId.current;
    const reservationDuration = liveReservationStartedAt.current ? Math.round((Date.now() - liveReservationStartedAt.current) / 1000) : 0;
    liveReservationId.current = null;
    liveReservationStartedAt.current = 0;
    if (user && reservationId) {
      void apiJson('/api/live/release', {
        method: 'POST',
        body: JSON.stringify({ reservationId, durationSeconds: reservationDuration }),
      }).then(() => refreshUsage()).catch(() => {});
    }
    const socket = liveSocket.current;
    liveSocket.current = null;
    if (socket && (socket.readyState === window.WebSocket.OPEN || socket.readyState === window.WebSocket.CONNECTING)) socket.close(1000, 'Session stopped');
    stopLiveMicrophone();
    closeLiveOutputContext();
    livePendingAudio.current = [];
    setHasPendingAudio(false);
    setAudioPlaybackBlocked(false);
    liveInputTranscript.current = '';
    liveOutputTranscript.current = '';
    liveUserMessageId.current = null;
    liveAssistantMessageId.current = null;
    setPlayingMessageId(null);
    setVoicePhase('stopped');
    if (announce) showNotice('Voice session stopped.');
  }, [clearLiveTimeouts, closeLiveOutputContext, refreshUsage, showNotice, stopLiveMicrophone, user]);

  stopLiveSessionRef.current = stopLiveSession;

  const startLiveMicrophone = useCallback(async (stream, socket, sessionId) => {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (typeof AudioContextClass !== 'function') throw new Error('Live audio is not supported in this browser.');
    if (window.isSecureContext === false && !['localhost', '127.0.0.1'].includes(window.location.hostname)) {
      throw new Error('Microphone access requires a secure HTTPS connection.');
    }

    const tracks = stream.getAudioTracks?.() || stream.getTracks?.() || [];
    const track = tracks.find((candidate) => candidate.kind === 'audio' || !candidate.kind);
    if (!track) throw new Error('No microphone track was found.');
    if (track.readyState && track.readyState !== 'live') throw new Error('The microphone track is not live.');

    const context = new AudioContextClass();
    try {
      await context.resume?.();
    } catch {
      context.close?.().catch?.(() => {});
      throw new Error('The microphone audio context could not start.');
    }
    if (context.state !== 'running') {
      context.close?.().catch?.(() => {});
      throw new Error('The microphone audio context is suspended. Try tapping Argue again.');
    }
    voiceDebug('microphone context', { state: context.state, trackState: track.readyState || 'live' });

    let firstChunkLogged = false;
    const sendSamples = (input) => {
      if (liveSessionId.current !== sessionId || socket.readyState !== window.WebSocket.OPEN) return;
      if (!input?.length) return;
      let energy = 0;
      for (let index = 0; index < input.length; index += 1) energy += input[index] * input[index];
      const rms = Math.sqrt(energy / input.length);
      liveAudioMetrics.current.rms = rms;
      if (rms >= LIVE_SPEECH_RMS_THRESHOLD) {
        if (!liveAudioMetrics.current.speechDetected) {
          liveAudioMetrics.current.speechDetected = true;
          clearLiveTimeout('no-audio');
          setVoicePhase('speech-detected');
          voiceDebug('microphone level', { rms: Number(rms.toFixed(4)), trackState: track.readyState || 'live' });
        }
      }
      const pcm = downsampleToPcm16(input, context.sampleRate || LIVE_INPUT_SAMPLE_RATE);
      if (!pcm.length) return;
      try {
        const encoded = arrayBufferToBase64(pcm.buffer);
        socket.send(JSON.stringify({
          realtimeInput: {
            audio: {
              data: encoded,
              mimeType: `audio/pcm;rate=${LIVE_INPUT_SAMPLE_RATE}`,
            },
          },
        }));
        liveAudioMetrics.current.chunksSent += 1;
        liveAudioMetrics.current.bytesSent += pcm.byteLength;
        clearLiveTimeout('first-chunk');
      } catch (error) {
        voiceDebug('audio chunk failed', { name: error?.name || 'Error' });
      }
      if (!firstChunkLogged) {
        firstChunkLogged = true;
        voiceDebug('audio chunk sent', { sampleRate: LIVE_INPUT_SAMPLE_RATE, bytes: pcm.byteLength });
      }
    };

    let capture = null;
    try {
      capture = await createAudioWorkletCapture(context, stream, sendSamples);
    } catch {
      capture = null;
    }

    if (!capture) {
      if (typeof AudioContextClass.prototype?.createScriptProcessor !== 'function') {
        context.close?.().catch?.(() => {});
        throw new Error('Live microphone capture is not supported in this browser.');
      }
      const source = context.createMediaStreamSource(stream);
      const processor = context.createScriptProcessor(4096, 1, 1);
      const silence = context.createGain();
      silence.gain.value = 0;
      processor.onaudioprocess = (event) => sendSamples(event.inputBuffer.getChannelData(0));
      source.connect(processor);
      processor.connect(silence);
      silence.connect(context.destination);
      capture = { source, processor, silence };
    }

    if (liveSessionId.current !== sessionId || socket.readyState !== window.WebSocket.OPEN) {
      capture.processor.port?.close?.();
      capture.processor.disconnect?.();
      capture.source.disconnect?.();
      capture.silence.disconnect?.();
      context.close?.().catch?.(() => {});
      return;
    }

    context.resume?.().catch?.(() => {});
    liveMicContext.current = context;
    liveMicSource.current = capture.source;
    liveMicProcessor.current = capture.processor;
    liveMicSilence.current = capture.silence;
    scheduleLiveTimeout('first-chunk', LIVE_FIRST_CHUNK_TIMEOUT_MS, sessionId, () => {
      stopLiveSession(false);
      showVoiceError(new Error('The microphone did not produce audio.'), 'starting-microphone');
    });
    scheduleLiveTimeout('no-audio', LIVE_NO_AUDIO_TIMEOUT_MS, sessionId, () => {
      if (liveAudioMetrics.current.speechDetected) return;
      stopLiveSession(false);
      showVoiceError(new Error('Your microphone is connected, but no audio is being received.'), 'starting-microphone');
    });
    voiceDebug('mic started', { transport: capture.processor.port ? 'audio-worklet' : 'script-processor' });
  }, [clearLiveTimeout, scheduleLiveTimeout, showNotice, showVoiceError, stopLiveSession]);

  useEffect(() => {
    try {
      window.localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
    } catch {
      // The app remains usable when browser storage is unavailable.
    }
    if (!user || !supabase) return;
    const timer = window.setTimeout(() => {
      supabase.from('user_preferences').upsert({
        user_id: user.id,
        default_mode: mode === 'Brainstorm' ? 'brainstorm' : mode === 'Roast' ? 'roast' : 'argue',
        input_mode: inputMode,
        replay_voice: settings.selectedVoice,
        autoplay_voice: settings.autoPlayVoice,
        haptics_enabled: settings.hapticsEnabled,
        compact_transcript: settings.compactTranscript,
        reduced_motion: settings.reducedMotion,
      }, { onConflict: 'user_id' }).then(({ error }) => {
        if (error) voiceDebug('preferences sync failed', { code: error.code });
      });
    }, 300);
    return () => window.clearTimeout(timer);
  }, [inputMode, mode, settings, user]);

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

  useEffect(() => {
    const stopWhenHidden = () => {
      if (document.visibilityState === 'hidden') stopConversation(false);
    };
    const stopBeforePageExit = () => stopConversation(false);
    document.addEventListener('visibilitychange', stopWhenHidden);
    window.addEventListener('pagehide', stopBeforePageExit);
    return () => {
      document.removeEventListener('visibilitychange', stopWhenHidden);
      window.removeEventListener('pagehide', stopBeforePageExit);
    };
  }, [stopConversation]);

  useEffect(() => {
    let active = true;
    const handles = [];
    void Promise.all([import('@capacitor/core'), import('@capacitor/app'), import('@capacitor/network')]).then(async ([core, app, network]) => {
      if (!active || !core.Capacitor.isNativePlatform()) return;
      handles.push(await app.App.addListener('appStateChange', ({ isActive }) => {
        if (!isActive) {
          stopConversation(false);
          setInputMode('text');
        }
      }));
      handles.push(await app.App.addListener('backButton', () => {
        if (!['idle', 'stopped'].includes(voicePhase)) {
          stopConversation(false);
          setInputMode('text');
        }
      }));
      handles.push(await network.Network.addListener('networkStatusChange', ({ connected }) => {
        if (!connected) {
          stopConversation(false);
          showNotice('You are offline. Voice has been stopped safely.');
        }
      }));
    }).catch(() => {});
    return () => {
      active = false;
      handles.forEach((handle) => handle?.remove?.());
    };
  }, [showNotice, stopConversation, voicePhase]);

  const startVoiceSession = async () => {
    if (liveStartPromise.current) return;
    if (liveSocket.current || !['idle', 'stopped', 'error'].includes(voicePhase)) {
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

    try {
      await ensureActiveConversation(mode);
    } catch (error) {
      showNotice(error.message || 'A conversation could not be created.');
      return;
    }

    const startPromise = (async () => {
      const sessionId = liveSessionId.current + 1;
      liveSessionId.current = sessionId;
      liveSetupReady.current = false;
      liveAudioMetrics.current = { chunksSent: 0, bytesSent: 0, chunksReceived: 0, bytesReceived: 0, rms: 0, speechDetected: false };
      livePendingAudio.current = [];
      setHasPendingAudio(false);
      setAudioPlaybackBlocked(false);
      setLastVoiceError('');
      setVoicePhase('requesting-permission');
      const controller = new AbortController();
      liveTokenAbort.current = controller;

      let stream;
      try {
        const outputContext = new AudioContextClass();
        liveOutputContext.current = outputContext;
        try {
          await outputContext.resume?.();
        } catch {
          setAudioPlaybackBlocked(true);
        }
        voiceDebug('output context', { state: outputContext.state });

        setVoicePhase('requesting-permission');
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

        const tracks = stream.getAudioTracks?.() || stream.getTracks?.() || [];
        const track = tracks.find((candidate) => candidate.kind === 'audio' || !candidate.kind);
        if (!track) throw new Error('No microphone was found.');
        if (track.readyState && track.readyState !== 'live') throw new Error('The microphone is not available.');
        track.onended = () => {
          if (liveSessionId.current !== sessionId) return;
          stopLiveSession(false);
          showVoiceError(new Error('The microphone disconnected.'), 'starting-microphone');
        };
        liveStream.current = stream;

        setVoicePhase('requesting-token');
        scheduleLiveTimeout('token', LIVE_TOKEN_TIMEOUT_MS, sessionId, () => {
          controller.abort();
          stopLiveSession(false);
          showVoiceError(new Error('Gemini Live token creation timed out.'), 'requesting-token');
        });
        const token = await requestLiveToken(mode, controller.signal);
        clearLiveTimeout('token');
        if (liveSessionId.current !== sessionId) {
          stream.getTracks().forEach((mediaTrack) => mediaTrack.stop());
          return;
        }
        liveReservationId.current = token.reservationId || null;
        liveReservationStartedAt.current = Date.now();
        scheduleLiveTimeout('max-session', Math.max(1, Number(token.maxSessionSeconds) || 60) * 1000, sessionId, () => {
          stopLiveSession(false);
          showNotice('Your voice session time is up.');
        });

        setVoicePhase('opening-socket');
        const apiVersion = token.apiVersion || LIVE_API_VERSION;
        const socket = new window.WebSocket(`wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.${apiVersion}.GenerativeService.BidiGenerateContentConstrained?access_token=${encodeURIComponent(token.token)}`);
        socket.binaryType = 'arraybuffer';
        liveSocket.current = socket;
        scheduleLiveTimeout('socket', LIVE_SOCKET_TIMEOUT_MS, sessionId, () => {
          stopLiveSession(false);
          showVoiceError(new Error('Gemini Live did not open a connection.'), 'opening-socket');
        });
        socket.onopen = () => {
          if (liveSessionId.current !== sessionId) return;
          try {
            clearLiveTimeout('socket');
            voiceDebug('socket opened');
            setVoicePhase('sending-setup');
            socket.send(JSON.stringify({
              setup: {
                model: `models/${token.model}`,
                generationConfig: {
                  responseModalities: ['AUDIO'],
                  speechConfig: {
                    voiceConfig: { prebuiltVoiceConfig: { voiceName: token.voice || 'Kore' } },
                  },
                  thinkingConfig: { thinkingLevel: 'low' },
                },
                inputAudioTranscription: {},
                outputAudioTranscription: {},
                sessionResumption: {},
                realtimeInputConfig: {
                  automaticActivityDetection: {
                    disabled: false,
                    prefixPaddingMs: 250,
                    silenceDurationMs: 700,
                  },
                },
              },
            }));
            voiceDebug('setup sent', { apiVersion, model: token.model });
            setVoicePhase('waiting-for-setup');
            scheduleLiveTimeout('setup', LIVE_SETUP_TIMEOUT_MS, sessionId, () => {
              stopLiveSession(false);
              showVoiceError(new Error('Gemini Live did not confirm setup.'), 'waiting-for-setup');
            });
          } catch (error) {
            stopLiveSession(false);
            showVoiceError(error, 'sending-setup');
          }
        };
        socket.onmessage = (event) => {
          let payload;
          try {
            const raw = typeof event.data === 'string' ? event.data : new TextDecoder().decode(event.data);
            payload = JSON.parse(raw);
          } catch {
            payload = null;
          }

          if (payload?.setupComplete && liveSessionId.current === sessionId && !liveSetupReady.current) {
            clearLiveTimeout('setup');
            liveSetupReady.current = true;
            setVoicePhase('starting-microphone');
            startLiveMicrophone(stream, socket, sessionId)
              .then(() => {
                if (liveSessionId.current !== sessionId) return;
                voiceDebug('setup complete; microphone started');
                setVoicePhase('listening');
              })
              .catch((error) => {
                if (liveSessionId.current !== sessionId) return;
                stopLiveSession(false);
                showVoiceError(error, 'starting-microphone');
              });
          }

          if (payload?.error && liveSessionId.current === sessionId) {
            const message = payload.error.message || 'Gemini Live rejected the session setup.';
            stopLiveSession(false);
            showVoiceError(new Error(String(message).slice(0, 180)), 'waiting-for-setup');
            return;
          }

          handleLiveMessage(event, sessionId);
        };
        socket.onerror = () => {
          if (liveSessionId.current !== sessionId) return;
          stopLiveSession(false);
          showVoiceError(new Error('Gemini Live connection failed.'), 'opening-socket');
        };
        socket.onclose = (event) => {
          if (liveSessionId.current !== sessionId) return;
          clearLiveTimeouts();
          voiceDebug('socket closed', { code: event.code, reason: String(event.reason || '').slice(0, 120) });
          stopLiveSession(false);
          if (event.code !== 1000) showVoiceError(new Error(`Gemini Live closed (${event.code})${event.reason ? `: ${String(event.reason).slice(0, 100)}` : ''}`), 'socket');
        };
      } catch (error) {
        if (liveSessionId.current !== sessionId) return;
        stopLiveSession(false);
        clearLiveTimeouts();
        if (error?.name !== 'AbortError') showVoiceError(error, error?.stage || voicePhase);
      } finally {
        if (liveTokenAbort.current === controller) liveTokenAbort.current = null;
      }
    })();

    liveStartPromise.current = startPromise;
    try {
      await startPromise;
    } finally {
      if (liveStartPromise.current === startPromise) liveStartPromise.current = null;
    }
  };

  const sendDraft = async (event) => {
    event?.preventDefault();
    const value = draft.trim();
    if (!value || !['idle', 'stopped', 'error'].includes(voicePhase)) return;

    haptic();
    const sessionMode = mode;
    setDraft('');
    setLastVoiceError('');
    setVoicePhase('thinking');

    try {
      const conversationId = await ensureActiveConversation(sessionMode);
      if (!user) {
        const userMessage = { id: createId('text-user'), role: 'user', time: getCurrentTime(), text: value };
        setMessages((current) => [...current, userMessage]);
      }
      const response = await apiJson('/api/chat', {
        method: 'POST',
        body: JSON.stringify({ conversationId, input: value }),
      });
      if (response.userMessage && response.assistantMessage) {
        setMessages((current) => [...current, messageFromApi(response.userMessage), messageFromApi(response.assistantMessage)]);
        await refreshConversations();
      } else {
        setMessages((current) => [...current, { id: createId('text-ai'), role: 'assistant', time: getCurrentTime(), text: response.reply }]);
      }
      await refreshUsage();
    } catch (error) {
      showNotice(error.message);
    } finally {
      setVoicePhase('idle');
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

  const resetVoiceSettings = () => {
    setSettings((current) => ({
      ...current,
      autoPlayVoice: defaultSettings.autoPlayVoice,
      selectedVoice: defaultSettings.selectedVoice,
      speakingSpeed: String(VOICE_PLAYBACK_RATE),
      settingsVersion: SETTINGS_VERSION,
    }));
    showNotice('Voice settings reset.');
  };

  const startCheckout = async (plan) => {
    try {
      const { checkoutUrl } = await apiJson('/api/billing/checkout', {
        method: 'POST',
        body: JSON.stringify({ plan }),
      });
      if (!checkoutUrl) throw new Error('Checkout could not be started.');
      window.location.assign(checkoutUrl);
    } catch (error) {
      showNotice(error.message || 'Checkout could not be started.');
      throw error;
    }
  };

  const openPricing = () => setPricingOpen(true);

  const navigate = (destination) => {
    haptic();
    if (destination !== activeNav && !['idle', 'stopped'].includes(voicePhase)) stopConversation(false);
    stopSpeechPlayback();
    setPlayingMessageId(null);
    if (destination === 'Profile') void refreshUsage();
    setActiveNav(destination);
  };

  const openConversation = async (conversation) => {
    stopConversation(false);
    setMode(conversation.mode);
    setInputMode('text');
    if (user) {
      try {
        setHistoryLoading(true);
        setMessages(await getMessages(conversation.id));
        setActiveConversationId(conversation.id);
      } catch (error) {
        showNotice(error.message || 'That conversation could not be opened.');
      } finally {
        setHistoryLoading(false);
      }
    } else {
      setMessages(conversation.messages || []);
    }
    setActiveNav('Argue');
  };

  const startNewConversation = () => {
    stopConversation(false);
    setMessages([]);
    setActiveConversationId(null);
    setDraft('');
    setActiveNav('Argue');
  };

  return (
    <>
      {showSplash && <SplashScreen />}
      <main aria-hidden={showSplash ? 'true' : undefined} className={settings.reducedMotion ? 'app-stage reduced-motion' : 'app-stage'}>
      <section className="device-frame" aria-label="Argue AI responsive workspace">
        <div className="device-screen">
          <div className="desktop-layout">
            <DesktopSidebar activeNav={activeNav} onNavigate={navigate} onUpgrade={openPricing} />
            <div className="desktop-main">
              <div className="app-content">
                {activeNav === 'Argue' && (
                  <HomeScreen
                    mode={mode}
                    setMode={setMode}
                    inputMode={inputMode}
                    setInputMode={setInputMode}
                    voiceState={voiceState}
                    voicePhase={voicePhase}
                    lastVoiceError={lastVoiceError}
                    hasPendingAudio={hasPendingAudio}
                    audioPlaybackBlocked={audioPlaybackBlocked}
                    playPendingResponse={playPendingResponse}
                    startVoiceSession={startVoiceSession}
                    messages={messages}
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
                    conversations={conversations}
                    loading={historyLoading}
                    onOpenConversation={openConversation}
                    onStartNew={startNewConversation}
                  />
                )}
                {activeNav === 'Profile' && (
                  <ProfileScreen
                    user={user}
                    conversations={conversations}
                    onOpenSettings={openSettings}
                    onAction={showNotice}
                    onUpgrade={openPricing}
                    onLogout={onLogout}
                    onDeleteAccount={onDeleteAccount}
                    usage={usage}
                  />
                )}
              </div>

              <BottomNav activeNav={activeNav} onNavigate={navigate} />
            </div>
          </div>
        </div>
      </section>

      {settingsOpen && (
        <SettingsSheet
          section={settingsSection}
          settings={settings}
          onChange={updateSettings}
          onResetVoiceSettings={resetVoiceSettings}
          onClose={closeSettings}
        />
      )}
      {notice && <div className="app-toast" role="status">{notice}</div>}
      </main>
      {pricingOpen && <PricingModal usage={usage} onClose={() => setPricingOpen(false)} onCheckout={startCheckout} />}
    </>
  );
}

function HomeScreen({ mode, setMode, inputMode, setInputMode, voiceState, voicePhase, lastVoiceError, hasPendingAudio, audioPlaybackBlocked, playPendingResponse, startVoiceSession, messages, draft, setDraft, sendDraft, copyMessage, copiedId, playingMessageId, replayMessage, openSettings }) {
  const activeState = voiceUiStateForPhase(voicePhase);
  const isBusy = !['idle', 'stopped', 'error'].includes(voicePhase);
  const debugEnabled = new URLSearchParams(window.location.search).get('voiceDebug') === '1';
  const transcriptRef = useRef(null);
  const inputRef = useRef(null);
  const visibleMessages = messages;
  const liveMessages = messages.filter((message) => message.id.startsWith('live-')).slice(-2);
  const buttonText = voicePhase === 'error' ? voiceButtonLabels.error : isBusy ? voiceButtonLabels[voiceState] : mode.toUpperCase();
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
      {inputMode === 'voice' && <SignalWaveBackdrop state={activeState} />}
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

      <div className="mode-switcher" role="group" aria-label="Conversation mode">
        <button className={mode === 'Argue' ? 'mode-tab active' : 'mode-tab'} disabled={isBusy} onClick={() => setMode('Argue')} aria-pressed={mode === 'Argue'} type="button">
          <ChatCircleDots size={27} weight="regular" />
          <span>Argue</span>
        </button>
        <button className={mode === 'Brainstorm' ? 'mode-tab active' : 'mode-tab'} disabled={isBusy} onClick={() => setMode('Brainstorm')} aria-pressed={mode === 'Brainstorm'} type="button">
          <Lightbulb size={26} weight="regular" />
          <span>Brainstorm</span>
        </button>
        <button className={mode === 'Roast' ? 'mode-tab active roast-tab' : 'mode-tab roast-tab'} disabled={isBusy} onClick={() => setMode('Roast')} aria-pressed={mode === 'Roast'} type="button">
          <Flame size={26} weight="fill" />
          <span>Roast</span>
        </button>
      </div>

      <p className="tagline">{mode === 'Argue' ? 'Challenge the claim.' : mode === 'Brainstorm' ? 'Strengthen the idea.' : 'Expose the flaw - with humor.'}</p>
      <p className="desktop-subtitle">Argue your point. Defend your ideas. Win the discussion.</p>

      <div className="input-mode-switcher" role="group" aria-label="Input mode">
        <button className={inputMode === 'voice' ? 'input-mode-tab active' : 'input-mode-tab'} disabled={isBusy} onClick={() => setInputMode('voice')} aria-pressed={inputMode === 'voice'} aria-label="Voice input" type="button">
          <Microphone size={17} weight="bold" />
          <span>Voice</span>
        </button>
        <button className={inputMode === 'text' ? 'input-mode-tab active' : 'input-mode-tab'} disabled={isBusy} onClick={() => setInputMode('text')} aria-pressed={inputMode === 'text'} aria-label="Text input" type="button">
          <TextT size={18} weight="bold" />
          <span>Text</span>
        </button>
      </div>

      {inputMode === 'voice' && (
        <section className={isBusy ? 'voice-zone busy' : 'voice-zone'} aria-label="Voice conversation control">
          <button className="voice-orbit" type="button" onClick={startVoiceSession} aria-label={isBusy ? 'Stop voice session' : voicePhase === 'error' ? 'Retry voice session' : 'Start voice session'}>
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
          <p className="voice-caption">{voicePhase === 'error' && lastVoiceError ? lastVoiceError : voiceStatusCopy[voiceState]}</p>
          {voicePhase === 'error' && (
            <div className="voice-error-card" role="alert">
              <strong>Voice session needs attention</strong>
              <div><button type="button" onClick={startVoiceSession}>Retry</button><button type="button" onClick={() => setInputMode('text')}>Continue in text</button></div>
            </div>
          )}
          {(liveMessages.length > 0 || hasPendingAudio || audioPlaybackBlocked) && (
            <div className="live-transcript" aria-label="Live voice transcript">
              {liveMessages.map((message) => <p key={message.id}><strong>{message.role === 'user' ? 'YOU' : 'ARGUE AI'}</strong> {message.text}</p>)}
              {(hasPendingAudio || audioPlaybackBlocked) && (
                <button type="button" className="live-playback-button" onClick={playPendingResponse}>
                  {audioPlaybackBlocked ? 'Tap to enable audio' : 'Play response'}
                </button>
              )}
            </div>
          )}
          {debugEnabled && <div className="voice-debug-panel" aria-label="Voice diagnostics"><strong>{voicePhase}</strong><span>{lastVoiceError || 'No error'}</span><small>Detailed diagnostics are in the browser console.</small></div>}
          <div className="desktop-feature-grid" aria-label="Argue AI benefits">
            <FeatureCard icon={<ShieldCheck size={22} weight="fill" />} title="Defend your point" copy="Build stronger arguments" />
            <FeatureCard icon={<Target size={22} weight="fill" />} title="Win the discussion" copy="Counter with confidence" />
            <FeatureCard icon={<ChartLineUp size={22} weight="fill" />} title="Track your progress" copy="Improve over time" />
          </div>
          <span className="sr-only" role="status">Voice status: {voiceState}</span>
          <span className="sr-only">Voice phase: {voicePhase}</span>
        </section>
      )}

      {inputMode === 'text' && (
        <section className="text-workspace" aria-label="Text conversation">
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
                  <p>{mode === 'Argue' ? 'Pick a claim and make your case.' : mode === 'Brainstorm' ? 'Start with an idea worth improving.' : 'Bring a plan that can take a joke.'}</p>
                  <div className="starter-prompts" aria-label="Starter prompts">
                    {(mode === 'Argue' ? ['Remote work is better for productivity.', 'College is still worth the cost.'] : mode === 'Brainstorm' ? ['Help me improve my app idea.', 'Find a better target audience.'] : ['Roast my startup idea.', 'Find the weakest part of my argument.']).map((prompt) => <button key={prompt} type="button" onClick={() => setDraft(prompt)}>{prompt}</button>)}
                  </div>
                </div>
              )}
            </div>
          </section>

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
        </section>
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

function SignalWaveBackdrop({ state }) {
  const paths = [
    'M0 117 C96 84 174 159 281 121 S460 82 600 120 S827 157 918 120 S1094 80 1200 117',
    'M0 142 C112 107 196 184 312 142 S484 105 600 144 S798 182 892 143 S1091 105 1200 142',
    'M0 95 C127 134 217 61 331 104 S487 150 600 96 S777 59 879 102 S1067 137 1200 96',
    'M0 164 C91 123 188 194 300 161 S481 129 600 165 S812 197 915 160 S1087 126 1200 165',
    'M0 71 C117 110 212 43 326 79 S483 119 600 72 S790 40 900 79 S1089 111 1200 72',
  ];

  return (
    <svg className="signal-wave-backdrop" data-state={state} viewBox="0 0 1200 240" preserveAspectRatio="none" aria-hidden="true" focusable="false">
      <defs>
        <radialGradient id="signal-center-glow" cx="50%" cy="50%" r="50%">
          <stop offset="0%" stopColor="#ff761b" stopOpacity=".34" />
          <stop offset="38%" stopColor="#ff5d00" stopOpacity=".12" />
          <stop offset="100%" stopColor="#ff5d00" stopOpacity="0" />
        </radialGradient>
        <linearGradient id="signal-trail" x1="0%" x2="100%">
          <stop offset="0%" stopColor="#ff6b12" stopOpacity="0" />
          <stop offset="21%" stopColor="#ff7a21" stopOpacity=".28" />
          <stop offset="50%" stopColor="#ffb36b" stopOpacity=".95" />
          <stop offset="79%" stopColor="#ff7a21" stopOpacity=".28" />
          <stop offset="100%" stopColor="#ff6b12" stopOpacity="0" />
        </linearGradient>
        <filter id="signal-soft-glow" x="-20%" y="-80%" width="140%" height="260%">
          <feGaussianBlur stdDeviation="3" result="blur" />
          <feMerge><feMergeNode in="blur" /><feMergeNode in="SourceGraphic" /></feMerge>
        </filter>
      </defs>
      <ellipse className="signal-center-glow" cx="600" cy="120" rx="278" ry="104" fill="url(#signal-center-glow)" />
      <g className="signal-wave-trails" fill="none" stroke="url(#signal-trail)" strokeLinecap="round">
        {paths.map((d, index) => <path className={`signal-wave signal-wave-${index + 1}`} d={d} key={d} />)}
      </g>
      <g className="signal-wave-shimmer" fill="none" strokeLinecap="round">
        {paths.slice(0, 3).map((d, index) => <path d={d} key={d} className={`signal-shimmer signal-shimmer-${index + 1}`} />)}
      </g>
    </svg>
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

function DesktopSidebar({ activeNav, onNavigate, onUpgrade }) {
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
          <button type="button" onClick={onUpgrade}>Upgrade</button>
        </div>
      </div>
    </aside>
  );
}

function HistoryScreen({ conversations, loading, onOpenConversation, onStartNew }) {
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
        {['All', 'Argue', 'Brainstorm', 'Roast'].map((option) => (
          <button key={option} type="button" className={filter === option ? 'filter-pill active' : 'filter-pill'} aria-pressed={filter === option} onClick={() => setFilter(option)}>{option}</button>
        ))}
      </div>
      <div className={compact ? 'history-list compact' : 'history-list'}>
        {loading ? <div className="history-empty">Loading conversations...</div> : filteredConversations.length ? filteredConversations.map((item) => (
          <button className="history-item" type="button" key={item.id || item.title} onClick={() => onOpenConversation(item)}>
            <div className={`history-icon history-icon-${item.mode.toLowerCase()}`} aria-hidden="true">{item.mode === 'Argue' ? <ChatCircleDots size={20} /> : item.mode === 'Brainstorm' ? <Lightbulb size={20} /> : <Flame size={20} weight="fill" />}</div>
            <div className="history-copy">
              <div className="history-title"><strong>{item.title}</strong><time>{item.date}</time></div>
              <p>{item.preview}</p>
              <small><span className={`history-mode history-mode-${item.mode.toLowerCase()}`}>{item.mode}</span>{item.count} messages</small>
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

function ProfileScreen({ user, conversations, onOpenSettings, onAction, onUpgrade, onLogout, onDeleteAccount, usage }) {
  const currentPlan = usage?.plan || 'free';
  const modeCounts = conversations.reduce((counts, conversation) => ({
    ...counts,
    [conversation.mode]: (counts[conversation.mode] || 0) + 1,
  }), {});
  const displayName = user?.user_metadata?.full_name || user?.email?.split('@')[0] || 'Guest account';
  const accountLabel = user?.email || 'Sign in to save your conversations';

  return (
    <div className="secondary-screen profile-screen">
      <header className="secondary-header">
        <div><span className="eyebrow">YOUR SPACE</span><h1>Profile</h1></div>
        <button className="icon-button" type="button" aria-label="Open app preferences" onClick={() => onOpenSettings('app')}><GearSix size={22} /></button>
      </header>
      <section className="profile-card profile-hero">
        <div className="profile-avatar" aria-hidden="true"><UserCircle size={49} weight="fill" /></div>
        <div><strong>{displayName}</strong><span>{accountLabel}</span></div>
      </section>
      <section className="profile-metrics" aria-label="Conversation statistics">
        <div><strong>{conversations.length}</strong><span>Conversations</span></div>
        <div><strong>{modeCounts.Argue || 0}</strong><span>Arguments</span></div>
        <div><strong>{modeCounts.Roast || 0}</strong><span>Roasts</span></div>
      </section>
      {usage && <section className="usage-dashboard" aria-label="Plan usage">
        <article className="membership-card">
          <span className="usage-kicker">Your membership</span>
          <strong>{usage.plan}</strong>
          <span className="membership-status"><Check size={14} weight="bold" /> {usage.status}</span>
        </article>
        <article className="capacity-card">
          <span className="usage-kicker">Capacity usage</span>
          <UsageBar label="Text replies" used={usage.textRepliesUsed} limit={usage.textRepliesLimit} />
          <UsageBar label="Voice allowance" used={Math.ceil(usage.voiceSecondsUsed / 60)} limit={Math.ceil(usage.voiceSecondsLimit / 60)} suffix=" min" />
          <UsageBar label="Voice session length" used={usage.maxVoiceSessionSeconds} limit={usage.maxVoiceSessionSeconds} suffix=" sec" />
          <small>Resets {new Date(usage.billingPeriodEnd).toLocaleDateString()}</small>
        </article>
      </section>}
      {currentPlan !== 'pro' && <section className="billing-actions" aria-label="Upgrade plan">
        <div><span className="usage-kicker">Membership</span><strong>Choose the plan that fits your pace.</strong></div>
        <button type="button" className="billing-pro-button" onClick={onUpgrade}>View plans</button>
      </section>}
      <section className="profile-section" aria-label="Settings">
        <span className="profile-section-label">SETTINGS</span>
        <div className="settings-list">
        <button type="button" onClick={() => onOpenSettings('voice')}><Waveform size={21} /><span>Voice settings</span><CaretRight size={17} /></button>
        <button type="button" onClick={() => onOpenSettings('app')}><GearSix size={21} /><span>App preferences</span><CaretRight size={17} /></button>
        </div>
      </section>
      {user ? (
        <div className="profile-auth-actions">
          <button className="guest-cta" type="button" onClick={() => onLogout?.().catch((error) => onAction(error.message))}>Log out</button>
          <DeleteAccountButton onDeleteAccount={onDeleteAccount} onAction={onAction} />
        </div>
      ) : <button className="guest-cta" type="button" onClick={() => onAction('Sign in is required in production.')}>Create an account <ArrowUp size={18} /></button>}
    </div>
  );
}

function UsageBar({ label, used, limit, suffix = '' }) {
  const safeLimit = Math.max(1, Number(limit) || 1);
  const safeUsed = Math.max(0, Number(used) || 0);
  const percent = Math.min(100, (safeUsed / safeLimit) * 100);
  return <div className="capacity-row"><div><span>{label}</span><strong>{safeUsed}{suffix} / {safeLimit}{suffix}</strong></div><span className="capacity-track" aria-label={`${label}: ${safeUsed} of ${safeLimit}`}><span style={{ width: `${percent}%` }} /></span></div>;
}

function DeleteAccountButton({ onDeleteAccount, onAction }) {
  const [open, setOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const confirmDelete = async () => {
    setDeleting(true);
    try { await onDeleteAccount?.(); } catch (error) { onAction(error.message || 'Account deletion failed.'); setDeleting(false); return; }
    setOpen(false);
  };
  return <><button className="account-delete" type="button" onClick={() => setOpen(true)}>Delete account</button>{open && <div className="delete-dialog-backdrop" role="presentation"><section className="delete-dialog" role="alertdialog" aria-modal="true" aria-labelledby="delete-account-title"><h2 id="delete-account-title">Delete account?</h2><p>This permanently deletes your Argue AI account and saved conversations. This cannot be undone.</p><div><button type="button" onClick={() => setOpen(false)} disabled={deleting}>Cancel</button><button type="button" className="account-delete" onClick={confirmDelete} disabled={deleting}>{deleting ? 'Deleting...' : 'Delete account'}</button></div></section></div>}</>;
}

function SettingsSheet({ section, settings, onChange, onResetVoiceSettings, onClose }) {
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
              <div><strong>Browser replay voice</strong><span>SpeechSynthesis replay only</span></div>
              <select className="setting-select" value={settings.selectedVoice} onChange={(event) => onChange({ selectedVoice: event.target.value })} aria-label="AI voice">
                <option>Nova</option><option>Ember</option>
              </select>
            </label>
            <div className="sheet-setting">
              <div><strong>Gemini Live voice</strong><span>Controlled by the server environment</span></div>
              <span className="setting-value">Server configured</span>
            </div>
            <button className="sheet-reset" type="button" onClick={onResetVoiceSettings}>Reset voice settings</button>
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
