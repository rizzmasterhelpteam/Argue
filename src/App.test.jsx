import React from 'react';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from './App';

class TestMediaRecorder {
  static isTypeSupported() {
    return true;
  }

  constructor() {
    this.state = 'inactive';
    this.mimeType = 'audio/webm';
  }

  start() {
    this.state = 'recording';
  }

  stop() {
    this.state = 'inactive';
    this.ondataavailable?.({ data: new Blob(['voice sample'], { type: this.mimeType }) });
    this.onstop?.();
  }
}

const flushPromises = async () => {
  for (let index = 0; index < 8; index += 1) await Promise.resolve();
};

describe('Argue AI', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal('MediaRecorder', TestMediaRecorder);
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: { getUserMedia: vi.fn(async () => ({ getTracks: () => [{ stop: vi.fn() }] })) },
    });
    vi.stubGlobal('fetch', vi.fn(async (path, options = {}) => {
      if (path === '/api/transcribe') return { ok: true, json: async () => ({ transcript: 'AI will replace most creative jobs within five years.' }) };
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

    expect(screen.getByText('Shape your next big idea.')).toBeInTheDocument();
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
    expect(screen.getByText('Remote work makes people more productive and happier.')).toBeInTheDocument();
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

  it('records voice, transcribes with Whisper, and sends the transcript to Groq', async () => {
    render(<App />);

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Start voice session' }));
      await flushPromises();
    });
    expect(screen.getByText('Voice status: listening')).toBeInTheDocument();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Stop voice session' }));
      await flushPromises();
    });

    fireEvent.click(screen.getByRole('tab', { name: 'Text input' }));
    expect(screen.getByText('AI will replace most creative jobs within five years.')).toBeInTheDocument();
    expect(screen.getByText('Groq reasoning response.')).toBeInTheDocument();
    expect(fetch).toHaveBeenCalledWith('/api/transcribe', expect.objectContaining({ method: 'POST' }));
    expect(fetch).toHaveBeenCalledWith('/api/chat', expect.objectContaining({ method: 'POST' }));
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
