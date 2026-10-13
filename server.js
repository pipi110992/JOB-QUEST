const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { createClient } = require('@supabase/supabase-js');

const app = express();
const srv = http.createServer(app);
const io = new Server(srv, { pingInterval: 10000, pingTimeout: 30000 });
app.use(express.static('public'));

const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const TEACHER_PASSWORD = process.env.TEACHER_PASSWORD || '';

// ===== ค่าที่ปรับสมดุลเกมได้ =====
const C = {
  DAY_SEC: 420,            // 1 วันในเกม = 7 นาที
  RENT: 40,                // ค่าเช่า/วัน
  HUNGER_DROP: 0.24,       // หิวลดต่อวินาที
  MEAL_PRICE: 15, MEAL_FOOD: 40, INGREDIENT_PRICE: 10,
  RESTOCK_PAY: { grocer: 20, other: 10 },
  COOLDOWN: 3500,          // ทำงานซ้ำได้ทุกกี่ ms
  REACH: 90,               // ระยะที่ถือว่าอยู่ใกล้อาคาร (px)
  TEST_SWITCH: process.env.TEST_SWITCH !== 'off',  // ปุ่มเปลี่ยนอาชีพ (ตั้ง TEST_SWITCH=off ใน Render เพื่อปิด)
};
// ภาษีเงินสด/วัน และดอกเบี้ยเงินฝาก/วัน แบบขั้นบันได [เพดานของขั้น, อัตรา]
const TAX = [[500, 0.03], [1000, 0.05], [2000, 0.08], [5000, 0.12], [10000, 0.17], [Infinity, 0.22]];
const INTEREST = [[500, 0.01], [1000, 0.02], [2000, 0.03], [5000, 0.04], [Infinity, 0.05]];
const bracket = (amt, table) => {
  let sum = 0, prev = 0;
  for (const [cap, rate] of table) { if (amt > prev) sum += (Math.min(amt, cap) - prev) * rate; prev = cap; }
  return Math.round(sum);
};

// salary = เงินเดือนต่อวัน | site+pay+len = งานมินิเกม (len = จำนวนลูกศร)
const CAREERS = {
  gov:    { name: 'ข้าราชการ',       seats: 3, minGrade: 3.0, salary: 150 },
  nurse:  { name: 'พยาบาล',          seats: 2, minGrade: 2.5, salary: 100, site: 'hospital', pay: 20, len: 3 },
  food:   { name: 'คนขายอาหาร',      seats: 5, minGrade: 0, site: 'restaurant', mini: 'cook' },
  grocer: { name: 'เจ้าของร้านชำ',   seats: 4, minGrade: 0 },
  farmer: { name: 'เกษตรกร',         seats: 3, minGrade: 0, site: 'farm', pay: 18, len: 4 },
  rider:  { name: 'ไรเดอร์',         seats: 2, minGrade: 0, site: 'depot', pay: 22, len: 5 },
  labor:  { name: 'รับจ้างก่อสร้าง', seats: 4, minGrade: 0, site: 'site', pay: 14, len: 4 },
};
const BUILDINGS = {
  shop:       { x: 100, y: 130, name: 'ร้านชำ',      color: '#2a9d8f' },
  bank:       { x: 240, y: 130, name: 'ธนาคาร',      color: '#4361ee' },
  hospital:   { x: 550, y: 130, name: 'โรงพยาบาล',   color: '#e5e5e5' },
  restaurant: { x: 690, y: 130, name: 'ร้านอาหาร',   color: '#e76f51' },
  farm:       { x: 110, y: 410, name: 'ฟาร์ม',        color: '#6a994e' },
  depot:      { x: 280, y: 410, name: 'ศูนย์ส่งของ', color: '#f4a261' },
  site:       { x: 600, y: 410, name: 'ไซต์ก่อสร้าง', color: '#ffd23f' },
};

// ----- ข้อมูลมินิเกม -----
const PALETTE = [
  { id: 'rice', e: '🍚', n: 'ข้าว' }, { id: 'egg', e: '🥚', n: 'ไข่' }, { id: 'onion', e: '🧅', n: 'หอม' },
  { id: 'pork', e: '🥩', n: 'หมู' }, { id: 'chili', e: '🌶️', n: 'พริก' }, { id: 'veg', e: '🥬', n: 'ผัก' },
  { id: 'shrimp', e: '🦐', n: 'กุ้ง' }, { id: 'lime', e: '🍋', n: 'มะนาว' }, { id: 'mushroom', e: '🍄', n: 'เห็ด' },
];
const RECIPES = {
  fried: { name: 'ข้าวผัดไข่', need: ['rice', 'egg', 'onion'], pay: 30 },
  basil: { name: 'ผัดกะเพราหมู', need: ['pork', 'chili', 'veg', 'rice'], pay: 40 },
  tom:   { name: 'ต้มยำกุ้ง', need: ['shrimp', 'lime', 'chili', 'mushroom'], pay: 45 },
};
const PRODUCTS = [['🥛', 'นม', 25], ['🍞', 'ขนมปัง', 20], ['🍌', 'กล้วย', 15], ['🧃', 'น้ำผลไม้', 12], ['🍪', 'คุกกี้', 18], ['🧴', 'สบู่', 45]];
const BILLS = [20, 50, 100, 500, 1000];
const rand = n => Math.floor(Math.random() * n);

const game = { day: 1, elapsed: 0, phase: 'lobby', paused: false, order: [], pick: 0, treasury: 0 };
const players = new Map();   // code -> player (เฉพาะคนออนไลน์)
let seatUsed = {};

const near = (p, b) => Math.hypot(p.x - BUILDINGS[b].x, p.y - BUILDINGS[b].y) < C.REACH;
async function refreshSeats() {
  const { data } = await db.from('players').select('career').not('career', 'is', null);
  seatUsed = {};
  (data || []).forEach(r => (seatUsed[r.career] = (seatUsed[r.career] || 0) + 1));
}
const savePlayer = p => db.from('players').update({
  nick: p.nick, career: p.career, money: p.money, bank: p.bank,
  hunger: Math.round(p.hunger * 10) / 10, ingredients: p.ingredients,
}).eq('code', p.code);
const saveGame = () => db.from('game_state')
  .update({ day: game.day, elapsed: game.elapsed, phase: game.phase, treasury: game.treasury }).eq('id', 1);
const saveAll = () => Promise.all([...players.values()].map(savePlayer).concat(saveGame()));

function worldState() {
  const pickerCode = game.order[game.pick];
  const seats = {};
  for (const k in CAREERS) seats[k] = CAREERS[k].seats - (seatUsed[k] || 0);
  return {
    phase: game.phase, day: game.day, elapsed: game.elapsed, dayLen: C.DAY_SEC, paused: game.paused, treasury: game.treasury,
    pickerCode: game.phase === 'selecting' ? pickerCode || null : null,
    pickerNick: game.phase === 'selecting' ? (players.get(pickerCode)?.nick || '(ยังไม่ออนไลน์)') : null,
    seats,
    careers: Object.fromEntries(Object.entries(CAREERS).map(([k, v]) =>
      [k, { name: v.name, minGrade: v.minGrade, site: v.site || null, len: v.len || 0, pay: v.pay || 0 }])),
  };
}
const meState = p => ({
  code: p.code, nick: p.nick, career: p.career, money: p.money, bank: p.bank,
  hunger: Math.round(p.hunger), ingredients: p.ingredients, grade: Number(p.grade),
});
const toast = (p, msg) => p.sid && io.to(p.sid).emit('toast', msg);

function dayTick() {
  game.day++; game.elapsed = 0;
  for (const p of players.values()) {
    const salary = p.career && CAREERS[p.career].salary || 0;
    const parts = [`วันที่ ${game.day}:`];
    if (salary) { p.money += salary; parts.push(`เงินเดือน +${salary}`); }
    const rent = Math.min(p.money, C.RENT); p.money -= rent;
    parts.push(rent < C.RENT ? 'เงินไม่พอจ่ายค่าเช่า!' : `ค่าเช่า -${rent}`);
    const tax = Math.min(p.money, bracket(p.money, TAX)); p.money -= tax; game.treasury += tax;
    if (tax) parts.push(`ภาษี -${tax}`);
    const interest = bracket(p.bank, INTEREST); p.bank += interest;
    if (interest) parts.push(`ดอกเบี้ย +${interest}`);
    toast(p, parts.join(' '));
  }
  saveAll();
}

setInterval(() => {
  if (players.size && !game.paused && game.phase !== 'lobby') {
    game.elapsed++;
    for (const p of players.values()) p.hunger = Math.max(0, p.hunger - C.HUNGER_DROP);
    if (game.elapsed >= C.DAY_SEC) dayTick();
  }
  io.emit('world', worldState());
  for (const p of players.values()) p.sid && io.to(p.sid).emit('me', meState(p));
}, 1000);

setInterval(() => {
  io.emit('players', [...players.values()].map(p => ({ code: p.code, nick: p.nick, x: p.x, y: p.y, career: p.career })));
}, 100);
setInterval(() => saveAll().catch(() => {}), 20000);
setInterval(() => refreshSeats().catch(() => {}), 10000);

function creditGrocer(amount) {   // เงินจากการซื้อของที่ร้านชำ ไปที่เจ้าของร้านที่ออนไลน์ (ถ้ามี)
  const g = [...players.values()].filter(p => p.career === 'grocer');
  if (!g.length) return;
  const p = g[Math.floor(Math.random() * g.length)];
  p.money += amount; toast(p, `ลูกค้าซื้อของที่ร้าน +${amount}`);
}

io.on('connection', socket => {
  let p = null, isTeacher = false;

  socket.on('login', async ({ code, nick, password, x, y }, ack) => {
    code = String(code || '').trim().toUpperCase();
    if (code === 'TEACHER') {
      if (!TEACHER_PASSWORD || password !== TEACHER_PASSWORD) return ack({ ok: false, msg: 'รหัสครูไม่ถูกต้อง' });
      isTeacher = true;
      return ack({ ok: true, teacher: true });
    }
    const { data, error } = await db.from('players').select('*').eq('code', code).maybeSingle();
    if (error || !data) return ack({ ok: false, msg: 'ไม่พบรหัสนักเรียนนี้' });
    const old = players.get(code);
    const keep = old && old.sid !== socket.id ? old : null;   // ล็อกอินซ้ำ/เชื่อมต่อใหม่: ใช้ข้อมูลในหน่วยความจำที่ใหม่กว่า
    if (keep) { io.to(keep.sid).emit('kicked'); players.delete(code); }
    p = keep ? { ...keep, sid: socket.id } : {
      ...data, grade: Number(data.grade), hunger: Number(data.hunger), bank: Number(data.bank) || 0,
      x: 400, y: 300, cd: 0, sid: socket.id,
    };
    if (!keep) p.nick = String(nick || data.nick || code).slice(0, 12);
    if (Number.isFinite(Number(x)) && Number.isFinite(Number(y))) { p.x = Number(x); p.y = Number(y); }
    players.set(code, p);
    ack({ ok: true, me: meState(p), buildings: BUILDINGS,
      cfg: { meal: C.MEAL_PRICE, ingredient: C.INGREDIENT_PRICE, testSwitch: C.TEST_SWITCH, tax: TAX, interest: INTEREST } });
  });

  socket.on('move', ({ x, y }) => {
    if (!p) return;
    p.x = Math.max(10, Math.min(790, Number(x) || p.x));
    p.y = Math.max(10, Math.min(510, Number(y) || p.y));
  });

  async function setCareer(career, ack, requireTurn) {
    const c = CAREERS[career];
    if (!c) return ack({ ok: false, msg: 'ไม่มีอาชีพนี้' });
    if (p.grade < c.minGrade) return ack({ ok: false, msg: `ต้องมีเกรด ${c.minGrade.toFixed(2)} ขึ้นไป` });
    if (career !== p.career) {
      const prev = p.career;
      p.career = null; await savePlayer(p); await refreshSeats();   // คืนที่นั่งเดิมก่อนตรวจที่นั่งใหม่
      if ((seatUsed[career] || 0) >= c.seats) {
        p.career = prev; await savePlayer(p); await refreshSeats();
        return ack({ ok: false, msg: 'ที่นั่งเต็มแล้ว' });
      }
    }
    p.career = career; await savePlayer(p); await refreshSeats();
    if (requireTurn) advancePick();
    ack({ ok: true });
  }
  socket.on('pick', (career, ack) => {
    if (!p || game.phase !== 'selecting') return ack({ ok: false, msg: 'ยังไม่ถึงช่วงเลือกอาชีพ' });
    if (game.order[game.pick] !== p.code) return ack({ ok: false, msg: 'ยังไม่ถึงคิวของคุณ' });
    setCareer(career, ack, true);
  });
  socket.on('switch', (career, ack) => {   // ปุ่มทดสอบ: เปลี่ยนอาชีพ
    if (!p || !C.TEST_SWITCH) return ack({ ok: false, msg: 'ปิดการเปลี่ยนอาชีพอยู่' });
    if (game.phase !== 'playing') return ack({ ok: false, msg: 'เปลี่ยนได้เมื่อเกมเริ่มแล้ว' });
    setCareer(career, ack, false);
  });

  socket.on('buyMeal', (_, ack) => {
    if (!p || !near(p, 'shop')) return ack({ ok: false, msg: 'ต้องอยู่ใกล้ร้านชำ' });
    if (p.money < C.MEAL_PRICE) return ack({ ok: false, msg: 'เงินไม่พอ' });
    p.money -= C.MEAL_PRICE; p.hunger = Math.min(100, p.hunger + C.MEAL_FOOD); creditGrocer(C.MEAL_PRICE);
    ack({ ok: true, msg: `ซื้ออาหาร -${C.MEAL_PRICE}` });
  });
  socket.on('buyIngredient', (_, ack) => {
    if (!p || !near(p, 'shop')) return ack({ ok: false, msg: 'ต้องอยู่ใกล้ร้านชำ' });
    if (p.money < C.INGREDIENT_PRICE) return ack({ ok: false, msg: 'เงินไม่พอ' });
    p.money -= C.INGREDIENT_PRICE; p.ingredients++; creditGrocer(C.INGREDIENT_PRICE);
    ack({ ok: true, msg: `ซื้อวัตถุดิบ -${C.INGREDIENT_PRICE}` });
  });

  const canWork = ack => {
    if (game.paused || game.phase !== 'playing') { ack({ ok: false, msg: 'เกมยังไม่เริ่มหรือถูกหยุดอยู่' }); return false; }
    if (p.hunger <= 0) { ack({ ok: false, msg: 'หิวเกินไป ไปกินข้าวก่อน' }); return false; }
    if (Date.now() - p.cd < C.COOLDOWN) { ack({ ok: false, msg: 'ช้าหน่อย รอสักครู่' }); return false; }
    return true;
  };
  socket.on('work', (_, ack) => {
    const c = p && CAREERS[p.career];
    if (!c || !c.site) return ack({ ok: false, msg: 'อาชีพนี้ไม่มีงานที่นี่' });
    if (c.mini) return ack({ ok: false, msg: 'อาชีพนี้ใช้มินิเกมของตัวเอง' });
    if (!near(p, c.site)) return ack({ ok: false, msg: `ต้องอยู่ที่${BUILDINGS[c.site].name}` });
    if (!canWork(ack)) return;
    if (c.needIng) { if (p.ingredients < 1) return ack({ ok: false, msg: 'วัตถุดิบหมด ไปซื้อที่ร้านชำ' }); p.ingredients--; }
    p.cd = Date.now(); p.money += c.pay;
    ack({ ok: true, msg: `ได้เงิน +${c.pay}` });
  });
  socket.on('restock', (_, ack) => {
    if (!p || !near(p, 'shop')) return ack({ ok: false, msg: 'ต้องอยู่ใกล้ร้านชำ' });
    if (p.career === 'grocer') return ack({ ok: false, msg: 'เจ้าของร้านใช้เคาน์เตอร์ชำระเงิน' });
    if (!canWork(ack)) return;
    const pay = p.career === 'grocer' ? C.RESTOCK_PAY.grocer : C.RESTOCK_PAY.other;
    p.cd = Date.now(); p.money += pay;
    ack({ ok: true, msg: `จัดของ +${pay}` });
  });

  // ===== มินิเกม: เซิร์ฟเวอร์ออกใบงาน แล้วตรวจคำตอบก่อนจ่ายเงิน =====
  const gate = ack => {
    if (game.paused || game.phase !== 'playing') { ack({ ok: false, msg: 'เกมยังไม่เริ่มหรือถูกหยุดอยู่' }); return false; }
    if (p.hunger <= 0) { ack({ ok: false, msg: 'หิวเกินไป ไปกินข้าวก่อน' }); return false; }
    if (Date.now() - p.cd < 1500) { ack({ ok: false, msg: 'ช้าหน่อย รอสักครู่' }); return false; }
    return true;
  };
  socket.on('jobStart', (kind, ack) => {
    if (!p) return;
    if (kind === 'cook') {
      if (p.career !== 'food') return ack({ ok: false, msg: 'เฉพาะคนขายอาหาร' });
      if (!near(p, 'restaurant')) return ack({ ok: false, msg: 'ต้องอยู่ที่ร้านอาหาร' });
      if (!gate(ack)) return;
      if (p.ingredients < 1) return ack({ ok: false, msg: 'วัตถุดิบหมด ไปซื้อที่ร้านชำ' });
      const key = Object.keys(RECIPES)[rand(Object.keys(RECIPES).length)], r = RECIPES[key];
      p.job = { kind, key, t0: Date.now() };
      return ack({ ok: true, spec: { name: r.name, need: r.need, palette: PALETTE } });
    }
    if (kind === 'counter') {
      if (p.career !== 'grocer') return ack({ ok: false, msg: 'เฉพาะเจ้าของร้านชำ' });
      if (!near(p, 'shop')) return ack({ ok: false, msg: 'ต้องอยู่ที่ร้านชำ' });
      if (!gate(ack)) return;
      const customers = Array.from({ length: 3 }, () => {
        const items = Array.from({ length: 2 + rand(3) }, () => { const [e, n, pr] = PRODUCTS[rand(PRODUCTS.length)]; return { e, n, p: pr }; });
        const total = items.reduce((a, x) => a + x.p, 0);
        const bills = BILLS.filter(b => b >= total);
        return { items, total, paid: bills[rand(Math.min(2, bills.length))] };
      });
      p.job = { kind, customers, t0: Date.now() };
      return ack({ ok: true, spec: { customers: customers.map(({ items, paid }) => ({ items, paid })) } });
    }
    ack({ ok: false, msg: 'ไม่รู้จักงานนี้' });
  });
  socket.on('jobDone', (ans, ack) => {
    const j = p && p.job;
    if (!j) return ack({ ok: false, msg: 'ไม่มีงานที่ค้างอยู่' });
    p.job = null;
    const dt = Date.now() - j.t0;
    if (j.kind === 'cook') {
      if (dt < 4000 || p.ingredients < 1) return ack({ ok: false, msg: 'ผลงานไม่ถูกต้อง ลองใหม่' });
      const r = RECIPES[j.key], pool = [...r.need];
      let extra = 0;
      for (const id of (Array.isArray(ans?.items) ? ans.items : []).slice(0, 20)) {
        const i = pool.indexOf(id);
        if (i < 0) extra++; else pool.splice(i, 1);
      }
      const wrong = pool.length + extra, q = Math.max(0, 1 - wrong / r.need.length);
      const tip = wrong === 0 ? Math.round(r.pay * 0.2 * Math.max(0, Math.min(1, Number(ans?.heat) || 0))) : 0;
      const pay = Math.round(r.pay * q) + tip;
      p.ingredients--; p.money += pay; p.cd = Date.now();
      return ack({ ok: true, msg: wrong ? `${r.name} ผิดสูตร ${wrong} จุด +${pay}` : `${r.name} ถูกสูตร! +${pay}` + (tip ? ` (ทิป ${tip})` : '') });
    }
    if (j.kind === 'counter') {
      if (dt < 2500 * j.customers.length) return ack({ ok: false, msg: 'ผลงานไม่ถูกต้อง ลองใหม่' });
      const ch = Array.isArray(ans?.changes) ? ans.changes : [];
      const ok = j.customers.filter((c, i) => Number(ch[i]) === c.paid - c.total).length;
      const pay = ok * 12 + (ok === j.customers.length ? 10 : 0);
      p.money += pay; p.cd = Date.now();
      return ack({ ok: true, msg: `ทอนถูก ${ok}/${j.customers.length} คน +${pay}` });
    }
  });

  socket.on('deposit', (amt, ack) => {
    amt = Math.floor(Number(amt));
    if (!p || !near(p, 'bank')) return ack({ ok: false, msg: 'ต้องอยู่ที่ธนาคาร' });
    if (!(amt > 0) || amt > p.money) return ack({ ok: false, msg: 'จำนวนเงินไม่ถูกต้อง' });
    p.money -= amt; p.bank += amt; ack({ ok: true, msg: `ฝากเงิน ${amt}` });
  });
  socket.on('withdraw', (amt, ack) => {
    amt = Math.floor(Number(amt));
    if (!p || !near(p, 'bank')) return ack({ ok: false, msg: 'ต้องอยู่ที่ธนาคาร' });
    if (!(amt > 0) || amt > p.bank) return ack({ ok: false, msg: 'จำนวนเงินไม่ถูกต้อง' });
    p.bank -= amt; p.money += amt; ack({ ok: true, msg: `ถอนเงิน ${amt}` });
  });

  socket.on('teacher', async (cmd, ack) => {
    if (!isTeacher) return ack && ack({ ok: false });
    if (cmd === 'select') {
      const { data } = await db.from('players').select('code,grade').is('career', null).order('grade', { ascending: false });
      game.order = (data || []).map(r => r.code); game.pick = 0; game.phase = game.order.length ? 'selecting' : 'playing';
    } else if (cmd === 'skip') advancePick();
    else if (cmd === 'play') game.phase = 'playing';
    else if (cmd === 'pause') game.paused = !game.paused;
    saveGame(); io.emit('world', worldState());
    ack && ack({ ok: true });
  });

  socket.on('disconnect', () => {
    if (p && players.get(p.code)?.sid === socket.id) { players.delete(p.code); savePlayer(p).catch(() => {}); }
  });
});

function advancePick() {
  game.pick++;
  if (game.pick >= game.order.length) game.phase = 'playing';
  saveGame(); io.emit('world', worldState());
}

async function boot() {
  const { data } = await db.from('game_state').select('*').eq('id', 1).maybeSingle();
  if (data) { game.day = data.day; game.elapsed = data.elapsed; game.phase = data.phase; game.treasury = data.treasury || 0; }
  if (game.phase === 'selecting') {
    const { data: rows } = await db.from('players').select('code').is('career', null).order('grade', { ascending: false });
    game.order = (rows || []).map(r => r.code); game.pick = 0;
  }
  await refreshSeats();
  srv.listen(process.env.PORT || 3000, () => console.log('เซิร์ฟเวอร์พร้อมแล้ว'));
}
boot();
process.on('SIGTERM', async () => { await saveAll().catch(() => {}); process.exit(0); });
