import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { App } from '@/app/App';

describe('アプリの起動', () => {
  it('タイトルと開発中の案内を表示する', () => {
    render(<App />);
    expect(
      screen.getByRole('heading', { name: 'Relicspire', level: 1 }),
    ).toBeVisible();
    expect(screen.getByText('開発中')).toBeVisible();
  });
});
