/**
 * Google Analytics game events. The gtag snippet is injected into
 * index.html by vite.config.ts for production builds only, so in dev
 * `window.gtag` is undefined and these calls do nothing.
 */
type Gtag = (command: 'event', name: string, params?: Record<string, unknown>) => void;

function send(name: string, params: Record<string, unknown>): void {
    const gtag = (window as unknown as { gtag?: Gtag }).gtag;
    if (typeof gtag !== 'function') return;
    try { gtag('event', name, params); } catch { /* analytics must never break the game */ }
}

export const Analytics = {
    gameStart(playerCount: number, difficulty: number): void {
        send('game_start', { player_count: playerCount, difficulty });
    },
    waveReached(wave: number): void {
        send('wave_reached', { wave });
    },
    gameOver(scores: number[], wave: number, playerCount: number): void {
        send('game_over', { score: Math.max(0, ...scores), wave, player_count: playerCount });
    },
};
