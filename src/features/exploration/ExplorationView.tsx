import { useEffect, useRef, useState } from 'react';
import { createExplorationScene } from './scene';

export function ExplorationView({
  location,
  enemy,
  paths,
  paused,
  reducedMotion,
  speed,
}: {
  location: string;
  enemy: boolean;
  paths: number;
  paused: boolean;
  reducedMotion: boolean;
  speed: number;
}) {
  const host = useRef<HTMLDivElement>(null);
  const scene = useRef<ReturnType<typeof createExplorationScene> | null>(null);
  const previous = useRef(location);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    const instance = createExplorationScene(host.current!, () =>
      setFailed(true),
    );
    scene.current = instance;
    return () => {
      instance.destroy();
      scene.current = null;
    };
  }, []);
  useEffect(() => {
    scene.current?.update({
      enemy,
      paths,
      paused,
      reducedMotion,
      speed,
      moved: previous.current !== location,
    });
    previous.current = location;
  }, [enemy, paths, paused, reducedMotion, speed, location]);
  return (
    <>
      <div
        className="exploration-canvas"
        ref={host}
        role="img"
        aria-label={
          enemy
            ? '迷宮の通路。前方に敵がいる。'
            : '迷宮の通路と次の部屋への道。'
        }
        hidden={failed}
      />
      {failed && (
        <p role="alert">
          迷宮の描画を開始または継続できません。Canvas・WebGL対応のブラウザで再読み込みしてください。現在地は保存済みです。下の経路ボタンで探索を続けられます。
        </p>
      )}
    </>
  );
}
