import React from 'react';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from './App';

describe('Argue AI', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    if (vi.isFakeTimers()) vi.runOnlyPendingTimers();
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

  it('sends text and adds a mode-appropriate assistant response', () => {
    render(<App />);
    fireEvent.click(screen.getByRole('tab', { name: 'Text input' }));
    const input = screen.getByRole('textbox', { name: 'Add your argument' });

    fireEvent.change(input, { target: { value: 'Cities should ban private cars.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send argument' }));

    expect(screen.getByText('Cities should ban private cars.')).toBeInTheDocument();
    expect(screen.queryByText('Voice status: thinking')).not.toBeInTheDocument();

    act(() => vi.advanceTimersByTime(1100));

    expect(screen.getByText(/That claim may be too broad/)).toBeInTheDocument();
    expect(screen.queryByText('Voice status: speaking')).not.toBeInTheDocument();
  });

  it('completes the mock voice flow with user and assistant messages', () => {
    render(<App />);

    fireEvent.click(screen.getAllByRole('button', { name: 'Start voice session' })[0]);
    expect(screen.getByText('Voice status: listening')).toBeInTheDocument();

    act(() => vi.advanceTimersByTime(1700));
    expect(screen.queryByText('AI will replace most creative jobs within five years.')).not.toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Conversation transcript' })).not.toBeInTheDocument();
    expect(screen.getByText('Voice status: thinking')).toBeInTheDocument();

    act(() => vi.advanceTimersByTime(1300));
    expect(screen.queryByText(/That claim may be too broad/)).not.toBeInTheDocument();
    expect(screen.getByText('Voice status: speaking')).toBeInTheDocument();

    act(() => vi.advanceTimersByTime(1700));
    fireEvent.click(screen.getByRole('tab', { name: 'Text input' }));
    expect(screen.getByText('AI will replace most creative jobs within five years.')).toBeInTheDocument();
    expect(screen.getByText(/That claim may be too broad/)).toBeInTheDocument();
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
