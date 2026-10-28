import * as PIXI from 'pixi.js';
import { GameConfig } from './config';
import { playerProjectiles, enemyProjectiles, enemies, humansAndProgs, obstacles, player, demoPlayer, app, effectsContainer } from './main';
import { UI } from './ui';
import { SoundManager } from './soundManager';
import { Effects } from './effects';
import { Enemies } from './enemies';
import { Humans } from './humans';
import { Obstacles } from './obstacles';
import { gameState } from './gameState';
import { gameEvents } from './core/EventSystem';
import { Vector2 } from './utils/Vector2';
import { ArcadeBorder } from './core/ArcadeBorder';
import { getWaveDef } from './waveTable';
import { WavePacing } from './core/WavePacing';
import { TwoPlayer } from './core/TwoPlayer';
import { isEntityGone, spriteHalfExtents } from './gameObject';
import { SpawnPlacement, SpawnPoint } from './core/SpawnPlacement';
import { electrodeLook } from './core/ElectrodeShapes';
import { ScorePopup } from './core/ScorePopup';
import { WaveTransition } from './core/WaveTransition';
import { Operator } from './core/OperatorSettings';
import { DeathBeat } from './core/DeathBeat';
import { Analytics } from './core/Analytics';

// --- High Score ---
export function loadHighScore() {
    if (!GameConfig) return; // GameConfig might not be ready during initial script parse order
    const savedScore = localStorage.getItem('robotronHighScore');
    if (savedScore !== null) {
        gameState.highScore = parseInt(savedScore, 10);
    } else {
        gameState.highScore = 0;
    }
    gameState.nextExtraLifeScore = Operator.get().extraManEvery;
}

export function saveHighScore() {
    localStorage.setItem('robotronHighScore', String(gameState.highScore));
}

// --- Game State Management ---
export function resetGameVariables() {
    if (!GameConfig) { console.warn("resetGameVariables: GameConfig not found."); return; }

    gameState.score = 0;
    // operator TURNS PER PLAYER / EXTRA MAN EVERY (factory: 3 men, 25000)
    gameState.lives = Operator.get().turnsPerPlayer;
    gameState.wave = 0;
    gameState.currentHumanRescueBonus = GameConfig.INITIAL_HUMAN_RESCUE_BONUS;
    gameState.humanRescueBonusDecayTimer = 0;
    gameState.nextExtraLifeScore = Operator.get().extraManEvery;
    gameState.playerInvulnerableTime = 0;

    clearEntities(true); // Clear all entities on screen including humans for game reset

    if (UI && UI.updateScoreDisplay) UI.updateScoreDisplay();
    if (UI && UI.updateBonusDisplay) UI.updateBonusDisplay();
    // UI.updateUI() will also be called by main loop or state change handler
}

export function clearEntities(clearHumans: boolean = false, keepPlayer: boolean = false) {
    // Player projectiles
    if (playerProjectiles) {
        playerProjectiles.forEach(p => { if (p.sprite && !p._destroyed) p.sprite.destroy(); });
        playerProjectiles.length = 0;
    }
    // Enemy projectiles
    if (enemyProjectiles) {
        enemyProjectiles.forEach(p => { if (p.sprite && !p._destroyed) p.sprite.destroy(); });
        enemyProjectiles.length = 0;
    }
    // Enemies
    if (enemies) {
        enemies.forEach(e => { if (e.sprite && !e._destroyed) e.sprite.destroy(); });
        enemies.length = 0;
    }
    // Humans and Progs - only clear if explicitly requested (for game reset)
    if (clearHumans && humansAndProgs) {
        humansAndProgs.forEach(h => { if (!h._destroyed) h.destroy(); });   // Prog.destroy clears its trail
        humansAndProgs.length = 0;
    }
    // Obstacles
    if (obstacles) {
        obstacles.forEach(o => { if (o.sprite && !o.sprite._destroyed) o.sprite.destroy(); });
        obstacles.length = 0;
    }
    Obstacles.clearDyingElectrodes();
    // Effects
    if (effectsContainer) { // Effects container directly holds children sprites
        // Iterate backwards safely
        for (let i = effectsContainer.children.length - 1; i >= 0; i--) {
            const child = effectsContainer.children[i];
            if (child && (child as any).destroy) (child as any).destroy();
        }
        // PIXI might also have effectsContainer.removeChildren(0, effectsContainer.children.length);
        effectsContainer.removeChildren();
    }

    // Player sprite (if exists and managed by player)
    // createPlayer in Player.js handles its own sprite, but main.js might nullify player
    if (player && !player._destroyed && !keepPlayer) {
        player.sprite.destroy();
        // player = null; // main.js should manage nullifying player
    }
    // Demo player sprite
    if (demoPlayer && demoPlayer.sprite && !demoPlayer._destroyed) {
        demoPlayer.sprite.destroy();
        // demoPlayer = null; // main.js/attractMode.js should manage this
    }
}

// --- Core Gameplay Logic ---
export function playerHit() {
    if (!player || !player.isAlive || gameState.playerInvulnerableTime > 0) return;
    if (!GameConfig || !SoundManager || !Effects || !UI) {
        console.warn("playerHit: Missing critical dependencies."); return;
    }

    // Emit player hit event for visual effects system
    gameEvents.emit({
        type: 'player:hit',
        timestamp: Date.now(),
        source: 'gameLogic',
        data: {
            position: new Vector2(player.sprite.x, player.sprite.y),
            livesRemaining: gameState.lives - 1
        }
    });

    // ROM death ($70EF): no explosion. Everything freezes while the man
    // flashes and fades (core/DeathBeat.ts); then the man is taken and the
    // wave is re-laid from what is left and beamed back in.
    SoundManager.play('playerDeath');
    gameState.lives--;
    player.isAlive = false;
    player.dx = 0; player.dy = 0;
    WavePacing.onPlayerDeath(Math.max(0, gameState.lives - 1));
    gameState.currentHumanRescueBonus = GameConfig.INITIAL_HUMAN_RESCUE_BONUS;
    gameState.humanRescueBonusDecayTimer = 0;
    if(UI.updateBonusDisplay) UI.updateBonusDisplay();

    const outcome = TwoPlayer.onDeath();
    if (outcome === 'game_over') {
        gameState.currentGameState = 'GAME_OVER';
        Analytics.gameOver(TwoPlayer.scores(), gameState.wave, TwoPlayer.isTwoPlayer() ? 2 : 1);
        if (UI && UI.showGameOverScreen) UI.showGameOverScreen();   // plays the death beat itself
        if (UI && UI.updateUI) UI.updateUI();
        return;
    }
    gameState.currentGameState = 'WAVE_TRANSITION';   // freezes the playfield
    const deadPlayer = player;
    DeathBeat.play(player.sprite as PIXI.Sprite, () => {
        if (outcome === 'swap') swapAfterDeath();
        else relayWave();
    }, () => gameState.currentGameState === 'WAVE_TRANSITION' && player === deadPlayer);
    if (UI && UI.updateUI) UI.updateUI();
}

/** 2P alternating: hand control to the other player after the PLAYER N interstitial. */
function swapAfterDeath(): void {
    if (!player || isEntityGone(player)) return;
    gameState.currentGameState = 'PLAYING';
    player.sprite.visible = false;
    TwoPlayer.showInterstitial(app.stage).then(() => {
        if (gameState.currentGameState === 'GAME_OVER') return;
        // If the wave ended during the interstitial, the wave-transition
        // timer starts the next wave — but the player must still be
        // restored, or they stay invisible and unhittable (ghost).
        if (gameState.currentGameState === 'PLAYING') startNextWave();
        if (player && !isEntityGone(player)) {
            player.sprite.x = GameConfig.GAME_WIDTH / 2;
            player.sprite.y = GameConfig.GAME_HEIGHT / 2;
            player.dx = 0;
            player.dy = 0;
            player.sprite.visible = true;
            player.isAlive = true;
        }
        gameState.playerInvulnerableTime = GameConfig.RESPAWN_INVULNERABILITY_TIME;
        if (UI && UI.updateUI) UI.updateUI();
    });
}

/**
 * After a death the ROM re-lays the wave from its live counts ($7101/$9E76
 * wave_spawn with $BE68-$BE70): the surviving grunts, electrodes, family,
 * hulks, brains, spheroids and quarks get fresh spawn positions and beam in
 * again; enforcers, tanks, progs and all shots are gone.
 */
function relayWave(): void {
    const alive = (t: string) => enemies.filter(e => !isEntityGone(e) && e.type === t).length;
    const humans = (t: string) => humansAndProgs.filter((h: any) => !isEntityGone(h) && h.type === 'human' && !h.isRescued && h.humanType === t).length;
    const counts: WaveCounts = {
        grunts: alive('grunt'), hulks: alive('hulk'), spheroids: alive('spheroid'), brains: alive('brain'),
        quarks: alive('quark'), electrodes: obstacles.filter(o => !isEntityGone(o) && o.type === 'electrode').length,
        mommies: humans('WOMAN'), daddies: humans('MAN'), mikeys: humans('CHILD'),
    };
    clearEntities(true, true);
    layWave(counts);
    if (player && !isEntityGone(player)) player.sprite.visible = false;
    WaveTransition.materialize(() => {
        if (gameState.currentGameState === 'WAVE_TRANSITION') gameState.currentGameState = 'PLAYING';
    });
}

export function isColliding(spriteA: PIXI.Sprite | PIXI.Graphics | PIXI.Container, spriteB: PIXI.Sprite | PIXI.Graphics | PIXI.Container, tolerance = 5) {
    if (!spriteA || !spriteB || (spriteA as any)._destroyed || (spriteB as any)._destroyed || !spriteA.visible || !spriteB.visible) return false;
    
    try {
        // Safely access sprite properties with additional error handling
        let centerAX, centerAY, centerBX, centerBY;
        
        try {
            centerAX = spriteA.x;
            centerAY = spriteA.y;
        } catch (error) {
            return false; // spriteA properties are inaccessible
        }
        
        try {
            centerBX = spriteB.x;
            centerBY = spriteB.y;
        } catch (error) {
            return false; // spriteB properties are inaccessible
        }
        
        // Check if position properties are valid numbers
        if (typeof centerAX !== 'number' || typeof centerAY !== 'number' || 
            typeof centerBX !== 'number' || typeof centerBY !== 'number' ||
            centerAX === null || centerAY === null || 
            centerBX === null || centerBY === null ||
            isNaN(centerAX) || isNaN(centerAY) || isNaN(centerBX) || isNaN(centerBY)) {
            return false;
        }
        
        const distance = Math.sqrt(
            Math.pow(centerAX - centerBX, 2) + Math.pow(centerAY - centerBY, 2)
        );
        
        // Use simple distance-based collision for now
        return distance <= tolerance;
        
    } catch (error) {
        // If any error occurs accessing sprite properties, return false
        console.warn('Collision detection error:', error);
        return false;
    }
}

export function startNextWave() {
    if (!GameConfig || !SoundManager || !Enemies || !Humans || !Obstacles) {
         console.warn("startNextWave: Missing critical dependencies."); return;
    }
    gameState.wave++;
    console.log(`Starting Wave: ${gameState.wave}`);
    if (gameState.currentGameState !== 'DEMO_PLAY') Analytics.waveReached(gameState.wave);
    ArcadeBorder.setWave(gameState.wave);
    gameState.currentHumanRescueBonus = GameConfig.INITIAL_HUMAN_RESCUE_BONUS;
    gameState.humanRescueBonusDecayTimer = 0;
    if (UI && UI.updateBonusDisplay) UI.updateBonusDisplay();
    if (UI && UI.updateScoreDisplay) UI.updateScoreDisplay();   // wave label shows the new wave as it beams in

    // Clear existing non-player entities for the new wave (optional, depends on desired behavior)
    // Obstacles are typically per-wave. Enemies and projectiles are definitely per-wave.
    // Let's clear obstacles, specific projectiles, and enemies. Humans might persist or be reset.
    // The original code cleared obstacles.
    if (obstacles) {
        obstacles.forEach(o => { if (o.sprite && !o._destroyed) o.sprite.destroy(); });
        obstacles.length = 0;
    }
    Obstacles.clearDyingElectrodes();
    // Enemy projectiles clear (player projectiles might be kept briefly or cleared too)
    if (enemyProjectiles) {
        enemyProjectiles.forEach(p => { if (!isEntityGone(p)) p.sprite.destroy(); });
        enemyProjectiles.length = 0;
    }

    // Arcade behavior: every wave spawns its own enemies from the wave
    // table. Survivors (hulks — the only enemies left at wave end) must not
    // carry over, or they pile up wave after wave and wall off the arena.
    if (enemies) {
        enemies.forEach(e => { if (!isEntityGone(e)) e.sprite.destroy(); });
        enemies.length = 0;
    }

    // Arcade behavior: unrescued humans do not carry over — each wave
    // spawns a fresh family.
    if (humansAndProgs) {
        humansAndProgs.forEach(h => { if (!isEntityGone(h)) (h as any).destroy?.(); });
        humansAndProgs.length = 0;
    }
     // if (enemyProjectilesContainer) enemyProjectilesContainer.removeChildren(); // Removed as enemyProjectilesContainer is not imported


    // Reset player position (if player exists)
    if (player && !isEntityGone(player)) {
        player.sprite.x = GameConfig.GAME_WIDTH / 2;
        player.sprite.y = GameConfig.GAME_HEIGHT / 2;
        player.dx = 0;
        player.dy = 0;
    }

    // Arcade wave composition: the ROM's count tables (js/waveTable.ts).
    const def = getWaveDef(gameState.wave);
    WavePacing.beginWave(gameState.wave, Math.max(0, gameState.lives - 1));
    layWave(def);

    if (player) player.isAlive = true;
    gameState.playerInvulnerableTime = GameConfig.RESPAWN_INVULNERABILITY_TIME;
}

type WaveCounts = Pick<ReturnType<typeof getWaveDef>, 'grunts' | 'hulks' | 'spheroids' | 'brains' | 'quarks' | 'electrodes' | 'mommies' | 'daddies' | 'mikeys'>;

/**
 * Lay out a wave's electrodes, enemies and family at ROM spawn positions
 * (core/SpawnPlacement.ts), with the player in the centre.
 */
function layWave(def: WaveCounts): void {
    if (player && !isEntityGone(player)) {
        player.sprite.x = GameConfig.GAME_WIDTH / 2;
        player.sprite.y = GameConfig.GAME_HEIGHT / 2;
        player.dx = 0;
        player.dy = 0;
    }
    const numGrunts = def.grunts, numHulks = def.hulks, numSpheroids = def.spheroids;
    const numBrains = def.brains, numQuarks = def.quarks;
    const numElectrodes = def.electrodes;
    // Tanks are not wave-spawned in the arcade: quarks drop them.

    // ROM spawn positions (core/SpawnPlacement.ts): most things stay out of a
    // per-wave box around the player's start; brains, spheroids and quarks
    // start near the edges; humans go anywhere.
    const place = (e: any, p: SpawnPoint) => {
        if (!e) return;
        e.sprite.x = e.position.x = e.previousPosition.x = p.x;
        e.sprite.y = e.position.y = e.previousPosition.y = p.y;
    };
    const size = (e: any) => ({ w: e.sprite.width || 8, h: e.sprite.height || 8 });
    const rest = electrodeLook(gameState.wave).frames[0].rows;
    for (let i = 0; i < numElectrodes; i++) {
        const p = SpawnPlacement.electrode(gameState.wave, rest[0].length, rest.length);
        Obstacles.createElectrode(p.x, p.y, 8, 8);
    }
    // grunts also skip spots that overlap something already placed ($DE0F)
    const overlaps = (self: any, p: SpawnPoint, w: number, h: number) =>
        [...obstacles, ...enemies].some((o: any) => {
            if (o === self || isEntityGone(o)) return false;
            const { hw, hh } = spriteHalfExtents(o.sprite);
            return Math.abs(o.sprite.x - p.x) < hw + w / 2 && Math.abs(o.sprite.y - p.y) < hh + h / 2;
        });
    for (let i = 0; i < numGrunts; i++) {
        const g = Enemies.createGrunt(0, 0); if (!g) continue;
        const { w, h } = size(g);
        place(g, SpawnPlacement.outsideBox(gameState.wave, w, h, p => overlaps(g, p, w, h)));
    }
    for (let i = 0; i < numHulks; i++) {
        const e = Enemies.createHulk(0, 0); if (!e) continue;
        const { w, h } = size(e); place(e, SpawnPlacement.outsideBox(gameState.wave, w, h));
    }
    for (let i = 0; i < numSpheroids; i++) {
        const e = Enemies.createSpheroid(0, 0); if (!e) continue;
        const { w, h } = size(e); place(e, SpawnPlacement.spheroid(w, h));
    }
    for (let i = 0; i < numBrains; i++) {
        const e = Enemies.createBrain(0, 0); if (!e) continue;
        const { w, h } = size(e); place(e, SpawnPlacement.brain(w, h));
    }
    for (let i = 0; i < numQuarks; i++) {
        const e = Enemies.createQuark(0, 0); if (!e) continue;
        const { w, h } = size(e); place(e, SpawnPlacement.quark(w, h));
    }

    // The ROM spawns each family member type in its own count ($42B2):
    // mommies = WOMAN, daddies = MAN, mikeys = CHILD.
    const family: [string, number][] = [['WOMAN', def.mommies], ['MAN', def.daddies], ['CHILD', def.mikeys]];
    for (const [type, n] of family) {
        for (let i = 0; i < n; i++) {
            const hm = Humans.createHuman(0, 0, type); if (!hm) continue;
            const { w, h } = size(hm); place(hm, SpawnPlacement.anywhere(w, h));
        }
    }
    if (player) player.isAlive = true;
    gameState.playerInvulnerableTime = GameConfig.RESPAWN_INVULNERABILITY_TIME;
}

export function checkWaveCompletion() {
    if (gameState.currentGameState !== 'PLAYING' || !enemies) return;

    const activeEnemies = enemies.filter(e => !e.indestructible && e.sprite && !(e.sprite as any)._destroyed && e.type !== 'hulk');
    if (activeEnemies.length === 0) {
        console.log("Wave Complete!");
        gameState.currentGameState = 'WAVE_TRANSITION';

        // Emit wave completed event for visual effects system
        gameEvents.emit({
            type: 'wave:completed',
            timestamp: Date.now(),
            source: 'gameLogic',
            data: {
                wave: gameState.wave,
                score: gameState.score,
                centerPosition: new Vector2(GameConfig.GAME_WIDTH / 2, GameConfig.GAME_HEIGHT / 2)
            }
        });

        // Arcade wave-clear sequence: wipe, ring zoom, then beam the next
        // wave in; play resumes when the player has materialized.
        WaveTransition.start(
            () => clearEntities(true, true),
            () => startNextWave(),
            () => {
                if (gameState.currentGameState === 'WAVE_TRANSITION') gameState.currentGameState = 'PLAYING';
            });
    }
}

/** Award points: score display, extra-man check, and the ROM's score_update counter ($F0) for grunt pacing. */
function addScore(points: number): void {
    gameState.score += points;
    if (UI && UI.updateScoreDisplay) UI.updateScoreDisplay();
    checkForExtraLife();
    WavePacing.noteScore();
}

export function checkForExtraLife() {
    if (gameState.currentGameState !== 'PLAYING' || !GameConfig || !SoundManager) return;
    const every = Operator.get().extraManEvery;
    if (every <= 0) return;   // operator setting: NO EXTRA MEN
    if (gameState.score >= gameState.nextExtraLifeScore) {
        gameState.lives++;
        gameState.nextExtraLifeScore += every;
        console.log(`Extra life awarded! Lives: ${gameState.lives}. Next at: ${gameState.nextExtraLifeScore}`);
        SoundManager.play('extraLife');
        if (UI && UI.updateUI) UI.updateUI();
    }
}

export function updateBonusDecay(_delta: number) {
    // Arcade behavior: the progressive rescue bonus (1000..5000) never decays
    // over time — it resets only on player death and at wave start.
}

// --- Collision Detection ---
export function checkCollisions() {
    if (typeof gameState.currentGameState === 'undefined' || (gameState.currentGameState !== 'PLAYING' && gameState.currentGameState !== 'DEMO_PLAY')) {
        return;
    }
    if (!GameConfig || !SoundManager || !Effects || !UI ||
        !playerProjectiles || !enemyProjectiles || !enemies || !humansAndProgs || !obstacles) {
        // console.warn("checkCollisions: Missing critical dependencies.");
        return;
    }

    const currentPlayer = gameState.currentGameState === 'DEMO_PLAY' ? demoPlayer : player;
    if (isEntityGone(currentPlayer)) {
         // If no current player (e.g. during GAME_OVER transition or if demo player dies), skip player-related collisions
    }

    // Player Projectile vs Enemy
    for (let i = playerProjectiles.length - 1; i >= 0; i--) {
        const p = playerProjectiles[i];
        if (isEntityGone(p)) continue;

        for (let j = enemies.length - 1; j >= 0; j--) {
            const enemy = enemies[j];
            if (isEntityGone(enemy)) continue;

            // Arcade hulk behavior: bullets don't kill it, they nudge it
            // ~1px along the bullet's direction of travel.
            if (enemy.indestructible) {
                if (enemy.type === 'hulk' && isColliding(p.sprite, enemy.sprite, 6)) {
                    const pdx = (p as any).dx ?? 0;
                    const pdy = (p as any).dy ?? 0;
                    const mag = Math.hypot(pdx, pdy) || 1;
                    enemy.position.x += (pdx / mag) * 2;
                    enemy.position.y += (pdy / mag) * 2;
                    enemy.sprite.x = enemy.position.x;
                    enemy.sprite.y = enemy.position.y;
                    if (p.sprite && !(p.sprite as any)._destroyed) (p.sprite as any).destroy();
                    playerProjectiles.splice(i, 1);
                    break;
                }
                continue;
            }

            if (isColliding(p.sprite, enemy.sprite, 5)) {
                if (p.sprite && !(p.sprite as any)._destroyed) (p.sprite as any).destroy();
                playerProjectiles.splice(i, 1);

                enemy.health--;
                if (enemy.health <= 0) {
                    let explosionColor = 0xFF0000;
                    let soundToPlayKey = 'gruntPop'; // Default, actual sound keys are in SoundManager

                    if (enemy.type === 'spheroid') { explosionColor = 0xFF8800; soundToPlayKey = 'spheroidPop'; }
                    else if (enemy.type === 'enforcer') { explosionColor = 0x00AAFF; soundToPlayKey = 'enforcerPop'; }
                    else if (enemy.type === 'brain') { explosionColor = 0xFF88FF; soundToPlayKey = 'brainPop'; }
                    else if (enemy.type === 'tank') { explosionColor = 0xAAAAAA; soundToPlayKey = 'tankPop'; }
                    else if (enemy.type === 'quark') { explosionColor = 0xF0F0F0; soundToPlayKey = 'quarkPop'; }
                    else if (enemy.type === 'prog_enemy') { explosionColor = 0xFF55FF; soundToPlayKey = 'progDestroy';}

                    // Emit enemy destroyed event for visual effects system
                    gameEvents.emit({
                        type: 'enemy:destroyed',
                        timestamp: Date.now(),
                        source: 'gameLogic',
                        data: {
                            position: new Vector2(enemy.sprite.x, enemy.sprite.y),
                            enemyType: enemy.type,
                            points: enemy.points || 0
                        }
                    });

                    // Arcade: a spheroid kill shows its 1000 points in place
                    // of an explosion.
                    if (enemy.type === 'spheroid') {
                        ScorePopup.show(enemy.sprite.x, enemy.sprite.y, enemy.points || 0);
                    } else {
                        Effects.createExplosion(enemy.sprite.x, enemy.sprite.y, explosionColor);
                    }
                    SoundManager.play(soundToPlayKey);
                    if (enemy.sprite && !(enemy.sprite as any)._destroyed) (enemy.sprite as any).destroy();
                    enemies.splice(j, 1);
                    if (enemy.type === 'grunt') WavePacing.onGruntKilled();

                    if (gameState.currentGameState === 'PLAYING' && (!p.isDemoProjectile)) {
                        addScore(enemy.points || 0);
                    }
                }
                break;
            }
        }
        if (!p || (p.sprite as any)._destroyed) return; // Projectile might have been destroyed by hitting an enemy

        // Player Projectile vs Human-Converted Prog (from humansAndProgs list)
        for (let k = humansAndProgs.length - 1; k >= 0; k--) {
            const entity = humansAndProgs[k];
            if (entity.type === 'prog' && entity.sprite && !(entity.sprite as any)._destroyed) {
                if (isColliding(p.sprite, entity.sprite, 5)) {
                    if (p.sprite && !(p.sprite as any)._destroyed) (p.sprite as any).destroy();
                    playerProjectiles.splice(i, 1);

                    Effects.createExplosion(entity.sprite.x, entity.sprite.y, 0xFF55FF);
                    SoundManager.play('progDestroy');
                    (entity as any).destroy();   // Prog.destroy also clears its trail
                    humansAndProgs.splice(k, 1);

                    if (gameState.currentGameState === 'PLAYING' && (!p.isDemoProjectile)) {
                        addScore(entity.points || 0);
                    }
                    break;
                }
            }
        }
    }

    if (currentPlayer && currentPlayer.isAlive && currentPlayer.sprite && !(currentPlayer.sprite as any)._destroyed) {
        const invulnerable = gameState.currentGameState === 'PLAYING' && gameState.playerInvulnerableTime > 0;

        // Enemy Projectile vs Player
        for (let i = enemyProjectiles.length - 1; i >= 0; i--) {
            const p = enemyProjectiles[i];
            if (isEntityGone(p)) continue;
            if (!invulnerable && isColliding(p.sprite, currentPlayer.sprite, 5)) {
                if (p.sprite && !(p.sprite as any)._destroyed) (p.sprite as any).destroy();
                enemyProjectiles.splice(i,1);
                if (gameState.currentGameState === 'PLAYING') playerHit();
                // Demo player hit logic would be handled by attractMode.js if it has its own collision check
                break;
            }
        }

        // Player vs Enemy
        if (!invulnerable) {
            for (let i = enemies.length - 1; i >= 0; i--) {
                const enemy = enemies[i];
                if (isEntityGone(enemy)) continue;
                if (isColliding(currentPlayer.sprite, enemy.sprite, 8)) {
                    if (gameState.currentGameState === 'PLAYING') playerHit();
                    break;
                }
            }
            // Player vs Human-Converted Prog
            for (let i = humansAndProgs.length - 1; i >= 0; i--) {
                const entity = humansAndProgs[i];
                if (entity.type === 'prog' && entity.sprite && !(entity.sprite as any)._destroyed) {
                    if (isColliding(currentPlayer.sprite, entity.sprite, 8)) {
                       if (gameState.currentGameState === 'PLAYING') playerHit();
                       break;
                    }
                }
            }
        }

        // Player vs Obstacle (Electrodes)
        if (!invulnerable) {
            for (let i = obstacles.length - 1; i >= 0; i--) {
                const obstacle = obstacles[i];
                if (isEntityGone(obstacle)) continue;
                if (obstacle.type === 'electrode' && isColliding(currentPlayer.sprite, obstacle.sprite, 6)) {
                    if (gameState.currentGameState === 'PLAYING') playerHit();
                    break;
                }
            }
        }

        // Grunt vs Electrode — arcade: electrodes kill grunts and are
        // consumed in the process (100 pts, same as shooting the grunt).
        for (let oi = obstacles.length - 1; oi >= 0; oi--) {
            const ob = obstacles[oi];
            if (!ob || ob.type !== 'electrode' || !ob.sprite || (ob.sprite as any)._destroyed) continue;
            for (let ei = enemies.length - 1; ei >= 0; ei--) {
                const en = enemies[ei];
                if (!en || en.type !== 'grunt' || !en.sprite || (en.sprite as any)._destroyed) continue;
                if (isColliding(ob.sprite, en.sprite, 5)) {
                    Effects.createExplosion(en.sprite.x, en.sprite.y, 0xFF0000);
                    SoundManager.play('gruntPop');
                    (en.sprite as any).destroy();
                    enemies.splice(ei, 1);
                    WavePacing.onGruntKilled();
                    Obstacles.killElectrode(ob);     // ROM shrink ($7AA9)
                    if (gameState.currentGameState === 'PLAYING') {
                        addScore(GameConfig.POINTS.GRUNT);
                    }
                    break;
                }
            }
        }

        // Player bullet vs Electrode — one shot destroys it (no points) and it
        // shrinks away over 11 frames.
        for (let pi = playerProjectiles.length - 1; pi >= 0; pi--) {
            const pb = playerProjectiles[pi];
            if (isEntityGone(pb)) continue;
            for (let oi = obstacles.length - 1; oi >= 0; oi--) {
                const ob = obstacles[oi];
                if (!ob || ob.type !== 'electrode' || !ob.sprite || (ob.sprite as any)._destroyed) continue;
                if (isColliding(pb.sprite, ob.sprite, 5)) {
                    (pb.sprite as any).destroy();
                    playerProjectiles.splice(pi, 1);
                    Obstacles.killElectrode(ob);
                    break;
                }
            }
        }

        // Player bullet vs enemy shots: enforcer sparks ($54DC), brain cruise
        // missiles ($6119) and tank shells ($8FD5) all die to player fire for
        // 25 points each (score_update $0025).
        const SHOT_POINTS: Record<string, number> = {
            enforcer_shot: GameConfig.POINTS.ENFORCER_SPARK,
            brain_shot: GameConfig.POINTS.CRUISE_MISSILE,
            tank_shell: GameConfig.POINTS.TANK_SHELL,
        };
        for (let pi = playerProjectiles.length - 1; pi >= 0; pi--) {
            const pb = playerProjectiles[pi];
            if (isEntityGone(pb)) continue;
            for (let ei = enemyProjectiles.length - 1; ei >= 0; ei--) {
                const ep = enemyProjectiles[ei];
                if (isEntityGone(ep) || !(ep.type in SHOT_POINTS)) continue;
                if (isColliding(pb.sprite, ep.sprite, 5)) {
                    (pb.sprite as any).destroy();
                    playerProjectiles.splice(pi, 1);
                    (ep.sprite as any).destroy();
                    enemyProjectiles.splice(ei, 1);
                    SoundManager.play('subQuarkPop');   // ROM $4B1E for shells; sparks/missiles have no captured sample
                    if (gameState.currentGameState === 'PLAYING' && !pb.isDemoProjectile) addScore(SHOT_POINTS[ep.type]);
                    break;
                }
            }
        }

        // Player vs Human (Rescue) - TEMPORARILY DISABLED FOR DEBUGGING
        for (let i = humansAndProgs.length - 1; i >= 0; i--) {
            const humanEntity = humansAndProgs[i];
             if (humanEntity.type === 'human' && !humanEntity.isRescued && humanEntity.sprite && !(humanEntity.sprite as any)._destroyed) {
                // Use reasonable collision radius - sprites touching or very close
                if (isColliding(currentPlayer.sprite, humanEntity.sprite, 18)) {
                    // Debug the collision
                    const distance = Math.sqrt(
                        Math.pow(currentPlayer.sprite.x - humanEntity.sprite.x, 2) +
                        Math.pow(currentPlayer.sprite.y - humanEntity.sprite.y, 2)
                    );
                    console.log('[GameLogic.checkCollisions] Human collision detected:', {
                        playerPos: {x: currentPlayer.sprite.x, y: currentPlayer.sprite.y},
                        humanPos: {x: humanEntity.sprite.x, y: humanEntity.sprite.y},
                        distance: distance.toFixed(2)
                    });
                    
                    // Mark as rescued but don't destroy sprite here - let humans.js handle it
                    humanEntity.isRescued = true;
                    console.log('[GameLogic.checkCollisions] Human marked as rescued, letting humans.js handle cleanup');
                    
                    // Emit human rescued event for visual effects system
                    gameEvents.emit({
                        type: 'human:rescued',
                        timestamp: Date.now(),
                        source: 'gameLogic',
                        data: {
                            position: new Vector2(humanEntity.sprite.x, humanEntity.sprite.y),
                            bonus: gameState.currentHumanRescueBonus
                        }
                    });
                    
                    // Arcade: the bonus value appears where the human was touched.
                    ScorePopup.show(humanEntity.sprite.x, humanEntity.sprite.y, gameState.currentHumanRescueBonus);

                    if (gameState.currentGameState === 'PLAYING') {
                        addScore(gameState.currentHumanRescueBonus);
                        SoundManager.play('humanRescue');
                        if (gameState.currentHumanRescueBonus < GameConfig.MAX_HUMAN_RESCUE_BONUS) {
                            gameState.currentHumanRescueBonus += GameConfig.HUMAN_RESCUE_BONUS_INCREMENT;
                        }
                        if(UI.updateBonusDisplay) UI.updateBonusDisplay();
                    }
                    // No specific demo player rescue score/sound in original, handled by demo logic if needed
                }
            }
        }
    } // End of if(currentPlayer && currentPlayer.isAlive)

    // --- Non-Player specific collisions ---
    // Enemy Projectile vs Human (Tank Shells only in original)
    for (let i = enemyProjectiles.length - 1; i >= 0; i--) {
        const p = enemyProjectiles[i];
        if (isEntityGone(p) || p.type !== 'tank_shell') continue;
        for (let j = humansAndProgs.length - 1; j >=0; j--) {
            const humanEntity = humansAndProgs[j];
            if (humanEntity.type === 'human' && humanEntity.sprite && !(humanEntity.sprite as any)._destroyed) {
                if (isColliding(p.sprite, humanEntity.sprite, 5)) {
                    if (p.sprite && !(p.sprite as any)._destroyed) (p.sprite as any).destroy();
                    enemyProjectiles.splice(i,1);

                    Effects.createExplosion(humanEntity.sprite.x, humanEntity.sprite.y, 0xCCCCCC);
                    SoundManager.play('humanDeathByEnemy');
                    if (humanEntity.sprite && !(humanEntity.sprite as any)._destroyed) (humanEntity.sprite as any).destroy();
                    humansAndProgs.splice(j, 1);

                    // Arcade: a human's death does not reset the rescue bonus.
                    break;
                }
            }
        }
    }

    // Enemy vs Human (Hulk killing human)
    for (let i = enemies.length - 1; i >= 0; i--) {
        const enemy = enemies[i];
        if (isEntityGone(enemy) || enemy.type !== 'hulk') continue;

        for (let j = humansAndProgs.length - 1; j >= 0; j--) {
            const humanEntity = humansAndProgs[j];
            if (humanEntity.type === 'human' && !humanEntity.isRescued && humanEntity.sprite && !(humanEntity.sprite as any)._destroyed) {
                if (isColliding(enemy.sprite, humanEntity.sprite, 10)) {
                    Effects.createExplosion(humanEntity.sprite.x, humanEntity.sprite.y, 0xCCCCCC);
                    SoundManager.play('humanDeathByEnemy');
                    if (humanEntity.sprite && !(humanEntity.sprite as any)._destroyed) (humanEntity.sprite as any).destroy();
                    humansAndProgs.splice(j, 1);
                    // Arcade: a human's death does not reset the rescue bonus.
                    // No break here, Hulk might trample multiple humans
                }
            }
        }
    }
}
