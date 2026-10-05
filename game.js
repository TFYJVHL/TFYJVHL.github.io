/* 攻防战场 · 双人自由模式 / 无尽模式 —— 逻辑引擎 */
(function () {
  'use strict';

  // ================= 常量与工具 =================
  var CELL = 40, COLS = 20, ROWS = 15, W = COLS * CELL, H = ROWS * CELL, TAU = Math.PI * 2;
  var canvas = document.getElementById('game');
  var ctx = canvas.getContext('2d');
  var BUILDING_DEFS = window.GD.BUILDINGS;
  var UNIT_DEFS = window.GD.UNITS;
  var B_MAP = {}, U_MAP = {};
  BUILDING_DEFS.forEach(function (d) { B_MAP[d.key] = d; });
  UNIT_DEFS.forEach(function (d) { U_MAP[d.key] = d; });

  var CASTLE = { gx: 9, gy: 6, w: 80, h: 80, hp: 1500 };
  // 双人自由模式：防御方大本营（自动生成，被摧毁即攻击方获胜）
  var HQ_CELL = { gx: 9, gy: 7 };
  var HQ_DEF = {
    key: 'hq', name: '大本营', cost: 0, hp: 3000, range: 0, hpTier: '超高',
    color: '#ffd76a', isHq: true, s: {}
  };
  B_MAP.hq = HQ_DEF;                     // 只登记到表里供 addBuilding 使用，不会出现在卡片栏

  // ---- 所有可调数值都来自 defs.js 的 CONFIG ----
  var CFG = window.GD.CONFIG;
  var START_GOLD_VS = CFG.startGoldVersus, ROUND_INCOME = CFG.roundIncome;
  var START_GOLD_ENDLESS = CFG.startGoldEndless, KILL_GOLD = CFG.killGold;
  var REST_SECONDS = CFG.restSeconds;     // 无尽模式每波之间的修整时间
  var UNIT_CAP = CFG.unitCap;             // 场上敌人上限（波次生成时节流）
  var uid = 0;

  function toSet(keys) {
    var m = {};
    for (var i = 0; i < keys.length; i++) m[keys[i]] = 1;
    return m;
  }
  // 强力角色：引力核心对它们无效
  var HEAVY = toSet(CFG.heavyKeys);
  // Boss：出场时在画面最上方显示专属长血条
  var BOSS = toSet(CFG.bossKeys);
  // Boss 免疫一切负面状态：减速 / 冰冻 / 灼烧 / 中毒 / 拉扯
  function immuneDebuff(u) { return !!(u && BOSS[u.key]); }

  function fitCanvas() {
    var dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  fitCanvas();
  window.addEventListener('resize', fitCanvas);

  function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }
  function rand(a, b) { return a + Math.random() * (b - a); }
  function dist(ax, ay, bx, by) { var dx = ax - bx, dy = ay - by; return Math.sqrt(dx * dx + dy * dy); }
  function chance(p) { return Math.random() < p; }
  function roundRect(c, x, y, w, h, r) {
    r = Math.min(r, w / 2, h / 2);
    c.beginPath();
    c.moveTo(x + r, y);
    c.lineTo(x + w - r, y); c.quadraticCurveTo(x + w, y, x + w, y + r);
    c.lineTo(x + w, y + h - r); c.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    c.lineTo(x + r, y + h); c.quadraticCurveTo(x, y + h, x, y + h - r);
    c.lineTo(x, y + r); c.quadraticCurveTo(x, y, x + r, y);
    c.closePath();
  }

  // ================= 状态 =================
  var G;
  function newGame(mode) {
    var g = {
      mode: mode,
      phase: mode === 'versus' ? 'defDeploy' : 'rest',
      round: 1, wave: 0, kills: 0, score: 0,
      goldDef: START_GOLD_VS, goldAtk: START_GOLD_VS, gold: START_GOLD_ENDLESS,
      buildings: [], units: [], projs: [], rollers: [], zones: [], fx: [], parts: [], texts: [],
      sel: null, hover: { x: -99, y: -99, gx: -1, gy: -1, on: false },
      hq: null,                         // 双人模式防御方大本营
      focus: null,                      // 进攻方全军集火的同一个建筑目标
      drag: null,                       // 长按拖动中的建筑 / 角色
      press: null,                      // 长按判定状态
      pickB: null,                      // 详情面板里正在查看的建筑
      destroyMode: false,               // 触屏拆除模式：点击 = 拆除
      castle: null, countdown: REST_SECONDS, spawnQueue: [], spawnTimer: 0, waveData: null, preview: null,
      paused: false, speed: 1, time: 0, over: false, roundWinner: null,
      shakeT: 0, shakeMag: 0
    };
    if (mode === 'endless') {
      g.castle = {
        x: CASTLE.gx * CELL + CASTLE.w / 2, y: CASTLE.gy * CELL + CASTLE.h / 2,
        hp: CASTLE.hp, maxHp: CASTLE.hp, isCastle: true
      };
    }
    return g;
  }

  function goldOf(side) {
    if (G.mode === 'endless') return G.gold;
    return Infinity;                  // 双人自由模式：双方无限金币
  }
  function payGold(side, amount) {
    if (G.mode === 'endless') { G.gold -= amount; return; }
    // 双人自由模式：不扣金币
  }
  function refund(side, amount) {
    if (G.mode === 'endless') { G.gold += amount; return; }
    // 双人自由模式：金币无限，无需返还
  }
  function activeSide() {
    if (G.mode === 'endless') return 'def';
    return G.phase === 'atkDeploy' ? 'atk' : 'def';
  }
  function canModify() {
    if (G.mode === 'endless') return !G.over;
    return G.phase === 'defDeploy' || G.phase === 'atkDeploy';
  }
  // 是否处于战斗（用于背景音乐切换节奏）
  function isBattle() {
    if (G.over) return false;
    if (G.mode === 'endless') return G.phase === 'wave';
    return G.phase === 'battle';
  }
  // 移动（长按拖动）已放置的建筑 / 角色：无尽模式只允许在修整阶段
  function canMove() {
    if (G.mode === 'endless') return !G.over && G.phase === 'rest';
    return canModify();
  }
  // 无尽模式：波次越靠后，击杀给的金币越多（第 1 波 10，每波 +15%）
  function killGold() {
    if (G.mode !== 'endless') return KILL_GOLD;
    return Math.min(CFG.killGoldMax, Math.round(KILL_GOLD * (1 + Math.max(0, G.wave - 1) * CFG.killGoldPerWave)));
  }
  // 无尽模式单位计数（用于上限与 HUD）
  function countAtk() {
    var n = 0;
    for (var i = 0; i < G.units.length; i++) if (!G.units[i].dead && G.units[i].side === 'atk') n++;
    return n;
  }

  // ================= 音效（音量与音乐分开控制） =================
  var Sound = {
    on: false, ac: null, master: null, VOL: CFG.vol.sfx,
    ensure: function () {
      if (!this.on) return null;
      if (!this.ac) {
        var AC = window.AudioContext || window.webkitAudioContext; if (!AC) return null;
        this.ac = Music.ac || new AC();
        if (!Music.ac) Music.ac = this.ac;                  // 与音乐共用一个上下文
        this.master = this.ac.createGain();
        this.master.gain.value = this.VOL;                  // 音效总音量
        this.master.connect(this.ac.destination);
      }
      if (this.ac.state === 'suspended') this.ac.resume();
      return this.ac;
    },
    play: function (f, dur, type, vol) {
      var ac = this.ensure(); if (!ac) return;
      var o = ac.createOscillator(), g = ac.createGain();
      o.type = type || 'square'; o.frequency.value = f;
      g.gain.setValueAtTime(vol || 0.035, ac.currentTime);
      g.gain.exponentialRampToValueAtTime(0.0001, ac.currentTime + dur);
      o.connect(g); g.connect(this.master || ac.destination); o.start(); o.stop(ac.currentTime + dur);
    },
    setVol: function (v) {
      this.VOL = clamp(v, 0, 1);
      if (this.master) this.master.gain.value = this.VOL;
      try { localStorage.setItem('td_vol_sfx', String(this.VOL)); } catch (e) {}
    },
    shoot: function () { this.play(rand(430, 560), 0.05, 'square', 0.018); },
    boom: function () { this.play(rand(90, 140), 0.2, 'sawtooth', 0.04); },
    zap: function () { this.play(rand(700, 1000), 0.1, 'sawtooth', 0.028); },
    hurt: function () { this.play(rand(120, 180), 0.1, 'triangle', 0.045); },
    coin: function () { this.play(880, 0.07, 'square', 0.025); },
    build: function () { this.play(500, 0.09, 'triangle', 0.035); }
  };

  // ================= 背景音乐（WebAudio 程序化合成，不需要音频文件） =================
  var Music = {
    on: true, started: false, ac: null, master: null, wet: null, noiseBuf: null,
    timer: null, step: 0, nextTime: 0, bpm: CFG.music.bpmCalm, mood: 0, paused: false,
    VOL: CFG.vol.music,

    // 和弦进行：Am - F - C - G（MIDI 音高）
    PROG: [
      { root: 45, chord: [45, 48, 52] },
      { root: 41, chord: [41, 45, 48] },
      { root: 48, chord: [48, 52, 55] },
      { root: 43, chord: [43, 47, 50] }
    ],
    // 主旋律：每小节 8 个八分音符，0 = 休止
    LEAD: [
      [69, 0, 72, 71, 69, 0, 67, 69],
      [65, 0, 69, 72, 69, 0, 65, 64],
      [72, 0, 76, 72, 71, 0, 69, 67],
      [67, 0, 71, 74, 71, 0, 69, 67]
    ],

    mtof: function (m) { return 440 * Math.pow(2, (m - 69) / 12); },

    ensure: function () {
      if (!this.ac) {
        var AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) return null;
        this.ac = Sound.ac || new AC();
        if (!Sound.ac) Sound.ac = this.ac;              // 音效与音乐共用一个上下文
        this.master = this.ac.createGain();
        this.master.gain.value = 0.0001;
        this.master.connect(this.ac.destination);
        var dly = this.ac.createDelay(0.6); dly.delayTime.value = 0.26;
        var fb = this.ac.createGain(); fb.gain.value = 0.26;
        this.wet = this.ac.createGain(); this.wet.gain.value = 0.3;
        this.wet.connect(dly); dly.connect(fb); fb.connect(dly); dly.connect(this.master);
        var len = Math.floor(this.ac.sampleRate * 0.5);
        this.noiseBuf = this.ac.createBuffer(1, len, this.ac.sampleRate);
        var d = this.noiseBuf.getChannelData(0);
        for (var i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
      }
      if (this.ac.state === 'suspended') this.ac.resume();
      return this.ac;
    },

    volume: function (v) {
      if (!this.master) return;
      var t = this.ac.currentTime;
      this.master.gain.cancelScheduledValues(t);
      this.master.gain.setValueAtTime(Math.max(0.0001, this.master.gain.value), t);
      this.master.gain.linearRampToValueAtTime(Math.max(0.0001, v), t + 0.35);
    },

    start: function () {
      if (!this.on || this.started) return;
      var ac = this.ensure(); if (!ac) { this.on = false; return; }
      this.started = true;
      this.step = 0;
      this.nextTime = ac.currentTime + 0.08;
      this.volume(this.paused ? this.VOL * CFG.vol.musicPaused : this.VOL);
      var self = this;
      this.timer = setInterval(function () { self.tick(); }, 25);
    },

    stop: function () {
      if (this.timer) { clearInterval(this.timer); this.timer = null; }
      this.started = false;
      this.volume(0);
    },

    toggle: function () {
      this.on = !this.on;
      if (this.on) this.start(); else this.stop();
      try { localStorage.setItem('td_music', this.on ? '1' : '0'); } catch (e) {}
    },

    setVol: function (v) {
      this.VOL = clamp(v, 0, 1);
      if (this.started) this.volume(this.paused ? this.VOL * CFG.vol.musicPaused : this.VOL);
      try { localStorage.setItem('td_vol_music', String(this.VOL)); } catch (e) {}
    },

    tick: function () {
      var ac = this.ac; if (!ac || !this.started) return;
      if (ac.state === 'suspended') { ac.resume(); this.nextTime = ac.currentTime + 0.05; }
      var ahead = 0.16, spb = 60 / this.bpm / 4;
      if (this.nextTime < ac.currentTime - 0.4) this.nextTime = ac.currentTime + 0.05;  // 后台节流后不补播
      while (this.nextTime < ac.currentTime + ahead) {
        this.playStep(this.step, this.nextTime);
        this.nextTime += spb;
        this.step = (this.step + 1) % 64;
      }
    },

    playStep: function (i, t) {
      var bar = (i >> 4) & 3, sub = i & 15;
      var p = this.PROG[bar], battle = this.mood === 1;
      if (sub % 4 === 0) this.tone(p.root - 12, t, sub === 0 ? 0.4 : 0.2, 'triangle', battle ? 0.22 : 0.15, false);
      if (sub === 0) {
        for (var k = 0; k < p.chord.length; k++) this.tone(p.chord[k] + 12, t, 1.1, 'sine', 0.045, true);
      }
      if (sub % 2 === 0) {
        this.tone(p.chord[(sub / 2) % 3] + 12, t, 0.16, 'triangle', battle ? 0.09 : 0.06, true);
        var n = this.LEAD[bar][sub / 2];
        if (n) this.tone(n, t, 0.26, 'square', battle ? 0.055 : 0.038, true);
      }
      if (sub % 8 === 0) this.kick(t);
      if (battle && sub % 8 === 4) this.noise(t, 0.13, 0.12, 1200, true);
      if (sub % 2 === 1 || battle) this.noise(t, 0.03, battle ? 0.045 : 0.028, 6000, false);
    },

    tone: function (midi, t, dur, type, vol, sendWet) {
      var ac = this.ac; if (!ac) return;
      var o = ac.createOscillator(), g = ac.createGain();
      o.type = type; o.frequency.setValueAtTime(this.mtof(midi), t);
      g.gain.setValueAtTime(0.0001, t);
      g.gain.linearRampToValueAtTime(vol, t + 0.012);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      o.connect(g); g.connect(this.master);
      if (sendWet) g.connect(this.wet);
      o.start(t); o.stop(t + dur + 0.05);
    },

    noise: function (t, dur, vol, hp, sendWet) {
      var ac = this.ac; if (!ac || !this.noiseBuf) return;
      var s = ac.createBufferSource(); s.buffer = this.noiseBuf;
      var f = ac.createBiquadFilter(); f.type = 'highpass'; f.frequency.value = hp;
      var g = ac.createGain();
      g.gain.setValueAtTime(vol, t);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      s.connect(f); f.connect(g); g.connect(this.master);
      if (sendWet) g.connect(this.wet);
      s.start(t); s.stop(t + dur + 0.03);
    },

    kick: function (t) {
      var ac = this.ac; if (!ac) return;
      var o = ac.createOscillator(), g = ac.createGain();
      o.type = 'sine';
      o.frequency.setValueAtTime(140, t);
      o.frequency.exponentialRampToValueAtTime(45, t + 0.11);
      g.gain.setValueAtTime(0.45, t);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.16);
      o.connect(g); g.connect(this.master);
      o.start(t); o.stop(t + 0.2);
    },

    // 每帧调用：按阶段切换节奏，暂停时压低音量
    update: function (battle, paused) {
      if (paused !== this.paused) {
        this.paused = paused;
        if (this.started) this.volume(paused ? this.VOL * CFG.vol.musicPaused : this.VOL);
      }
      var want = battle ? 1 : 0;
      if (want !== this.mood) { this.mood = want; this.bpm = want ? CFG.music.bpmBattle : CFG.music.bpmCalm; }
    }
  };
  try {
    if (localStorage.getItem('td_music') === '0') Music.on = false;
    var vm = parseFloat(localStorage.getItem('td_vol_music'));
    if (!isNaN(vm)) Music.VOL = clamp(vm, 0, 1);
    var vs2 = parseFloat(localStorage.getItem('td_vol_sfx'));
    if (!isNaN(vs2)) Sound.VOL = clamp(vs2, 0, 1);
  } catch (e) {}

  // ================= 实体 =================
  function addBuilding(key, gx, gy) {
    var d = B_MAP[key];
    var b = {
      id: ++uid, def: d, key: key, gx: gx, gy: gy,
      x: (gx + 0.5) * CELL, y: (gy + 0.5) * CELL,
      hp: d.hp, maxHp: d.hp, cd: 0, angle: 0,
      shots: 0, volley: 0, vtimer: 0, burnT: 0, burnDps: 0,
      rateSlowT: 0, dmgCd: 0, mouthHit: false, dead: false,
      corroded: false, corrodedT: 0, prevCd: 0,
      level: 1,                                     // 塔等级（修整阶段可花金币升级）
      range: d.range, minRange: d.minRange || 0,    // 升级会改这两个值，所以不能直接读 def
      s: {}                                         // 本塔自己的属性副本，升级只改这里
    };
    for (var sk in d.s) if (Object.prototype.hasOwnProperty.call(d.s, sk)) b.s[sk] = d.s[sk];
    G.buildings.push(b);
    return b;
  }

  // 双人自由模式：为防御方放置大本营（不可拆除、不可拖动，被摧毁即输）
  function addHq() {
    var b = addBuilding('hq', HQ_CELL.gx, HQ_CELL.gy);
    b.isHq = true;
    G.hq = b;
    return b;
  }

  function addUnit(key, side, x, y, variant) {
    var d = U_MAP[key];
    var u = {
      id: ++uid, def: d, key: key, side: side, variant: variant || null,
      x: x, y: y, hp: d.hp, maxHp: d.hp,
      cd: rand(0, 0.35), angle: side === 'atk' ? Math.PI : 0,
      target: null, slow: 0, slowT: 0, freezeT: 0, burnT: 0, burnDps: 0,
      shield: false, poisonT: 0, poisonStacks: 0, poisonDps: 0,
      burrowed: false, burrowT: 0, burrowCd: rand(0, 3), trailT: 0, corroded: false, corrodedT: 0,
      stuckT: 0, stuckX: x, stuckY: y, wallTarget: null,   // 被墙挡住时的绕行 / 拆墙状态
      life: 0,                                   // 召唤物存活时间（0 = 永久）
      dead: false, used: false, phased: false, bob: rand(0, TAU),
      range: d.range, dmg: d.dmg, cdBase: d.cd, speedBoost: 1
    };
    if (variant === 'purple') { u.dmg = 44; u.cdBase = 1.5; u.range = 160; }
    if (key === 'destroyer') {
      u.segs = [];
      var nseg = d.segs || 11, dir = side === 'atk' ? 1 : -1;   // 身体朝身后方向排开，避免一出生就伸出地图
      for (var i = 0; i < nseg; i++) u.segs.push({ x: x + dir * i * 20, y: y });
      u.speedMul = 1; u.contacted = false; u.orbit = null; u.orbitCd = 0;
      u.ramDone = false; u.lastRam = null; u.ramCd = 0;
    }
    G.units.push(u);
    if (d.special === 'death') {
      summonAround('skeleton', side, x, y, 2);
      summonAround('flameskull', side, x, y, 2);
      G.fx.push({ type: 'ring', x: x, y: y, r0: 8, r1: 70, life: 0.5, max: 0.5, color: '#a06bff' });
    }
    return u;
  }

  function summonAround(key, side, x, y, n, life) {
    for (var i = 0; i < n; i++) {
      var a = rand(0, TAU), r = rand(24, 46);
      var u = addUnit(key, side, clamp(x + Math.cos(a) * r, 14, W - 14), clamp(y + Math.sin(a) * r, 14, H - 14));
      if (life) u.life = life;
    }
  }

  function addProj(o) {
    o.dead = false;
    if (o.sx === undefined) { o.sx = o.x; o.sy = o.y; }   // 记录出发点：跟踪弹按它算飞行距离
    G.projs.push(o);
    return o;
  }

  // ================= 放置 / 摧毁 =================
  function cellFree(gx, gy) {
    if (gx < 0 || gy < 0 || gx >= COLS || gy >= ROWS) return false;
    if (G.castle && gx >= CASTLE.gx && gx < CASTLE.gx + 2 && gy >= CASTLE.gy && gy < CASTLE.gy + 2) return false;
    for (var i = 0; i < G.buildings.length; i++) {
      if (G.buildings[i].gx === gx && G.buildings[i].gy === gy) return false;
    }
    return true;
  }

  // 双人自由模式 = 无放置限制（可叠放建筑、可贴着建筑/城堡部署）
  function freeBuild() { return G.mode === 'versus'; }
  function canDropCell(gx, gy) {
    if (gx < 0 || gy < 0 || gx >= COLS || gy >= ROWS) return false;
    if (freeBuild()) return true;
    return cellFree(gx, gy);
  }

  // ================= 合成：把一座建筑直接放到另一座建筑上 =================
  function buildingsAtCell(gx, gy) {
    var out = [];
    for (var i = 0; i < G.buildings.length; i++) {
      var b = G.buildings[i];
      if (!b.dead && b.gx === gx && b.gy === gy) out.push(b);
    }
    return out;
  }
  // 返回能合成的那条配方（不分先后顺序）
  function fuseRecipe(k1, k2) {
    var F = window.GD.FUSE || [];
    for (var i = 0; i < F.length; i++) {
      var f = F[i];
      if ((f.a === k1 && f.b === k2) || (f.a === k2 && f.b === k1)) return f;
    }
    return null;
  }
  // 卡片提示：这座塔能和谁合成什么
  function fuseHintFor(key) {
    var F = window.GD.FUSE || [], out = [];
    for (var i = 0; i < F.length; i++) {
      var f = F[i];
      var other = f.a === key ? f.b : (f.b === key ? f.a : null);
      if (!other) continue;
      var od = B_MAP[other], ob = B_MAP[f.out];
      if (od && ob) out.push('叠放在「' + od.name + '」上 → 合成「' + ob.name + '」');
    }
    return out.join('\n');
  }

  function tryPlace() {
    var sel = G.sel;
    if (!sel) { toast('先在下方卡片栏选择一个单位'); return; }
    if (!canModify()) { toast('战斗阶段无法部署'); return; }
    var side = activeSide();

    if (sel.isUnit) {
      if (side !== 'atk') { toast('现在是防御方回合，只能建造建筑'); return; }
      if (goldOf('atk') < sel.cost) { toast('攻击方金币不足'); return; }
      var px = clamp(G.hover.x, 16, W - 16), py = clamp(G.hover.y, 16, H - 16);
      if (!unitSpotOk(px, py)) { toast('不能贴着建筑或城堡部署（至少 76 像素）'); return; }
      payGold('atk', sel.cost);
      if (G.mode === 'endless') floatText(px, py - 18, '-' + sel.cost, '#ff8a5c');
      if (sel.key === 'eyes') {
        addUnit('eyes', 'atk', px - 16, py, 'red');
        addUnit('eyes', 'atk', px + 16, py, 'purple');
      } else {
        addUnit(sel.key, 'atk', px, py);
      }
      Sound.build();
      burst(px, py, 12, sel.color || '#ffffff', 90);
      syncUI();
    } else {
      if (side !== 'def') { toast('现在是攻击方回合，只能部署角色'); return; }
      var gx = G.hover.gx, gy = G.hover.gy;

      // 先看这一格上有没有能和自己合成的建筑
      var onCell = buildingsAtCell(gx, gy), recipe = null, base = null;
      for (var fi = 0; fi < onCell.length && !recipe; fi++) {
        if (onCell[fi].isHq) continue;
        var fr = fuseRecipe(onCell[fi].key, sel.key);
        if (fr) { recipe = fr; base = onCell[fi]; }
      }
      if (recipe) {
        if (goldOf('def') < sel.cost) { toast('防御方金币不足'); return; }
        payGold('def', sel.cost);
        base.dead = true;
        var bidx = G.buildings.indexOf(base);
        if (bidx >= 0) G.buildings.splice(bidx, 1);
        var nb2 = addBuilding(recipe.out, gx, gy);
        if (G.mode === 'endless') floatText(nb2.x, nb2.y - 20, '-' + sel.cost, '#ffc857');
        floatText(nb2.x, nb2.y - 40, '合成 ' + nb2.def.name + '！', '#ffe066');
        G.fx.push({ type: 'ring', x: nb2.x, y: nb2.y, r0: 8, r1: 68, life: 0.5, max: 0.5, color: '#ffe066' });
        burst(nb2.x, nb2.y, 18, '#ffe066', 120);
        shake(4); Sound.build();
        syncUI();
        return;
      }

      if (!canDropCell(gx, gy)) { toast('这里不能建造'); return; }
      if (goldOf('def') < sel.cost) { toast('防御方金币不足'); return; }
      payGold('def', sel.cost);
      var b = addBuilding(sel.key, gx, gy);
      if (G.mode === 'endless') floatText(b.x, b.y - 20, '-' + sel.cost, '#ffc857');
      Sound.build();
      burst(b.x, b.y, 10, sel.color, 80);
      syncUI();
    }
  }

  function tryDestroy() {
    if (G.over) return;
    if (!canModify()) { toast('战斗阶段无法摧毁或移动建筑'); return; }
    var side = activeSide();
    var x = G.hover.x, y = G.hover.y;

    if (side === 'atk') {
      for (var i = G.units.length - 1; i >= 0; i--) {
        var u = G.units[i];
        if (u.side !== 'atk') continue;
        if (dist(x, y, u.x, u.y) <= (u.def.r || 10) + 14) {
          G.units.splice(i, 1);
          refund('atk', u.def.cost);
          if (G.mode === 'endless') floatText(u.x, u.y, '+' + u.def.cost, '#ffc857');
          Sound.coin();
          syncUI();
          return;
        }
      }
      return;
    }

    var gx = G.hover.gx, gy = G.hover.gy;
    for (var k = 0; k < G.buildings.length; k++) {
      var b = G.buildings[k];
      if (b.gx === gx && b.gy === gy) {
        if (b.isHq) { toast('大本营不能被拆除'); return; }
        var back = (G.mode === 'versus' && G.phase === 'defDeploy') ? b.def.cost : Math.floor(b.def.cost * CFG.refundRate);
        refund('def', back);
        if (G.mode === 'endless') floatText(b.x, b.y, '+' + back, '#ffc857');
        burst(b.x, b.y, 14, '#ffc857', 110);
        b.dead = true;
        if (G.focus === b) G.focus = null;
        G.buildings.splice(k, 1);
        Sound.coin();
        syncUI();
        return;
      }
    }
  }

  // ================= 长按拖动已放置的建筑 / 角色 =================
  var HOLD_MS = 300;

  function unitSpotOk(px, py) {
    if (freeBuild()) return true;                 // 双人自由模式：不限位置
    for (var i = 0; i < G.buildings.length; i++) {
      if (dist(px, py, G.buildings[i].x, G.buildings[i].y) < 76) return false;
    }
    if (G.castle && Math.abs(px - G.castle.x) < 70 && Math.abs(py - G.castle.y) < 70) return false;
    return true;
  }

  // 光标下可移动的目标：防御回合=已建建筑，攻击回合=已放角色
  function pickMovable() {
    if (!canModify()) return null;
    var x = G.hover.x, y = G.hover.y;
    if (activeSide() === 'atk') {
      for (var i = G.units.length - 1; i >= 0; i--) {
        var u = G.units[i];
        if (u.side !== 'atk' || u.dead) continue;
        if (dist(x, y, u.x, u.y) <= (u.def.r || 10) + 12) return u;
      }
      return null;
    }
    var gx = G.hover.gx, gy = G.hover.gy;
    for (var k = G.buildings.length - 1; k >= 0; k--) {   // 允许叠放时取最上面那个
      var b = G.buildings[k];
      if (b.isHq) continue;                               // 大本营不可移动
      if (b.gx === gx && b.gy === gy) return b;
    }
    return null;
  }

  function clearPress() {
    if (G.press) { clearTimeout(G.press.timer); G.press = null; }
  }

  function startDrag(obj) {
    if (!obj || !canMove()) {
      if (obj && G.mode === 'endless') toast('战斗中无法移动建筑，等修整阶段再调整');
      clearPress();
      return;
    }
    clearPress();
    G.drag = { obj: obj, isUnit: !!obj.side, ox: obj.x, oy: obj.y, ogx: obj.gx, ogy: obj.gy };
    if (!G.drag.isUnit) { obj.gx = -999; obj.gy = -999; }   // 拖动时腾出原格子
    G.sel = null;
    Sound.build();
    syncUI();
  }

  function updateDragPos() {
    var d = G.drag;
    if (!d || !G.hover.on) return;
    d.obj.x = clamp(G.hover.x, 16, W - 16);
    d.obj.y = clamp(G.hover.y, 16, H - 16);
  }

  function cancelDrag() {
    var d = G.drag;
    if (!d) return;
    var o = d.obj;
    if (d.isUnit) { o.x = d.ox; o.y = d.oy; }
    else { o.gx = d.ogx; o.gy = d.ogy; o.x = (o.gx + 0.5) * CELL; o.y = (o.gy + 0.5) * CELL; }
    G.drag = null;
  }

  function dropDrag() {
    var d = G.drag;
    if (!d) return;
    var o = d.obj;
    G.drag = null;
    if (d.isUnit) {
      var px = clamp(G.hover.x, 16, W - 16), py = clamp(G.hover.y, 16, H - 16);
      if (G.hover.on && unitSpotOk(px, py)) { o.x = px; o.y = py; }
      else { o.x = d.ox; o.y = d.oy; toast('这里放不下，已回到原位'); }
    } else {
      var gx = G.hover.gx, gy = G.hover.gy;
      if (G.hover.on && canDropCell(gx, gy)) { o.gx = gx; o.gy = gy; }
      else { o.gx = d.ogx; o.gy = d.ogy; toast('这里放不下，已回到原位'); }
      o.x = (o.gx + 0.5) * CELL; o.y = (o.gy + 0.5) * CELL;
    }
    Sound.build();
    syncUI();
  }

  function drawDragHint() {
    var d = G.drag;
    ctx.save();
    if (d.isUnit) {
      var px = clamp(G.hover.x, 16, W - 16), py = clamp(G.hover.y, 16, H - 16);
      var ok = G.hover.on && unitSpotOk(px, py);
      ctx.globalAlpha = 0.85;
      ctx.strokeStyle = ok ? '#4fd1c5' : '#ff5a5f'; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(px, py, (d.obj.def.r || 10) + 8, 0, TAU); ctx.stroke();
    } else {
      var gx = G.hover.gx, gy = G.hover.gy;
      var ok2 = G.hover.on && canDropCell(gx, gy);
      ctx.globalAlpha = 0.45;
      ctx.fillStyle = ok2 ? '#4fd1c5' : '#ff5a5f';
      roundRect(ctx, gx * CELL + 2, gy * CELL + 2, CELL - 4, CELL - 4, 6); ctx.fill();
    }
    ctx.restore();
  }

  // ================= 目标 =================
  function buildingsNear(x, y, r) {
    var out = [];
    for (var i = 0; i < G.buildings.length; i++) {
      var b = G.buildings[i];
      if (!b.dead && dist(x, y, b.x, b.y) <= r) out.push(b);
    }
    return out;
  }

  // 进攻方部队重心：集火目标时用它来判断“最近的建筑”
  function atkCentroid() {
    var n = 0, sx = 0, sy = 0;
    for (var i = 0; i < G.units.length; i++) {
      var u = G.units[i];
      if (u.dead || u.side !== 'atk') continue;
      sx += u.x; sy += u.y; n++;
    }
    if (!n) return null;
    return { x: sx / n, y: sy / n };
  }

  function targetAlive(t) {
    if (!t) return false;
    if (t.isCastle) return t.hp > 0;
    return !t.dead;
  }

  // 全军集火的唯一目标：烟竹 > 最近的普通建筑 > 城堡 > 裂岩墙（兜底）
  function pickFocusTarget() {
    var c = atkCentroid();
    var taunt = null, td = 1e9;      // 烟竹：最高优先级
    var best = null, bd = 1e9;       // 普通建筑（裂岩墙不算）
    var wall = null, wd = 1e9;       // 裂岩墙：只有挡路且没有其它目标时才拆
    for (var i = 0; i < G.buildings.length; i++) {
      var b = G.buildings[i];
      if (b.dead || b.def.untargetable) continue;
      var d = dist(c ? c.x : W / 2, c ? c.y : H / 2, b.x, b.y);
      if (b.def.taunt) { if (d < td) { td = d; taunt = b; } continue; }
      if (b.def.blocking) { if (d < wd) { wd = d; wall = b; } continue; }
      if (d < bd) { bd = d; best = b; }
    }
    if (taunt) return taunt;
    if (best) return best;
    if (G.castle && G.castle.hp > 0) return G.castle;
    return wall;                     // 只剩裂岩墙时才不得不拆墙
  }

  // 地图上是否存在烟竹（只要出现，就立刻把集火目标抢过去）
  function hasTaunt() {
    for (var i = 0; i < G.buildings.length; i++) {
      var b = G.buildings[i];
      if (!b.dead && b.def.taunt) return true;
    }
    return false;
  }

  // 每帧刷新一次集火目标：目标没了才换，但一出现烟竹就立刻改打烟竹
  function refreshFocus() {
    var any = false;
    for (var i = 0; i < G.units.length; i++) {
      if (!G.units[i].dead && G.units[i].side === 'atk') { any = true; break; }
    }
    if (!any) { G.focus = null; return; }
    var f = G.focus;
    if (targetAlive(f) && !(hasTaunt() && !(f.def && f.def.taunt))) return;
    G.focus = pickFocusTarget();
  }

  // 每个敌人都拿到同一个目标 → 一起集中攻击一个建筑
  function acquireBuildingTarget(u) {
    if (!targetAlive(G.focus)) G.focus = pickFocusTarget();
    return G.focus;
  }

  // 攻击方目标：先打拦在面前的防守单位（骷髅屋召的骷髅），没有再照常集火建筑
  var AGGRO = 150;
  function nearestDefUnit(x, y, r) {
    var best = null, bd = 1e9;
    for (var i = 0; i < G.units.length; i++) {
      var e = G.units[i];
      if (e.dead || e.side !== 'def') continue;
      var d = dist(x, y, e.x, e.y);
      if (d <= r && d < bd) { bd = d; best = e; }
    }
    return best;
  }
  // 普罗米修斯的“高智商”：射程内优先补刀血量最少的建筑（裂岩墙不值得打），否则照常集火
  function smartBuildingTarget(u) {
    var best = null, bhp = 1e9;
    for (var i = 0; i < G.buildings.length; i++) {
      var b = G.buildings[i];
      if (b.dead || b.def.untargetable || b.def.blocking) continue;
      if (dist(u.x, u.y, b.x, b.y) > u.range) continue;
      if (b.hp < bhp) { bhp = b.hp; best = b; }
    }
    if (best) return best;
    if (G.castle && G.castle.hp > 0 && dist(u.x, u.y, G.castle.x, G.castle.y) <= u.range) return G.castle;
    return null;
  }
  function acquireAttackTarget(u) {
    if (u.wallTarget) {                       // 正在拆挡路的裂岩墙：墙没了 / 拆够 10 秒就恢复集火
      if (!u.wallTarget.dead && G.time < (u.wallUntil || 0)) return u.wallTarget;
      u.wallTarget = null; u.wallUntil = 0;
    }
    var du = nearestDefUnit(u.x, u.y, AGGRO);
    if (du) return du;
    if (u.def.special === 'prometheus') {              // 智商高：射程内先补刀最残的建筑
      var smart = smartBuildingTarget(u);
      if (smart) return smart;
    }
    return acquireBuildingTarget(u);
  }

  function acquireEnemyTarget(u) {
    var best = null, bd = 1e9;
    for (var i = 0; i < G.units.length; i++) {
      var e = G.units[i];
      if (e.dead || e.side !== 'atk') continue;
      // 飞行单位打不到，除非它标注了可被近战攻击（幽灵）；钻地期间同样打不到
      if ((e.def.flying && !e.def.meleeTargetable) || e.burrowed) continue;
      var d = unitDist(u.x, u.y, e);
      if (d < bd) { bd = d; best = e; }
    }
    return best;
  }

  // 到单位的距离：毁灭者按整条身体算（任何一段都能被打到）
  function unitDist(x, y, u) {
    if (!u.segs) return dist(x, y, u.x, u.y);
    var best = 1e9;
    for (var i = 0; i < u.segs.length; i++) {
      var d = dist(x, y, u.segs[i].x, u.segs[i].y);
      if (d < best) best = d;
    }
    return best;
  }
  // 毁灭者身上离 (x,y) 最近的一段（弹道瞄准用）
  function nearestSeg(u, x, y) {
    var best = u.segs[0], bd = 1e9;
    for (var i = 0; i < u.segs.length; i++) {
      var d = dist(x, y, u.segs[i].x, u.segs[i].y);
      if (d < bd) { bd = d; best = u.segs[i]; }
    }
    return best;
  }

  function towerTarget(b, range, minRange, skipFly) {
    var best = null, bd = 1e9;
    for (var i = 0; i < G.units.length; i++) {
      var e = G.units[i];
      if (e.dead || e.side !== 'atk') continue;
      if (skipFly && e.def.flying) continue;
      if (e.burrowed) continue;              // 钻地期间不会被塔选中
      var d = unitDist(b.x, b.y, e);
      if (d > range) continue;
      if (minRange && d < minRange) continue;
      if (d < bd) { bd = d; best = e; }
    }
    return best;
  }

  function enemiesInRange(x, y, r, skipFly) {
    var out = [];
    for (var i = 0; i < G.units.length; i++) {
      var e = G.units[i];
      if (e.dead || e.side !== 'atk') continue;
      if (skipFly && e.def.flying) continue;
      if (e.burrowed) continue;
      if (unitDist(x, y, e) <= r) out.push(e);
    }
    return out;
  }

  // 圣佑祭坛 / 圣杯：范围内友方建筑减伤
  function wardAt(x, y) {
    for (var i = 0; i < G.buildings.length; i++) {
      var b = G.buildings[i];
      if (b.dead || !b.def.aura) continue;
      if (dist(x, y, b.x, b.y) <= b.range) return b;
    }
    return null;
  }

  // ================= 伤害 =================
  function hurtUnit(u, dmg, opts) {
    if (u.dead) return;
    opts = opts || {};
    // 掘地虫钻地期间无敌：任何伤害（含持续伤害）都打不动
    if (u.burrowed && dmg > 0) {
      if (!opts.silent && chance(0.35)) floatText(u.x, u.y - 22, '无敌', '#d97706');
      return;
    }
    // 普罗米修斯：受到攻击时 20% 完全免疫、40% 减伤（只判定成规模的伤害，持续伤害不触发）
    if (u.def.special === 'prometheus' && dmg >= 8 && !opts.dot) {
      var pr = Math.random(), ps = u.def.s;
      if (pr < ps.immuneChance) {
        if (!opts.silent) {
          floatText(u.x, u.y - 26, '免疫', '#ffd9a0');
          G.fx.push({ type: 'ring', x: u.x, y: u.y, r0: 6, r1: 34, life: 0.3, max: 0.3, color: '#ffd9a0' });
        }
        return;
      }
      if (pr < ps.immuneChance + ps.reductChance) {
        dmg *= ps.reduct;
        if (!opts.silent) floatText(u.x, u.y - 26, '减伤', '#ffb347');
      }
    }
    // 缚灵祭司护盾：抵挡一次伤害（持续伤害不触发）
    if (u.shield && !opts.dot && dmg > 0.5) {
      u.shield = false;
      floatText(u.x, u.y - 22, '护盾抵挡', '#a5f3d0');
      G.fx.push({ type: 'ring', x: u.x, y: u.y, r0: 4, r1: 26, life: 0.3, max: 0.3, color: '#a5f3d0' });
      return;
    }
    u.hp -= dmg;
    if (!opts.silent) burst(u.x, u.y, 2, '#ffffff', 50);
    if (u.hp <= 0) { killUnit(u); return; }
    if (u.def.special === 'titan' && !u.used && u.hp < u.maxHp * u.def.enrageAt) {
      u.used = true;
      u.speedBoost = u.def.enrage.speedBoost;
      u.cdBase = u.def.enrage.cd;
      floatText(u.x, u.y - 26, '狂暴！', '#ff5722');
      G.fx.push({ type: 'ring', x: u.x, y: u.y, r0: 10, r1: 80, life: 0.5, max: 0.5, color: '#ff5722' });
    }
    if (u.def.special === 'arthur' && !u.used && u.hp < u.maxHp * 0.2) {
      u.used = true;
      var lost = u.maxHp - u.hp;
      u.hp = Math.min(u.maxHp, u.hp + lost * 0.5);
      floatText(u.x, u.y - 24, '圣光回复！', '#ffd24d');
      G.fx.push({ type: 'ring', x: u.x, y: u.y, r0: 10, r1: 90, life: 0.6, max: 0.6, color: '#ffd24d' });
      summonAround('warrior', 'atk', u.x, u.y, 4);
      Sound.zap();
    }
    if (u.def.special === 'eyes' && !u.phased && u.hp < u.maxHp * 0.5) {
      u.phased = true;
      u.range = 34; u.dmg = 12; u.cdBase = 0.32; u.cd = 0.2; u.speedBoost = 1.5;
      floatText(u.x, u.y - 24, '狂暴形态', '#ff5c5c');
      G.fx.push({ type: 'ring', x: u.x, y: u.y, r0: 8, r1: 60, life: 0.5, max: 0.5, color: '#ff5c5c' });
    }
  }

  function killUnit(u) {
    if (u.dead) return;
    u.dead = true;
    burst(u.x, u.y, u.key === 'destroyer' ? 34 : 12, u.def.color, 140);
    if (u.side === 'atk') {
      G.kills++;
      if (G.mode === 'endless') {
        var kg = killGold();
        G.gold += kg;
        G.score += kg;
        floatText(u.x, u.y - 10, '+' + kg, '#ffc857');
        Sound.coin();
      }
      if (u.def.special === 'death') deathClaw(u);
      if (u.def.special === 'golem') golemBoom(u);
    }
    syncUI();
  }

  // 熔岩傀儡：死亡爆炸
  function golemBoom(u) {
    var s = u.def.s;
    var list = buildingsNear(u.x, u.y, s.boomR);
    for (var i = 0; i < list.length; i++) hurtBuilding(list[i], s.boomDmg);
    G.fx.push({ type: 'ring', x: u.x, y: u.y, r0: 10, r1: s.boomR, life: 0.5, max: 0.5, color: '#ff7043' });
    burst(u.x, u.y, 26, '#ff7043', 190);
    shake(7); Sound.boom();
  }

  function deathClaw(u) {
    if (!G.buildings.length) return;
    var b = G.buildings[Math.floor(Math.random() * G.buildings.length)];
    G.fx.push({ type: 'claw', x: b.x, y: b.y, life: 0.9, max: 0.9, b: b });
    floatText(b.x, b.y - 26, '死亡黑爪！', '#a06bff');
  }

  function hurtBuilding(b, dmg, opts) {
    if (!b || b.dead) return;
    opts = opts || {};
    if (!b.isCastle) {
      if (b.def.dmgTaken) dmg *= b.def.dmgTaken;                      // 裂岩墙：只掉少量血
      if (!b.corroded) {                                              // 被腐蚀后吃不到增益
        var w = wardAt(b.x, b.y);
        if (w) dmg *= w.s.reduct;                                     // 圣佑祭坛减伤
      }
    }
    b.hp -= dmg;
    if (!opts.silent) burst(b.x + rand(-8, 8), b.y + rand(-8, 8), 2, '#ffd6a5', 45);
    if (b.hp <= 0) {
      b.hp = 0; b.dead = true;
      if (b.isHq) { G.hq = null; G.focus = null; }           // 大本营被摧毁 → 攻击方获胜
      if (b.isCastle) {
        burst(b.x, b.y, 40, '#ff6b81', 200);
        shake(10);
        endlessOver();
        return;
      }
      burst(b.x, b.y, 22, '#ffb454', 150);
      G.fx.push({ type: 'ring', x: b.x, y: b.y, r0: 10, r1: 55, life: 0.4, max: 0.4, color: '#ffb454' });
      shake(5); Sound.hurt();
      var idx = G.buildings.indexOf(b);
      if (idx >= 0) G.buildings.splice(idx, 1);
      syncUI();
    }
  }

  // 毒素：可叠加，持续伤害但不会直接杀死敌人
  function applyPoison(u, dps, dur, maxStacks) {
    if (immuneDebuff(u)) { debuffBlocked(u); return; }
    u.poisonDps = dps;
    u.poisonT = Math.max(u.poisonT || 0, dur);
    u.poisonStacks = Math.min(maxStacks || 5, (u.poisonStacks || 0) + 1);
  }

  function applySlow(u, amt, dur) {
    if (immuneDebuff(u)) { debuffBlocked(u); return; }
    if (amt >= u.slow) { u.slow = amt; u.slowT = Math.max(u.slowT, dur); }
    else u.slowT = Math.max(u.slowT, dur * 0.5);
  }

  // Boss 挡下负面状态时给一次提示（同一时刻不刷屏）
  function debuffBlocked(u) {
    if (G.time - (u.lastImmuneFx || -9) < 1.2) return;
    u.lastImmuneFx = G.time;
    floatText(u.x, u.y - 26, '免疫', '#cfe8ff');
  }

  // ================= 建筑逻辑 =================
  function updateBuildings(dt) {
    for (var i = G.buildings.length - 1; i >= 0; i--) {
      var b = G.buildings[i];
      if (b.dead) { G.buildings.splice(i, 1); continue; }
      if (b.burnT > 0) {
        b.burnT -= dt;
        hurtBuilding(b, b.burnDps * dt, { silent: true });
        if (chance(0.25)) G.parts.push({ x: b.x + rand(-10, 10), y: b.y + rand(-10, 10), vx: rand(-8, 8), vy: rand(-30, -12), life: .5, maxLife: .5, color: '#ff8a3d', r: rand(1.5, 3) });
        if (b.dead) continue;
      }
      if (b.rateSlowT > 0) b.rateSlowT -= dt;
      if (b.dmgCd > 0) b.dmgCd -= dt;
      var rm = b.rateSlowT > 0 ? 0.5 : 1;
      var s = b.s;

      if (b.def.key === 'archer') {
        var t = towerTarget(b, b.range, 0, false);
        if (t) {
          b.angle = Math.atan2(t.y - b.y, t.x - b.x);
          b.cd -= dt * rm;
          if (b.cd <= 0) {
            shoot(b, t, s.dmg, 'arrow');
            b.shots++;
            b.cd = s.gap + (b.shots % s.burst === 0 ? s.pause : 0);
          }
        }
      } else if (b.def.key === 'tesla') {
        b.cd -= dt * rm;
        if (b.cd <= 0) {
          var list = enemiesInRange(b.x, b.y, b.range, false);
          if (list.length) {
            b.cd = s.cd;
            var hit = list.slice(0, s.targets);
            for (var k = 0; k < hit.length; k++) {
              G.fx.push({ type: 'bolt', x1: b.x, y1: b.y - 10, x2: hit[k].x, y2: hit[k].y, life: 0.18, max: 0.18, color: '#c39bff' });
              hurtUnit(hit[k], s.dmg);
              if (chance(s.chain)) {
                var others = enemiesInRange(hit[k].x, hit[k].y, 70, false);
                for (var q = 0; q < others.length; q++) {
                  if (hit.indexOf(others[q]) >= 0) continue;
                  G.fx.push({ type: 'bolt', x1: hit[k].x, y1: hit[k].y, x2: others[q].x, y2: others[q].y, life: 0.16, max: 0.16, color: '#c39bff' });
                  hurtUnit(others[q], s.dmg * 0.6);
                  break;
                }
              }
            }
            Sound.zap();
          }
        }
      } else if (b.def.key === 'thunder') {              // 雷瓦斯：电磁塔 + 天雷
        b.cd -= dt * rm;
        if (b.cd <= 0) {
          var tl = enemiesInRange(b.x, b.y, b.range, false);
          if (tl.length) {
            b.cd = s.cd;
            var th = tl.slice(0, s.targets);
            for (var tk = 0; tk < th.length; tk++) {
              G.fx.push({ type: 'bolt', x1: b.x, y1: b.y - 14, x2: th[tk].x, y2: th[tk].y, life: 0.18, max: 0.18, color: '#ffe066' });
              hurtUnit(th[tk], s.dmg);
              if (chance(s.chain)) {                     // 连锁到旁边一个敌人
                var to = enemiesInRange(th[tk].x, th[tk].y, 74, false);
                for (var tq = 0; tq < to.length; tq++) {
                  if (th.indexOf(to[tq]) >= 0) continue;
                  G.fx.push({ type: 'bolt', x1: th[tk].x, y1: th[tk].y, x2: to[tq].x, y2: to[tq].y, life: 0.16, max: 0.16, color: '#ffe066' });
                  hurtUnit(to[tq], s.dmg * 0.6);
                  break;
                }
              }
              if (chance(s.boltChance)) {                // 天雷劈中
                G.fx.push({ type: 'bolt', x1: th[tk].x, y1: th[tk].y - 140, x2: th[tk].x, y2: th[tk].y, life: 0.32, max: 0.32, color: '#fff6b0' });
                hurtUnit(th[tk], s.boltDmg);
                burst(th[tk].x, th[tk].y, 6, '#ffe066', 90);
                shake(3);
              }
            }
            Sound.zap();
          }
        }
      } else if (b.def.key === 'cannon') {
        if (b.volley > 0) {
          b.vtimer -= dt * rm;
          if (b.vtimer <= 0) {
            var tg = towerTarget(b, b.range, 0, false);
            if (tg) b.angle = Math.atan2(tg.y - b.y, tg.x - b.x);
            var bt = tg || { x: b.x + Math.cos(b.angle) * 100, y: b.y + Math.sin(b.angle) * 100 };
            for (var p = 0; p < s.per; p++) {
              var crit = chance(s.crit);
              addProj({
                side: 'def', kind: 'shell', x: b.x, y: b.y, target: tg,
                tx: bt.x + rand(-14, 14), ty: bt.y + rand(-14, 14),
                speed: 430, dmg: s.dmg * (crit ? s.critMul : 1),
                color: crit ? '#ff5c5c' : '#ffa94d', r: crit ? 6 : 5
              });
            }
            b.volley--; b.vtimer = 0.13;
            Sound.boom();
            if (b.volley === 0) b.cd = s.cd;
          }
        } else {
          b.cd -= dt * rm;
          if (b.cd <= 0 && towerTarget(b, b.range, 0, false)) { b.volley = s.volley; b.vtimer = 0; }
        }
      } else if (b.def.key === 'bamboo') {
        if (chance(dt * 1.6)) G.parts.push({ x: b.x + rand(-10, 10), y: b.y - 10, vx: rand(-6, 6), vy: rand(-24, -10), life: .9, maxLife: .9, color: '#cfe8cf', r: rand(2, 4) });
      } else if (b.def.key === 'mortar') {
        b.cd -= dt * rm;
        if (b.cd <= 0) {
          var m = towerTarget(b, b.range, b.minRange, false);
          if (m) {
            b.cd = s.cd;
            b.angle = Math.atan2(m.y - b.y, m.x - b.x);
            addProj({
              side: 'def', kind: 'mortar', x: b.x, y: b.y - 10, sx: b.x, sy: b.y - 10,
              tx: m.x, ty: m.y, t: 0, dur: s.delay, dmg: s.dmg, splash: s.splash, color: '#c3cad6', r: 8
            });
            Sound.boom();
          }
        }
      } else if (b.def.key === 'heavymortar') {          // 重型迫击炮：超大铁石
        b.cd -= dt * rm;
        if (b.cd <= 0) {
          var hm = towerTarget(b, b.range, b.minRange, false);
          if (hm) {
            b.cd = s.cd;
            b.angle = Math.atan2(hm.y - b.y, hm.x - b.x);
            addProj({
              side: 'def', kind: 'mortar', x: b.x, y: b.y - 16, sx: b.x, sy: b.y - 16,
              tx: hm.x, ty: hm.y, t: 0, dur: s.delay, dmg: s.dmg, splash: s.splash,
              color: '#8d97a6', r: s.r || 15
            });
            shake(3); Sound.boom();
          }
        }
      } else if (b.def.key === 'frostcrush') {           // 骨碎寒冰机：震地 + 必定冰冻
        b.cd -= dt * rm;
        if (b.cd <= 0) {
          var fn = enemiesInRange(b.x, b.y, b.range, true);
          if (fn.length) {
            b.cd = s.cd;
            for (var fci = 0; fci < fn.length; fci++) {
              var fu = fn[fci];
              hurtUnit(fu, s.dmg);
              if (immuneDebuff(fu)) { debuffBlocked(fu); continue; }
              fu.freezeT = Math.max(fu.freezeT || 0, s.freezeDur);
              fu.slow = 0; fu.slowT = 0;                 // 冰冻顶掉减速，状态干净
              floatText(fu.x, fu.y - 20, '冰冻', '#9be8ff');
            }
            G.fx.push({ type: 'ring', x: b.x, y: b.y, r0: 8, r1: b.range, life: 0.4, max: 0.4, color: '#9be8ff' });
            for (var fcp = 0; fcp < 14; fcp++) {
              var fa = rand(0, TAU), frr = rand(10, b.range);
              G.parts.push({ x: b.x + Math.cos(fa) * frr, y: b.y + Math.sin(fa) * frr, vx: rand(-10, 10), vy: rand(-30, -8), life: .6, maxLife: .6, color: '#cfefff', r: rand(2, 4) });
            }
            shake(9); Sound.boom();
          }
        }
      } else if (b.def.key === 'shaker') {
        b.cd -= dt * rm;
        if (b.cd <= 0) {
          var near = enemiesInRange(b.x, b.y, b.range, true);
          if (near.length) {
            b.cd = s.cd;
            for (var n = 0; n < near.length; n++) hurtUnit(near[n], s.dmg);
            G.fx.push({ type: 'ring', x: b.x, y: b.y, r0: 8, r1: b.range, life: 0.35, max: 0.35, color: '#d9a066' });
            shake(7); Sound.boom();
          }
        }
      } else if (b.def.key === 'mage') {
        b.cd -= dt * rm;
        if (b.cd <= 0) {
          var mg = towerTarget(b, b.range, 0, false);
          if (mg) {
            b.cd = s.cd;
            b.angle = Math.atan2(mg.y - b.y, mg.x - b.x);
            addProj({
              side: 'def', kind: 'fireball', x: b.x, y: b.y - 8, target: mg, tx: mg.x, ty: mg.y,
              speed: 300, dmg: s.dmg, splash: s.splash, color: '#ff7b54', r: 8,
              burnChance: s.burnChance, burnDps: s.burnDps, burnDur: s.burnDur
            });
            Sound.shoot();
          }
        }
      } else if (b.def.key === 'catapult') {
        b.cd -= dt * rm;
        if (b.cd <= 0) {
          var cp = towerTarget(b, b.range, b.minRange, false);
          if (cp) {
            b.cd = s.cd;
            b.angle = Math.atan2(cp.y - b.y, cp.x - b.x);
            addProj({
              side: 'def', kind: 'stone', x: b.x, y: b.y - 10, sx: b.x, sy: b.y - 10,
              tx: cp.x, ty: cp.y, t: 0, dur: 0.9, dmg: s.dmg, splash: s.splash,
              roll: s.roll, rollSpeed: s.rollSpeed, color: '#a1887f', r: 10
            });
            Sound.boom();
          }
        }
      } else if (b.def.key === 'iceberg') {
        b.cd -= dt * rm;
        if (b.cd <= 0) {
          var cold = enemiesInRange(b.x, b.y, b.range, false);
          if (cold.length) {
            b.cd = s.cd;
            for (var c = 0; c < cold.length; c++) {
              var e2 = cold[c];
              hurtUnit(e2, s.dmg);
              if (e2.dead) continue;
              applySlow(e2, s.slow, s.slowDur);
              if (chance(s.freezeChance)) {
                if (immuneDebuff(e2)) debuffBlocked(e2);
                else { e2.freezeT = s.freezeDur; floatText(e2.x, e2.y - 20, '冻结', '#74d0ff'); }
              }
            }
            G.fx.push({ type: 'ring', x: b.x, y: b.y, r0: 6, r1: b.range, life: 0.4, max: 0.4, color: '#74d0ff' });
          }
        }
      } else if (b.def.key === 'skull') {
        var skAlive = 0;                                  // 场上自家骷髅数量
        for (var sk = 0; sk < G.units.length; sk++) {
          var sku = G.units[sk];
          if (!sku.dead && sku.side === 'def' && sku.key === 'skeleton') skAlive++;
        }
        b.cd -= dt * rm;
        if (b.cd <= 0 && skAlive < (s.max || 10)) {       // 到上限就不召，等有空位再继续
          var skes = enemiesInRange(b.x, b.y, b.range, false);
          if (skes.length) {
            b.cd = s.cd;
            summonAround('skeleton', 'def', b.x, b.y, s.count, s.life);
            G.fx.push({ type: 'ring', x: b.x, y: b.y, r0: 6, r1: 40, life: 0.4, max: 0.4, color: '#e6e6f0' });
          }
        }
      } else if (b.def.key === 'prism') {
        b.cd -= dt * rm;
        if (b.cd <= 0) {
          var pt = towerTarget(b, b.range, 0, false);
          if (pt) {
            b.cd = s.cd;
            b.angle = Math.atan2(pt.y - b.y, pt.x - b.x);
            var ex2 = b.x + Math.cos(b.angle) * b.range * 1.25;
            var ey2 = b.y + Math.sin(b.angle) * b.range * 1.25;
            G.fx.push({ type: 'beam', x1: b.x, y1: b.y - 6, x2: ex2, y2: ey2, life: 0.3, max: 0.3, color: '#7ce7ff', w: 4 });
            // 光束穿透沿途杂兵
            var along = enemiesInRange(b.x, b.y, b.range * 1.25, false);
            var struck = [];
            for (var ai = 0; ai < along.length; ai++) {
              if (pointSegDist(along[ai].x, along[ai].y, b.x, b.y, ex2, ey2) <= s.pierce) {
                hurtUnit(along[ai], s.dmg);
                struck.push(along[ai]);
              }
            }
            // 折射到附近 2~3 名敌人
            var maxR = 2 + (chance(0.5) ? 1 : 0), refracted = 0;
            for (var ri = 0; ri < struck.length && refracted < maxR; ri++) {
              var from = struck[ri];
              var near = enemiesInRange(from.x, from.y, s.refractRange, false);
              for (var rj = 0; rj < near.length && refracted < maxR; rj++) {
                if (struck.indexOf(near[rj]) >= 0 && near[rj] !== from) continue;
                if (near[rj] === from) continue;
                G.fx.push({ type: 'bolt', x1: from.x, y1: from.y, x2: near[rj].x, y2: near[rj].y, life: 0.18, max: 0.18, color: '#7ce7ff' });
                hurtUnit(near[rj], s.dmg * s.refractMul);
                struck.push(near[rj]);
                refracted++;
                break;
              }
            }
            Sound.zap();
          }
        }
      } else if (b.def.key === 'laser') {                // 激光塔：超长穿透激光
        b.cd -= dt * rm;
        if (b.cd <= 0) {
          var lt = towerTarget(b, b.range, 0, false);
          if (lt) {
            b.cd = s.cd;
            b.angle = Math.atan2(lt.y - b.y, lt.x - b.x);
            var len = s.len || 420, hw = (s.w || 8) * 0.5 + 6;
            var lx = b.x + Math.cos(b.angle) * len, ly = b.y + Math.sin(b.angle) * len;
            G.fx.push({ type: 'beam', x1: b.x, y1: b.y - 10, x2: lx, y2: ly, life: 0.45, max: 0.45, color: '#ff5c8a', w: s.w || 8 });
            var lal = enemiesInRange(b.x, b.y, len, false);
            for (var li = 0; li < lal.length; li++) {
              if (pointSegDist(lal[li].x, lal[li].y, b.x, b.y, lx, ly) <= hw) hurtUnit(lal[li], s.dmg);
            }
            shake(3); Sound.zap();
          }
        }
      } else if (b.def.key === 'mine') {                              // 矿洞（无尽模式专属）：战斗中每秒产金，修整阶段不产出
        if (G.mode === 'endless' && G.phase === 'wave') {
          b.mineT = (b.mineT || 0) + dt * rm;
          if (b.mineT >= 1) {
            b.mineT -= 1;
            var mg = s.goldPerSec || 1;
            G.gold += mg;
            floatText(b.x, b.y - 24, '+' + mg, '#ffc857');
            if (chance(0.5)) G.parts.push({ x: b.x + rand(-10, 10), y: b.y - 12, vx: rand(-6, 6), vy: rand(-26, -10), life: .7, maxLife: .7, color: '#ffc857', r: rand(1.5, 3) });
          }
        }
      } else if (b.def.aura) {                                        // 圣佑祭坛 / 圣杯：范围内友方建筑缓慢回血
        var allies = buildingsNear(b.x, b.y, b.range);
        for (var al = 0; al < allies.length; al++) {
          var ab = allies[al];
          if (ab.corroded) continue;                                  // 被腐蚀的建筑吃不到增益
          if (ab.hp < ab.maxHp) ab.hp = Math.min(ab.maxHp, ab.hp + s.heal * dt);
        }
        if (chance(dt * 1.2)) G.parts.push({ x: b.x + rand(-16, 16), y: b.y + rand(-16, 16), vx: rand(-4, 4), vy: rand(-22, -8), life: .8, maxLife: .8, color: '#ffe9a8', r: rand(1.5, 3) });
      } else if (b.def.key === 'gravity') {
        b.cd -= dt * rm;
        if (b.cd <= 0) {
          var gs = enemiesInRange(b.x, b.y, b.range, false);
          if (gs.length) {
            b.cd = s.cd;
            for (var gi = 0; gi < gs.length; gi++) {
              var gu = gs[gi];
              if (gu.dead || gu.def.flying || HEAVY[gu.key]) continue; // 对强力角色无效
              var ga = Math.atan2(gu.y - b.y, gu.x - b.x);             // 由中心向外推
              gu.x = clamp(gu.x + Math.cos(ga) * s.knock, 8, W - 8);
              gu.y = clamp(gu.y + Math.sin(ga) * s.knock, 8, H - 8);
              hurtUnit(gu, s.dmg);                                     // 极低伤害
            }
            G.fx.push({ type: 'ring', x: b.x, y: b.y, r0: 10, r1: b.range, life: 0.5, max: 0.5, color: '#b39ddb' });
            shake(2); Sound.hurt();
          }
        }
      } else if (b.def.key === 'spore') {
        b.cd -= dt * rm;
        if (b.cd <= 0) {
          var sp = towerTarget(b, b.range, 0, false);
          if (sp) {
            b.cd = s.cd;
            b.angle = Math.atan2(sp.y - b.y, sp.x - b.x);
            var stg = [sp];                                  // 尽量把 3 枚孢子分散给不同敌人
            var ses = enemiesInRange(b.x, b.y, b.range, false);
            for (var se = 0; se < ses.length && stg.length < (s.count || 3); se++) {
              if (stg.indexOf(ses[se]) < 0) stg.push(ses[se]);
            }
            for (var si3 = 0; si3 < (s.count || 3); si3++) {
              var st2 = stg[si3 % stg.length];
              addProj({
                side: 'def', kind: 'spore', x: b.x + rand(-6, 6), y: b.y - 8 + rand(-6, 6),
                target: st2, tx: st2.x, ty: st2.y,
                speed: 250, dmg: s.dmg, splash: s.splash, color: '#a3e635', r: 7,
                poisonDps: s.poisonDps, poisonDur: s.poisonDur, maxStacks: s.maxStacks,
                homing: s.homing, ttl: s.ttl                 // 短距离跟踪，飞太久就地消散
              });
            }
            G.fx.push({ type: 'ring', x: b.x, y: b.y - 8, r0: 4, r1: 22, life: 0.25, max: 0.25, color: '#a3e635' });
            Sound.shoot();
          }
        }
      } else if (b.def.key === 'trap') {
        var tr = enemiesInRange(b.x, b.y, s.radius, false);
        if (tr.length) {
          for (var t2 = 0; t2 < tr.length; t2++) {                 // 踩到的敌人全部挂上毒素
            applyPoison(tr[t2], s.poisonDps, s.poisonDur, s.maxStacks || 1);
          }
          G.fx.push({ type: 'ring', x: b.x, y: b.y, r0: 6, r1: s.radius + 10, life: 0.4, max: 0.4, color: '#a3e635' });
          floatText(b.x, b.y - 20, '毒素陷阱！', '#a3e635');
          burst(b.x, b.y, 12, '#a3e635', 110);
          shake(3); Sound.hurt();
          b.dead = true;
          G.buildings.splice(i, 1);
          syncUI();
          continue;
        }
      } else if (b.def.key === 'bomb') {
        var bt = enemiesInRange(b.x, b.y, s.radius, false);
        if (bt.length) {
          var bl = enemiesInRange(b.x, b.y, s.splash, false);
          for (var bi = 0; bi < bl.length; bi++) {
            var bu = bl[bi];
            if (bu.dead) continue;
            hurtUnit(bu, HEAVY[bu.key] ? s.dmg * s.heavyMul : s.dmg);
          }
          G.fx.push({ type: 'ring', x: b.x, y: b.y, r0: 8, r1: s.splash + 16, life: 0.45, max: 0.45, color: '#ff6b3d' });
          G.fx.push({ type: 'ring', x: b.x, y: b.y, r0: 4, r1: s.splash, life: 0.25, max: 0.25, color: '#ffd166' });
          floatText(b.x, b.y - 20, '炸弹引爆！', '#ff6b3d');
          burst(b.x, b.y, 22, '#ff6b3d', 180);
          burst(b.x, b.y, 10, '#ffd166', 120);
          shake(8); Sound.boom();
          b.dead = true;
          G.buildings.splice(i, 1);
          syncUI();
          continue;
        }
      }

      // 腐蚀：每次攻击有概率让冷却时间增加（不叠加）
      if (b.corrodedT > 0) {
        b.corrodedT -= dt;
        if (b.corrodedT <= 0) { b.corroded = false; b.corrodedT = 0; }
        if (b.cd > (b.prevCd || 0) + 0.001 && chance(0.5)) {
          b.cd += 1.5;
          floatText(b.x, b.y - 30, '腐蚀：冷却 +1.5s', '#84cc16');
        }
      }
      b.prevCd = b.cd;
    }
  }

  function shoot(b, t, dmg, kind) {
    addProj({
      side: 'def', kind: kind, x: b.x, y: b.y, target: t, tx: t.x, ty: t.y,
      speed: kind === 'arrow' ? 520 : 380, dmg: dmg, color: b.def.color, r: kind === 'arrow' ? 3 : 5
    });
    Sound.shoot();
  }

  // ================= 单位逻辑 =================
  function updateUnits(dt) {
    refreshFocus();
    for (var i = G.units.length - 1; i >= 0; i--) {
      var u = G.units[i];
      if (u.dead) { G.units.splice(i, 1); continue; }

      if (u.life > 0) {                          // 召唤物存在时间（如骷髅屋的骷髅 7 秒）
        u.life -= dt;
        if (u.life <= 0) {
          burst(u.x, u.y, 8, u.def.color, 70);
          G.parts.push({ x: u.x, y: u.y, vx: 0, vy: -14, life: .4, maxLife: .4, color: '#e6e6f0', r: 3 });
          G.units.splice(i, 1);
          continue;
        }
      }

      if (u.burnT > 0) {
        u.burnT -= dt;
        hurtUnit(u, u.burnDps * dt, { silent: true });
        if (chance(0.3)) G.parts.push({ x: u.x + rand(-6, 6), y: u.y + rand(-6, 6), vx: rand(-6, 6), vy: rand(-26, -10), life: .45, maxLife: .45, color: '#ff8a3d', r: rand(1.5, 3) });
        if (u.dead) { G.units.splice(i, 1); continue; }
      }
      if (u.poisonT > 0) {                                   // 毒素：可叠加，但不会杀死敌人
        u.poisonT -= dt;
        if (!u.burrowed) {                                     // 钻地期间免疫毒素
          var pd = u.poisonDps * u.poisonStacks * dt;
          u.hp = Math.max(1, u.hp - pd);
          if (chance(0.25)) G.parts.push({ x: u.x + rand(-6, 6), y: u.y + rand(-6, 6), vx: rand(-6, 6), vy: rand(-22, -8), life: .5, maxLife: .5, color: '#a3e635', r: rand(1.5, 3) });
        }
      }
      if (u.freezeT > 0) { u.freezeT -= dt; continue; }
      if (u.slowT > 0) { u.slowT -= dt; if (u.slowT <= 0) u.slow = 0; }

      if (u.key === 'destroyer') { updateDestroyer(u, dt); continue; }
      if (u.def.noAttack) { updateSupport(u, dt); continue; }   // 梦魇母巢 / 缚灵祭司

      var tgt = u.target;
      if (u.side === 'atk') {
        tgt = u.target = acquireAttackTarget(u);          // 先打附近的骷髅，否则全军集火同一个建筑
      } else {
        if (!tgt || tgt.dead) tgt = u.target = acquireEnemyTarget(u);
      }
      u.bob += dt * 6;

      if (u.def.special === 'burrow') updateBurrow(u, dt, tgt); // 掘地虫钻地
      if (u.def.trail) {                                        // 炎狱泰坦：走过的地面燃烧
        u.trailT = (u.trailT || 0) - dt;
        if (u.trailT <= 0) {
          u.trailT = u.def.trail.gap;
          G.zones.push({ x: u.x, y: u.y, r: u.def.trail.r, life: u.def.trail.life, dps: u.def.trail.dps, side: 'atk', color: '#ff5722', hitBuildings: true });
        }
      }

      if (!tgt) {
        var cx = G.castle ? G.castle.x : W / 2, cy = G.castle ? G.castle.y : H / 2;
        moveToward(u, cx, cy, dt * 0.5);
        continue;
      }
      var d = unitDist(u.x, u.y, tgt);
      // 裂岩墙会把敌人往外推，攻击距离放宽一点，免得贴着墙却一直够不着
      var reach = u.range + ((tgt.def && tgt.def.blocking) ? 10 : 0);
      if (d <= reach) {
        u.angle = Math.atan2(tgt.y - u.y, tgt.x - u.x);
        u.cd -= dt;
        if (u.cd <= 0) { u.cd = u.cdBase; attack(u, tgt); }
      } else {
        if (u.def.flying || u.def.passThrough) {
          moveToward(u, tgt.x, tgt.y, dt);                 // 飞行 / 穿墙单位不受阻挡
          u.wallTarget = null;
        } else {
          moveAvoidWalls(u, tgt.x, tgt.y, dt);             // 会绕着墙走
          // 真的绕不过去（1 秒内几乎没靠近目标）→ 改拆挡在前面的那堵墙
          // 判定"真卡住"：这一秒实际位移不到正常速度的 40%（绕行时位移是满的，不会误判）
          u.stuckT += dt;
          if (u.stuckT >= 1) {
            var moved = dist(u.x, u.y, u.stuckX === undefined ? u.x : u.stuckX, u.stuckY === undefined ? u.y : u.stuckY);
            var full = u.def.speed * (u.speedBoost || 1) * (1 - u.slow);
            u.stuckX = u.x; u.stuckY = u.y; u.stuckT = 0;
            if (moved < full * 0.4) {
              var bw = blockingWallAhead(u, 78, tgt);
              if (bw && bw !== u.wallTarget) { u.wallTarget = bw; u.wallUntil = G.time + 10; u.stuckT = 0; }
            }
          }
        }
      }
      separate(u, dt);
      if (u.side === 'atk' && !u.def.passThrough && !u.def.flying) resolveWalls(u);
    }
  }

  // 支撑型角色：梦魇母巢（生成掘地虫）、缚灵祭司（套护盾）
  function updateSupport(u, dt) {
    var s = u.def.s || {};
    if (u.def.special === 'hive') {
      u.cd -= dt;
      if (u.cd <= 0) {
        u.cd = s.cd;
        var n = 0;
        for (var i = 0; i < G.units.length; i++) if (G.units[i].side === 'atk') n++;
        if (n < 70) {
          summonAround(s.spawn, 'atk', u.x, u.y, s.count);                        // 掘地虫
          if (s.spawn2) summonAround(s.spawn2, 'atk', u.x, u.y, s.count2 || s.count); // 腐蚀虫
        }
        G.fx.push({ type: 'ring', x: u.x, y: u.y, r0: 8, r1: 62, life: 0.5, max: 0.5, color: '#8e5bd6' });
      }
    } else if (u.def.special === 'priest') {
      u.cd -= dt;
      if (u.cd <= 0) {
        u.cd = s.cd;
        var given = 0;
        for (var k = 0; k < G.units.length; k++) {
          var t = G.units[k];
          if (t === u || t.dead || t.side !== u.side || t.shield) continue;
          if (dist(u.x, u.y, t.x, t.y) <= s.range) { t.shield = true; given++; }
        }
        if (given) {
          G.fx.push({ type: 'ring', x: u.x, y: u.y, r0: 6, r1: s.range, life: 0.5, max: 0.5, color: '#a5f3d0' });
          floatText(u.x, u.y - 24, '护盾 ×' + given, '#a5f3d0');
        }
      }
    }
    var tgt = u.target;
    if (u.side === 'atk') tgt = u.target = acquireAttackTarget(u);
    else if (!tgt || tgt.dead) tgt = u.target = acquireEnemyTarget(u);
    if (tgt) {
      var d = dist(u.x, u.y, tgt.x, tgt.y);
      if (d > 100) moveAvoidWalls(u, tgt.x, tgt.y, dt);
      else u.angle = Math.atan2(tgt.y - u.y, tgt.x - u.x);
    }
    u.bob += dt * 6;
  }

  // 掘地虫：钻地期间不会被塔选中，靠近建筑时钻出
  function updateBurrow(u, dt, tgt) {
    var s = u.def.s;
    var db = tgt ? dist(u.x, u.y, tgt.x, tgt.y) : 9999;
    if (u.burrowed) {
      u.burrowT -= dt;
      if (u.burrowT <= 0 || db <= s.emergeRange) {
        u.burrowed = false;
        u.speedBoost = 1;
        u.burrowCd = s.cd;
        burst(u.x, u.y, 8, '#d97706', 90);
      }
    } else {
      u.burrowCd -= dt;
      if (u.burrowCd <= 0 && db > 110) {
        u.burrowed = true;
        u.burrowT = s.duration;
        u.speedBoost = s.speedBoost;
        burst(u.x, u.y, 8, '#8a6b45', 90);
      }
    }
  }

  // 阻挡建筑（裂岩墙）：把敌人挡在外面
  function resolveWalls(u) {
    for (var i = 0; i < G.buildings.length; i++) {
      var b = G.buildings[i];
      if (b.dead || !b.def.blocking) continue;
      var min = 26 + (u.def.r || 9) * 0.4;
      var d = dist(u.x, u.y, b.x, b.y);
      if (d < min && d > 0.001) {
        var f = (min - d) / d;
        u.x += (u.x - b.x) * f;
        u.y += (u.y - b.y) * f;
      }
    }
  }

  function moveToward(u, x, y, dt) {
    var sp = u.def.speed * (u.speedBoost || 1) * (1 - u.slow) * dt;
    var dx = x - u.x, dy = y - u.y, d = Math.sqrt(dx * dx + dy * dy);
    if (d < 0.001) return;
    u.x += dx / d * sp; u.y += dy / d * sp;
    u.angle = Math.atan2(dy, dx);
    u.x = clamp(u.x, 8, W - 8); u.y = clamp(u.y, 8, H - 8);
  }

  // 挡在去目标路上的裂岩墙（单位前方 r 像素内）
  var WALL_SENSE = 84;
  function blockingWallAhead(u, r, tgt) {
    var dx = 0, dy = 0;
    if (tgt) {
      var dd = dist(u.x, u.y, tgt.x, tgt.y) || 1;
      dx = (tgt.x - u.x) / dd; dy = (tgt.y - u.y) / dd;
    }
    var best = null, bd = 1e9;
    for (var i = 0; i < G.buildings.length; i++) {
      var b = G.buildings[i];
      if (b.dead || !b.def.blocking) continue;
      var wx = b.x - u.x, wy = b.y - u.y, wd = Math.sqrt(wx * wx + wy * wy);
      if (wd > r || wd < 0.001) continue;
      if (tgt && (wx / wd) * dx + (wy / wd) * dy < 0.2) continue;   // 墙不在前进方向上
      if (wd < bd) { bd = wd; best = b; }
    }
    return best;
  }

  // 朝目标走，但会贴着阻挡建筑侧向绕过去（不再顶着墙原地抖）
  function moveAvoidWalls(u, x, y, dt) {
    var dx = x - u.x, dy = y - u.y, d = Math.sqrt(dx * dx + dy * dy);
    if (d < 0.001) return;
    dx /= d; dy /= d;
    var ax = 0, ay = 0;
    for (var i = 0; i < G.buildings.length; i++) {
      var b = G.buildings[i];
      if (b.dead || !b.def.blocking) continue;
      var wx = b.x - u.x, wy = b.y - u.y, wd = Math.sqrt(wx * wx + wy * wy);
      if (wd > WALL_SENSE || wd < 0.001) continue;
      var nx = wx / wd, ny = wy / wd;
      var front = nx * dx + ny * dy;          // 墙挡在前面才绕
      if (front <= 0.1) continue;
      var px = -ny, py = nx;                  // 两支切线，选更贴近目标方向的那一支
      var side = (px * dx + py * dy) >= 0 ? 1 : -1;
      var w = (1 - wd / WALL_SENSE) * (0.8 + front);
      ax += px * side * w; ay += py * side * w;
    }
    var mx = dx + ax * 1.5, my = dy + ay * 1.5;
    var md = Math.sqrt(mx * mx + my * my) || 1;
    var sp = u.def.speed * (u.speedBoost || 1) * (1 - u.slow) * dt;
    u.x += mx / md * sp; u.y += my / md * sp;
    u.angle = Math.atan2(my, mx);
    u.x = clamp(u.x, 8, W - 8); u.y = clamp(u.y, 8, H - 8);
  }

  function separate(u, dt) {
    for (var i = 0; i < G.units.length; i++) {
      var o = G.units[i];
      if (o === u || o.dead || o.side !== u.side) continue;
      var rr = (u.def.r || 9) + (o.def.r || 9);
      var dx = u.x - o.x, dy = u.y - o.y, d = Math.sqrt(dx * dx + dy * dy);
      if (d > 0.001 && d < rr * 0.85) {
        var push = (rr * 0.85 - d) * 3 * dt;
        u.x += dx / d * push; u.y += dy / d * push;
      }
    }
  }

  function attack(u, tgt) {
    var d = u.def;
    if (d.special === 'prometheus') {                 // 普罗米修斯：先远程射满 5 发，之后永久转近战
      if (!u.phased) {
        addProj({
          side: 'atk', kind: 'orb', x: u.x, y: u.y, target: tgt, tx: tgt.x, ty: tgt.y,
          speed: 360, dmg: u.dmg, color: '#ffb347', r: 7
        });
        Sound.shoot();
        u.promShots = (u.promShots || 0) + 1;
        if (u.promShots >= (d.s.rangedShots || 5)) {
          u.phased = true;
          u.range = d.s.meleeRange || 36;
          floatText(u.x, u.y - 30, '近战形态', '#ffb347');
          G.fx.push({ type: 'ring', x: u.x, y: u.y, r0: 8, r1: 70, life: 0.5, max: 0.5, color: '#ffb347' });
        }
        return;
      }
      if (!tgt || tgt.dead) return;
      if (tgt.side) { hurtUnit(tgt, u.dmg); Sound.hurt(); return; }
      hurtBuilding(tgt, u.dmg);
      Sound.hurt();
      return;
    }
    if (d.ranged && !u.phased) {
      if (u.def.special === 'eyes') {
        if (u.variant === 'red') {
          var ang = Math.atan2(tgt.y - u.y, tgt.x - u.x);
          var ex = u.x + Math.cos(ang) * 260, ey = u.y + Math.sin(ang) * 260;
          G.fx.push({ type: 'beam', x1: u.x, y1: u.y, x2: ex, y2: ey, life: 0.22, max: 0.22, color: '#ff5c5c', w: 5 });
          var list = G.buildings.slice();
          if (G.castle && G.castle.hp > 0) list.push(G.castle);
          for (var i = 0; i < list.length; i++) {
            if (pointSegDist(list[i].x, list[i].y, u.x, u.y, ex, ey) < 28) hurtBuilding(list[i], u.dmg);
          }
          for (var bi = 0; bi < G.units.length; bi++) {      // 激光顺带扫到防守单位（骷髅）
            var bu2 = G.units[bi];
            if (bu2.dead || bu2.side !== 'def') continue;
            if (pointSegDist(bu2.x, bu2.y, u.x, u.y, ex, ey) < 20) hurtUnit(bu2, u.dmg);
          }
          Sound.zap();
          return;
        }
        addProj({
          side: 'atk', kind: 'purplefire', x: u.x, y: u.y, target: tgt, tx: tgt.x, ty: tgt.y,
          speed: 260, dmg: u.dmg, splash: 45, color: '#b06bff', r: 8, burnChance: 1, burnDps: 14, burnDur: 4
        });
        return;
      }
      if (u.key === 'wizard') {                       // 巫师：紫火（小范围爆炸 + 点燃）
        addProj({
          side: 'atk', kind: 'purplefire', x: u.x, y: u.y, target: tgt, tx: tgt.x, ty: tgt.y,
          speed: 260, dmg: u.dmg, splash: d.splash || 45, color: '#b06bff', r: 8,
          burnChance: 1, burnDps: d.burn.dps, burnDur: d.burn.dur
        });
        Sound.shoot();
        return;
      }
      var p = {
        side: 'atk', kind: 'orb', x: u.x, y: u.y, target: tgt, tx: tgt.x, ty: tgt.y,
        speed: 340, dmg: u.dmg, color: u.def.color, r: 5
      };
      if (d.bounce) p.bounce = d.bounce;
      if (d.burn) { p.burnChance = 1; p.burnDps = d.burn.dps; p.burnDur = d.burn.dur; }
      if (d.special === 'zeus') { p.color = '#ffe066'; p.zeus = 0.12; }
      addProj(p);
      Sound.shoot();
    } else {
      if (!tgt || tgt.dead) return;                     // 目标已经没了，别空挥一下
      if (tgt.side) { hurtUnit(tgt, u.dmg); Sound.hurt(); return; }   // 打的是防守单位（骷髅）
      hurtBuilding(tgt, u.dmg);
      if (d.slowBuilding && chance(d.slowBuilding.chance) && !tgt.isCastle) {
        tgt.rateSlowT = d.slowBuilding.dur;
        floatText(tgt.x, tgt.y - 22, '射速降低', '#dff3ff');
      }
      if (d.burn && !tgt.isCastle) {                 // 炎狱泰坦：点燃建筑
        tgt.burnT = d.burn.dur; tgt.burnDps = d.burn.dps;
      }
      if (u.def.special === 'corrode' && !tgt.isCastle) {  // 腐蚀虫：腐蚀建筑
        if (!tgt.corroded) floatText(tgt.x, tgt.y - 30, '腐蚀！', '#84cc16');
        tgt.corroded = true; tgt.corrodedT = u.def.s.dur;
      }
      Sound.hurt();
    }
  }

  function pointSegDist(px, py, x1, y1, x2, y2) {
    var dx = x2 - x1, dy = y2 - y1;
    var l2 = dx * dx + dy * dy;
    if (l2 === 0) return dist(px, py, x1, y1);
    var t = clamp(((px - x1) * dx + (py - y1) * dy) / l2, 0, 1);
    return dist(px, py, x1 + t * dx, y1 + t * dy);
  }

  // 毁灭者专用：随机挑一个建筑当撞击目标（不走普通敌人的集火逻辑）
  var RAM_REACH = 30, RAM_CD = 0.6;
  function randomBuildingTarget(u) {
    var list = [];
    for (var i = 0; i < G.buildings.length; i++) {
      var b = G.buildings[i];
      if (b.dead || b.def.untargetable) continue;
      list.push(b);
    }
    if (G.castle && G.castle.hp > 0) list.push(G.castle);
    if (!list.length) return null;
    var pick = list[Math.floor(Math.random() * list.length)];
    if (pick === u.lastRam && list.length > 1) pick = list[Math.floor(Math.random() * list.length)]; // 尽量不连撞同一座
    return pick;
  }

  function updateDestroyer(u, dt) {
    var head = u.segs[0];
    u.speedMul = 1;                                  // 移速恒定：撞到建筑也不减速
    var sp = u.def.speed * u.speedMul * (1 - u.slow) * dt;
    u.ramCd = Math.max(0, (u.ramCd || 0) - dt);
    // 撞完一个立刻换下一个随机建筑，依次类推
    var tgt = u.target;
    if (!tgt || tgt.dead || u.ramDone) {
      tgt = u.target = randomBuildingTarget(u);
      u.ramDone = false;
    }
    if (tgt) {
      var dx = tgt.x - head.x, dy = tgt.y - head.y, d = Math.sqrt(dx * dx + dy * dy);
      if (d > 1) {
        head.x += dx / d * sp; head.y += dy / d * sp;
        if (d > 6) u.angle = Math.atan2(dy, dx);        // 贴得太近时不再反复改朝向，免得脑袋左右抽搐
      }
      if (u.ramCd <= 0 && dist(head.x, head.y, tgt.x, tgt.y) <= RAM_REACH) {   // 脑袋撞上了
        u.ramCd = RAM_CD;
        u.ramDone = true; u.lastRam = tgt;
        if (!tgt.isCastle) {
          var md = u.def.mouthDmg || 150;
          hurtBuilding(tgt, md);
          floatText(tgt.x, tgt.y - 26, '机械嘴 ' + md + '！', '#ff5c5c');
          shake(8); Sound.boom();
        } else {
          hurtBuilding(tgt, u.dmg);                     // 城堡只吃普通撞击伤害
          shake(4); Sound.boom();
        }
      }
    }
    for (var i = 1; i < u.segs.length; i++) {
      var prev = u.segs[i - 1], s = u.segs[i];
      var ddx = prev.x - s.x, ddy = prev.y - s.y, dd = Math.sqrt(ddx * ddx + ddy * ddy);
      if (dd > 20) {
        var f = (dd - 20) / dd;
        s.x += ddx * f; s.y += ddy * f;
      }
    }
    u.x = head.x; u.y = head.y;

    var targets = G.buildings.slice();
    if (G.castle && G.castle.hp > 0) targets.push(G.castle);
    for (var t = 0; t < targets.length; t++) {
      var b = targets[t];
      if (b.dead) continue;
      var touching = false;
      for (var k = 0; k < u.segs.length; k++) {
        if (dist(u.segs[k].x, u.segs[k].y, b.x, b.y) < 26) { touching = true; break; }
      }
      if (!touching) continue;
      if (b.dmgCd <= 0) { b.dmgCd = 0.5; hurtBuilding(b, u.dmg); }   // 身体蹭到的持续伤害
    }
    // 身体压到的防守单位（骷髅）也照样碾
    for (var du2 = 0; du2 < G.units.length; du2++) {
      var eu = G.units[du2];
      if (eu.dead || eu.side !== 'def') continue;
      eu.dmgCd = (eu.dmgCd || 0) - dt;
      if (unitDist(eu.x, eu.y, u) > 26) continue;
      if (eu.dmgCd <= 0) { eu.dmgCd = 0.5; hurtUnit(eu, u.dmg); }
    }
  }

  function centroid(list) {
    var x = 0, y = 0;
    for (var i = 0; i < list.length; i++) { x += list[i].x; y += list[i].y; }
    return { x: x / list.length, y: y / list.length };
  }

  // ================= 地面持续区域（火焰 / 尖刺） =================
  function updateZones(dt) {
    for (var i = G.zones.length - 1; i >= 0; i--) {
      var z = G.zones[i];
      z.life -= dt;
      if (z.life <= 0) { G.zones.splice(i, 1); continue; }
      for (var k = 0; k < G.units.length; k++) {
        var u = G.units[k];
        if (u.dead || u.side === z.side) continue;
        if (unitDist(z.x, z.y, u) <= z.r) hurtUnit(u, z.dps * dt, { silent: true, dot: true });
      }
      if (z.hitBuildings) {
        var bs = buildingsNear(z.x, z.y, z.r);
        for (var m = 0; m < bs.length; m++) hurtBuilding(bs[m], z.dps * dt * 0.6, { silent: true });
      }
      if (chance(dt * 10)) G.parts.push({ x: z.x + rand(-z.r, z.r), y: z.y + rand(-z.r, z.r), vx: rand(-6, 6), vy: rand(-30, -10), life: .5, maxLife: .5, color: z.color, r: rand(2, 4) });
    }
  }

  // 弹道原目标已阵亡：就近改锁新目标，避免子弹飞到空地上白炸
  function retargetProj(p) {
    if (p.side === 'def') {
      var es = enemiesInRange(p.x, p.y, 220, false);
      var bu = null, bdu = 1e9;
      for (var i = 0; i < es.length; i++) {
        var d0 = unitDist(p.x, p.y, es[i]);
        if (d0 < bdu) { bdu = d0; bu = es[i]; }
      }
      return bu;
    }
    var du = nearestDefUnit(p.x, p.y, 220);
    if (du) return du;
    if (targetAlive(G.focus)) return G.focus;
    var best = null, bd = 1e9;
    for (var k = 0; k < G.buildings.length; k++) {
      var b = G.buildings[k];
      if (b.dead || b.def.untargetable) continue;
      var d = dist(p.x, p.y, b.x, b.y);
      if (d < bd) { bd = d; best = b; }
    }
    if (best) return best;
    return (G.castle && G.castle.hp > 0) ? G.castle : null;
  }

  // ================= 弹道与滚石 =================
  function updateProjs(dt) {
    for (var i = G.projs.length - 1; i >= 0; i--) {
      var p = G.projs[i];
      if (p.kind === 'mortar' || p.kind === 'stone') {
        p.t += dt;
        var k = clamp(p.t / p.dur, 0, 1);
        p.x = p.sx + (p.tx - p.sx) * k;
        p.y = p.sy + (p.ty - p.sy) * k - Math.sin(k * Math.PI) * 120;
        if (k >= 1) {
          var hit = enemiesInRange(p.tx, p.ty, p.splash, false);
          for (var q = 0; q < hit.length; q++) hurtUnit(hit[q], p.dmg);
          G.fx.push({ type: 'ring', x: p.tx, y: p.ty, r0: 6, r1: p.splash, life: 0.35, max: 0.35, color: p.color });
          burst(p.tx, p.ty, p.kind === 'mortar' ? 18 : 12, p.color, 150);
          shake(5); Sound.boom();
          if (p.kind === 'stone') {
            G.rollers.push({ x: p.tx, y: p.ty, ang: rand(0, TAU), speed: p.rollSpeed || 74, life: p.roll, dmg: p.dmg * 0.7, r: 20, hits: {}, spin: 0 });
          }
          G.projs.splice(i, 1);
        }
        continue;
      }
      if (p.target && p.target.dead) {                 // 目标在飞行途中没了 → 换目标，别飞过去炸空气
        var nt = retargetProj(p);
        if (nt) p.target = nt;
      }
      if (p.target && !p.target.dead) {
        // 跟踪弹：只在限定范围内咬住目标，超出就直飞最后落点
        if (p.homing && dist(p.sx, p.sy, p.x, p.y) > p.homing) p.target = null;
        else if (p.target.segs) {                    // 毁灭者：瞄准最近的一段身体
          var ns = nearestSeg(p.target, p.x, p.y);
          p.tx = ns.x; p.ty = ns.y;
        } else { p.tx = p.target.x; p.ty = p.target.y; }
      }
      if (p.ttl !== undefined) {                     // 飞行时限：小距离弹道，超时就地消散
        p.ttl -= dt;
        if (p.ttl <= 0) { burst(p.x, p.y, 5, p.color, 70); G.projs.splice(i, 1); continue; }
      }
      var dx = p.tx - p.x, dy = p.ty - p.y, d = Math.sqrt(dx * dx + dy * dy);
      var step = p.speed * dt;
      if (d <= step || d < 3) {
        resolveProj(p);
        G.projs.splice(i, 1);
        continue;
      }
      p.x += dx / d * step; p.y += dy / d * step;
      p.a = Math.atan2(dy, dx);
    }
  }

  function resolveProj(p) {
    if (p.side === 'def') {
      if (p.splash) {
        var list = enemiesInRange(p.tx, p.ty, p.splash, false);
        for (var i = 0; i < list.length; i++) {
          hurtUnit(list[i], p.dmg);
          if (list[i].dead) continue;
          if (p.burnChance && chance(p.burnChance)) {
            if (immuneDebuff(list[i])) debuffBlocked(list[i]);
            else { list[i].burnT = p.burnDur; list[i].burnDps = p.burnDps; }
          }
          if (p.poisonDps) applyPoison(list[i], p.poisonDps, p.poisonDur, p.maxStacks);
        }
        G.fx.push({ type: 'ring', x: p.tx, y: p.ty, r0: 4, r1: p.splash, life: 0.3, max: 0.3, color: p.color });
        burst(p.tx, p.ty, 12, p.color, 120);
      } else if (p.target && !p.target.dead) {
        hurtUnit(p.target, p.dmg);
        if (!p.target.dead) {
          if (p.burnChance && chance(p.burnChance)) {
            if (immuneDebuff(p.target)) debuffBlocked(p.target);
            else { p.target.burnT = p.burnDur; p.target.burnDps = p.burnDps; }
          }
          if (p.poisonDps) applyPoison(p.target, p.poisonDps, p.poisonDur, p.maxStacks);
        }
        if (p.kind === 'arrow') burst(p.tx, p.ty, 3, '#ffffff', 60);
      }
      return;
    }
    var b = p.target;
    if (b && !b.dead) {
      if (b.side) {                                     // 目标是防守单位（骷髅）
        hurtUnit(b, p.dmg);
        if (p.burnChance && chance(p.burnChance)) {
          if (immuneDebuff(b)) debuffBlocked(b);
          else { b.burnT = p.burnDur; b.burnDps = p.burnDps; }
        }
        burst(b.x, b.y, 3, p.color, 60);
        return;
      }
      hurtBuilding(b, p.dmg);
      if (p.burnChance && chance(p.burnChance) && !b.isCastle) { b.burnT = p.burnDur; b.burnDps = p.burnDps; }
      if (p.zeus && chance(p.zeus)) {
        G.fx.push({ type: 'bolt', x1: b.x, y1: b.y - 130, x2: b.x, y2: b.y, life: 0.3, max: 0.3, color: '#ffe066' });
        var near = buildingsNear(b.x, b.y, 46);
        for (var n = 0; n < near.length; n++) hurtBuilding(near[n], 70);
        hurtBuilding(b, 70);
        shake(4);
      }
      if (p.bounce && chance(p.bounce)) {
        var alt = null, bd = 1e9;
        for (var k = 0; k < G.buildings.length; k++) {
          var o = G.buildings[k];
          if (o === b || o.dead) continue;
          var dd = dist(b.x, b.y, o.x, o.y);
          if (dd < 150 && dd < bd) { bd = dd; alt = o; }
        }
        if (alt) addProj({ side: 'atk', kind: 'orb', x: b.x, y: b.y, target: alt, tx: alt.x, ty: alt.y, speed: 300, dmg: p.dmg * 0.6, color: '#66d9e8', r: 4 });
      }
    }
    if (p.splash) {
      var nb = buildingsNear(p.tx, p.ty, p.splash);
      for (var m = 0; m < nb.length; m++) {
        hurtBuilding(nb[m], p.dmg * 0.6);
        if (p.burnChance && chance(p.burnChance) && !nb[m].isCastle) { nb[m].burnT = p.burnDur; nb[m].burnDps = p.burnDps; }
      }
      G.fx.push({ type: 'ring', x: p.tx, y: p.ty, r0: 4, r1: p.splash, life: 0.3, max: 0.3, color: p.color });
    }
  }

  function updateRollers(dt) {
    for (var i = G.rollers.length - 1; i >= 0; i--) {
      var r = G.rollers[i];
      r.life -= dt;
      if (r.life <= 0) { G.rollers.splice(i, 1); continue; }
      var best = null, bd = 1e9;
      var list = enemiesInRange(r.x, r.y, 240, false);
      for (var k = 0; k < list.length; k++) {
        var d = dist(r.x, r.y, list[k].x, list[k].y);
        if (d < bd) { bd = d; best = list[k]; }
      }
      if (best) {
        var want = Math.atan2(best.y - r.y, best.x - r.x);
        var diff = Math.atan2(Math.sin(want - r.ang), Math.cos(want - r.ang));
        r.ang += clamp(diff, -1.6 * dt, 1.6 * dt);
      }
      r.x += Math.cos(r.ang) * r.speed * dt;
      r.y += Math.sin(r.ang) * r.speed * dt;
      r.spin += dt * (r.speed / 12);                 // 自转速度跟着滚动速度走
      if (r.x < 10 || r.x > W - 10 || r.y < 10 || r.y > H - 10) r.life = Math.min(r.life, 0.2);
      var hits = enemiesInRange(r.x, r.y, r.r + 8, false);
      for (var h = 0; h < hits.length; h++) {
        var e = hits[h];
        if (G.time - (r.hits[e.id] || -9) < 0.7) continue;
        r.hits[e.id] = G.time;
        hurtUnit(e, r.dmg);
      }
      if (chance(dt * 6)) G.parts.push({ x: r.x, y: r.y + 8, vx: rand(-10, 10), vy: rand(-20, -6), life: .4, maxLife: .4, color: '#9c8b7a', r: rand(1.5, 3) });
    }
  }

  // ================= 特效 =================
  function burst(x, y, n, color, spd) {
    for (var i = 0; i < n; i++) {
      var a = rand(0, TAU), s = rand(spd * 0.25, spd);
      G.parts.push({ x: x, y: y, vx: Math.cos(a) * s, vy: Math.sin(a) * s, life: rand(0.25, 0.55), maxLife: 0.55, color: color, r: rand(1.5, 3.5) });
    }
  }
  function floatText(x, y, text, color) { G.texts.push({ x: x, y: y, text: text, color: color, life: 1, max: 1 }); }
  function shake(m) { G.shakeMag = m; G.shakeT = 0.25; }

  function updateFx(dt) {
    var i;
    for (i = G.fx.length - 1; i >= 0; i--) {
      var f = G.fx[i];
      f.life -= dt;
      if (f.life > 0) continue;
      if (f.type === 'claw' && f.b && !f.b.dead) hurtBuilding(f.b, 1e9);
      G.fx.splice(i, 1);
    }
    for (i = G.parts.length - 1; i >= 0; i--) {
      var p = G.parts[i];
      p.life -= dt;
      if (p.life <= 0) { G.parts.splice(i, 1); continue; }
      p.x += p.vx * dt; p.y += p.vy * dt;
      p.vy += 200 * dt; p.vx *= 0.96; p.vy *= 0.96;
    }
    for (i = G.texts.length - 1; i >= 0; i--) {
      var t = G.texts[i];
      t.life -= dt * 0.9; t.y -= 24 * dt;
      if (t.life <= 0) G.texts.splice(i, 1);
    }
    if (G.shakeT > 0) { G.shakeT -= dt; if (G.shakeT <= 0) G.shakeMag = 0; }
  }

  // ================= 模式流程 =================
  UNIT_DEFS.forEach(function (d) { if (!d.summon) d.isUnit = true; });

  function startVersusRound() {
    G.phase = 'defDeploy';
    G.units.length = 0; G.projs.length = 0; G.rollers.length = 0; G.zones.length = 0; G.fx.length = 0;
    for (var i = 0; i < G.buildings.length; i++) G.buildings[i].hp = G.buildings[i].maxHp;
    G.sel = null; G.focus = null;
    buildCards();
    syncUI();
  }

  function endDefDeploy() {
    if (!realBuildingCount()) { toast('防御方至少需要部署一座建筑（陷阱不算）'); return; }
    G.phase = 'atkDeploy'; G.sel = null;
    buildCards(); syncUI();
    toast('攻击方部署阶段：选角色后点击 / 轻点放置，右键或双指移除');
  }

  function startBattle() {
    var has = false;
    for (var i = 0; i < G.units.length; i++) if (G.units[i].side === 'atk') { has = true; break; }
    if (!has) { toast('攻击方至少需要部署一名角色'); return; }
    G.phase = 'battle'; G.sel = null; G.focus = null;
    buildCards(); syncUI();
    toast('战斗阶段：双方都无法部署或摧毁');
  }

  function realBuildingCount() {
    var n = 0;
    for (var i = 0; i < G.buildings.length; i++) {
      var b = G.buildings[i];
      if (b.isHq) continue;                                  // 大本营不算防御建筑
      if (!b.def.untargetable) n++;
    }
    return n;
  }

  function checkVersusEnd() {
    if (G.phase !== 'battle') return;
    // 攻击方胜利条件：摧毁防御方的大本营
    if (!G.hq || G.hq.dead || G.hq.hp <= 0) { endRound('atk'); return; }
    var atkAlive = false;
    for (var i = 0; i < G.units.length; i++) if (G.units[i].side === 'atk' && !G.units[i].dead) { atkAlive = true; break; }
    if (!atkAlive) { endRound('def'); return; }
  }

  function endRound(winner) {
    G.phase = 'roundEnd'; G.roundWinner = winner; G.sel = null;
    buildCards();
    if (winner === 'def') {
      showOverlay('第 ' + G.round + ' 轮：防御方守住！',
        '攻击方的角色已全部被消灭。\n防御方建筑已修复，下一轮双方金币依旧无限。',
        '开始第 ' + (G.round + 1) + ' 轮');
    } else {
      showOverlay('攻击方获胜！', '防御方的大本营被摧毁。', '重新开始');
    }
    syncUI();
  }

  function nextRound() {
    G.round++;
    G.goldDef += ROUND_INCOME;
    G.goldAtk += ROUND_INCOME;
    hideOverlay();
    startVersusRound();
  }

  function wavePool(n) {
    var pool = ['goblin', 'archer'];
    if (n >= 2) pool.push('warrior');
    if (n >= 3) pool.push('flameskull');
    if (n >= 4) pool.push('pulse');
    if (n >= 5) pool.push('bone');
    if (n >= 6) pool.push('wizard');
    if (n >= 7) pool.push('ghost', 'corrode');
    if (n >= 8) pool.push('snowman', 'burrow');
    if (n >= 10) pool.push('zeus', 'death', 'golem', 'priest');
    if (n >= 13) pool.push('arthur', 'eyes', 'titan');
    if (n >= 16) pool.push('destroyer', 'hive');
    return pool;
  }

  // Boss 波：每 5 波固定一次，Boss 按波次强度分档
  var BOSS_TIERS = [
    ['arthur', 'zeus'],        // 第 5 波
    ['titan', 'death'],        // 第 10 波
    ['eyes', 'hive', 'prometheus'],        // 第 15 波
    ['destroyer', 'titan', 'prometheus']   // 第 20 波及以后
  ];
  function isBossWave(n) { return n > 0 && n % 5 === 0; }
  function bossPick(n) {
    var tier = clamp(Math.floor(n / 5) - 1, 0, BOSS_TIERS.length - 1);
    var pool = BOSS_TIERS[tier];
    return pool[Math.floor(Math.random() * pool.length)];
  }

  function makeWave(n) {
    var W3 = CFG.wave;
    var pool = wavePool(n);
    var count = Math.min(W3.countMax, W3.countBase + Math.floor(n * W3.countPerWave));
    var list = [];
    var boss = isBossWave(n);
    if (boss) {
      var nb = n >= W3.doubleBossFrom ? 2 : 1;         // 后期双 Boss 压场
      for (var b2 = 0; b2 < nb; b2++) list.push(bossPick(n));
      var guards = Math.max(W3.bossGuardMin, Math.round(count * W3.bossGuardRatio));
      for (var g2 = 0; g2 < guards; g2++) list.push(pool[Math.floor(Math.random() * pool.length)]);
    } else {
      for (var i = 0; i < count; i++) list.push(pool[Math.floor(Math.random() * pool.length)]);
    }
    var gap = Math.max(W3.gapMin, W3.gapBase - n * W3.gapPerWave);
    return {
      n: n, list: list, boss: boss,
      hpMul: W3.hpBase + n * W3.hpPerWave,
      gap: boss ? Math.max(W3.bossGapMin, gap) : gap
    };
  }

  // 波次预告：统计下一波的兵种组成
  function wavePreview(n) {
    var w = makeWave(n), cnt = {}, order = [];
    for (var i = 0; i < w.list.length; i++) {
      var k = w.list[i];
      if (cnt[k] === undefined) { cnt[k] = 0; order.push(k); }
      cnt[k]++;
    }
    var parts = [];
    for (var j = 0; j < order.length && parts.length < 5; j++) {
      parts.push(U_MAP[order[j]].name + '×' + cnt[order[j]]);
    }
    var more = order.length > parts.length ? ' 等' : '';
    return { text: parts.join(' ') + more, boss: w.boss, hpMul: w.hpMul, count: w.list.length };
  }

  function edgePoint() {
    var s = Math.floor(Math.random() * 4);
    if (s === 0) return { x: -24, y: rand(40, H - 40) };
    if (s === 1) return { x: W + 24, y: rand(40, H - 40) };
    if (s === 2) return { x: rand(40, W - 40), y: -24 };
    return { x: rand(40, W - 40), y: H + 24 };
  }

  function spawnWaveUnit(key) {
    if (countAtk() >= UNIT_CAP) return;      // 场上敌人达到上限，这一只延后生成
    var p = edgePoint();
    var u = addUnit(key, 'atk', p.x, p.y);
    var mul = G.waveData ? G.waveData.hpMul : 1;
    u.hp = Math.round(u.hp * mul); u.maxHp = u.hp;
    if (key === 'eyes') {
      u.variant = 'red';
      var u2 = addUnit('eyes', 'atk', p.x + 20, p.y, 'purple');
      u2.hp = Math.round(u2.hp * mul); u2.maxHp = u2.hp;
    }
  }

  function startWave(bonus) {
    if (G.mode !== 'endless' || G.over) return;
    if (bonus && G.phase === 'rest') {
      var extra = Math.round(G.countdown * CFG.earlyBonusPerSec);   // 提前开波：剩余秒数换金币
      if (extra > 0) { G.gold += extra; floatText(W / 2, H / 2, '+' + extra + ' 提前奖励', '#ffc857'); }
    }
    G.wave++;
    G.waveData = makeWave(G.wave);
    G.spawnQueue = G.waveData.list.slice();
    G.spawnTimer = 0;
    G.phase = 'wave';
    G.preview = wavePreview(G.wave + 1);
    syncUI();
  }

  function finishWave() {
    var bonus = CFG.waveClearGold + G.wave * CFG.waveClearGoldPerWave;
    G.gold += bonus;
    G.score += G.wave * CFG.scorePerWave;
    floatText(W / 2, H / 2 - 30, '第 ' + G.wave + ' 波完成 +' + bonus, '#7ee787');
    Sound.coin();
    G.phase = 'rest';
    G.countdown = REST_SECONDS;
    G.preview = wavePreview(G.wave + 1);
    syncUI();
  }

  // 最高纪录（无尽模式：波次与得分）
  var best = { wave: 0, score: 0 };
  try {
    best.wave = parseInt(localStorage.getItem('td_best_wave') || '0', 10) || 0;
    best.score = parseInt(localStorage.getItem('td_best_score') || '0', 10) || 0;
  } catch (e) {}
  function saveBest() {
    var beat = G.wave > best.wave || G.score > best.score;
    if (G.wave > best.wave) best.wave = G.wave;
    if (G.score > best.score) best.score = G.score;
    if (beat) {
      try {
        localStorage.setItem('td_best_wave', String(best.wave));
        localStorage.setItem('td_best_score', String(best.score));
      } catch (e) {}
    }
    return beat;
  }

  function endlessOver() {
    G.over = true; G.phase = 'over';
    var isNew = saveBest();
    showOverlay('城堡陷落',
      '你在第 ' + G.wave + ' 波被攻破。\n累计击杀 ' + G.kills + ' 名敌人，得分 ' + G.score + '。\n' +
      '最高纪录：第 ' + best.wave + ' 波 / ' + best.score + ' 分' + (isNew ? '（新纪录！）' : ''),
      '再来一局');
    syncUI();
  }

  // ================= 渲染：背景 =================
  var bgCache = null;
  function buildBackground() {
    var c = document.createElement('canvas');
    c.width = W; c.height = H;
    var g = c.getContext('2d');
    for (var gx = 0; gx < COLS; gx++) {
      for (var gy = 0; gy < ROWS; gy++) {
        g.fillStyle = (gx + gy) % 2 === 0 ? '#1c3527' : '#21402c';
        g.fillRect(gx * CELL, gy * CELL, CELL, CELL);
      }
    }
    g.globalAlpha = 0.06;
    for (var k = 0; k < 300; k++) {
      g.fillStyle = '#9ff5b0';
      g.fillRect((k * 97) % W, (k * 173) % H, 2, 6);
    }
    g.globalAlpha = 1;
    g.strokeStyle = 'rgba(255,255,255,.05)'; g.lineWidth = 1;
    for (var i = 1; i < COLS; i++) { g.beginPath(); g.moveTo(i * CELL, 0); g.lineTo(i * CELL, H); g.stroke(); }
    for (var j = 1; j < ROWS; j++) { g.beginPath(); g.moveTo(0, j * CELL); g.lineTo(W, j * CELL); g.stroke(); }
    bgCache = c;
  }

  // ================= 渲染：建筑 =================
  function drawBuilding(c, b) {
    var s = 18;
    if (b.isHq) { drawHq(c, b); return; }
    if (b.level > 1) {                      // 升级过的塔：右上角标出等级
      c.save();
      c.translate(b.x, b.y);
      c.fillStyle = 'rgba(10,16,30,.85)';
      c.beginPath(); c.arc(15, -17, 8.5, 0, TAU); c.fill();
      c.strokeStyle = '#7ee787'; c.lineWidth = 1.4; c.stroke();
      c.fillStyle = '#7ee787';
      c.font = 'bold 9px "PingFang SC","Microsoft YaHei",sans-serif';
      c.textAlign = 'center'; c.textBaseline = 'middle';
      c.fillText(String(b.level), 15, -16.5);
      c.restore();
    }
    if (b.def.trap) {                       // 陷阱类：隐形（只留极淡的痕迹）
      c.save();
      c.translate(b.x, b.y);
      c.globalAlpha = 0.16;
      c.fillStyle = b.def.color;
      if (b.def.key === 'bomb') {           // 炸弹：淡圆 + 引信点
        c.beginPath(); c.arc(0, 0, 13, 0, TAU); c.fill();
        c.globalAlpha = 0.3;
        c.fillRect(-1.5, -18, 3, 6);
      } else {
        roundRect(c, -16, -16, 32, 32, 5); c.fill();
      }
      c.restore();
      return;
    }
    c.save();
    c.translate(b.x, b.y);
    if (b.rateSlowT > 0) {
      c.fillStyle = 'rgba(116,208,255,.22)';
      c.beginPath(); c.arc(0, 0, s + 5, 0, TAU); c.fill();
    }
    c.fillStyle = 'rgba(0,0,0,.3)';
    c.beginPath(); c.ellipse(0, 11, s, s * 0.4, 0, 0, TAU); c.fill();
    var gr = c.createLinearGradient(0, -s, 0, s);
    gr.addColorStop(0, '#54657f'); gr.addColorStop(1, '#2b3548');
    c.fillStyle = gr; roundRect(c, -s, -s, s * 2, s * 2, 5); c.fill();
    c.strokeStyle = 'rgba(255,255,255,.16)'; c.lineWidth = 1.5; c.stroke();
    drawBuildingArt(c, b);
    c.restore();
    drawHpBar(c, b.x, b.y - 26, Math.max(26, s * 2), b.hp / b.maxHp);
  }

  // 集火标记：红色虚线圈出敌人正在集中攻击的建筑
  function drawFocusMark() {
    var t = G.focus;
    if (!t || !targetAlive(t)) return;
    var r = t.isCastle ? 46 : (t.isHq ? 34 : 26);
    ctx.save();
    ctx.globalAlpha = 0.85;
    ctx.strokeStyle = '#ff5a5f'; ctx.lineWidth = 2; ctx.setLineDash([5, 4]);
    ctx.beginPath(); ctx.arc(t.x, t.y, r + G.time % 1 * 2, 0, TAU); ctx.stroke();
    ctx.setLineDash([]);
    ctx.restore();
  }

  // 双人自由模式：防御方大本营
  function drawHq(c, b) {
    c.save();
    c.translate(b.x, b.y);
    c.fillStyle = 'rgba(0,0,0,.32)';
    c.beginPath(); c.ellipse(0, 18, 28, 11, 0, 0, TAU); c.fill();
    var g = c.createLinearGradient(0, -24, 0, 16);
    g.addColorStop(0, '#ffeeb5'); g.addColorStop(1, '#c8952c');
    c.fillStyle = g; roundRect(c, -25, -18, 50, 38, 6); c.fill();
    c.strokeStyle = 'rgba(110,72,8,.65)'; c.lineWidth = 2; c.stroke();
    c.fillStyle = '#a9741f';                                  // 城垛
    for (var i = -1; i <= 1; i++) { roundRect(c, i * 15 - 6, -26, 12, 10, 2); c.fill(); }
    c.strokeStyle = '#6b4a10'; c.lineWidth = 2;               // 旗杆
    c.beginPath(); c.moveTo(0, -26); c.lineTo(0, -44); c.stroke();
    c.fillStyle = '#ff6b81';                                  // 旗帜
    c.beginPath(); c.moveTo(0, -44); c.lineTo(17, -38); c.lineTo(0, -32); c.closePath(); c.fill();
    c.fillStyle = '#fff6d8'; c.beginPath(); c.arc(0, 0, 8, 0, TAU); c.fill();
    c.fillStyle = '#e0a92c'; c.beginPath(); c.arc(0, 0, 4, 0, TAU); c.fill();
    c.restore();
    drawHpBar(c, b.x, b.y - 34, 52, b.hp / b.maxHp);
    c.save();
    c.font = 'bold 11px "PingFang SC",sans-serif';
    c.textAlign = 'center'; c.fillStyle = '#ffd76a';
    c.fillText('大本营', b.x, b.y - 40);
    c.restore();
  }

  function drawBuildingArt(c, b) {
    var col = b.def.color, key = b.def.key, t = G.time, ang = b.angle || -Math.PI / 2;
    c.save();
    if (key === 'archer') {
      c.fillStyle = '#6b7c96'; roundRect(c, -11, -11, 22, 22, 3); c.fill();
      for (var i = 0; i < 4; i++) {
        var ax = (i % 2 ? 6 : -6), ay = (i < 2 ? -6 : 6);
        c.fillStyle = '#eef3ff'; c.beginPath(); c.arc(ax, ay, 3.2, 0, TAU); c.fill();
        c.strokeStyle = col; c.lineWidth = 1.8;
        c.beginPath(); c.moveTo(ax, ay); c.lineTo(ax + Math.cos(ang) * 8, ay + Math.sin(ang) * 8); c.stroke();
      }
    } else if (key === 'tesla') {
      c.fillStyle = '#5a4a80'; roundRect(c, -3, -4, 6, 14, 2); c.fill();
      var pulse = 0.7 + 0.3 * Math.sin(t * 6);
      var gg = c.createRadialGradient(0, -10, 1, 0, -10, 12);
      gg.addColorStop(0, '#f2e9ff'); gg.addColorStop(1, 'rgba(160,110,255,.2)');
      c.fillStyle = gg; c.beginPath(); c.arc(0, -10, 10 * pulse, 0, TAU); c.fill();
      c.strokeStyle = col; c.lineWidth = 2; c.beginPath(); c.arc(0, -10, 10, 0, TAU); c.stroke();
    } else if (key === 'cannon') {
      c.save(); c.rotate(ang);
      c.fillStyle = '#ffb454'; roundRect(c, -2, -6, 22, 12, 4); c.fill();
      c.fillStyle = '#8a4f18'; roundRect(c, 16, -7, 5, 14, 2); c.fill();
      c.restore();
      c.fillStyle = '#e8590c'; c.beginPath(); c.arc(0, 0, 9, 0, TAU); c.fill();
      c.fillStyle = 'rgba(255,255,255,.35)'; c.beginPath(); c.arc(-3, -3, 3, 0, TAU); c.fill();
    } else if (key === 'bamboo') {
      for (var k2 = -1; k2 <= 1; k2++) {
        c.fillStyle = k2 === 0 ? '#7fce7f' : '#9be89b';
        roundRect(c, k2 * 7 - 2.5, -18, 5, 32, 2); c.fill();
        c.fillStyle = '#5da85d';
        for (var n2 = 0; n2 < 3; n2++) c.fillRect(k2 * 7 - 2.5, -14 + n2 * 9, 5, 1.6);
      }
      c.fillStyle = 'rgba(220,255,220,.3)';
      c.beginPath(); c.arc(Math.sin(t * 2) * 4, -20, 5, 0, TAU); c.fill();
    } else if (key === 'mortar') {
      c.save(); c.rotate(ang - Math.PI / 2);
      c.fillStyle = '#c3cad6'; roundRect(c, -6, -16, 12, 24, 3); c.fill();
      c.fillStyle = '#7c848f'; roundRect(c, -7, -18, 14, 5, 2); c.fill();
      c.restore();
      c.fillStyle = '#5c6470'; c.beginPath(); c.arc(0, 6, 8, 0, TAU); c.fill();
    } else if (key === 'shaker') {
      var off = Math.sin(t * 8) * 1.5;
      c.fillStyle = '#8a6b45'; roundRect(c, -14, -6 + off, 28, 12, 3); c.fill();
      c.fillStyle = col; roundRect(c, -10, -14 + off, 20, 8, 2); c.fill();
      c.fillStyle = '#5c4a30'; c.fillRect(-12, 6, 4, 6); c.fillRect(8, 6, 4, 6);
    } else if (key === 'mage') {
      c.fillStyle = '#7a4a3a'; roundRect(c, -9, -6, 18, 20, 3); c.fill();
      c.fillStyle = '#c0452c';
      c.beginPath(); c.moveTo(-11, -6); c.lineTo(0, -19); c.lineTo(11, -6); c.closePath(); c.fill();
      var og = c.createRadialGradient(0, -12, 1, 0, -12, 9);
      og.addColorStop(0, '#fff1c9'); og.addColorStop(1, 'rgba(255,123,84,.15)');
      c.fillStyle = og; c.beginPath(); c.arc(0, -12, 7 + Math.sin(t * 5) * 0.8, 0, TAU); c.fill();
    } else if (key === 'catapult') {
      c.save(); c.rotate(ang);
      c.fillStyle = '#8d6e53'; roundRect(c, -14, -4, 28, 8, 2); c.fill();
      c.fillStyle = col; roundRect(c, 6, -12, 12, 12, 3); c.fill();
      c.restore();
      c.fillStyle = '#6d543f'; c.beginPath(); c.arc(0, 4, 7, 0, TAU); c.fill();
      c.fillStyle = '#795548'; c.beginPath(); c.arc(-8, 6, 4, 0, TAU); c.fill();
    } else if (key === 'iceberg') {
      c.fillStyle = col;
      c.beginPath();
      c.moveTo(0, -18); c.lineTo(11, -2); c.lineTo(6, 12); c.lineTo(-7, 12); c.lineTo(-12, -2);
      c.closePath(); c.fill();
      c.fillStyle = '#d8f3ff';
      c.beginPath(); c.moveTo(0, -18); c.lineTo(5, -2); c.lineTo(-2, 8); c.closePath(); c.fill();
      c.strokeStyle = 'rgba(255,255,255,.5)'; c.lineWidth = 1;
      c.beginPath(); c.moveTo(-6, -4); c.lineTo(4, 6); c.stroke();
    } else if (key === 'skull') {
      c.fillStyle = '#3a3f52'; roundRect(c, -13, -10, 26, 24, 3); c.fill();
      c.fillStyle = '#232838';
      c.beginPath(); c.moveTo(-13, -10); c.lineTo(0, -20); c.lineTo(13, -10); c.closePath(); c.fill();
      c.fillStyle = col;
      c.beginPath(); c.arc(0, 2, 6, 0, TAU); c.fill();
      c.fillStyle = '#3a3f52';
      c.beginPath(); c.arc(-2.2, 1, 1.6, 0, TAU); c.fill();
      c.beginPath(); c.arc(2.2, 1, 1.6, 0, TAU); c.fill();
      c.fillRect(-2, 5, 4, 2);
    } else if (key === 'prism') {
      c.fillStyle = '#4b5f72'; roundRect(c, -8, -4, 16, 16, 3); c.fill();
      c.fillStyle = col;
      var pw = 5 + Math.sin(t * 4) * 1.2;
      c.beginPath(); c.moveTo(0, -20); c.lineTo(pw, -6); c.lineTo(-pw, -6); c.closePath(); c.fill();
      c.save(); c.rotate(ang);
      c.fillStyle = 'rgba(124,231,255,.75)';
      roundRect(c, 4, -1.6, 16, 3.2, 1.6); c.fill();
      c.restore();
    } else if (key === 'altar') {
      c.fillStyle = '#6b5b3a'; roundRect(c, -12, 2, 24, 8, 2); c.fill();
      c.fillStyle = '#8a7550'; roundRect(c, -8, -6, 16, 8, 2); c.fill();
      var ag = c.createRadialGradient(0, -14, 1, 0, -14, 14);
      ag.addColorStop(0, '#fff6d8'); ag.addColorStop(1, 'rgba(255,233,168,.1)');
      c.fillStyle = ag; c.beginPath(); c.arc(0, -14, 9 + Math.sin(t * 3) * 1.2, 0, TAU); c.fill();
      c.strokeStyle = col; c.lineWidth = 2;
      c.beginPath(); c.arc(0, -14, 11, 0, TAU); c.stroke();
      c.fillStyle = '#fff3c4';
      c.beginPath(); c.moveTo(0, -22); c.lineTo(3, -14); c.lineTo(-3, -14); c.closePath(); c.fill();
    } else if (key === 'mine') {                      // 矿洞：土坡 + 拱形洞口 + 金币
      c.fillStyle = '#8a6b45'; roundRect(c, -15, -2, 30, 14, 4); c.fill();
      c.fillStyle = '#5d4630'; c.fillRect(-15, 8, 30, 4);
      c.fillStyle = '#241c14';
      c.beginPath(); c.moveTo(-8, 10); c.lineTo(-8, 0); c.arc(0, 0, 8, Math.PI, 0); c.lineTo(8, 10); c.closePath(); c.fill();
      c.strokeStyle = '#c99a4e'; c.lineWidth = 2;
      c.beginPath(); c.arc(0, 0, 8, Math.PI, 0); c.stroke();
      c.fillStyle = '#ffc857';
      c.beginPath(); c.arc(-4, 8, 2.2 + Math.sin(t * 3) * 0.5, 0, TAU); c.fill();
      c.beginPath(); c.arc(3, 9, 1.7, 0, TAU); c.fill();
      c.strokeStyle = '#7a5c38'; c.lineWidth = 1.4;
      c.beginPath(); c.moveTo(-11, -2); c.lineTo(11, -2); c.stroke();
    } else if (key === 'grail') {                     // 圣杯：竹节托着发光的圣杯
      c.fillStyle = '#7fae7a'; roundRect(c, -13, 4, 26, 10, 3); c.fill();
      c.strokeStyle = '#5d8a58'; c.lineWidth = 1.4;
      c.beginPath(); c.moveTo(-13, 9); c.lineTo(13, 9); c.stroke();
      c.fillStyle = '#ffe9a8';
      c.beginPath();
      c.moveTo(-10, -8); c.lineTo(10, -8); c.lineTo(6, 4); c.lineTo(-6, 4); c.closePath(); c.fill();
      c.fillStyle = '#fff6d8'; c.fillRect(-2.5, 4, 5, 8);
      c.fillStyle = '#e8c56a'; roundRect(c, -12, 11, 24, 4, 2); c.fill();
      var gr = c.createRadialGradient(0, -14, 1, 0, -14, 16);
      gr.addColorStop(0, '#fffbe8'); gr.addColorStop(1, 'rgba(255,233,168,.08)');
      c.fillStyle = gr; c.beginPath(); c.arc(0, -14, 11 + Math.sin(t * 3) * 1.4, 0, TAU); c.fill();
      c.strokeStyle = col; c.lineWidth = 2;
      c.beginPath(); c.arc(0, -14, 13, 0, TAU); c.stroke();
    } else if (key === 'gravity') {
      c.fillStyle = '#4a3f63'; c.beginPath(); c.arc(0, 0, 11, 0, TAU); c.fill();
      var cg = c.createRadialGradient(0, 0, 2, 0, 0, 12);
      cg.addColorStop(0, '#ffffff'); cg.addColorStop(1, 'rgba(179,157,219,.15)');
      c.fillStyle = cg; c.beginPath(); c.arc(0, 0, 9 + Math.sin(t * 5) * 1.5, 0, TAU); c.fill();
      c.strokeStyle = col; c.lineWidth = 2;
      for (var gi2 = 0; gi2 < 3; gi2++) {
        var rr2 = 8 + gi2 * 4 - (t * 6 % 4);
        if (rr2 > 2) { c.beginPath(); c.arc(0, 0, rr2, 0, TAU); c.stroke(); }
      }
    } else if (key === 'spore') {
      c.fillStyle = '#4d6b2a'; roundRect(c, -9, -2, 18, 14, 3); c.fill();
      c.fillStyle = col;
      for (var si = 0; si < 3; si++) {
        var sx = -6 + si * 6, sy = -8 - Math.sin(t * 3 + si) * 2;
        c.beginPath(); c.arc(sx, sy, 4, 0, TAU); c.fill();
      }
      c.strokeStyle = 'rgba(163,230,53,.5)'; c.lineWidth = 1.4;
      c.beginPath(); c.arc(0, -6, 9, 0, TAU); c.stroke();
    } else if (key === 'wall') {
      var wg = c.createLinearGradient(0, -18, 0, 18);
      wg.addColorStop(0, '#9c907a'); wg.addColorStop(1, '#5f5748');
      c.fillStyle = wg; roundRect(c, -18, -18, 36, 36, 4); c.fill();
      c.strokeStyle = 'rgba(0,0,0,.35)'; c.lineWidth = 2; c.stroke();
      c.strokeStyle = 'rgba(255,255,255,.18)'; c.lineWidth = 1.5;
      c.beginPath(); c.moveTo(-18, -6); c.lineTo(18, -6); c.stroke();
      c.beginPath(); c.moveTo(-18, 6); c.lineTo(18, 6); c.stroke();
      c.beginPath(); c.moveTo(-6, -18); c.lineTo(-6, -6); c.stroke();
      c.beginPath(); c.moveTo(6, 6); c.lineTo(6, 18); c.stroke();
    } else if (key === 'trap') {
      c.fillStyle = col;
      for (var ti = -1; ti <= 1; ti++) {
        c.beginPath();
        c.moveTo(ti * 8 - 3, 8); c.lineTo(ti * 8, -6); c.lineTo(ti * 8 + 3, 8);
        c.closePath(); c.fill();
      }
    } else if (key === 'bomb') {
      var bg2 = c.createRadialGradient(-4, -4, 1, 0, 2, 14);
      bg2.addColorStop(0, '#5a5f6e'); bg2.addColorStop(1, '#22262f');
      c.fillStyle = bg2; c.beginPath(); c.arc(0, 2, 12, 0, TAU); c.fill();
      c.strokeStyle = 'rgba(255,255,255,.18)'; c.lineWidth = 1.5; c.stroke();
      c.strokeStyle = '#c98a5a'; c.lineWidth = 2;
      c.beginPath(); c.moveTo(6, -8); c.quadraticCurveTo(12, -16, 8, -19); c.stroke();
      var fs = 2.5 + Math.sin(t * 12) * 1.2;
      c.fillStyle = '#ffe066';
      c.beginPath(); c.arc(8, -20, fs, 0, TAU); c.fill();
      c.fillStyle = col; c.globalAlpha = 0.55;
      c.beginPath(); c.arc(0, 2, 12, 0, TAU); c.fill();
      c.globalAlpha = 1;
    } else if (key === 'thunder') {                  // 雷瓦斯
      c.fillStyle = '#4a4368'; roundRect(c, -5, -2, 10, 16, 2); c.fill();
      var tp = 0.75 + 0.25 * Math.sin(t * 7);
      var tg2 = c.createRadialGradient(0, -12, 1, 0, -12, 15);
      tg2.addColorStop(0, '#fffbe0'); tg2.addColorStop(1, 'rgba(255,224,102,.2)');
      c.fillStyle = tg2; c.beginPath(); c.arc(0, -12, 12 * tp, 0, TAU); c.fill();
      c.strokeStyle = col; c.lineWidth = 2.2;
      c.beginPath(); c.arc(0, -12, 12, 0, TAU); c.stroke();
      c.strokeStyle = '#fff6b0'; c.lineWidth = 1.6;
      c.beginPath(); c.moveTo(0, -24); c.lineTo(-4, -16); c.lineTo(1, -16); c.lineTo(-2, -8); c.stroke();
    } else if (key === 'heavymortar') {              // 重型迫击炮
      c.save(); c.rotate(ang - Math.PI / 2);
      c.fillStyle = '#6f7784'; roundRect(c, -10, -22, 20, 34, 4); c.fill();
      c.fillStyle = '#4d545e'; roundRect(c, -12, -25, 24, 7, 2); c.fill();
      c.fillStyle = '#2f343c'; roundRect(c, -7, -21, 14, 6, 2); c.fill();
      c.restore();
      c.fillStyle = '#5b626d'; c.beginPath(); c.arc(0, 8, 12, 0, TAU); c.fill();
      c.strokeStyle = 'rgba(255,255,255,.18)'; c.lineWidth = 1.5; c.stroke();
      c.fillStyle = '#8d97a6'; c.beginPath(); c.arc(0, 8, 5, 0, TAU); c.fill();
    } else if (key === 'laser') {                    // 激光塔
      c.fillStyle = '#46364a'; roundRect(c, -11, -4, 22, 18, 3); c.fill();
      c.fillStyle = '#2e2433'; roundRect(c, -8, -10, 16, 8, 2); c.fill();
      c.save(); c.rotate(ang);
      c.fillStyle = 'rgba(255,92,138,.85)'; roundRect(c, 6, -2.6, 22, 5.2, 2.6); c.fill();
      c.restore();
      var lg2 = c.createRadialGradient(0, -14, 1, 0, -14, 11);
      lg2.addColorStop(0, '#ffffff'); lg2.addColorStop(1, 'rgba(255,92,138,.15)');
      c.fillStyle = lg2; c.beginPath(); c.arc(0, -14, 8 + Math.sin(t * 5) * 1, 0, TAU); c.fill();
      c.strokeStyle = col; c.lineWidth = 2;
      c.beginPath(); c.arc(0, -14, 9, 0, TAU); c.stroke();
    } else if (key === 'frostcrush') {               // 骨碎寒冰机
      var q = Math.sin(t * 9) * 1.6;                 // 震动
      c.fillStyle = '#6b7c96'; roundRect(c, -16, -2 + q, 32, 14, 3); c.fill();
      c.fillStyle = '#49586e'; c.fillRect(-13, 10, 5, 7); c.fillRect(8, 10, 5, 7);
      c.fillStyle = '#dff3ff'; roundRect(c, -11, -14 + q, 22, 13, 3); c.fill();
      c.fillStyle = col;
      c.beginPath(); c.moveTo(0, -26 + q); c.lineTo(7, -14 + q); c.lineTo(-7, -14 + q); c.closePath(); c.fill();
      c.strokeStyle = 'rgba(255,255,255,.75)'; c.lineWidth = 1.2;
      c.beginPath(); c.moveTo(-4, -8 + q); c.lineTo(4, -2 + q); c.stroke();
      c.fillStyle = 'rgba(155,232,255,.35)';
      c.beginPath(); c.arc(0, 4, 12 + Math.sin(t * 6) * 1.5, 0, TAU); c.fill();
    }
    c.restore();
  }

  function drawCastle(c) {
    var k = G.castle;
    if (!k || k.hp <= 0) return;
    c.save();
    c.translate(k.x, k.y);
    c.fillStyle = 'rgba(0,0,0,.3)';
    c.beginPath(); c.ellipse(0, 32, 44, 16, 0, 0, TAU); c.fill();
    var g = c.createLinearGradient(0, -40, 0, 40);
    g.addColorStop(0, '#7c8ca8'); g.addColorStop(1, '#3d4a63');
    c.fillStyle = g; roundRect(c, -38, -32, 76, 64, 6); c.fill();
    c.strokeStyle = 'rgba(255,255,255,.2)'; c.lineWidth = 2; c.stroke();
    c.fillStyle = '#5a6b86';
    for (var i = 0; i < 5; i++) c.fillRect(-38 + i * 16, -44, 10, 13);
    c.fillStyle = '#8fa3c4'; roundRect(c, -38, -32, 76, 8, 3); c.fill();
    c.fillStyle = '#26314a'; roundRect(c, -12, 0, 24, 32, 10); c.fill();
    c.fillStyle = '#ff6b81';
    c.beginPath(); c.moveTo(0, -48); c.lineTo(18, -40); c.lineTo(0, -32); c.closePath(); c.fill();
    c.strokeStyle = '#8fa3c4'; c.lineWidth = 3;
    c.beginPath(); c.moveTo(0, -48); c.lineTo(0, -60); c.stroke();
    c.restore();
    drawHpBar(c, k.x, k.y - 52, 76, k.hp / k.maxHp);
  }

  // ================= 渲染：单位 =================
  function drawUnit(c, u) {
    var d = u.def, r = d.r || 9, flying = !!d.flying;
    c.save();
    c.translate(u.x, u.y);
    var bob = flying ? Math.sin(u.bob) * 4 : Math.abs(Math.sin(u.bob)) * 1.6;
    c.fillStyle = 'rgba(0,0,0,.28)';
    c.beginPath();
    c.ellipse(0, r * 0.95 + (flying ? 12 : 0), r * (flying ? 0.7 : 0.9), r * 0.34, 0, 0, TAU);
    c.fill();
    c.translate(0, -bob - (flying ? 8 : 0));
    if (u.freezeT > 0) {                        // 冻结：覆盖冰壳 + 冰棱，动不了也打不了
      c.fillStyle = 'rgba(180,230,255,.42)';
      c.beginPath(); c.arc(0, 0, r + 4, 0, TAU); c.fill();
      c.strokeStyle = 'rgba(232,248,255,.9)'; c.lineWidth = 2;
      for (var fi = 0; fi < 3; fi++) {
        var fa = fi / 3 * Math.PI + 0.4;
        c.beginPath();
        c.moveTo(Math.cos(fa) * (r + 6), Math.sin(fa) * (r + 6));
        c.lineTo(Math.cos(fa + 2.1) * (r + 6), Math.sin(fa + 2.1) * (r + 6));
        c.stroke();
      }
    }
    if (u.burrowed) c.globalAlpha = 0.45;      // 钻地中：半透明
    if (u.life > 0 && u.life < 2) {            // 召唤物快到期：闪烁提示
      c.globalAlpha *= 0.45 + 0.55 * Math.abs(Math.sin(G.time * 9));
    }
    drawUnitBody(c, u, r);
    c.globalAlpha = 1;
    if (u.shield) {                            // 缚灵祭司护盾
      c.strokeStyle = 'rgba(165,243,208,.9)'; c.lineWidth = 2;
      c.beginPath(); c.arc(0, 0, r + 5, 0, TAU); c.stroke();
    }
    if (u.poisonStacks > 0 && u.poisonT > 0) { // 毒素层数
      c.fillStyle = '#a3e635';
      for (var pi = 0; pi < u.poisonStacks; pi++) {
        c.beginPath(); c.arc(-6 + pi * 4, -r - 6, 1.8, 0, TAU); c.fill();
      }
    }
    if (u.slow > 0) {
      c.strokeStyle = 'rgba(116,208,255,.85)'; c.lineWidth = 1.8;
      c.beginPath(); c.arc(0, 0, r + 3, 0, TAU); c.stroke();
    }
    c.restore();
    drawHpBar(c, u.x, u.y - r - 12 - bob - (flying ? 8 : 0), Math.max(20, r * 2), u.hp / u.maxHp);
  }

  function drawUnitBody(c, u, r) {
    var d = u.def;
    var g = c.createLinearGradient(0, -r, 0, r);
    g.addColorStop(0, '#ffffff'); g.addColorStop(0.35, d.color); g.addColorStop(1, 'rgba(0,0,0,.35)');
    c.fillStyle = g;
    c.beginPath(); c.arc(0, 0, r, 0, TAU); c.fill();
    c.strokeStyle = u.side === 'def' ? 'rgba(126,231,135,.9)' : 'rgba(0,0,0,.35)';
    c.lineWidth = 1.6; c.stroke();
    drawUnitArt(c, u, r);
  }

  function drawUnitArt(c, u, r) {
    var key = u.key, t = G ? G.time : 0, ang = u.angle || 0;
    c.save();
    if (key === 'goblin') {
      c.fillStyle = '#2f5d2f';
      c.beginPath(); c.moveTo(-r, -r * 0.4); c.lineTo(-r * 1.6, -r); c.lineTo(-r * 0.4, -r * 0.9); c.closePath(); c.fill();
    } else if (key === 'archer' || key === 'flameskull' || key === 'pulse' || key === 'wizard') {
      c.save(); c.rotate(ang);
      var bowCol = key === 'flameskull' ? '#ff8a3d' : (key === 'pulse' ? '#66d9e8' : (key === 'wizard' ? '#d9c7ff' : '#c0e663'));
      c.strokeStyle = bowCol; c.lineWidth = 2.2;
      c.beginPath(); c.arc(r * 0.5, 0, r * 0.7, -1.9, 1.9); c.stroke();
      c.restore();
    } else if (key === 'warrior' || key === 'arthur') {
      c.save(); c.rotate(ang);
      c.strokeStyle = key === 'arthur' ? '#fff0b3' : '#ffe3b0'; c.lineWidth = 2.6;
      c.beginPath(); c.moveTo(r * 0.4, 0); c.lineTo(r * 1.5, -3); c.stroke();
      c.restore();
      if (key === 'arthur') {
        c.fillStyle = '#ffd24d';
        c.beginPath(); c.moveTo(-6, -r - 2); c.lineTo(0, -r - 12); c.lineTo(6, -r - 2); c.closePath(); c.fill();
      }
    } else if (key === 'bone') {
      c.fillStyle = '#fffdf2';
      c.beginPath(); c.ellipse(0, -2, r * 0.9, r * 0.5, 0.4, 0, TAU); c.fill();
      c.fillStyle = '#cdc8b4';
      c.beginPath(); c.arc(-r * 0.7, -r * 0.7, 3.4, 0, TAU); c.fill();
      c.beginPath(); c.arc(r * 0.7, -r * 0.7, 3.4, 0, TAU); c.fill();
    } else if (key === 'snowman') {
      c.fillStyle = '#ffffff';
      c.beginPath(); c.arc(0, r * 0.6, r * 0.85, 0, TAU); c.fill();
      c.fillStyle = '#ff8a3d';
      c.beginPath(); c.moveTo(r * 0.4, -2); c.lineTo(r * 1.4, 0); c.lineTo(r * 0.4, 2); c.closePath(); c.fill();
    } else if (key === 'death') {
      c.save(); c.rotate(ang);
      c.strokeStyle = '#3a2a4d'; c.lineWidth = 2.4;
      c.beginPath(); c.moveTo(r * 0.3, -r * 0.4); c.lineTo(r * 1.4, -r * 0.2); c.stroke();
      c.strokeStyle = '#e6e6f0'; c.lineWidth = 3;
      c.beginPath(); c.arc(r * 1.2, r * 0.3, r * 0.8, -1.2, 1.4); c.stroke();
      c.restore();
      c.fillStyle = '#2b2036';
      c.beginPath(); c.moveTo(-r, -r * 0.2); c.lineTo(0, -r * 1.5); c.lineTo(r, -r * 0.2); c.closePath(); c.fill();
    } else if (key === 'zeus') {
      c.strokeStyle = '#ffe066'; c.lineWidth = 2;
      c.beginPath();
      c.moveTo(-4, -r - 1); c.lineTo(1, -r - 6); c.lineTo(-1, -r - 6); c.lineTo(4, -r - 12);
      c.stroke();
    } else if (key === 'eyes') {
      var pc = u.variant === 'purple' ? '#b06bff' : '#ff5c5c';
      if (u.phased) {
        c.fillStyle = '#2a1a2a';
        c.beginPath(); c.arc(0, 0, r * 0.9, 0, TAU); c.fill();
        c.fillStyle = '#ffffff';
        for (var i2 = -2; i2 <= 2; i2++) {
          c.beginPath();
          c.moveTo(i2 * 4 - 1.6, -r * 0.7); c.lineTo(i2 * 4, -r * 0.2); c.lineTo(i2 * 4 + 1.6, -r * 0.7);
          c.closePath(); c.fill();
        }
      } else {
        c.fillStyle = '#ffffff';
        c.beginPath(); c.arc(0, 0, r, 0, TAU); c.fill();
        c.fillStyle = pc;
        c.beginPath(); c.arc(0, 0, r * 0.45 + Math.sin(t * 5) * 0.6, 0, TAU); c.fill();
        c.fillStyle = '#1a1a22';
        c.beginPath(); c.arc(0, 0, r * 0.2, 0, TAU); c.fill();
        c.strokeStyle = pc; c.lineWidth = 1.4;
        for (var k2 = 0; k2 < 6; k2++) {
          var a2 = k2 / 6 * TAU + t;
          c.beginPath();
          c.moveTo(Math.cos(a2) * r, Math.sin(a2) * r);
          c.lineTo(Math.cos(a2) * (r + 5), Math.sin(a2) * (r + 5));
          c.stroke();
        }
      }
    } else if (key === 'skeleton') {
      c.fillStyle = '#ffffff';
      c.beginPath(); c.arc(-3, -1, 2, 0, TAU); c.fill();
      c.beginPath(); c.arc(3, -1, 2, 0, TAU); c.fill();
      c.fillRect(-3, 3, 6, 1.4);
    } else if (key === 'prometheus') {          // 普罗米修斯：盗火者，远程持火球 / 近战燃拳
      c.fillStyle = '#5a2a12';
      c.beginPath(); c.arc(-r * 0.6, -r * 0.35, r * 0.3, 0, TAU); c.fill();
      c.beginPath(); c.arc(r * 0.6, -r * 0.35, r * 0.3, 0, TAU); c.fill();
      var pg = c.createRadialGradient(0, 0, 1, 0, 0, r);
      pg.addColorStop(0, '#fff3c4'); pg.addColorStop(0.55, '#ffb347'); pg.addColorStop(1, 'rgba(140,50,0,.6)');
      c.fillStyle = pg;
      c.beginPath(); c.arc(0, 0, r * 0.66, 0, TAU); c.fill();
      if (!u.phased) {                          // 远程形态：手中托着火球
        c.save(); c.rotate(ang);
        c.fillStyle = '#ff8a3d';
        c.beginPath(); c.arc(r * 1.15, 0, 4 + Math.sin(t * 8) * 1.2, 0, TAU); c.fill();
        c.strokeStyle = 'rgba(255,220,150,.7)'; c.lineWidth = 1.4;
        c.beginPath(); c.moveTo(r * 0.5, 0); c.lineTo(r * 1.1, 0); c.stroke();
        c.restore();
      } else {                                  // 近战形态：双拳燃火
        c.fillStyle = '#ff7a1a';
        c.beginPath(); c.arc(-r * 0.95, r * 0.15, 4 + Math.sin(t * 9) * 0.8, 0, TAU); c.fill();
        c.beginPath(); c.arc(r * 0.95, r * 0.15, 4 + Math.sin(t * 9 + 1) * 0.8, 0, TAU); c.fill();
      }
      c.fillStyle = 'rgba(255,200,120,.9)';     // 头顶火苗
      c.beginPath(); c.moveTo(0, -r - 12); c.lineTo(4, -r - 2); c.lineTo(-4, -r - 2); c.closePath(); c.fill();
    } else if (key === 'titan') {
      c.fillStyle = '#3d1c10';
      c.beginPath(); c.arc(-r * 0.7, -r * 0.4, r * 0.35, 0, TAU); c.fill();
      c.beginPath(); c.arc(r * 0.7, -r * 0.4, r * 0.35, 0, TAU); c.fill();
      var tg2 = c.createRadialGradient(0, 0, 1, 0, 0, r);
      tg2.addColorStop(0, '#ffd9a0'); tg2.addColorStop(0.6, '#ff5722'); tg2.addColorStop(1, 'rgba(120,20,0,.6)');
      c.fillStyle = tg2;
      c.beginPath(); c.arc(0, 0, r * 0.65, 0, TAU); c.fill();
      c.fillStyle = '#ffb74d';
      for (var ti2 = 0; ti2 < 4; ti2++) {
        var ta = ti2 / 4 * TAU + t * 1.5;
        c.beginPath();
        c.arc(Math.cos(ta) * r * 0.9, Math.sin(ta) * r * 0.9 - 2, 2 + Math.sin(t * 6 + ti2) * 0.8, 0, TAU);
        c.fill();
      }
    } else if (key === 'hive') {
      c.fillStyle = '#4a2a63';
      c.beginPath(); c.ellipse(0, 0, r, r * 0.85, 0, 0, TAU); c.fill();
      c.fillStyle = '#8e5bd6';
      for (var hi = 0; hi < 5; hi++) {
        var ha = hi / 5 * TAU;
        c.beginPath(); c.arc(Math.cos(ha) * r * 0.6, Math.sin(ha) * r * 0.5, 3.4 + Math.sin(t * 3 + hi) * 0.6, 0, TAU); c.fill();
      }
      c.fillStyle = '#f0d9ff';
      c.beginPath(); c.arc(0, 0, r * 0.3, 0, TAU); c.fill();
    } else if (key === 'priest') {
      c.fillStyle = '#e8fff5';
      c.beginPath(); c.moveTo(-r * 0.7, r * 0.9); c.lineTo(0, -r * 0.9); c.lineTo(r * 0.7, r * 0.9); c.closePath(); c.fill();
      c.strokeStyle = '#a5f3d0'; c.lineWidth = 2;
      c.beginPath(); c.arc(0, -r * 0.2, r * 0.55, 0, TAU); c.stroke();
      c.fillStyle = '#2f7d63';
      c.fillRect(-1.4, -r * 0.5, 2.8, r * 0.8);
      c.fillRect(-r * 0.4, -r * 0.2, r * 0.8, 2.8);
    } else if (key === 'golem') {
      c.fillStyle = '#5c2b18';
      c.beginPath(); c.arc(-r * 0.6, -r * 0.5, r * 0.3, 0, TAU); c.fill();
      c.beginPath(); c.arc(r * 0.6, -r * 0.5, r * 0.3, 0, TAU); c.fill();
      c.strokeStyle = '#ff7043'; c.lineWidth = 2;
      c.beginPath(); c.moveTo(-r * 0.5, r * 0.7); c.lineTo(r * 0.5, r * 0.7); c.stroke();
      c.fillStyle = '#ffcc80';
      c.beginPath(); c.arc(0, r * 0.1, r * 0.35 + Math.sin(t * 4) * 0.7, 0, TAU); c.fill();
    } else if (key === 'ghost') {
      c.fillStyle = 'rgba(230,240,255,.55)';
      c.beginPath();
      c.moveTo(-r, r * 0.6);
      for (var gi3 = 0; gi3 <= 4; gi3++) {
        var gx = -r + (gi3 / 4) * r * 2;
        c.lineTo(gx, r * 0.6 + (gi3 % 2 ? 4 : 0));
      }
      c.lineTo(r, -r * 0.3);
      c.quadraticCurveTo(0, -r * 1.5, -r, -r * 0.3);
      c.closePath(); c.fill();
    } else if (key === 'corrode') {
      c.fillStyle = '#3f6212';
      c.beginPath(); c.ellipse(0, 0, r * 0.9, r * 0.7, 0.3, 0, TAU); c.fill();
      c.fillStyle = '#d9f99d';
      c.beginPath(); c.arc(r * 0.4, -r * 0.3, 2.6, 0, TAU); c.fill();
      c.beginPath(); c.arc(-r * 0.3, r * 0.2, 2.2, 0, TAU); c.fill();
      c.strokeStyle = 'rgba(132,204,22,.8)'; c.lineWidth = 1.6;
      c.beginPath(); c.moveTo(-r * 0.9, r * 0.5); c.lineTo(r * 0.9, -r * 0.4); c.stroke();
    } else if (key === 'burrow') {
      c.fillStyle = '#92400e';
      c.beginPath(); c.ellipse(0, 0, r * 0.9, r * 0.6, 0.2, 0, TAU); c.fill();
      c.fillStyle = '#fbbf24';
      for (var bi = 0; bi < 4; bi++) {
        c.beginPath(); c.arc(-r * 0.6 + bi * r * 0.4, Math.sin(t * 4 + bi) * 1.5, 2.2, 0, TAU); c.fill();
      }
      c.strokeStyle = '#78350f'; c.lineWidth = 1.6;
      c.beginPath(); c.arc(r * 0.7, 0, r * 0.28, 0, TAU); c.stroke();
    }

    if (key !== 'eyes' && key !== 'ghost' && key !== 'titan' && key !== 'hive' && key !== 'golem' && key !== 'corrode' && key !== 'burrow') {
      var ex = Math.cos(ang) * r * 0.3, ey = Math.sin(ang) * r * 0.3;
      c.fillStyle = '#ffffff';
      c.beginPath(); c.arc(ex - r * 0.28, ey - 2, r * 0.2, 0, TAU); c.fill();
      c.beginPath(); c.arc(ex + r * 0.28, ey - 2, r * 0.2, 0, TAU); c.fill();
      c.fillStyle = '#16202f';
      c.beginPath(); c.arc(ex - r * 0.24, ey - 2, r * 0.1, 0, TAU); c.fill();
      c.beginPath(); c.arc(ex + r * 0.32, ey - 2, r * 0.1, 0, TAU); c.fill();
    }
    c.restore();
  }

  function drawDestroyer(c, u) {
    for (var i = u.segs.length - 1; i >= 0; i--) {
      var s = u.segs[i];
      c.save();
      c.translate(s.x, s.y);
      c.fillStyle = 'rgba(0,0,0,.25)';
      c.beginPath(); c.ellipse(0, 8, 13, 5, 0, 0, TAU); c.fill();
      var rr = 14 - i * (5 / Math.max(1, u.segs.length - 1));   // 从头到尾均匀收细（尾端 9）
      var g = c.createLinearGradient(0, -rr, 0, rr);
      g.addColorStop(0, '#c3ccd8'); g.addColorStop(1, '#5c6773');
      c.fillStyle = g;
      c.beginPath(); c.arc(0, 0, rr, 0, TAU); c.fill();
      c.strokeStyle = '#39424d'; c.lineWidth = 1.6; c.stroke();
      if (i % 2 === 0) {
        c.fillStyle = '#8d99ae';
        c.beginPath(); c.arc(0, -rr * 0.4, rr * 0.35, 0, TAU); c.fill();
      }
      if (i === 0) {
        c.save(); c.rotate(u.angle);
        c.fillStyle = '#2b323b';
        c.beginPath(); c.moveTo(rr * 0.6, -6); c.lineTo(rr + 10, -3); c.lineTo(rr + 10, 3); c.lineTo(rr * 0.6, 6); c.closePath(); c.fill();
        c.fillStyle = '#ff5c5c';
        c.beginPath(); c.arc(rr * 0.8, -4, 2, 0, TAU); c.fill();
        c.beginPath(); c.arc(rr * 0.8, 4, 2, 0, TAU); c.fill();
        c.restore();
      }
      c.restore();
    }
    var head = u.segs[0];
    drawHpBar(c, head.x, head.y - 24, 46, u.hp / u.maxHp);
  }

  function drawHpBar(c, x, y, w, pct) {
    pct = clamp(pct, 0, 1);
    if (pct >= 1) return;
    var h = 4;
    c.fillStyle = 'rgba(0,0,0,.6)';
    roundRect(c, x - w / 2 - 1, y - 1, w + 2, h + 2, 3); c.fill();
    c.fillStyle = pct > 0.5 ? '#7ee787' : (pct > 0.25 ? '#ffc857' : '#ff6b81');
    roundRect(c, x - w / 2, y, w * pct, h, 2); c.fill();
  }

  // ================= Boss 血条（画面最上方，多个从上往下并列） =================
  var BOSS_BAR_H = 20, BOSS_BAR_GAP = 6, BOSS_PAD = 10;

  function bossUnits() {
    var out = [];
    for (var i = 0; i < G.units.length; i++) {
      var u = G.units[i];
      if (u.dead || !BOSS[u.key]) continue;
      out.push(u);
    }
    return out;
  }
  // 多个 Boss 同场时只显示一条：挑当前剩余血量最高的那个
  function topBoss() {
    var list = bossUnits();
    if (!list.length) return null;
    var best = list[0];
    for (var i = 1; i < list.length; i++) if (list[i].hp > best.hp) best = list[i];
    return best;
  }
  function bossName(u) {
    if (u.key === 'eyes') return u.variant === 'purple' ? '双子魔眼·紫瞳' : '双子魔眼·红瞳';
    return u.def.name;
  }
  function bossBarsHeight() {
    return topBoss() ? BOSS_BAR_H + 14 : 0;
  }
  function drawBossBars(c) {
    var u = topBoss();
    if (!u) return;
    var total = BOSS_BAR_H + 14;
    var x = BOSS_PAD, w = W - BOSS_PAD * 2, y = 7;

    c.save();
    var bg = c.createLinearGradient(0, 0, 0, total);
    bg.addColorStop(0, 'rgba(6,10,20,.85)'); bg.addColorStop(1, 'rgba(6,10,20,.15)');
    c.fillStyle = bg; c.fillRect(0, 0, W, total);

    {
      var pct = clamp(u.hp / u.maxHp, 0, 1);
      c.fillStyle = 'rgba(0,0,0,.6)';
      roundRect(c, x - 2, y - 2, w + 4, BOSS_BAR_H + 4, 6); c.fill();
      c.fillStyle = 'rgba(255,255,255,.07)';
      roundRect(c, x, y, w, BOSS_BAR_H, 4); c.fill();

      if (pct > 0) {
        var fw = w * pct;
        var lg = c.createLinearGradient(0, y, 0, y + BOSS_BAR_H);
        lg.addColorStop(0, u.def.color); lg.addColorStop(1, 'rgba(0,0,0,.45)');
        c.fillStyle = lg;
        roundRect(c, x, y, fw, BOSS_BAR_H, 4); c.fill();
        c.fillStyle = 'rgba(255,255,255,.3)';
        roundRect(c, x + 1, y + 1, Math.max(0, fw - 2), BOSS_BAR_H * 0.36, 3); c.fill();
      }
      c.strokeStyle = 'rgba(0,0,0,.22)'; c.lineWidth = 1;
      for (var s = 1; s < 10; s++) {
        c.beginPath(); c.moveTo(x + w * s / 10, y + 3); c.lineTo(x + w * s / 10, y + BOSS_BAR_H - 3); c.stroke();
      }
      c.strokeStyle = 'rgba(255,255,255,.28)'; c.lineWidth = 1.5;
      roundRect(c, x, y, w, BOSS_BAR_H, 4); c.stroke();

      c.font = 'bold 12px "PingFang SC","Microsoft YaHei",sans-serif';
      c.textBaseline = 'middle'; c.lineWidth = 3; c.strokeStyle = 'rgba(0,0,0,.8)';
      var nb = bossUnits().length;
      var label = 'BOSS ' + bossName(u) + '（免疫控制）' + (nb > 1 ? '　共 ' + nb + ' 个 BOSS' : '') + '　' + Math.max(0, Math.ceil(u.hp)) + ' / ' + u.maxHp;
      c.textAlign = 'left'; c.strokeText(label, x + 9, y + BOSS_BAR_H / 2 + 0.5);
      c.fillStyle = '#ffffff'; c.fillText(label, x + 9, y + BOSS_BAR_H / 2 + 0.5);
      var pc = Math.ceil(pct * 100) + '%';
      c.textAlign = 'right'; c.strokeText(pc, x + w - 9, y + BOSS_BAR_H / 2 + 0.5);
      c.fillText(pc, x + w - 9, y + BOSS_BAR_H / 2 + 0.5);
    }
    c.restore();
  }

  // ================= 主渲染 =================
  function render() {
    ctx.save();
    if (G.shakeT > 0) {
      var m = G.shakeMag * (G.shakeT / 0.25);
      ctx.translate(rand(-m, m), rand(-m, m));
    }
    ctx.clearRect(-20, -20, W + 40, H + 40);
    ctx.drawImage(bgCache, 0, 0);

    // 地面持续区域（火焰 / 尖刺）
    for (var z = 0; z < G.zones.length; z++) {
      var zo = G.zones[z];
      var za = clamp(zo.life, 0, 1);
      ctx.save();
      ctx.globalAlpha = 0.35 * za;
      var zg = ctx.createRadialGradient(zo.x, zo.y, 2, zo.x, zo.y, zo.r);
      zg.addColorStop(0, zo.color); zg.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = zg;
      ctx.beginPath(); ctx.arc(zo.x, zo.y, zo.r, 0, TAU); ctx.fill();
      ctx.restore();
    }

    drawCastle(ctx);
    if (G.sel && G.hover.on && canModify()) drawGhost();
    if (G.drag) drawDragHint();
    drawFocusMark();                       // 敌人当前集火的建筑

    var bs = G.buildings.slice().sort(function (a, b) { return a.y - b.y; });
    for (var i = 0; i < bs.length; i++) {
      var dragging = G.drag && G.drag.obj === bs[i];
      if (dragging) { ctx.save(); ctx.globalAlpha = 0.65; }
      drawBuilding(ctx, bs[i]);
      if (dragging) ctx.restore();
    }

    // 详情面板选中的建筑：高亮圈 + 射程圈
    if (G.pickB && !G.pickB.dead && G.buildings.indexOf(G.pickB) >= 0) {
      ctx.save();
      ctx.strokeStyle = '#ffd166'; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(G.pickB.x, G.pickB.y, 24, 0, TAU); ctx.stroke();
      if (G.pickB.range > 0) {
        ctx.globalAlpha = 0.35;
        ctx.setLineDash([6, 6]);
        ctx.strokeStyle = '#ffd166'; ctx.lineWidth = 1.5;
        ctx.beginPath(); ctx.arc(G.pickB.x, G.pickB.y, G.pickB.range, 0, TAU); ctx.stroke();
      }
      ctx.restore();
    }

    for (var r = 0; r < G.rollers.length; r++) {
      var ro = G.rollers[r];
      ctx.save(); ctx.translate(ro.x, ro.y); ctx.rotate(ro.spin);
      ctx.fillStyle = '#8d7f6d'; ctx.beginPath(); ctx.arc(0, 0, ro.r, 0, TAU); ctx.fill();
      ctx.fillStyle = '#6f6455'; ctx.beginPath(); ctx.arc(-5, -5, 5, 0, TAU); ctx.fill();
      ctx.strokeStyle = 'rgba(0,0,0,.3)'; ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.arc(0, 0, ro.r, 0, TAU); ctx.stroke();
      ctx.restore();
    }

    var us = G.units.slice().sort(function (a, b) { return a.y - b.y; });
    for (var k = 0; k < us.length; k++) {
      if (us[k].key === 'destroyer') drawDestroyer(ctx, us[k]);
      else drawUnit(ctx, us[k]);
    }

    for (var p = 0; p < G.projs.length; p++) {
      var pr = G.projs[p];
      ctx.save();
      ctx.translate(pr.x, pr.y);
      if (pr.kind === 'arrow') {
        ctx.rotate(pr.a || 0);
        ctx.fillStyle = '#e9f5df'; roundRect(ctx, -6, -1.4, 11, 2.8, 1.4); ctx.fill();
      } else if (pr.kind === 'mortar' || pr.kind === 'stone') {
        ctx.fillStyle = pr.color;
        ctx.beginPath(); ctx.arc(0, 0, pr.r, 0, TAU); ctx.fill();
        ctx.fillStyle = 'rgba(255,255,255,.35)';
        ctx.beginPath(); ctx.arc(-2, -2, pr.r * 0.35, 0, TAU); ctx.fill();
      } else if (pr.kind === 'fireball' || pr.kind === 'purplefire') {
        var gg = ctx.createRadialGradient(0, 0, 1, 0, 0, pr.r + 5);
        gg.addColorStop(0, '#fff6d8'); gg.addColorStop(1, 'rgba(0,0,0,0)');
        ctx.fillStyle = gg; ctx.beginPath(); ctx.arc(0, 0, pr.r + 5, 0, TAU); ctx.fill();
        ctx.fillStyle = pr.color; ctx.beginPath(); ctx.arc(0, 0, pr.r, 0, TAU); ctx.fill();
      } else {
        ctx.fillStyle = pr.color;
        ctx.beginPath(); ctx.arc(0, 0, pr.r, 0, TAU); ctx.fill();
        ctx.fillStyle = 'rgba(255,255,255,.4)';
        ctx.beginPath(); ctx.arc(-1, -1, pr.r * 0.35, 0, TAU); ctx.fill();
      }
      ctx.restore();
    }

    for (var f = 0; f < G.fx.length; f++) {
      var fx = G.fx[f], al = clamp(fx.life / fx.max, 0, 1);
      ctx.save();
      ctx.globalAlpha = al;
      if (fx.type === 'ring') {
        var rr = fx.r0 + (fx.r1 - fx.r0) * (1 - al);
        ctx.strokeStyle = fx.color; ctx.lineWidth = 3 * al + 1;
        ctx.beginPath(); ctx.arc(fx.x, fx.y, rr, 0, TAU); ctx.stroke();
      } else if (fx.type === 'bolt') {
        ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 5; ctx.lineCap = 'round';
        ctx.beginPath(); ctx.moveTo(fx.x1, fx.y1); ctx.lineTo(fx.x2, fx.y2); ctx.stroke();
        ctx.strokeStyle = fx.color; ctx.lineWidth = 2;
        ctx.beginPath(); ctx.moveTo(fx.x1, fx.y1);
        for (var q = 1; q < 4; q++) {
          var tt = q / 4;
          ctx.lineTo(fx.x1 + (fx.x2 - fx.x1) * tt + rand(-6, 6), fx.y1 + (fx.y2 - fx.y1) * tt + rand(-6, 6));
        }
        ctx.lineTo(fx.x2, fx.y2); ctx.stroke();
      } else if (fx.type === 'beam') {
        ctx.strokeStyle = 'rgba(255,255,255,.7)'; ctx.lineWidth = (fx.w || 4) + 4;
        ctx.beginPath(); ctx.moveTo(fx.x1, fx.y1); ctx.lineTo(fx.x2, fx.y2); ctx.stroke();
        ctx.strokeStyle = fx.color; ctx.lineWidth = fx.w || 4;
        ctx.beginPath(); ctx.moveTo(fx.x1, fx.y1); ctx.lineTo(fx.x2, fx.y2); ctx.stroke();
      } else if (fx.type === 'claw') {
        var prog = 1 - al;
        ctx.globalAlpha = 1;
        for (var ci = 0; ci < 4; ci++) {
          var a2 = ci / 4 * TAU + 0.6;
          var rad = 46 - prog * 30;
          ctx.strokeStyle = '#2b2036'; ctx.lineWidth = 6; ctx.lineCap = 'round';
          ctx.beginPath();
          ctx.moveTo(fx.x + Math.cos(a2) * (rad + 26), fx.y + Math.sin(a2) * (rad + 26));
          ctx.lineTo(fx.x + Math.cos(a2) * rad, fx.y + Math.sin(a2) * rad);
          ctx.stroke();
          ctx.strokeStyle = '#a06bff'; ctx.lineWidth = 2.5;
          ctx.beginPath();
          ctx.moveTo(fx.x + Math.cos(a2) * (rad + 26), fx.y + Math.sin(a2) * (rad + 26));
          ctx.lineTo(fx.x + Math.cos(a2) * rad, fx.y + Math.sin(a2) * rad);
          ctx.stroke();
        }
        ctx.fillStyle = 'rgba(20,10,30,' + (0.5 * prog) + ')';
        ctx.beginPath(); ctx.arc(fx.x, fx.y, 40 * prog, 0, TAU); ctx.fill();
      }
      ctx.restore();
    }

    for (var pa = 0; pa < G.parts.length; pa++) {
      var pt = G.parts[pa];
      ctx.save(); ctx.globalAlpha = clamp(pt.life / pt.maxLife, 0, 1);
      ctx.fillStyle = pt.color;
      ctx.beginPath(); ctx.arc(pt.x, pt.y, pt.r, 0, TAU); ctx.fill();
      ctx.restore();
    }

    for (var te = 0; te < G.texts.length; te++) {
      var tx = G.texts[te];
      ctx.save();
      ctx.globalAlpha = clamp(tx.life, 0, 1);
      ctx.font = 'bold 13px "PingFang SC","Microsoft YaHei",sans-serif';
      ctx.textAlign = 'center'; ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(0,0,0,.75)';
      ctx.strokeText(tx.text, tx.x, tx.y);
      ctx.fillStyle = tx.color; ctx.fillText(tx.text, tx.x, tx.y);
      ctx.restore();
    }

    var banner = '';
    if (G.mode === 'versus') {
      if (G.phase === 'defDeploy') banner = '防御方部署阶段 · 金币无限 / 无放置限制 · 左键建塔 / 长按拖动 / 右键拆除 · 守住大本营';
      else if (G.phase === 'atkDeploy') banner = '攻击方部署阶段 · 金币无限 / 无放置限制 · 左键放角色 / 长按拖动 / 右键移除';
      else if (G.phase === 'battle') banner = '战斗阶段 · 双方都无法部署或摧毁 · 敌人集火同一建筑，目标是摧毁大本营';
    } else {
      var wn = G.phase === 'rest' ? G.wave + 1 : G.wave;
      var tag = isBossWave(wn) ? '【BOSS 波】' : '';
      if (G.phase === 'rest') banner = tag + '第 ' + wn + ' 波将在 ' + Math.max(0, Math.ceil(G.countdown)) + ' 秒后到来 · 可继续建塔（长按可拖动）';
      else if (G.phase === 'wave') banner = tag + '第 ' + wn + ' 波进攻中 · 可建塔、拆塔（移动建筑要等修整阶段）';
    }
    var bossTop = bossBarsHeight();                 // Boss 血条占住顶部时，横幅整体下移
    if (banner) {
      ctx.save();
      ctx.font = 'bold 14px "PingFang SC",sans-serif';
      ctx.textAlign = 'center';
      var tw = ctx.measureText(banner).width;
      ctx.fillStyle = 'rgba(8,14,26,.72)';
      roundRect(ctx, W / 2 - tw / 2 - 14, 8 + bossTop, tw + 28, 28, 14); ctx.fill();
      ctx.fillStyle = '#e8eefc';
      ctx.fillText(banner, W / 2, 27 + bossTop);
      ctx.restore();
    }
    ctx.restore();
    drawBossBars(ctx);                              // 画在最上层、不随震屏抖动
  }

  function drawGhost() {
    var sel = G.sel;
    if (sel.isUnit) {
      var px = clamp(G.hover.x, 16, W - 16), py = clamp(G.hover.y, 16, H - 16);
      var ok = goldOf('atk') >= sel.cost && unitSpotOk(px, py);
      ctx.save();
      ctx.globalAlpha = 0.6;
      ctx.strokeStyle = ok ? '#ff8a5c' : '#ff5a5f'; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(px, py, (sel.r || 10) + 6, 0, TAU); ctx.stroke();
      ctx.fillStyle = ok ? 'rgba(255,138,92,.25)' : 'rgba(255,90,95,.25)';
      ctx.beginPath(); ctx.arc(px, py, (sel.r || 10) + 6, 0, TAU); ctx.fill();
      ctx.restore();
    } else {
      var gx = G.hover.gx, gy = G.hover.gy;
      var px2 = (gx + 0.5) * CELL, py2 = (gy + 0.5) * CELL;
      // 这一格上有能合成的建筑 → 显示金色「合成 X」提示
      var fus = null, cellBs = buildingsAtCell(gx, gy);
      for (var ci = 0; ci < cellBs.length && !fus; ci++) {
        if (cellBs[ci].isHq) continue;
        var cr = fuseRecipe(cellBs[ci].key, sel.key);
        if (cr) fus = cr;
      }
      var ok2 = canDropCell(gx, gy) && goldOf('def') >= sel.cost;
      ctx.save();
      ctx.globalAlpha = 0.35;
      ctx.fillStyle = fus ? '#ffe066' : (ok2 ? '#4fd1c5' : '#ff5a5f');
      roundRect(ctx, gx * CELL + 2, gy * CELL + 2, CELL - 4, CELL - 4, 6); ctx.fill();
      ctx.restore();
      if (fus && B_MAP[fus.out]) {
        ctx.save();
        ctx.font = 'bold 12px "PingFang SC","Microsoft YaHei",sans-serif';
        ctx.textAlign = 'center'; ctx.textBaseline = 'bottom';
        ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(0,0,0,.85)';
        var ft = '合成 ' + B_MAP[fus.out].name;
        ctx.strokeText(ft, px2, gy * CELL - 4);
        ctx.fillStyle = '#ffe066'; ctx.fillText(ft, px2, gy * CELL - 4);
        ctx.restore();
      }
      if (sel.range) {
        ctx.save();
        ctx.globalAlpha = 0.4;
        ctx.strokeStyle = sel.color; ctx.lineWidth = 2; ctx.setLineDash([6, 6]);
        ctx.beginPath(); ctx.arc(px2, py2, sel.range, 0, TAU); ctx.stroke();
        if (sel.minRange) { ctx.beginPath(); ctx.arc(px2, py2, sel.minRange, 0, TAU); ctx.stroke(); }
        ctx.setLineDash([]);
        ctx.restore();
      }
      ctx.save();
      ctx.globalAlpha = 0.55; ctx.translate(px2, py2);
      drawBuildingArt(ctx, { def: sel, angle: -Math.PI / 2 });
      ctx.restore();
    }
  }

  // ================= 输入 =================
  function toLocal(ev) {
    var rect = canvas.getBoundingClientRect();
    return {
      x: (ev.clientX - rect.left) * (W / rect.width),
      y: (ev.clientY - rect.top) * (H / rect.height)
    };
  }
  function setHover(ev) {
    var p = toLocal(ev);
    G.hover.x = p.x; G.hover.y = p.y;
    G.hover.gx = Math.floor(p.x / CELL); G.hover.gy = Math.floor(p.y / CELL);
    G.hover.on = p.x >= 0 && p.y >= 0 && p.x < W && p.y < H;
    updateDragPos();
    // 长按判定期间移动过多则取消
    if (G.press && dist(p.x, p.y, G.press.x, G.press.y) > 14) clearPress();
  }
  // 点击 / 轻点的实际操作：拆除模式下为拆除，否则为部署
  function tapAction() {
    if (G.destroyMode) { tryDestroy(); return; }
    tryPlace();
  }
  function isTouch(ev) { return ev.pointerType === 'touch'; }

  // 统一用 Pointer 事件处理鼠标 / 触屏 / 触控笔
  var activeId = null;

  canvas.addEventListener('pointermove', function (ev) {
    if (activeId !== null && ev.pointerId !== activeId) return;
    setHover(ev);
  });
  canvas.addEventListener('mouseleave', function () { if (activeId === null) G.hover.on = false; });

  canvas.addEventListener('pointerdown', function (ev) {
    if (ev.pointerType === 'mouse' && ev.button === 2) {   // 右键：拖动中则取消，否则拆除
      setHover(ev);
      clearPress();
      if (G.drag) { cancelDrag(); syncUI(); } else tryDestroy();
      return;
    }
    if (ev.pointerType === 'mouse' && ev.button !== 0) return;
    if (activeId !== null) return;                         // 忽略多指中的其余手指
    activeId = ev.pointerId;
    try { canvas.setPointerCapture(ev.pointerId); } catch (e) {}
    setHover(ev);

    if (G.drag) { dropDrag(); return; }                    // 拖动中：点击 / 轻点 = 放下
    clearPress();
    var cand = pickMovable();
    if (cand) {                                            // 长按 300ms 拿起建筑 / 角色
      G.press = {
        obj: cand, x: G.hover.x, y: G.hover.y, touch: isTouch(ev),
        timer: setTimeout(function () { startDrag(cand); }, HOLD_MS)
      };
      // 鼠标点一下已建建筑 = 打开详情面板（长按依然是拖动）
      if (!isTouch(ev) && !G.sel && !G.destroyMode && !cand.side) { G.pickB = cand; syncUI(); }
      return;
    }
    if (isTouch(ev)) {                                     // 触屏：抬手才生效，可滑动取消
      G.press = { obj: null, x: G.hover.x, y: G.hover.y, touch: true, timer: null };
      return;
    }
    tapAction();                                           // 鼠标：按下即部署
  });

  function endTouch() { G.hover.on = false; }

  window.addEventListener('pointerup', function (ev) {
    if (ev.pointerType === 'mouse' && ev.button !== 0) return;
    if (activeId !== null && ev.pointerId !== activeId) return;
    activeId = null;
    try { canvas.releasePointerCapture(ev.pointerId); } catch (e) {}

    if (G.drag) { dropDrag(); if (isTouch(ev)) endTouch(); syncUI(); return; }
    if (G.press) {
      var obj = G.press.obj;
      clearPress();
      if (obj) {
        // 手上已选卡片：按普通点击处理（自由模式可叠放，其它模式会提示不能建造）
        if (G.sel) tryPlace();
        else if (G.destroyMode) tryDestroy();
        else if (!obj.side) { G.pickB = obj; syncUI(); }        // 轻点建筑 = 打开详情
        else if (!canMove()) toast('战斗中无法移动角色');
        else toast('长按可以移动已放置的角色');
      } else {
        tapAction();
      }
      syncUI();
    }
    if (isTouch(ev)) endTouch();
  });

  canvas.addEventListener('pointercancel', function (ev) {
    if (activeId !== null && ev.pointerId !== activeId) return;
    activeId = null;
    clearPress();
    if (G.drag) { cancelDrag(); syncUI(); }
    endTouch();
  });

  // 双指轻点 = 拆除（触屏替代右键）
  canvas.addEventListener('touchstart', function (ev) {
    if (ev.touches.length !== 2) return;
    clearPress();
    if (G.drag) { cancelDrag(); syncUI(); }
    var t0 = ev.touches[0], t1 = ev.touches[1];
    setHover({ clientX: (t0.clientX + t1.clientX) / 2, clientY: (t0.clientY + t1.clientY) / 2 });
    tryDestroy();
    syncUI();
    ev.preventDefault();
  }, { passive: false });

  canvas.addEventListener('contextmenu', function (ev) { ev.preventDefault(); });
  canvas.addEventListener('wheel', function (ev) {
    document.getElementById('cards').scrollLeft += ev.deltaY > 0 ? 120 : -120;
    ev.preventDefault();
  }, { passive: false });

  window.addEventListener('keydown', function (ev) {
    if (ev.key === 'Escape') {
      if (G.drag) { cancelDrag(); }
      else if (G.destroyMode) { G.destroyMode = false; }
      else { G.sel = null; G.pickB = null; }
      clearPress();
      syncUI();
    }
    else if (ev.key === ' ') { ev.preventDefault(); togglePause(); }
    else if (ev.key === 'f' || ev.key === 'F') cycleSpeed();
  });

  // ================= UI =================
  var el = {
    phase: document.getElementById('statPhase'),
    goldDef: document.getElementById('statGoldDef'),
    goldAtk: document.getElementById('statGoldAtk'),
    gold: document.getElementById('statGold'),
    castle: document.getElementById('statCastle'),
    hq: document.getElementById('statHq'),
    boxHq: document.getElementById('boxHq'),
    round: document.getElementById('statRound'),
    wave: document.getElementById('statWave'),
    kills: document.getElementById('statKills'),
    units: document.getElementById('statUnits'),
    best: document.getElementById('statBest'),
    next: document.getElementById('statNext'),
    boxUnits: document.getElementById('boxUnits'),
    boxBest: document.getElementById('boxBest'),
    boxNext: document.getElementById('boxNext'),
    infoPanel: document.getElementById('infoPanel'),
    ipName: document.getElementById('ipName'),
    ipLv: document.getElementById('ipLv'),
    ipStats: document.getElementById('ipStats'),
    ipBrief: document.getElementById('ipBrief'),
    ipTip: document.getElementById('ipTip'),
    ipUpgrade: document.getElementById('ipUpgrade'),
    ipRepair: document.getElementById('ipRepair'),
    ipClose: document.getElementById('ipClose'),
    btnCancel: document.getElementById('btnCancel'),
    volMusic: document.getElementById('volMusic'),
    volSfx: document.getElementById('volSfx'),
    boxDef: document.getElementById('boxDef'),
    boxAtk: document.getElementById('boxAtk'),
    boxGold: document.getElementById('boxGold'),
    boxCastle: document.getElementById('boxCastle'),
    boxRound: document.getElementById('boxRound'),
    boxWave: document.getElementById('boxWave'),
    cards: document.getElementById('cards'),
    badge: document.getElementById('turnBadge'),
    hint: document.getElementById('hintText'),
    costHint: document.getElementById('costHint'),
    btnMain: document.getElementById('btnMain'),
    btnPause: document.getElementById('btnPause'),
    btnSpeed: document.getElementById('btnSpeed'),
    btnDestroy: document.getElementById('btnDestroy'),
    btnMusic: document.getElementById('btnMusic'),
    btnSound: document.getElementById('btnSound'),
    btnRestart: document.getElementById('btnRestart'),
    overlay: document.getElementById('overlay'),
    ovTitle: document.getElementById('ovTitle'),
    ovText: document.getElementById('ovText'),
    ovBtn: document.getElementById('ovBtn'),
    toast: document.getElementById('toast'),
    modes: document.getElementById('modes')
  };

  var cardList = [];
  function currentDefs() {
    // 合成建筑不在卡片栏出现；矿洞等无尽模式专属建筑只在无尽模式出现
    var bs = BUILDING_DEFS.filter(function (d) { return !d.fuseOnly && (G.mode === 'endless' || !d.endlessOnly); });
    if (G.mode === 'endless') return bs;
    if (G.phase === 'atkDeploy') return UNIT_DEFS.filter(function (d) { return !d.summon; });
    return bs;
  }

  function buildCards() {
    var defs = currentDefs();
    el.cards.innerHTML = '';
    cardList = [];
    defs.forEach(function (d) {
      var card = document.createElement('button');
      card.className = 'card' + (d.isUnit ? ' atk' : '');
      var ic = document.createElement('canvas');
      var dpr = Math.min(window.devicePixelRatio || 1, 2);
      ic.width = 46 * dpr; ic.height = 46 * dpr;
      var c = ic.getContext('2d');
      c.setTransform(dpr, 0, 0, dpr, 0, 0);
      c.translate(23, 25);
      drawCardIcon(c, d);
      card.appendChild(ic);
      var nm = document.createElement('span');
      nm.className = 'c-name'; nm.textContent = d.name;
      card.appendChild(nm);
      var co = document.createElement('span');
      co.className = 'c-cost'; co.textContent = d.cost + ' 金';
      card.appendChild(co);
      var tag = document.createElement('span');
      tag.className = 'c-tag'; tag.textContent = d.isUnit ? '兵' : '塔';
      card.appendChild(tag);
      card.title = d.name + '（' + d.cost + ' 金 · 血量' + d.hpTier + '）\n' + d.brief;
      if (BOSS[d.key]) card.title += '\n【Boss】免疫减速 / 冰冻 / 灼烧 / 中毒等一切负面状态';
      if (fuseHintFor(d.key)) card.title += '\n【合成】' + fuseHintFor(d.key);
      card.addEventListener('click', function () {
        if (!canModify()) { toast('战斗阶段无法部署'); return; }
        G.sel = (G.sel === d) ? null : d;
        if (G.sel) G.pickB = null;                 // 选了卡片就关掉建筑详情
        syncUI();
      });
      el.cards.appendChild(card);
      cardList.push({ el: card, def: d });
    });
  }

  function drawCardIcon(c, d) {
    if (d.isUnit) {
      var fake = {
        key: d.key, def: d, angle: 0, side: 'atk', variant: d.key === 'eyes' ? 'red' : null,
        phased: false, bob: 0, hp: d.hp, maxHp: d.hp, slow: 0, freezeT: 0
      };
      c.save(); c.scale(0.8, 0.8);
      drawUnitBody(c, fake, d.r || 9);
      c.restore();
    } else {
      c.save(); c.scale(0.75, 0.75);
      drawBuildingArt(c, { def: d, angle: -Math.PI / 2 });
      c.restore();
    }
  }

  // ================= 建筑维护：升级 / 修复（只能在修整阶段） =================
  function canMaintain() {
    if (G.over) return false;
    if (G.mode === 'endless') return G.phase === 'rest';
    return G.phase === 'defDeploy';
  }
  function upgradeCost(b) { return Math.max(1, Math.round(b.def.cost * CFG.upgrade.costMul * b.level)); }
  function repairCost(b) { return Math.max(1, Math.ceil((b.maxHp - b.hp) * CFG.repairGoldPerHp)); }

  function doUpgrade() {
    var b = G.pickB;
    if (!b || b.dead) { toast('先在地图上点一座建筑'); return; }
    if (!canMaintain()) { toast('只能在修整阶段升级建筑'); return; }
    if (b.def.trap) { toast('一次性建筑不能升级'); return; }
    if (b.level >= CFG.upgrade.maxLevel) { toast('已经是满级了'); return; }
    var c = upgradeCost(b);
    if (G.mode === 'endless' && G.gold < c) { toast('金币不足，升级需要 ' + c + ' 金'); return; }
    payGold('def', c);
    var U = CFG.upgrade;
    b.level++;
    var add = Math.round(b.maxHp * U.hpMul);
    b.maxHp += add; b.hp += add;
    if (b.s.dmg) b.s.dmg = Math.round(b.s.dmg * (1 + U.dmgMul));
    if (b.s.heal) b.s.heal = Math.round(b.s.heal * (1 + U.dmgMul) * 10) / 10;
    if (b.s.cd) b.s.cd = Math.round(b.s.cd * U.cdMul * 100) / 100;
    if (b.range > 0) b.range = Math.round(b.range * (1 + U.rangeMul));
    if (b.minRange > 0) b.minRange = Math.round(b.minRange * (1 + U.rangeMul));
    floatText(b.x, b.y - 28, 'Lv.' + b.level + '！', '#7ee787');
    G.fx.push({ type: 'ring', x: b.x, y: b.y, r0: 8, r1: 46, life: 0.45, max: 0.45, color: '#7ee787' });
    Sound.build();
    syncUI();
  }

  function doRepair() {
    var b = G.pickB;
    if (!b || b.dead) { toast('先在地图上点一座建筑'); return; }
    if (!canMaintain()) { toast('只能在修整阶段修复建筑'); return; }
    if (b.hp >= b.maxHp - 0.5) { toast('这座建筑血量是满的'); return; }
    var c = repairCost(b);
    if (G.mode === 'endless' && G.gold < c) { toast('金币不足，修复需要 ' + c + ' 金'); return; }
    payGold('def', c);
    b.hp = b.maxHp;
    floatText(b.x, b.y - 28, '修复完成', '#7ee787');
    G.fx.push({ type: 'ring', x: b.x, y: b.y, r0: 8, r1: 34, life: 0.4, max: 0.4, color: '#7ee787' });
    Sound.build();
    syncUI();
  }

  function updateInfoPanel() {
    var b = G.pickB;
    if (!b || b.dead || G.buildings.indexOf(b) < 0) {
      el.infoPanel.classList.add('hidden');
      G.pickB = null;
      return;
    }
    el.infoPanel.classList.remove('hidden');
    var U = CFG.upgrade;
    el.ipName.textContent = b.def.name;
    el.ipLv.textContent = 'Lv.' + b.level + (b.level >= U.maxLevel ? ' · 满级' : '');
    var st = ['血量 <b>' + Math.ceil(b.hp) + ' / ' + b.maxHp + '</b>'];
    if (b.s.dmg) st.push('伤害 <b>' + b.s.dmg + '</b>');
    if (b.range > 0) st.push('射程 <b>' + b.range + '</b>');
    if (b.s.cd) st.push('冷却 <b>' + b.s.cd + ' 秒</b>');
    if (b.s.heal) st.push('回血 <b>' + b.s.heal + ' / 秒</b>');
    if (b.s.reduct) st.push('减伤 <b>' + Math.round(b.s.reduct * 100) + '%</b>');
    el.ipStats.innerHTML = st.map(function (t) { return '<span>' + t + '</span>'; }).join('');
    el.ipBrief.textContent = b.def.brief || '';

    var maxed = b.def.trap || b.level >= U.maxLevel, uc = upgradeCost(b);
    el.ipUpgrade.textContent = b.def.trap ? '不可升级' : (maxed ? '已满级' : ('升级 Lv.' + (b.level + 1) + '（' + uc + ' 金）'));
    el.ipUpgrade.disabled = maxed || !canMaintain() || (G.mode === 'endless' && G.gold < uc);
    var full = b.hp >= b.maxHp - 0.5, rc = repairCost(b);
    el.ipRepair.textContent = full ? '血量已满' : ('修复（' + rc + ' 金）');
    el.ipRepair.disabled = full || !canMaintain() || (G.mode === 'endless' && G.gold < rc);
    el.ipTip.textContent = canMaintain()
      ? ('每升一级：血量 +' + Math.round(U.hpMul * 100) + '% · 伤害 +' + Math.round(U.dmgMul * 100) + '% · 射程 +' + Math.round(U.rangeMul * 100) + '%')
      : '战斗中无法升级 / 修复，等修整阶段再操作';
  }

  var lastPhaseKey = '';
  function syncUI() {
    var vs = G.mode === 'versus';
    el.boxDef.classList.toggle('hidden', !vs);
    el.boxAtk.classList.toggle('hidden', !vs);
    el.boxRound.classList.toggle('hidden', !vs);
    el.boxGold.classList.toggle('hidden', vs);
    el.boxCastle.classList.toggle('hidden', vs);
    el.boxWave.classList.toggle('hidden', vs);
    el.boxHq.classList.toggle('hidden', !vs);
    el.boxUnits.classList.toggle('hidden', vs);
    el.boxBest.classList.toggle('hidden', vs);
    el.boxNext.classList.toggle('hidden', vs);

    var phaseText = '—';
    if (vs) {
      phaseText = G.phase === 'defDeploy' ? '防御部署' : (G.phase === 'atkDeploy' ? '攻击部署' : (G.phase === 'battle' ? '战斗中' : '回合结束'));
    } else {
      phaseText = G.phase === 'wave' ? '进攻中' : (G.phase === 'over' ? '结束' : '备战');
    }
    el.phase.textContent = phaseText;
    el.goldDef.textContent = vs ? '∞' : G.goldDef;
    el.goldAtk.textContent = vs ? '∞' : G.goldAtk;
    el.gold.textContent = G.gold;
    el.castle.textContent = G.castle ? Math.ceil(G.castle.hp) : '—';
    el.hq.textContent = G.hq ? Math.ceil(G.hq.hp) : '已陷落';
    el.round.textContent = '第 ' + G.round + ' 轮';
    el.wave.textContent = '第 ' + G.wave + ' 波';
    el.kills.textContent = G.kills;
    if (!vs) {
      el.units.textContent = countAtk() + ' / ' + UNIT_CAP;
      el.best.textContent = '第 ' + best.wave + ' 波 · ' + best.score + ' 分';
      if (G.over) el.next.textContent = '本局已结束';
      else if (G.phase === 'wave') el.next.textContent = '第 ' + G.wave + ' 波进攻中 · 待出场 ' + G.spawnQueue.length + ' 名';
      else {
        if (!G.preview) G.preview = wavePreview(G.wave + 1);
        var pv = G.preview;
        el.next.textContent = '第 ' + (G.wave + 1) + ' 波：' + (pv.boss ? '【BOSS 波】' : '') +
          pv.text + ' · 血量 ×' + pv.hpMul.toFixed(2);
      }
    }

    var key = G.mode + '|' + G.phase;
    if (key !== lastPhaseKey) { lastPhaseKey = key; buildCards(); }

    for (var i = 0; i < cardList.length; i++) {
      var it = cardList[i];
      var g = G.mode === 'endless' ? G.gold : (it.def.isUnit ? G.goldAtk : G.goldDef);
      it.el.classList.toggle('locked', G.mode === 'endless' && g < it.def.cost);
      it.el.classList.toggle('active', G.sel === it.def);
      var cc = it.el.querySelector('.c-cost');
      if (cc) cc.textContent = G.mode === 'endless' ? (it.def.cost + ' 金') : '免费';
    }

    if (vs) {
      if (G.phase === 'defDeploy') {
        el.badge.className = 'badge'; el.badge.textContent = '防御方';
        el.hint.textContent = '金币无限、无放置限制：建筑可以叠加放置；右键 / 双指拆除，长按可拖动换位。守住中央的大本营。';
      } else if (G.phase === 'atkDeploy') {
        el.badge.className = 'badge atk'; el.badge.textContent = '攻击方';
        el.hint.textContent = '金币无限、无放置限制：角色可以贴着建筑放；右键 / 双指移除，长按可拖动换位。';
      } else {
        el.badge.className = 'badge battle'; el.badge.textContent = '战斗中';
        el.hint.textContent = '战斗阶段：防御方不能部署或移动建筑，攻击方也不能增援；敌人会集火同一目标，攻击方目标是摧毁大本营。';
      }
    } else {
      el.badge.className = 'badge';
      el.badge.textContent = G.phase === 'wave' ? '第 ' + G.wave + ' 波' : '备战';
      el.hint.textContent = '击杀敌人 +' + killGold() + ' 金币（波次越高越多）；边被攻击也能建塔，右键 / 双指拆塔返还 ' +
        Math.round(CFG.refundRate * 100) + '%；点建筑可查看详情，修整阶段可花金币升级 / 修复；移动建筑只能在修整阶段（长按拖动）；选中一座塔后直接放在指定建筑上即可合成（如电磁塔 + 电磁塔 = 雷瓦斯）。';
    }

    if (G.destroyMode) {
      el.costHint.textContent = '拆除模式：点击地图上的建筑 / 角色即可移除';
      el.hint.textContent = '拆除模式已开启：点击拆除，长按仍可拖动；再点「拆除」按钮关闭。';
    } else if (G.sel) {
      if (vs) {
        el.costHint.textContent = '放置「' + G.sel.name + '」→ 免费（双方金币无限，无放置限制）';
      } else {
        el.costHint.textContent = '放置「' + G.sel.name + '」→ 花费 ' + G.sel.cost + ' 金币（余 ' + G.gold + '）';
      }
      el.hint.textContent = G.sel.name + '：' + G.sel.brief;
    } else {
      el.costHint.textContent = '花费提示：先选一张卡片';
    }

    if (vs) {
      if (G.phase === 'defDeploy') { el.btnMain.textContent = '完成部署 →'; el.btnMain.disabled = false; }
      else if (G.phase === 'atkDeploy') { el.btnMain.textContent = '开始进攻 →'; el.btnMain.disabled = false; }
      else if (G.phase === 'battle') { el.btnMain.textContent = '战斗中…'; el.btnMain.disabled = true; }
      else { el.btnMain.textContent = '回合结束'; el.btnMain.disabled = true; }
    } else {
      if (G.phase === 'rest') {
        var eb = Math.round(G.countdown * CFG.earlyBonusPerSec);
        el.btnMain.textContent = '立即开波 +' + eb;
        el.btnMain.disabled = G.over;
      }
      else if (G.phase === 'wave') { el.btnMain.textContent = '进攻中…'; el.btnMain.disabled = true; }
      else { el.btnMain.textContent = '重新开始'; el.btnMain.disabled = false; }
    }
    el.btnPause.textContent = G.paused ? '继续' : '暂停';
    el.btnSpeed.textContent = '速度 ×' + G.speed;
    el.btnDestroy.textContent = '拆除：' + (G.destroyMode ? '开' : '关');
    el.btnDestroy.classList.toggle('danger', G.destroyMode);
    canvas.classList.toggle('destroy', G.destroyMode);
    el.btnMusic.textContent = '音乐：' + (Music.on ? '开' : '关');
    el.btnMusic.classList.toggle('on', Music.on);
    el.btnSound.classList.toggle('on', Sound.on);
    el.btnSound.textContent = '音效：' + (Sound.on ? '开' : '关');
    if (el.volMusic.value !== String(Math.round(Music.VOL * 100))) el.volMusic.value = String(Math.round(Music.VOL * 100));
    if (el.volSfx.value !== String(Math.round(Sound.VOL * 100))) el.volSfx.value = String(Math.round(Sound.VOL * 100));

    updateInfoPanel();
  }

  // 每 0.25 秒刷新一次会跳动的 HUD 数值（金币 / 城堡 / 单位数 / 提前开波奖励）
  var hudTick = 0;
  function syncHud() {
    if (G.mode === 'endless') {
      el.gold.textContent = G.gold;
      el.units.textContent = countAtk() + ' / ' + UNIT_CAP;
      el.castle.textContent = G.castle ? Math.ceil(G.castle.hp) : '—';
      if (!G.over && G.phase === 'rest') el.btnMain.textContent = '立即开波 +' + Math.round(G.countdown * CFG.earlyBonusPerSec);
      if (G.phase === 'wave') el.next.textContent = '第 ' + G.wave + ' 波进攻中 · 待出场 ' + G.spawnQueue.length + ' 名';
    }
    if (G.pickB) updateInfoPanel();
  }

  var toastTimer = null;
  function toast(msg) {
    el.toast.textContent = msg;
    el.toast.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.toast.classList.remove('show'); }, 1500);
  }
  function showOverlay(t, x, b) {
    el.ovTitle.textContent = t; el.ovText.textContent = x; el.ovBtn.textContent = b;
    el.overlay.classList.remove('hidden');
  }
  function hideOverlay() { el.overlay.classList.add('hidden'); }

  function togglePause() {
    if (G.over) return;
    G.paused = !G.paused;
    if (G.paused) showOverlay('已暂停', '点击继续回到战场。', '继续');
    else hideOverlay();
    syncUI();
  }
  function cycleSpeed() { G.speed = G.speed === 1 ? 2 : (G.speed === 2 ? 3 : 1); syncUI(); }

  el.btnMain.addEventListener('click', function () {
    if (G.mode === 'versus') {
      if (G.phase === 'defDeploy') endDefDeploy();
      else if (G.phase === 'atkDeploy') startBattle();
    } else {
      if (G.phase === 'rest') startWave(true);
      else if (G.phase === 'over') reset('endless');
    }
  });
  el.btnPause.addEventListener('click', togglePause);
  el.btnSpeed.addEventListener('click', cycleSpeed);
  el.btnDestroy.addEventListener('click', function () {
    G.destroyMode = !G.destroyMode;
    if (G.destroyMode) { G.sel = null; toast('拆除模式：点击地图即可拆除（再按一次关闭）'); }
    syncUI();
  });
  el.btnMusic.addEventListener('click', function () { Music.toggle(); syncUI(); });
  el.btnSound.addEventListener('click', function () { Sound.on = !Sound.on; if (Sound.on) Sound.ensure(); syncUI(); });
  // 音量分离：音乐 / 音效各自一条滑块
  el.volMusic.addEventListener('input', function () { Music.setVol(this.value / 100); });
  el.volSfx.addEventListener('input', function () {
    Sound.setVol(this.value / 100);
    if (Sound.on) Sound.ensure(); else { Sound.on = true; Sound.ensure(); }   // 拖动即可试听
  });
  // 触屏 / 鼠标都能用的「取消选择」：清空卡片选择、详情面板与拆除模式
  el.btnCancel.addEventListener('click', function () {
    G.sel = null; G.pickB = null; G.destroyMode = false;
    if (G.drag) cancelDrag();
    clearPress();
    syncUI();
  });
  el.ipUpgrade.addEventListener('click', doUpgrade);
  el.ipRepair.addEventListener('click', doRepair);
  el.ipClose.addEventListener('click', function () { G.pickB = null; syncUI(); });
  el.btnRestart.addEventListener('click', function () { reset(G.mode); });
  el.ovBtn.addEventListener('click', function () {
    if (G.paused) { togglePause(); return; }
    if (G.mode === 'versus') {
      if (G.phase === 'roundEnd') { if (G.roundWinner === 'def') nextRound(); else reset('versus'); }
      else hideOverlay();
    } else {
      if (G.over) reset('endless'); else hideOverlay();
    }
  });
  Array.prototype.forEach.call(el.modes.children, function (b) {
    b.addEventListener('click', function () {
      Array.prototype.forEach.call(el.modes.children, function (o) { o.classList.remove('active'); });
      b.classList.add('active');
      reset(b.dataset.mode);
    });
  });

  // ================= 主循环 =================
  var lastT = 0;
  function step(dt) {
    G.time += dt;
    var sim = (G.mode === 'endless' && !G.over) || (G.mode === 'versus' && G.phase === 'battle');
    if (G.mode === 'endless' && !G.over) {
      if (G.phase === 'wave') {
        G.spawnTimer -= dt;
        if (G.spawnQueue.length && G.spawnTimer <= 0) {
          if (countAtk() >= UNIT_CAP) { G.spawnTimer = 0.5; }   // 达到单位上限：等一会儿再放
          else { spawnWaveUnit(G.spawnQueue.shift()); G.spawnTimer = G.waveData.gap; }
        }
        if (!G.spawnQueue.length) {
          var any = false;
          for (var i = 0; i < G.units.length; i++) if (G.units[i].side === 'atk') { any = true; break; }
          if (!any) finishWave();
        }
      } else if (G.phase === 'rest') {
        G.countdown -= dt;
        if (G.countdown <= 0) startWave(false);
      }
    } else if (G.mode === 'versus' && G.phase === 'battle') {
      checkVersusEnd();
    }
    if (sim) {
      updateBuildings(dt);
      updateUnits(dt);
      updateProjs(dt);
      updateRollers(dt);
      updateZones(dt);
      updateFx(dt);
    } else {
      updateFx(dt);
    }
  }

  function loop(now) {
    var dt = Math.min((now - lastT) / 1000, 0.05);
    lastT = now;
    if (!dt || dt < 0) dt = 0;
    Music.update(isBattle(), G.paused);
    if (G.drag && !canMove()) { cancelDrag(); syncUI(); }     // 阶段变化：结束拖动
    if (!G.paused && !G.over) {
      for (var s = 0; s < G.speed; s++) step(dt);
    }
    hudTick += dt;
    if (hudTick > 0.25) { hudTick = 0; syncHud(); }     // 金币 / 单位数等每 0.25 秒刷新
    render();
    requestAnimationFrame(loop);
  }

  // ================= 初始化 =================
  function reset(mode) {
    G = newGame(mode);
    lastPhaseKey = '';
    hideOverlay();
    if (mode === 'endless') addBuilding('archer', 10, 5);
    else addHq();                       // 双人自由模式：防御方大本营
    buildCards();
    syncUI();
    if (mode === 'versus') {
      showOverlay('双人自由模式',
        '自由对战：双方金币无限、放置完全无限制（建筑可叠加、角色可贴脸部署）。\n轮流在同一台电脑上操作：\n1. 防御方先部署建筑，点击「完成部署」；\n2. 攻击方再部署角色，点击「开始进攻」；\n3. 战斗阶段双方都不能操作：全部敌人被消灭则防御方胜，大本营被摧毁则攻击方胜。\n进攻方规则：所有敌人集火同一个建筑，优先打烟竹，没有烟竹就打最近的建筑；裂岩墙只在没有其它目标时才拆。\n操作：鼠标左键部署、右键拆除、长按拖动；触屏轻点部署、长按拖动、双指轻点拆除（或用底部「拆除」按钮）。',
        '知道了');
    }
  }

  // 浏览器要求先有用户操作才能播放声音：首次点击 / 按键时启动背景音乐
  function unlockMusic() {
    if (Music.on) Music.start();
    if (Music.started || !Music.on) {
      document.removeEventListener('pointerdown', unlockMusic);
      document.removeEventListener('keydown', unlockMusic);
    }
  }
  document.addEventListener('pointerdown', unlockMusic);
  document.addEventListener('keydown', unlockMusic);
  document.addEventListener('visibilitychange', function () {
    if (document.hidden) Music.stop();                 // 切到后台：静音并停止排程
    else if (Music.on) Music.start();
  });

  buildBackground();
  reset('versus');
  requestAnimationFrame(function (t) { lastT = t; loop(t); });
})();
