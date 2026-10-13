const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { createClient } = require('@supabase/supabase-js');

const app = express();
const srv = http.createServer(app);
const io = new Server(srv);
app.use(express.static('public'));

const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const TEACHER_PASSWORD = process.env.TEACHER_PASSWORD || '';

// ===== ค่าที่ปรับสมดุลเกมได้ =====
const C = {
  DAY_SEC: 420,          // 1 วันในเกม = 7 นาที
  RENT: 40,              // ค่าเช่า/วัน
  HUNGER_DROP: 0.24,     // หิวลดต่อวินาที (~2.5 มื้อ/วัน)
  MEAL_PRICE: 15, MEAL_FOOD: 40,
  INGREDIENT_PRICE: 10,
  DISH_PRICE: 30,        // คนขายอาหารขายได้ต่อจาน
  RESTOCK_PAY: { grocer: 20, other: 10 },
  COOLDOWN: 3500,        // มินิเกมทำซ้ำได้ทุกกี่ ms
  REACH: 90,             // ระยะที่ถือว่าอยู่ใกล้อาคาร (px)
};
const CAREERS = {
  gov:    { name: 'ข้าราชการ',     seats: 3, minGrade: 3.0, salary: 150 },
  food:   { name: 'คนขายอาหาร',    seats: 5, minGrade: 0 },
  grocer: { name: 'เจ้าของร้านชำ', seats: 4, minGrade: 0 },
};
const BUILDINGS = { shop: { x: 150, y: 130 }, restaurant: { x: 650, y: 130 } };

const game = { day: 1, elapsed: 0, phase: 'lobby', paused: false, order: [], pick: 0 };
const players = new Map();   // code -> player (เฉพาะคนออนไลน์)
let teacherSocket = null;

const near = (p, b) => Math.hypot(p.x - BUILDINGS[b].x, p.y - BUILDINGS[b].y) < C.REACH;
const seatsLeft = () => {
  const left = {};
  for (const k in CAREERS) left[k] = CAREERS[k].seats;
  for (const p of players.values()) if (p.career) left[p.career]--;
  return left;
};

async function countSeatsDb() {
  const { data } = await db.from('players').select('career').not('career', 'is', null);
  const used = {};
  (data || []).forEach(r => (used[r.career] = (used[r.career] || 0) + 1));
  return used;
}

async function savePlayer(p) {
  await db.from('players').update({
    nick: p.nick, career: p.career, money: p.money,
    hunger: Math.round(p.hunger * 10) / 10, ingredients: p.ingredients,
  }).eq('code', p.code);
}
const saveGame = () =>
  db.from('game_state').update({ day: game.day, elapsed: game.elapsed, phase: game.phase }).eq('id', 1);
const saveAll = () => Promise.all([...players.values()].map(savePlayer).concat(saveGame()));

function worldState() {
  const pickerCode = game.order[game.pick];
  return {
    phase: game.phase, day: game.day, elapsed: game.elapsed, dayLen: C.DAY_SEC, paused: game.paused,
    pickerCode: game.phase === 'selecting' ? pickerCode || null : null,
    pickerNick: game.phase === 'selecting' ? (players.get(pickerCode)?.nick || '(ยังไม่ออนไลน์)') : null,
    seats: seatsLeft(),
    careers: Object.fromEntries(Object.entries(CAREERS).map(([k, v]) => [k, { name: v.name, minGrade: v.minGrade }])),
  };
}
const meState = p => ({
  code: p.code, nick: p.nick, career: p.career, money: p.money,
  hunger: Math.round(p.hunger), ingredients: p.ingredients, grade: Number(p.grade),
});
const toast = (p, msg) => p.sid && io.to(p.sid).emit('toast', msg);

function dayTick() {
  game.day++; game.elapsed = 0;
  for (const p of players.values()) {
    const salary = p.career && CAREERS[p.career].salary || 0;
    let note = `เริ่มวันที่ ${game.day}: `;
    if (salary) { p.money += salary; note += `เงินเดือน +${salary} `; }
    if (p.money >= C.RENT) { p.money -= C.RENT; note += `ค่าเช่า -${C.RENT}`; }
    else { note += 'เงินไม่พอจ่ายค่าเช่า!'; }
    toast(p, note);
  }
  saveAll();
}

setInterval(() => {
  if (!players.size || game.paused || game.phase === 'lobby') {
    io.emit('world', worldState());
    return;
  }
  game.elapsed++;
  for (const p of players.values()) p.hunger = Math.max(0, p.hunger - C.HUNGER_DROP);
  if (game.elapsed >= C.DAY_SEC) dayTick();
  io.emit('world', worldState());
  for (const p of players.values()) p.sid && io.to(p.sid).emit('me', meState(p));
}, 1000);

setInterval(() => {
  io.emit('players', [...players.values()].map(p => ({ code: p.code, nick: p.nick, x: p.x, y: p.y, career: p.career })));
}, 100);

setInterval(() => saveAll().catch(() => {}), 20000);

// หลังขายของ ให้เงินไปที่เจ้าของร้านชำที่ออนไลน์ (ถ้ามี)
function creditGrocer(amount) {
  const g = [...players.values()].filter(p => p.career === 'grocer');
  if (!g.length) return;
  const p = g[Math.floor(Math.random() * g.length)];
  p.money += amount;
  toast(p, `ลูกค้าซื้อของที่ร้าน +${amount}`);
}

io.on('connection', socket => {
  let p = null;
  let isTeacher = false;

  socket.on('login', async ({ code, nick, password }, ack) => {
    code = String(code || '').trim().toUpperCase();
    if (code === 'TEACHER') {
      if (!TEACHER_PASSWORD || password !== TEACHER_PASSWORD) return ack({ ok: false, msg: 'รหัสครูไม่ถูกต้อง' });
      isTeacher = true; teacherSocket = socket;
      return ack({ ok: true, teacher: true });
    }
    const { data, error } = await db.from('players').select('*').eq('code', code).maybeSingle();
    if (error || !data) return ack({ ok: false, msg: 'ไม่พบรหัสนักเรียนนี้' });
    const old = players.get(code);
    if (old) { io.to(old.sid).emit('kicked'); players.delete(code); }
    p = { ...data, grade: Number(data.grade), hunger: Number(data.hunger), x: 400, y: 300, cd: 0, sid: socket.id };
    p.nick = String(nick || data.nick || code).slice(0, 12);
    players.set(code, p);
    ack({ ok: true, me: meState(p), buildings: BUILDINGS, cfg: { meal: C.MEAL_PRICE, ingredient: C.INGREDIENT_PRICE, dish: C.DISH_PRICE } });
  });

  socket.on('move', ({ x, y }) => {
    if (!p) return;
    p.x = Math.max(10, Math.min(790, Number(x) || p.x));
    p.y = Math.max(10, Math.min(510, Number(y) || p.y));
  });

  socket.on('pick', async (career, ack) => {
    if (!p || game.phase !== 'selecting') return ack({ ok: false, msg: 'ยังไม่ถึงช่วงเลือกอาชีพ' });
    if (game.order[game.pick] !== p.code) return ack({ ok: false, msg: 'ยังไม่ถึงคิวของคุณ' });
    const c = CAREERS[career];
    if (!c) return ack({ ok: false, msg: 'ไม่มีอาชีพนี้' });
    if (p.grade < c.minGrade) return ack({ ok: false, msg: `ต้องมีเกรด ${c.minGrade.toFixed(2)} ขึ้นไป` });
    const used = await countSeatsDb();
    if ((used[career] || 0) >= c.seats) return ack({ ok: false, msg: 'ที่นั่งเต็มแล้ว' });
    p.career = career;
    await savePlayer(p);
    advancePick();
    ack({ ok: true });
  });

  socket.on('buyMeal', (_, ack) => {
    if (!p || !near(p, 'shop')) return ack({ ok: false, msg: 'ต้องอยู่ใกล้ร้านชำ' });
    if (p.money < C.MEAL_PRICE) return ack({ ok: false, msg: 'เงินไม่พอ' });
    p.money -= C.MEAL_PRICE; p.hunger = Math.min(100, p.hunger + C.MEAL_FOOD);
    creditGrocer(C.MEAL_PRICE);
    ack({ ok: true, msg: `ซื้ออาหาร -${C.MEAL_PRICE}` });
  });

  socket.on('buyIngredient', (_, ack) => {
    if (!p || !near(p, 'shop')) return ack({ ok: false, msg: 'ต้องอยู่ใกล้ร้านชำ' });
    if (p.money < C.INGREDIENT_PRICE) return ack({ ok: false, msg: 'เงินไม่พอ' });
    p.money -= C.INGREDIENT_PRICE; p.ingredients++;
    creditGrocer(C.INGREDIENT_PRICE);
    ack({ ok: true, msg: `ซื้อวัตถุดิบ -${C.INGREDIENT_PRICE}` });
  });

  const canWork = ack => {
    if (game.paused || game.phase !== 'playing') { ack({ ok: false, msg: 'เกมยังไม่เริ่มหรือถูกหยุดอยู่' }); return false; }
    if (p.hunger <= 0) { ack({ ok: false, msg: 'หิวเกินไป ไปกินข้าวก่อน' }); return false; }
    if (Date.now() - p.cd < C.COOLDOWN) { ack({ ok: false, msg: 'ช้าหน่อย รอสักครู่' }); return false; }
    return true;
  };

  socket.on('cook', (_, ack) => {
    if (!p || p.career !== 'food') return ack({ ok: false, msg: 'เฉพาะคนขายอาหาร' });
    if (!near(p, 'restaurant')) return ack({ ok: false, msg: 'ต้องอยู่ที่ร้านอาหาร' });
    if (!canWork(ack)) return;
    if (p.ingredients < 1) return ack({ ok: false, msg: 'วัตถุดิบหมด ไปซื้อที่ร้านชำ' });
    p.cd = Date.now(); p.ingredients--; p.money += C.DISH_PRICE;
    ack({ ok: true, msg: `ขายอาหาร +${C.DISH_PRICE}` });
  });

  socket.on('restock', (_, ack) => {
    if (!p || !near(p, 'shop')) return ack({ ok: false, msg: 'ต้องอยู่ใกล้ร้านชำ' });
    if (!canWork(ack)) return;
    const pay = p.career === 'grocer' ? C.RESTOCK_PAY.grocer : C.RESTOCK_PAY.other;
    p.cd = Date.now(); p.money += pay;
    ack({ ok: true, msg: `จัดของ +${pay}` });
  });

  // ===== ครู =====
  socket.on('teacher', async (cmd, ack) => {
    if (!isTeacher) return ack && ack({ ok: false });
    if (cmd === 'select') {
      const { data } = await db.from('players').select('code,grade').is('career', null).order('grade', { ascending: false });
      game.order = (data || []).map(r => r.code); game.pick = 0; game.phase = 'selecting';
      if (!game.order.length) game.phase = 'playing';
    } else if (cmd === 'skip') advancePick();
    else if (cmd === 'play') game.phase = 'playing';
    else if (cmd === 'pause') game.paused = !game.paused;
    saveGame();
    io.emit('world', worldState());
    ack && ack({ ok: true });
  });

  socket.on('disconnect', () => {
    if (isTeacher && teacherSocket === socket) teacherSocket = null;
    if (p && players.get(p.code)?.sid === socket.id) { players.delete(p.code); savePlayer(p).catch(() => {}); }
  });
});

function advancePick() {
  game.pick++;
  if (game.pick >= game.order.length) game.phase = 'playing';
  saveGame();
  io.emit('world', worldState());
}

async function boot() {
  const { data } = await db.from('game_state').select('*').eq('id', 1).maybeSingle();
  if (data) { game.day = data.day; game.elapsed = data.elapsed; game.phase = data.phase; }
  if (game.phase === 'selecting') {   // กู้คิวเลือกอาชีพหลังเซิร์ฟเวอร์รีสตาร์ต
    const { data: rows } = await db.from('players').select('code').is('career', null).order('grade', { ascending: false });
    game.order = (rows || []).map(r => r.code); game.pick = 0;
  }
  srv.listen(process.env.PORT || 3000, () => console.log('เซิร์ฟเวอร์พร้อมแล้ว'));
}
boot();

process.on('SIGTERM', async () => { await saveAll().catch(() => {}); process.exit(0); });
