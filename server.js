const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const PORT = process.env.PORT || 3000;
const MAX_PLAYERS = 8; 
const ADMIN_PASSWORD = "admin888"; // 👉 你可以在这里修改管理员密码

const rooms = new Map(); 
let globalNotice = "欢迎来到同词相遇！如果有问题请在群里反馈。";

const rid = (n = 10) => Math.random().toString(36).slice(2, 2 + n);
const norm = s => String(s).trim().toLowerCase().replace(/\s+/g, '');

// 安全 1：IP 限流，防止脚本爆破
const ipRequests = new Map();
function isRateLimited(ip) {
  const now = Date.now();
  const windowStart = now - 5000; // 5秒内
  if (!ipRequests.has(ip)) ipRequests.set(ip, []);
  const times = ipRequests.get(ip).filter(t => t > windowStart);
  times.push(now);
  ipRequests.set(ip, times);
  return times.length > 15; // 5秒内超过15次请求直接拦截
}

// 安全 2：6位字母+数字房间号（防爆破）
function genRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 6; i++) code += chars.charAt(Math.floor(Math.random() * chars.length));
  return code;
}

function getOnlineStats() {
  let totalPlayers = 0;
  for (const room of rooms.values()) totalPlayers += room.players.length;
  return { roomCount: rooms.size, playerCount: totalPlayers };
}

function createRoom(name) {
  let code;
  do { code = genRoomCode(); } while (rooms.has(code));
  const pid = rid();
  const room = {
    code, players: [{ pid, name, word: null }], round: 1, revealed: false,
    matches: [], nextReady: new Set(), history: [], touched: Date.now(),
  };
  rooms.set(code, room);
  return { room, pid };
}

function joinRoom(code, name, oldPid) {
  const room = rooms.get(String(code || '').toUpperCase());
  if (!room) return { error: '房间不存在，请检查房间号' };
  if (oldPid) {
    const existing = room.players.find(x => x.pid === oldPid);
    if (existing) return { room, pid: oldPid };
  }
  if (room.players.length >= MAX_PLAYERS) return { error: '房间人满了' };
  const pid = rid();
  room.players.push({ pid, name, word: null });
  room.touched = Date.now();
  return { room, pid };
}

function submitWord(room, pid, word) {
  const p = room.players.find(x => x.pid === pid);
  if (!p) return { error: '玩家不存在' };
  if (room.revealed) return { error: '本轮已结束' };
  if (p.word) return { error: '你已经提交过了' };
  word = String(word || '').trim().slice(0, 20);
  if (!word) return { error: '请输入一个词' };
  p.word = word;
  
  if (room.players.every(x => x.word)) {
    room.revealed = true;
    const wordMap = {};
    room.players.forEach(pl => {
      const w = norm(pl.word);
      if (!wordMap[w]) wordMap[w] = [];
      wordMap[w].push(pl.word);
    });
    room.matches = [];
    for (const w in wordMap) {
      if (wordMap[w].length > 1) room.matches.push({ word: wordMap[w][0], count: wordMap[w].length });
    }
    room.history.push({
      round: room.round,
      matches: JSON.parse(JSON.stringify(room.matches)),
      players: room.players.map(pl => ({ name: pl.name, word: pl.word }))
    });
  }
  room.touched = Date.now();
  return {};
}

function nextRound(room, pid) {
  room.nextReady.add(pid);
  room.touched = Date.now();
  if (room.players.every(p => room.nextReady.has(p.pid))) {
    room.round++;
    room.players.forEach(p => (p.word = null));
    room.revealed = false; room.matches = []; room.nextReady.clear();
  }
  return {};
}

function stateOf(room, pid) {
  room.touched = Date.now();
  const stats = getOnlineStats();
  return {
    code: room.code, round: room.round, revealed: room.revealed, matches: room.matches, history: room.history,
    notice: globalNotice, onlineStats: stats,
    players: room.players.map(p => ({
      isSelf: p.pid === pid, name: p.name, submitted: !!p.word, word: room.revealed ? p.word : null, nextReady: room.nextReady.has(p.pid)
    })),
  };
}

const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://localhost');
  const p = u.pathname;
  
  const ip = req.socket.remoteAddress || req.headers['x-forwarded-for'];
  if (p.startsWith('/api/') && isRateLimited(ip)) {
    res.writeHead(429); return res.end(JSON.stringify({ error: '操作太频繁，请稍等5秒再试' }));
  }

  // 后台管理页面
  if (p === '/admin') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(`
      <!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>管理员后台</title>
      <style>body{font-family:sans-serif;padding:20px;max-width:500px;margin:0 auto;} input,button{width:100%;padding:10px;margin:10px 0;font-size:16px;box-sizing:border-box;} button{background:#5b7cfa;color:#fff;border:0;border-radius:8px;cursor:pointer;}</style></head>
      <body>
        <h2>发布全服公告</h2>
        <p style="color:#666;font-size:14px;">当前状态：<span id="stats">加载中...</span></p>
        <input type="password" id="pwd" placeholder="请输入管理员密码">
        <input type="text" id="text" placeholder="输入公告内容 (留空则清除公告)" value="${globalNotice}">
        <button onclick="save()">发布公告</button>
        <script>
          setInterval(()=>{
            fetch('/api/public_stats').then(r=>r.json()).then(d=>{
              document.getElementById('stats').innerText = '房间数 ' + d.roomCount + ' | 在线玩家 ' + d.playerCount;
            });
          }, 3000);
          async function save(){
            const p = document.getElementById('pwd').value;
            const t = document.getElementById('text').value;
            const res = await fetch('/api/set_notice?pwd=' + p + '&text=' + encodeURIComponent(t));
            const d = await res.json();
            if(d.error) return alert(d.error);
            alert('公告已更新！所有在线玩家将在5秒内看到。');
          }
        </script>
      </body></html>
    `);
  }

  // 允许读取 bgm.mp3（如果你放了音乐文件）
  if (p === '/bgm.mp3') {
    fs.readFile(path.join(__dirname, 'bgm.mp3'), (err, buf) => {
      if (err) { res.writeHead(404); return res.end('not found'); }
      res.writeHead(200, { 'Content-Type': 'audio/mpeg' }); res.end(buf);
    });
    return;
  }

  if (p === '/' || p === '/index.html') {
    fs.readFile(path.join(__dirname, 'index.html'), (err, buf) => {
      if (err) { res.writeHead(500); return res.end('index.html not found'); }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(buf);
    });
    return;
  }

  if (p.startsWith('/api/')) {
    const q = Object.fromEntries(u.searchParams);
    const action = p.slice(5);
    let out = { error: '未知操作' };

    if (action === 'public_stats') {
      out = getOnlineStats();
    } else if (action === 'set_notice') {
      if (q.pwd !== ADMIN_PASSWORD) out = { error: '密码错误' };
      else { globalNotice = String(q.text || '').trim(); out = { success: true }; }
    } else if (action === 'create') {
      const name = String(q.name || '玩家').slice(0, 10);
      const { room, pid } = createRoom(name);
      out = { code: room.code, pid };
    } else if (action === 'join') {
      const r = joinRoom(q.code, String(q.name || '玩家').slice(0, 10), q.oldPid);
      out = r.error ? r : { code: r.room.code, pid: r.pid };
    } else if (action === 'state') {
      const room = rooms.get(String(q.code || '').toUpperCase());
      out = room ? stateOf(room, q.pid) : { error: '房间不存在或已关闭' };
    } else if (action === 'submit') {
      const room = rooms.get(String(q.code || '').toUpperCase());
      if (!room) out = { error: '房间不存在' };
      else { const r = submitWord(room, q.pid, q.word); out = r.error ? r : stateOf(room, q.pid); }
    } else if (action === 'next') {
      const room = rooms.get(String(q.code || '').toUpperCase());
      if (!room) out = { error: '房间不存在' };
      else { nextRound(room, q.pid); out = stateOf(room, q.pid); }
    }

    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    return res.end(JSON.stringify(out));
  }
  res.writeHead(404); res.end('not found');
});

// 后台定时监控
setInterval(() => {
  const now = Date.now();
  for (const [code, room] of rooms) {
    if (now - room.touched > 60 * 60 * 1000) rooms.delete(code); // 1小时清理
  }
}, 60 * 1000).unref();

setInterval(() => {
  const stats = getOnlineStats();
  console.log(`\x1b[36m[监控] 房间数: ${stats.roomCount} | 在线玩家: ${stats.playerCount}\x1b[0m`);
}, 10000);

server.listen(PORT, '0.0.0.0', () => {
  console.log(`\n  同词相遇 已启动 (优化版)`);
  console.log(`  本机访问:  http://localhost:${PORT}\n`);
});