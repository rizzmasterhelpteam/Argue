import React from 'react';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from './App';

class TestWebSocket {
  static instances = [];
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSED = 3;

  constructor(url) {
    this.url = url;
    this.readyState = TestWebSocket.CONNECTING;
    this.sent = [];
    this.onopen = null;
    this.onmessage = null;
    this.onerror = null;
    this.onclose = null;
    TestWebSocket.instances.push(this);
    Promise.resolve().then(() => this.open());
  }

  open() {
    if (this.readyState !== TestWebSocket.CONNECTING) return;
    this.readyState = TestWebSocket.OPEN;
    this.onopen?.();
  }

  send(message) {
    this.sent.push(JSON.parse(message));
  }

  emit(message) {
    this.onmessage?.({ data: JSON.stringify(message) });
  }

  close(code = 1000, reason = 'closed') {
    if (this.readyState === TestWebSocket.CLOSED) return;
    this.readyState = TestWebSocket.CLOSED;
    this.onclose?.({ code, reason });
  }
}

class TestAudioContext {
  static instances = [];
  static sources = [];

  constructor() {
    this.state = 'running';
    this.sampleRate = 48000;
    this.currentTime = 0;
    this.destination = {};
    this.resume = vi.fn(() => Promise.resolve());
    TestAudioContext.instances.push(this);
  }

  createMediaStreamSource() {
    return { connect: vi.fn(), disconnect: vi.fn() };
  }

  createScriptProcessor() {
    return { onaudioprocess: null, connect: vi.fn(), disconnect: vi.fn() };
  }

  createGain() {
    return { gain: { value: 1 }, connect: vi.fn(), disconnect: vi.fn() };
  }

  createBuffer(_channels, length, sampleRate) {
    const channel = new Float32Array(length);
    return {
      duration: length / sampleRate,
      copyToChannel: vi.fn((samples) => channel.set(samples)),
      getChannelData: () => channel,
    };
  }

  createBufferSource() {
    const source = { buffer: null, connect: vi.fn(), disconnect: vi.fn(), start: vi.fn(), stop: vi.fn(), onended: null };
    TestAudioContext.sources.push(source);
    return source;
  }

  resume() {
    return Promise.resolve();
  }

  close() {
    this.state = 'closed';
    return Promise.resolve();
  }
}

const flushPromises = async () => {
  for (let index = 0; index < 8; index += 1) await Promise.resolve();
};

const getLiveTokenCalls = () => fetch.mock.calls.filter(([path]) => path === '/api/live/token');

describe('Argue AI', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    TestWebSocket.instances = [];
    TestAudioContext.instances = [];
    TestAudioContext.sources = [];
    vi.stubGlobal('WebSocket', TestWebSocket);
    vi.stubGlobal('AudioContext', TestAudioContext);
    vi.stubGlobal('speechSynthesis', { speak: vi.fn(), cancel: vi.fn(), getVoices: vi.fn(() => []) });
    vi.stubGlobal('SpeechSynthesisUtterance', class {
      constructor(text) {
        this.text = text;
        this.rate = 1;
        this.onend = null;
        this.onerror = null;
      }
    });
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: { getUserMedia: vi.fn(async () => ({ getTracks: () => [{ kind: 'audio', readyState: 'live', stop: vi.fn() }] })) },
    });
    vi.stubGlobal('fetch', vi.fn(async (path, options = {}) => {
      if (path === '/api/live/token') return { ok: true, json: async () => ({ token: 'ephemeral-test-token', model: 'gemini-3.1-flash-live-preview', voice: 'Kore' }) };
      const body = JSON.parse(options.body);
      return { ok: true, json: async () => ({ reply: body.mode === 'Brainstorm' ? 'Groq brainstorm response.' : 'Groq reasoning response.' }) };
    }));
  });

  afterEach(() => {
    if (vi.isFakeTimers()) vi.runOnlyPendingTimers();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('switches between Argue and Brainstorm modes', () => {
    render(<App />);

    fireEvent.click(screen.getByRole('tab', { name: 'Brainstorm' }));

    expect(screen.getByText('Build the idea.')).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Brainstorm' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByText('BRAINSTORM')).toBeInTheDocument();
  });

  it('switches between voice and text input modes', () => {
    render(<App />);

    expect(screen.getByRole('tab', { name: 'Voice input' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('region', { name: 'Voice conversation control' })).toBeInTheDocument();
    expect(screen.queryByRole('textbox', { name: 'Add your argument' })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('tab', { name: 'Text input' }));

    expect(screen.getByRole('tab', { name: 'Text input' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('textbox', { name: 'Add your argument' })).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Voice conversation control' })).not.toBeInTheDocument();
  });

  it('hides the scrollable transcript in voice mode and restores it in text mode', () => {
    render(<App />);

    expect(screen.queryByRole('region', { name: 'Conversation transcript' })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('tab', { name: 'Text input' }));

    expect(screen.getByRole('region', { name: 'Conversation transcript' })).toBeInTheDocument();
    expect(screen.getByText('Remote work makes people more productive.')).toBeInTheDocument();
  });

  it('sends text to Groq and adds the returned assistant response', async () => {
    render(<App />);
    fireEvent.click(screen.getByRole('tab', { name: 'Text input' }));
    const input = screen.getByRole('textbox', { name: 'Add your argument' });

    fireEvent.change(input, { target: { value: 'Cities should ban private cars.' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Send argument' }));
      await flushPromises();
    });

    expect(screen.getByText('Cities should ban private cars.')).toBeInTheDocument();
    expect(screen.getByText('Groq reasoning response.')).toBeInTheDocument();
    expect(fetch).toHaveBeenCalledWith('/api/chat', expect.objectContaining({ method: 'POST' }));
  });

  it('connects voice to Gemini Live and streams live turns', async () => {
    render(<App />);

    expect(document.querySelector('.signal-wave-backdrop[data-state="idle"]')).not.toBeNull();
    expect(document.querySelectorAll('.signal-wave').length).toBe(5);

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Start voice session' }));
      await flushPromises();
    });

    const socket = TestWebSocket.instances.at(-1);
    expect(socket.url).toContain('google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContentConstrained');
    expect(socket.sent[0].setup.model).toBe('models/gemini-3.1-flash-live-preview');
    expect(socket.sent[0].setup.generationConfig.responseModalities).toEqual(['AUDIO']);
    expect(socket.sent).toHaveLength(1);

    await act(async () => {
      socket.emit({ setupComplete: {} });
      await flushPromises();
    });
    expect(screen.getByText('Voice status: listening')).toBeInTheDocument();

    await act(async () => {
      socket.emit({ serverContent: { inputTranscription: { text: 'AI will replace most creative jobs within five years.' } } });
      socket.emit({ serverContent: { outputTranscription: { text: 'That claim needs evidence.' }, turnComplete: true } });
      await flushPromises();
    });

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Stop voice session' }));
      await flushPromises();
    });
    fireEvent.click(screen.getByRole('tab', { name: 'Text input' }));
    expect(screen.getByText('AI will replace most creative jobs within five years.')).toBeInTheDocument();
    expect(screen.getByText('That claim needs evidence.')).toBeInTheDocument();
    expect(fetch).toHaveBeenCalledWith('/api/live/token', expect.objectContaining({ method: 'POST' }));
    expect(fetch).not.toHaveBeenCalledWith('/api/transcribe', expect.anything());
    expect(fetch).not.toHaveBeenCalledWith('/api/tts', expect.anything());
  });

  it('switches to Roast mode from the three-way mode control', () => {
    render(<App />);

    fireEvent.click(screen.getByRole('tab', { name: 'Roast' }));

    expect(screen.getByRole('tab', { name: 'Roast' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByText('Bring the take. Take the heat.')).toBeInTheDocument();
  });

  it('groups the text transcript and composer into the responsive workspace', () => {
    render(<App />);

    fireEvent.click(screen.getByRole('tab', { name: 'Text input' }));

    const workspace = document.querySelector('.text-workspace');
    expect(workspace).not.toBeNull();
    expect(workspace.querySelector('.transcript-panel')).not.toBeNull();
    expect(workspace.querySelector('.argument-input')).not.toBeNull();
  });

  it('ignores a duplicate voice click while the first token request is in flight', async () => {
    render(<App />);

    const startButton = screen.getByRole('button', { name: 'Start voice session' });
    fireEvent.click(startButton);
    fireEvent.click(startButton);
    await act(async () => {
      await flushPromises();
    });

    expect(getLiveTokenCalls()).toHaveLength(1);
  });

  it('keeps the output context alive when Gemini interrupts playback', async () => {
    render(<App />);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Start voice session' }));
      await flushPromises();
    });
    const socket = TestWebSocket.instances.at(-1);
    await act(async () => {
      socket.emit({ setupComplete: {} });
      await flushPromises();
    });

    const audioData = btoa('\u0000\u0000\u0000\u0000');
    await act(async () => {
      socket.emit({ serverContent: { outputTranscription: { text: 'A short reply.' }, modelTurn: { parts: [{ inlineData: { data: audioData, mimeType: 'audio/pcm;rate=24000' } }] } } });
      await flushPromises();
    });
    const outputContext = TestAudioContext.instances[0];
    const source = TestAudioContext.sources.at(-1);
    expect(source.start).toHaveBeenCalled();

    await act(async () => {
      socket.emit({ serverContent: { interrupted: true } });
      await flushPromises();
    });
    expect(outputContext.state).toBe('running');
    expect(source.stop).toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Stop voice session' }));
    expect(outputContext.state).toBe('closed');
  });

  it('preserves Gemini audio and exposes Play response when autoplay is disabled', async () => {
    render(<App />);
    fireEvent.click(screen.getByRole('button', { name: 'Open voice settings' }));
    fireEvent.click(screen.getByRole('switch', { name: 'Automatic voice playback' }));
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Start voice session' }));
      await flushPromises();
    });
    const socket = TestWebSocket.instances.at(-1);
    await act(async () => {
      socket.emit({ setupComplete: {} });
      await flushPromises();
      socket.emit({ serverContent: { outputTranscription: { text: 'Saved reply.' }, modelTurn: { parts: [{ inlineData: { data: btoa('\u0000\u0000\u0000\u0000'), mimeType: 'audio/pcm;rate=24000' } }] }, turnComplete: true } });
      await flushPromises();
    });

    expect(screen.getByRole('button', { name: 'Play response' })).toBeInTheDocument();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Play response' }));
      await flushPromises();
    });
    expect(TestAudioContext.sources.at(-1).start).toHaveBeenCalled();
  });

  it('reports a connected microphone with no usable speech', async () => {
    render(<App />);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Start voice session' }));
      await flushPromises();
    });
    const socket = TestWebSocket.instances.at(-1);
    await act(async () => {
      socket.emit({ setupComplete: {} });
      await flushPromises();
      vi.advanceTimersByTime(3100);
      await flushPromises();
    });

    expect(screen.getAllByText('Your microphone is connected, but no audio is being received.').length).toBeGreaterThanOrEqual(1);
  });

  it('closes the mic, socket, and audio contexts when leaving the voice screen', async () => {
    const trackStop = vi.fn();
    navigator.mediaDevices.getUserMedia.mockResolvedValueOnce({ getTracks: () => [{ stop: trackStop }] });
    render(<App />);

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Start voice session' }));
      await flushPromises();
    });
    const socket = TestWebSocket.instances.at(-1);
    await act(async () => {
      socket.emit({ setupComplete: {} });
      await flushPromises();
    });

    fireEvent.click(screen.getByRole('button', { name: 'History' }));

    expect(trackStop).toHaveBeenCalled();
    expect(socket.readyState).toBe(TestWebSocket.CLOSED);
    expect(TestAudioContext.instances.every((context) => context.state === 'closed')).toBe(true);
  });

  it('keeps the live voice session open while Gemini handles pauses automatically', async () => {
    render(<App />);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Start voice session' }));
      await flushPromises();
    });

    const socket = TestWebSocket.instances.at(-1);
    await act(async () => {
      socket.emit({ setupComplete: {} });
      await flushPromises();
    });

    await act(async () => {
      vi.advanceTimersByTime(2400);
      await flushPromises();
    });

    expect(screen.getByText('Voice status: listening')).toBeInTheDocument();
    expect(socket.readyState).toBe(TestWebSocket.OPEN);
    expect(socket.sent[0].setup.realtimeInputConfig.automaticActivityDetection.disabled).toBe(false);
  });

  it('cancels an active voice session when leaving the Argue screen', () => {
    render(<App />);

    fireEvent.click(screen.getAllByRole('button', { name: 'Start voice session' })[0]);
    fireEvent.click(screen.getByRole('button', { name: 'History' }));
    act(() => vi.advanceTimersByTime(4000));

    const navigation = screen.getByRole('navigation', { name: 'Primary navigation' });
    fireEvent.click(within(navigation).getByRole('button', { name: 'Argue' }));

    expect(screen.getByText('Voice status: idle')).toBeInTheDocument();
    expect(screen.queryByText('AI will replace most creative jobs within five years.')).not.toBeInTheDocument();
  });

  it('filters and searches conversation history', () => {
    render(<App />);
    fireEvent.click(screen.getByRole('button', { name: 'History' }));

    fireEvent.change(screen.getByRole('textbox', { name: 'Search conversations' }), { target: { value: 'fitness' } });
    expect(screen.getByText('AI Fitness App Idea')).toBeInTheDocument();
    expect(screen.queryByText('Is Remote Work Better?')).not.toBeInTheDocument();

    const filters = screen.getByRole('group', { name: 'Filter conversations' });
    fireEvent.click(within(filters).getByRole('button', { name: 'Argue' }));
    expect(screen.getByText('No conversations match that search.')).toBeInTheDocument();
  });

  it('keeps voice settings after the sheet is closed and reopened', () => {
    render(<App />);

    fireEvent.click(screen.getByRole('button', { name: 'Open voice settings' }));
    const toggle = screen.getByRole('switch', { name: 'Automatic voice playback' });
    expect(toggle).toHaveAttribute('aria-checked', 'true');
    expect(screen.queryByRole('combobox', { name: 'Speaking speed' })).not.toBeInTheDocument();
    fireEvent.click(toggle);
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    act(() => vi.advanceTimersByTime(1));
    fireEvent.click(screen.getByRole('button', { name: 'Open voice settings' }));

    expect(screen.getByRole('switch', { name: 'Automatic voice playback' })).toHaveAttribute('aria-checked', 'false');
  });

  it('opens App preferences and applies the motion setting', () => {
    render(<App />);

    fireEvent.click(screen.getByRole('button', { name: 'Profile' }));
    fireEvent.click(screen.getByRole('button', { name: 'App preferences' }));

    const reducedMotionToggle = screen.getByRole('switch', { name: 'Reduce motion' });
    expect(reducedMotionToggle).toHaveAttribute('aria-checked', 'false');
    fireEvent.click(reducedMotionToggle);

    expect(reducedMotionToggle).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByRole('main')).toHaveClass('reduced-motion');
  });
});
