import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowUp,
  CaretRight,
  ChatCircleDots,
  Check,
  Clock,
  Copy,
  DotsThree,
  GearSix,
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
  TextT,
  UserCircle,
  Waveform,
  X,
} from '@phosphor-icons/react';

const SETTINGS_KEY = 'argue-ai-settings';

const defaultSettings = {
  autoPlayVoice: true,
  selectedVoice: 'Nova',
  speakingSpeed: '1.0',
  hapticsEnabled: true,
  compactTranscript: false,
  reducedMotion: false,
};

const initialMessages = [
  {
    id: 'm1',
    role: 'user',
    time: '9:41 AM',
    text: 'Remote work makes people more productive and happier.',
  },
  {
    id: 'm2',
    role: 'assistant',
    time: '9:41 AM',
    text: 'While remote work offers flexibility, it can also lead to isolation, weaker collaboration, and blurred work-life boundaries.',
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

const voicePrompts = {
  Argue: 'AI will replace most creative jobs within five years.',
  Brainstorm: 'I want to build a study app for busy students.',
};

const voiceButtonLabels = {
  listening: 'LISTEN',
  transcribing: 'PROCESS',
  thinking: 'THINK',
  speaking: 'SPEAK',
};

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

function loadSettings() {
  try {
    const saved = window.localStorage.getItem(SETTINGS_KEY);
    return saved ? { ...defaultSettings, ...JSON.parse(saved) } : defaultSettings;
  } catch {
    return defaultSettings;
  }
}

export function App() {
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
  const conversationTimers = useRef(new Set());
  const copyTimer = useRef(null);
  const playbackTimer = useRef(null);
  const noticeTimer = useRef(null);
  const settingsTrigger = useRef(null);

  const clearConversationTimers = useCallback(() => {
    conversationTimers.current.forEach((timer) => window.clearTimeout(timer));
    conversationTimers.current.clear();
  }, []);

  const schedule = useCallback((callback, delay) => {
    const timer = window.setTimeout(() => {
      conversationTimers.current.delete(timer);
      callback();
    }, delay);
    conversationTimers.current.add(timer);
    return timer;
  }, []);

  const showNotice = useCallback((message) => {
    if (noticeTimer.current) window.clearTimeout(noticeTimer.current);
    setNotice(message);
    noticeTimer.current = window.setTimeout(() => setNotice(''), 2600);
  }, []);

  const haptic = useCallback(() => {
    if (settings.hapticsEnabled && navigator.vibrate) navigator.vibrate(10);
  }, [settings.hapticsEnabled]);

  useEffect(() => {
    try {
      window.localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
    } catch {
      // The app remains usable when browser storage is unavailable.
    }
  }, [settings]);

  useEffect(() => () => {
    clearConversationTimers();
    if (copyTimer.current) window.clearTimeout(copyTimer.current);
    if (playbackTimer.current) window.clearTimeout(playbackTimer.current);
    if (noticeTimer.current) window.clearTimeout(noticeTimer.current);
  }, [clearConversationTimers]);

  const stopConversation = useCallback((announce = true) => {
    clearConversationTimers();
    setVoiceState('idle');
    if (announce) showNotice('Voice session stopped.');
  }, [clearConversationTimers, showNotice]);

  const simulateVoice = () => {
    if (voiceState !== 'idle') {
      haptic();
      stopConversation();
      return;
    }

    haptic();
    const sessionMode = mode;
    const spokenText = voicePrompts[sessionMode];
    setVoiceState('listening');

    schedule(() => setVoiceState('transcribing'), 800);
    schedule(() => {
      setMessages((current) => [
        ...current,
        { id: createId('voice-user'), role: 'user', time: getCurrentTime(), text: spokenText },
      ]);
      setVoiceState('thinking');
    }, 1600);
    schedule(() => {
      setMessages((current) => [
        ...current,
        {
          id: createId('voice-ai'),
          role: 'assistant',
          time: getCurrentTime(),
          text: createAssistantResponse(sessionMode, spokenText),
        },
      ]);
      if (settings.autoPlayVoice) {
        setVoiceState('speaking');
        schedule(() => setVoiceState('idle'), 1600);
      } else {
        setVoiceState('idle');
      }
    }, 2900);
  };

  const sendDraft = (event) => {
    event?.preventDefault();
    const value = draft.trim();
    if (!value || voiceState !== 'idle') return;

    haptic();
    const sessionMode = mode;
    setMessages((current) => [
      ...current,
      { id: createId('text-user'), role: 'user', time: getCurrentTime(), text: value },
    ]);
    setDraft('');
    setVoiceState('thinking');

    schedule(() => {
      setMessages((current) => [
        ...current,
        {
          id: createId('text-ai'),
          role: 'assistant',
          time: getCurrentTime(),
          text: createAssistantResponse(sessionMode, value),
        },
      ]);
      if (inputMode === 'voice' && settings.autoPlayVoice) {
        setVoiceState('speaking');
        schedule(() => setVoiceState('idle'), 1500);
      } else {
        setVoiceState('idle');
      }
    }, 1000);
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
    if (playbackTimer.current) window.clearTimeout(playbackTimer.current);

    if (playingMessageId === message.id) {
      setPlayingMessageId(null);
      showNotice('Playback paused.');
      return;
    }

    setPlayingMessageId(message.id);
    playbackTimer.current = window.setTimeout(() => setPlayingMessageId(null), 2200);
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
    if (playbackTimer.current) window.clearTimeout(playbackTimer.current);
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
    <main className={settings.reducedMotion ? 'app-stage reduced-motion' : 'app-stage'}>
      <section className="device-frame" aria-label="Argue AI mobile prototype">
        <div className="device-screen">
          <div className="status-bar" aria-hidden="true">
            <span>9:41</span>
            <div className="status-icons">
              <span className="signal"><i /><i /><i /><i /></span>
              <span className="wifi" />
              <span className="battery"><span /></span>
            </div>
          </div>

          <div className="app-content">
            {activeNav === 'Argue' && (
              <HomeScreen
                mode={mode}
                setMode={setMode}
                inputMode={inputMode}
                setInputMode={setInputMode}
                voiceState={voiceState}
                simulateVoice={simulateVoice}
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
  );
}

function HomeScreen({ mode, setMode, inputMode, setInputMode, voiceState, simulateVoice, messages, messageLimit, draft, setDraft, sendDraft, copyMessage, copiedId, playingMessageId, replayMessage, openSettings }) {
  const activeState = voiceState === 'transcribing' ? 'thinking' : voiceState;
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

      <p className="tagline">{mode === 'Argue' ? 'Defend your opinion.' : 'Shape your next big idea.'}</p>

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
          <button className="voice-orbit" type="button" onClick={simulateVoice} aria-label={isBusy ? 'Stop voice session' : 'Start voice session'}>
            <img className="orbit-art" src="/assets/argue-orbit.png" alt="" />
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
                <option>Nova</option><option>Ember</option><option>Atlas</option>
              </select>
            </label>
            <label className="sheet-setting">
              <div><strong>Speaking speed</strong><span>Control response playback speed</span></div>
              <select className="setting-select" value={settings.speakingSpeed} onChange={(event) => onChange({ speakingSpeed: event.target.value })} aria-label="Speaking speed">
                <option value="0.8">0.8×</option><option value="1.0">1.0×</option><option value="1.2">1.2×</option>
              </select>
            </label>
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
