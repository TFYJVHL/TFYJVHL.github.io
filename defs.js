/* 单位与建筑数据（window.GD） */
window.GD = {
  // ---------------- 全局可调数值（集中在这里，方便继续调平衡） ----------------
  CONFIG: {
    // 经济
    startGoldVersus: 1200,      // 双人自由模式：双方金币无限，这里只作显示用
    roundIncome: 400,
    startGoldEndless: 120,
    killGold: 10,               // 第 1 波击杀奖励
    killGoldPerWave: 0.15,      // 每波递增 15%
    killGoldMax: 60,
    refundRate: 0.6,            // 拆塔返还比例
    repairGoldPerHp: 0.06,      // 修复 1 点血需要的金币
    // 波次
    restSeconds: 15,            // 每波之间的修整时间
    earlyBonusPerSec: 1.5,      // 提前开波：剩余秒数 × 此系数 = 奖励金币
    waveClearGold: 20,          // 清波奖励 = 20 + 波次 × 8
    waveClearGoldPerWave: 8,
    scorePerWave: 10,
    // 波次难度曲线
    wave: {
      countBase: 3, countPerWave: 1.6, countMax: 34,
      hpBase: 1, hpPerWave: 0.06,                    // hpMul = hpBase + 波次 × hpPerWave
      gapBase: 0.8, gapPerWave: 0.02, gapMin: 0.35,  // 出场间隔
      bossEvery: 5,                                  // 每几波固定一个 Boss 波
      bossGuardRatio: 0.6, bossGuardMin: 4,          // Boss 波护卫小兵数量
      bossGapMin: 0.55,
      doubleBossFrom: 20                             // 从第几波起每波两个 Boss
    },
    // 单位上限（波次生成时按此上限节流）
    unitCap: 70,
    // 塔升级
    upgrade: {
      maxLevel: 3,
      costMul: 0.9,             // 升级花费 = 造价 × 此系数 × 当前等级
      hpMul: 0.35,              // 每级血量 +35%
      dmgMul: 0.3,              // 每级伤害 +30%
      rangeMul: 0.08,           // 每级射程 +8%
      cdMul: 0.9                // 每级冷却 ×0.9
    },
    // 音量
    vol: { music: 0.5, sfx: 0.7, musicPaused: 0.35 },
    // 背景音乐节奏
    music: { bpmCalm: 92, bpmBattle: 116 },
    // 召唤冷却（骷髅屋 / 母巢 / 祭司）
    summon: { skullCd: 4, skullCount: 1, skullMax: 10, hiveCd: 6, hiveCount: 2, hiveCount2: 2, priestCd: 8 },
    // 名单
    bossKeys: ['death', 'zeus', 'eyes', 'destroyer', 'titan', 'hive', 'arthur', 'prometheus'],
    heavyKeys: ['destroyer', 'arthur', 'death', 'zeus', 'eyes', 'titan', 'hive', 'golem', 'prometheus']
  },

  // ---------------- 建筑（防御方） ----------------
  BUILDINGS: [
    {
      key: 'archer', name: '弓箭塔', cost: 10, hp: 330, range: 130, hpTier: '较少', color: '#8fd694',
      brief: '塔上四名射手连续射击，每射出 4 发后停顿一下；伤害低、射速快、血量较少。',
      s: { dmg: 7, gap: 0.26, burst: 4, pause: 0.7 }
    },
    {
      key: 'tesla', name: '电磁塔', cost: 30, hp: 560, range: 100, hpTier: '中等', color: '#c39bff',
      brief: '一次电击最多 3 名敌人，敌人之间有概率连锁电击；伤害中等、冷却 2 秒、血量中等。',
      s: { dmg: 22, cd: 2.0, targets: 3, chain: 0.5 }
    },
    {
      key: 'cannon', name: '加农炮', cost: 90, hp: 600, range: 150, hpTier: '中等', color: '#ffa94d',
      brief: '一次射击打 5 次、每次 2 颗炮弹，暴击率 60%；中范围，冷却 4 秒，血量中等。',
      s: { dmg: 19, cd: 4.0, volley: 5, per: 2, crit: 0.6, critMul: 2 }
    },
    {
      key: 'bamboo', name: '烟竹', cost: 100, hp: 1130, range: 0, hpTier: '较高', color: '#9be89b', taunt: true,
      brief: '不攻击，会吸引敌人优先攻击自己；血量较高。', s: {}
    },
    {
      key: 'mortar', name: '迫击炮', cost: 80, hp: 1000, range: 230, minRange: 95, hpTier: '较高', color: '#c3cad6',
      brief: '抛射铁石，2 秒后在敌人周围砸下高额伤害；范围较大、冷却 5 秒、敌人过近时无法锁定。',
      s: { dmg: 130, cd: 5, splash: 62, delay: 2 }
    },
    {
      key: 'shaker', name: '振地机', cost: 80, hp: 980, range: 80, hpTier: '较高', color: '#d9a066',
      brief: '范围较小，周围有敌人时高压振动地面造成高额伤害；冷却 5 秒，血量较高。',
      s: { dmg: 170, cd: 5 }
    },
    {
      key: 'mage', name: '法师塔', cost: 100, hp: 650, range: 165, hpTier: '中等', color: '#ff7b54',
      brief: '射出火球，中等伤害、冷却 2 秒；命中必定点燃，灼烧 4 秒（期间未再被火球命中则失效）。',
      s: { dmg: 58, cd: 2, splash: 45, burnChance: 1, burnDps: 14, burnDur: 4 }
    },
    {
      key: 'catapult', name: '投石机', cost: 90, hp: 880, range: 265, minRange: 110, hpTier: '较高', color: '#a1887f',
      brief: '大范围投射巨石，砸落后高速滚动 4 秒造成较高伤害；冷却 5 秒；敌人过近时无法锁定，血量较高。',
      s: { dmg: 75, cd: 5, splash: 48, roll: 4, rollSpeed: 120 }
    },
    {
      key: 'iceberg', name: '冰山', cost: 100, hp: 630, range: 115, hpTier: '中等', color: '#74d0ff',
      brief: '略小范围，每 2 秒造成寒气：低伤害 + 减速，并有很小概率冻住 1.5 秒。',
      s: { dmg: 11, cd: 2, slow: 0.45, slowDur: 2, freezeChance: 0.08, freezeDur: 1.5 }
    },
    {
      key: 'skull', name: '骷髅屋', cost: 150, hp: 230, range: 210, hpTier: '极少', color: '#e6e6f0',
      brief: '大范围内出现敌人时，每 4 秒生成 1 只骷髅（伤害低、血量少、移速快，不会自己消失）；场上防御方骷髅最多同时存在 10 只，满了就暂停召唤；骷髅屋本身血量极少。',
      s: { cd: 4, count: 1, max: 10 }
    },
    {
      key: 'prism', name: '棱镜塔', cost: 125, hp: 560, range: 160, hpTier: '中等', color: '#7ce7ff',
      brief: '中范围，发射一束光，击中第一个敌人后光束可折射到附近 2~3 名敌人；光束能穿透普通杂兵；单次伤害一般，冷却 3 秒。',
      s: { dmg: 45, cd: 3, pierce: 22, refract: 3, refractRange: 90, refractMul: 0.7 }
    },
    {
      key: 'altar', name: '圣佑祭坛', cost: 150, hp: 330, range: 150, hpTier: '偏少', color: '#ffe9a8', aura: true,
      brief: '自身不攻击；范围内所有友方建筑受到的伤害减少，并缓慢回复少量血量。被腐蚀的建筑享受不到这个效果。',
      s: { reduct: 0.65, heal: 6 }
    },
    {
      key: 'gravity', name: '引力核心', cost: 125, hp: 600, range: 240, hpTier: '中等', color: '#b39ddb',
      brief: '大范围，每 5 秒释放一次引力脉冲，把范围内地面敌人向外击退一小段距离，并造成极低伤害；对比较强的攻击角色无效。',
      s: { cd: 5, knock: 26, dmg: 4 }
    },
    {
      key: 'spore', name: '毒孢子塔', cost: 150, hp: 540, range: 95, hpTier: '中等', color: '#a3e635',
      brief: '小范围一次喷射 3 枚孢子，孢子会短距离跟踪敌人，碰到就小范围爆炸并让其中毒，持续掉血 5 秒；毒素可叠加但不会直接杀死敌人（最低扣到 1 血）；冷却 5 秒。',
      s: { dmg: 10, cd: 5, count: 3, splash: 34, poisonDps: 6, poisonDur: 5, maxStacks: 3, homing: 120, ttl: 1.2 }
    },
    {
      key: 'wall', name: '裂岩墙', cost: 50, hp: 1400, range: 0, hpTier: '偏高', color: '#8a7f6d',
      blocking: true,
      brief: '不攻击、血量偏高的阻挡建筑，能和任何建筑连在一起卡住敌人路线；可以和烟竹同时存在。',
      s: {}
    },
    {
      key: 'trap', name: '尖刺陷阱', cost: 20, hp: 1, range: 0, hpTier: '一次性', color: '#a3e635',
      trap: true, untargetable: true,
      brief: '放置后隐形的一次性建筑，敌人踩到就触发：踩中的敌人挂上毒素 buff，持续掉血 4 秒（毒素不会直接杀死敌人）；触发后陷阱消失。',
      s: { radius: 30, poisonDps: 12, poisonDur: 4, maxStacks: 1 }
    },
    {
      key: 'bomb', name: '炸弹', cost: 50, hp: 1, range: 0, hpTier: '一次性', color: '#ff6b3d',
      trap: true, untargetable: true,
      brief: '放置后隐形埋伏，敌人走到附近立即引爆：小范围高额爆炸伤害，一次性（对强力角色伤害减半）。',
      s: { radius: 34, dmg: 220, splash: 58, heavyMul: 0.5 }
    },
    {
      key: 'mine', name: '矿洞', cost: 150, hp: 500, range: 0, hpTier: '中等', color: '#ffc857', endlessOnly: true,
      brief: '无尽模式专属建筑：战斗中每秒产出 1 金币，修整阶段不产出。自身不攻击、血量中等，升级只提升耐久，不提升产量。',
      s: { goldPerSec: 1 }
    },

    // ---------------- 合成建筑（只能靠合成获得，不出现在卡片栏） ----------------
    {
      key: 'thunder', name: '雷瓦斯', cost: 60, hp: 1150, range: 135, hpTier: '高', color: '#ffe066', fuseOnly: true,
      brief: '合成建筑（电磁塔 + 电磁塔）：一次电击最多 4 名敌人并可连锁，被击中的敌人还有较大概率召来天雷劈中，造成额外伤害；血量高、范围比电磁塔更大。',
      s: { dmg: 34, cd: 2.0, targets: 4, chain: 0.6, boltChance: 0.55, boltDmg: 70 }
    },
    {
      key: 'heavymortar', name: '重型迫击炮', cost: 160, hp: 1400, range: 265, minRange: 110, hpTier: '高', color: '#9aa4b2', fuseOnly: true,
      brief: '合成建筑（迫击炮 + 迫击炮）：每 4 秒向天空抛射一颗超级巨大的铁石，3 秒后在敌人脚下砸落，范围与伤害都远大于普通迫击炮；血量高；敌人过近时无法锁定。',
      s: { dmg: 320, cd: 4, splash: 118, delay: 3, r: 15 }
    },
    {
      key: 'laser', name: '激光塔', cost: 250, hp: 820, range: 205, hpTier: '较高', color: '#ff5c8a', fuseOnly: true,
      brief: '合成建筑（棱镜塔 + 引力核心）：每 5 秒朝敌人方向射出一道超长激光，穿透沿途所有敌人，伤害中等、冷却 5 秒。',
      s: { dmg: 75, cd: 5, len: 420, w: 8 }
    },
    {
      key: 'frostcrush', name: '骨碎寒冰机', cost: 180, hp: 1150, range: 115, hpTier: '高', color: '#9be8ff', fuseOnly: true,
      brief: '合成建筑（振地机 + 冰山）：每 5 秒震动大地，对周围中等范围内的地面敌人造成高额伤害，并必定将其冰冻 2 秒；血量高。',
      s: { dmg: 250, cd: 5, freezeDur: 2 }
    },
    {
      key: 'grail', name: '圣杯', cost: 250, hp: 1400, range: 150, hpTier: '高', color: '#ffe9a8', fuseOnly: true,
      taunt: true, aura: true,
      brief: '合成建筑（烟竹 + 圣佑祭坛）：两者效果合并——仍然吸引所有敌人优先攻击自己（血量高、扛得住），同时让范围内所有友方建筑受到的伤害减少并缓慢回血。被腐蚀的建筑享受不到增益。',
      s: { reduct: 0.65, heal: 6 }
    }
  ],

  // 合成配方：把 b 直接放到 a 所在的格子上（两者重叠）即合成 out
  FUSE: [
    { a: 'tesla', b: 'tesla', out: 'thunder' },
    { a: 'mortar', b: 'mortar', out: 'heavymortar' },
    { a: 'prism', b: 'gravity', out: 'laser' },
    { a: 'shaker', b: 'iceberg', out: 'frostcrush' },
    { a: 'bamboo', b: 'altar', out: 'grail' }
  ],

  // ---------------- 角色（攻击方 / 召唤物） ----------------
  UNITS: [
    {
      key: 'goblin', name: '哥布林', cost: 70, hp: 90, hpTier: '极少', dmg: 6, speed: 82, range: 30, cd: 0.5,
      r: 8, color: '#7ed957', brief: '移速极快、伤害极低、血量极少、攻速较快。'
    },
    {
      key: 'archer', name: '弓箭手', cost: 60, hp: 140, hpTier: '较低', dmg: 13, speed: 52, range: 120, cd: 1.0,
      r: 9, color: '#c0e663', ranged: true, brief: '伤害较低、血量较低、攻速中等、移速中等，射程中等。'
    },
    {
      key: 'warrior', name: '战士', cost: 70, hp: 280, hpTier: '中等', dmg: 17, speed: 34, range: 32, cd: 1.5,
      r: 10, color: '#ffb454', brief: '近战角色，血量中等、伤害低、移速较低、攻速较低。'
    },
    {
      key: 'flameskull', name: '烈焰骷髅射手', cost: 70, hp: 230, hpTier: '中等', dmg: 15, speed: 40, range: 145, cd: 1.6,
      r: 9, color: '#ff8a3d', ranged: true, burn: { dps: 12, dur: 4 },
      brief: '伤害较低但带燃烧效果，血量中等、攻速较低、移速较慢。'
    },
    {
      key: 'pulse', name: '脉冲射手', cost: 100, hp: 210, hpTier: '较低', dmg: 11, speed: 34, range: 165, cd: 1.0,
      r: 9, color: '#66d9e8', ranged: true, bounce: 0.5,
      brief: '射速中等、移速较低、伤害较低；射出的东西有概率反弹到周围建筑一次。'
    },
    {
      key: 'bone', name: '大骨', cost: 100, hp: 560, hpTier: '高', dmg: 10, speed: 34, range: 34, cd: 2.4,
      r: 12, color: '#e3e0d0', brief: '血量高、伤害极低、移速较慢、攻速极慢。'
    },
    {
      key: 'wizard', name: '巫师', cost: 150, hp: 320, hpTier: '中等', dmg: 30, speed: 36, range: 155, cd: 1.7,
      r: 10, color: '#9b7bff', ranged: true, burn: { dps: 14, dur: 4 }, splash: 45,
      brief: '射出紫火，小范围爆炸并点燃目标（灼烧 4 秒）；伤害中等、血量中等、移速较慢、攻速较慢。'
    },
    {
      key: 'snowman', name: '雪人', cost: 150, hp: 760, hpTier: '较高', dmg: 18, speed: 32, range: 34, cd: 1.5,
      r: 13, color: '#dff3ff', slowBuilding: { chance: 0.35, dur: 4 },
      brief: '伤害较低、血量较高、移速较慢、攻速较慢；攻击建筑后有概率让建筑射速变慢 4 秒。'
    },
    {
      key: 'arthur', name: '亚瑟', cost: 600, hp: 1700, hpTier: '极高', dmg: 36, speed: 22, range: 34, cd: 1.1,
      r: 13, color: '#ffd24d', special: 'arthur',
      brief: 'Boss：免疫减速 / 冰冻 / 灼烧 / 中毒等一切负面状态。血量极高、伤害中等、移速低、攻速中等；血量低于 20% 时立即回复损失血量的 50%，并召唤 4 名战士（每局一次）。'
    },
    {
      key: 'death', name: '死神', cost: 750, hp: 980, hpTier: '高', dmg: 34, speed: 22, range: 95, cd: 2.2,
      r: 12, color: '#a06bff', ranged: true, special: 'death',
      brief: '挥镰攻击，伤害中等、血量高、移速低、攻速低；部署时周围生成 2 骷髅 + 2 烈焰骷髅射手；死亡时黑爪随机摧毁一座建筑。'
    },
    {
      key: 'zeus', name: '宙斯', cost: 750, hp: 760, hpTier: '高', dmg: 17, speed: 64, range: 135, cd: 0.45,
      r: 11, color: '#ffe066', ranged: true, special: 'zeus',
      brief: '中范围连续射出电球，伤害较低但攻速与移速极快；很小概率在命中建筑上方降下闪电，瞬间造成小范围高伤。'
    },
    {
      key: 'eyes', name: '双子魔眼', cost: 1000, hp: 3000, hpTier: '超高', dmg: 26, speed: 46, range: 170, cd: 0.7,
      r: 12, color: '#ff5c5c', ranged: true, flying: true, special: 'eyes',
      brief: '立即召唤两只飞行巨眼（免疫近战），两只各有一条独立血条、血量都很高（每只 3000）：红瞳激光（穿透、伤害中等、射速快），紫瞳紫火（伤害较高 + 燃烧、射速慢）。单只血量低于 50% 时该只变为近战巨嘴：攻速与移速变快、伤害变低。'
    },
    {
      key: 'destroyer', name: '毁灭者', cost: 1000, hp: 6500, hpTier: '超极高', dmg: 12, speed: 96, range: 34, cd: 0.5,
      r: 14, color: '#8d99ae', special: 'destroyer', mouthDmg: 150, segs: 24,
      brief: '超长铁虫（24 节，约 460 像素长），血量全场最高、移速极快；不跟随大部队集火，而是随机挑一座建筑冲过去，用脑袋撞一下（中等伤害）就立刻改撞下一座随机建筑；全身蹭到建筑也会持续造成伤害；身体任何一段都能被建筑锁定攻击。'
    },
    {
      key: 'titan', name: '炎狱泰坦', cost: 700, hp: 2800, hpTier: '超高', dmg: 30, speed: 48, range: 36, cd: 1.8,
      r: 15, color: '#ff5722', special: 'titan',
      burn: { dps: 16, dur: 5 }, trail: { dps: 18, life: 3.5, r: 26, gap: 0.35 },
      enrageAt: 0.4, enrage: { speedBoost: 2.0, cd: 0.6 },
      brief: '移速中等、攻速较低、血量超高；攻击建筑时会点燃建筑，走过的地面都会燃烧；血量低于 40% 进入狂暴，移速与攻速都变成高。'
    },
    {
      key: 'prometheus', name: '普罗米修斯', cost: 900, hp: 4200, hpTier: '超高', dmg: 22, speed: 48, range: 170, cd: 1.2,
      r: 16, color: '#ffb347', ranged: true, special: 'prometheus', passThrough: true,
      brief: 'Boss：免疫减速 / 冰冻 / 灼烧 / 中毒等一切负面状态。血量超高、伤害较低、移速中等、攻速中等；智商高——能翻越裂岩墙直取墙后的建筑，并优先补刀射程内血量最少的建筑。出场先用火焰远程射 5 发，射完永久转为近战形态冲上去肉搏。受到攻击时 20% 概率完全免疫、40% 概率减伤 50%。',
      s: { rangedShots: 5, meleeRange: 36, immuneChance: 0.2, reductChance: 0.4, reduct: 0.5 }
    },
    {
      key: 'hive', name: '梦魇母巢', cost: 850, hp: 1500, hpTier: '高', dmg: 0, speed: 40, range: 0, cd: 6,
      r: 14, color: '#8e5bd6', special: 'hive', noAttack: true,
      brief: '移速中等、血量高，本身不攻击；存活期间每 6 秒同时生成 2 只掘地虫 + 2 只腐蚀虫，被摧毁后不再生成。',
      s: { cd: 6, count: 2, spawn: 'burrow', count2: 2, spawn2: 'corrode' }
    },
    {
      key: 'priest', name: '缚灵祭司', cost: 200, hp: 420, hpTier: '中等', dmg: 0, speed: 48, range: 0, cd: 8,
      r: 10, color: '#a5f3d0', special: 'priest', noAttack: true,
      brief: '移速中等、血量中等，本身不攻击；每隔 8 秒给附近友方角色套上护盾，护盾可以抵挡一次伤害。',
      s: { cd: 8, range: 130 }
    },
    {
      key: 'golem', name: '熔岩傀儡', cost: 270, hp: 1150, hpTier: '高', dmg: 12, speed: 30, range: 34, cd: 1.4,
      r: 13, color: '#ff7043', special: 'golem',
      brief: '移速慢、血量高、伤害较低；被击杀时发生爆炸，对附近小范围内的所有防御建筑造成一次中等伤害。',
      s: { boomDmg: 120, boomR: 95 }
    },
    {
      key: 'ghost', name: '幽灵', cost: 120, hp: 260, hpTier: '中等', dmg: 10, speed: 72, range: 32, cd: 1.5,
      r: 10, color: '#cbd5e1', flying: true, passThrough: true, meleeTargetable: true,
      brief: '血量中等、移动快、攻速较低、伤害较低；可以穿过阻挡建筑，但不再免疫近战（防守单位能打它）。'
    },
    {
      key: 'corrode', name: '腐蚀虫', cost: 170, hp: 200, hpTier: '低', dmg: 5, speed: 32, range: 32, cd: 1.0,
      r: 9, color: '#84cc16', special: 'corrode',
      brief: '移速慢、血量低、伤害极低、攻速中等；攻击建筑时给建筑挂上腐蚀效果，被腐蚀的建筑不能再获得增益，且每次攻击有概率让冷却时间增加数秒，不叠加。',
      s: { dur: 8, chance: 0.5, extraCd: 1.5 }
    },
    {
      key: 'burrow', name: '掘地虫', cost: 200, hp: 190, hpTier: '较低', dmg: 12, speed: 68, range: 32, cd: 1.0,
      r: 9, color: '#d97706', special: 'burrow',
      brief: '移速较快、血量较低、伤害低；可以短暂钻地，钻地期间无敌（挡下一切伤害，包括持续伤害），攻击建筑时才钻出来。',
      s: { duration: 2.5, cd: 6, speedBoost: 1.35, emergeRange: 50 }
    },
    {
      key: 'skeleton', name: '骷髅', cost: 0, hp: 70, hpTier: '极少', dmg: 11, speed: 78, range: 30, cd: 0.6,
      r: 8, color: '#eef0f6', summon: true, brief: '召唤物：伤害较低、血量较少、移动速度较快。'
    }
  ]
};

// 卡片栏按造价从小到大排列（花费相同时按名称，保证顺序稳定）
[window.GD.BUILDINGS, window.GD.UNITS].forEach(function (list) {
  list.sort(function (a, b) { return a.cost - b.cost || a.name.localeCompare(b.name, 'zh'); });
});

// 召唤冷却 / 数量统一由 CONFIG.summon 驱动，避免同一数值散落两处
(function () {
  var S = window.GD.CONFIG.summon;
  function find(list, key) {
    for (var i = 0; i < list.length; i++) if (list[i].key === key) return list[i];
    return null;
  }
  var skull = find(window.GD.BUILDINGS, 'skull');
  if (skull) { skull.s.cd = S.skullCd; skull.s.count = S.skullCount; skull.s.max = S.skullMax; }
  var hive = find(window.GD.UNITS, 'hive');
  if (hive) { hive.s.cd = S.hiveCd; hive.s.count = S.hiveCount; hive.s.count2 = S.hiveCount2; }
  var priest = find(window.GD.UNITS, 'priest');
  if (priest) priest.s.cd = S.priestCd;
})();
