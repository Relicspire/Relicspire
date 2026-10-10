import { describe, it, expect, vi } from 'vitest';
const mock = vi.hoisted(() => ({
  apps: [] as Array<{
    canvas: HTMLCanvasElement;
    init: ReturnType<typeof vi.fn>;
    destroy: ReturnType<typeof vi.fn>;
    start: ReturnType<typeof vi.fn>;
    stop: ReturnType<typeof vi.fn>;
    render: ReturnType<typeof vi.fn>;
  }>,
  resolve: null as (() => void) | null,
  reject: null as ((e: Error) => void) | null,
}));
vi.mock('pixi.js', () => ({
  Graphics: class {
    clear() {
      return this;
    }
    rect() {
      return this;
    }
    fill() {
      return this;
    }
    poly() {
      return this;
    }
    stroke() {
      return this;
    }
    circle() {
      return this;
    }
    destroy() {}
  },
  Application: class {
    canvas = document.createElement('canvas');
    screen = { width: 800, height: 400 };
    renderer = {};
    stage = { addChild: vi.fn() };
    ticker = { add: vi.fn() };
    init = vi.fn(
      () =>
        new Promise<void>((resolve, reject) => {
          mock.resolve = resolve;
          mock.reject = reject;
        }),
    );
    destroy = vi.fn();
    start = vi.fn();
    stop = vi.fn();
    render = vi.fn();
    resize = vi.fn();
    constructor() {
      mock.apps.push(this);
    }
  },
}));
import { createExplorationScene } from './scene';
const state = {
  paused: false,
  reducedMotion: false,
  speed: 2,
  enemy: false,
  paths: 3,
  moved: true,
};
describe('PixiJS描画のライフサイクル', () => {
  it('非同期初期化より先に破棄した場合はCanvasを追加せずアプリを解放する', async () => {
    const host = document.createElement('div');
    const scene = createExplorationScene(host, vi.fn());
    const app = mock.apps.at(-1)!;
    scene.destroy();
    mock.resolve!();
    await scene.ready;
    expect(host.childElementCount).toBe(0);
    expect(app.destroy).toHaveBeenCalledTimes(1);
  });
  it('確定移動を演出し、休止・動きを減らす設定でTickerを停止して破棄する', async () => {
    const host = document.createElement('div');
    const scene = createExplorationScene(host, vi.fn());
    scene.update(state);
    mock.resolve!();
    await scene.ready;
    const app = mock.apps.at(-1)!;
    expect(host.firstChild).toBe(app.canvas);
    expect(app.start).toHaveBeenCalled();
    scene.update({ ...state, paused: true });
    expect(app.stop).toHaveBeenCalled();
    app.start.mockClear();
    scene.update({ ...state, reducedMotion: true });
    expect(app.start).not.toHaveBeenCalled();
    scene.destroy();
    expect(app.destroy).toHaveBeenCalledTimes(1);
  });
  it('初期化失敗とWebGLコンテキスト喪失を通知し、喪失後に描画を再開しない', async () => {
    const failure = vi.fn();
    const scene = createExplorationScene(
      document.createElement('div'),
      failure,
    );
    mock.reject!(new Error('WebGL unavailable'));
    await scene.ready;
    expect(failure).toHaveBeenCalledTimes(1);
    const lost = vi.fn();
    const second = createExplorationScene(document.createElement('div'), lost);
    mock.resolve!();
    await second.ready;
    const app = mock.apps.at(-1)!;
    app.canvas.dispatchEvent(
      new Event('webglcontextlost', { cancelable: true }),
    );
    expect(lost).toHaveBeenCalledTimes(1);
    app.start.mockClear();
    second.update(state);
    expect(app.start).not.toHaveBeenCalled();
    second.destroy();
  });
});
