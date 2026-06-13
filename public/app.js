const socket = io();

// DOM Elements - Config
const hostInput = document.getElementById('mc-host');
const portInput = document.getElementById('mc-port');
const versionSelect = document.getElementById('mc-version');
const loginCommandInput = document.getElementById('login-command');
const registerCommandInput = document.getElementById('register-command');
const loginDelayInput = document.getElementById('login-delay');
const checkDelayInput = document.getElementById('check-delay');
const autoJoinSubCheckbox = document.getElementById('auto-join-sub');
const subGuiSlotInput = document.getElementById('sub-gui-slot');
const subGuiSlotContainer = document.getElementById('sub-gui-slot-container');
const configForm = document.getElementById('config-form');

// DOM Elements - Bot List
const addBotForm = document.getElementById('add-bot-form');
const newBotUsername = document.getElementById('new-bot-username');
const newBotPassword = document.getElementById('new-bot-password');
const botsList = document.getElementById('bots-list');

// DOM Elements - Header Summary
const countOnline = document.getElementById('count-online');
const countConnecting = document.getElementById('count-connecting');
const countOffline = document.getElementById('count-offline');

// DOM Elements - Console
const consoleOutput = document.getElementById('console-output');
const consoleFilter = document.getElementById('console-filter');
const chatForm = document.getElementById('chat-form');
const chatSender = document.getElementById('chat-sender');
const chatInput = document.getElementById('chat-input');
const btnSendChat = document.getElementById('btn-send-chat');
const btnClearConsole = document.getElementById('btn-clear-console');

// Log History for client-side filtering
let logHistory = [];
const MAX_LOG_HISTORY = 1000;
let currentBotsData = {}; // Cache of current bots status

// Toggle Sub GUI Slot input display based on checkbox
autoJoinSubCheckbox.addEventListener('change', () => {
  if (autoJoinSubCheckbox.checked) {
    subGuiSlotContainer.style.display = 'block';
  } else {
    subGuiSlotContainer.style.display = 'none';
  }
});

// 1. Nhận cấu hình hiện tại từ Server khi load trang
socket.on('current-config', (config) => {
  hostInput.value = config.server.host || 'localhost';
  portInput.value = config.server.port || 25565;
  versionSelect.value = config.server.version || '1.20.4';
  
  loginCommandInput.value = config.global.loginCommand || '/login {password}';
  registerCommandInput.value = config.global.registerCommand || '/register {password} {password}';
  loginDelayInput.value = config.global.loginDelayMs || 2000;
  checkDelayInput.value = config.global.checkClockDelayMs || 5000;
  
  autoJoinSubCheckbox.checked = config.global.autoJoinSub !== false;
  subGuiSlotInput.value = config.global.subGuiSlot !== undefined ? config.global.subGuiSlot : 10;
  
  // Trigger change event to show/hide sub-gui slot container
  autoJoinSubCheckbox.dispatchEvent(new Event('change'));
});

// 2. Nhận cập nhật danh sách và trạng thái các Bot
socket.on('bots-update', (bots) => {
  currentBotsData = bots;
  renderBotsList(bots);
  updateHeaderSummary(bots);
  updateConsoleFilters(bots);
  updateChatSenders(bots);
});

// Helper: Render danh sách Bot ở cột trái
function renderBotsList(bots) {
  botsList.innerHTML = '';
  const botNames = Object.keys(bots);
  
  if (botNames.length === 0) {
    botsList.innerHTML = '<div class="no-bots-msg">Chưa có bot nào được cấu hình.</div>';
    return;
  }
  
  botNames.forEach(name => {
    const bot = bots[name];
    const botItem = document.createElement('div');
    botItem.className = 'bot-item';
    
    // Status Dot Class
    let statusClass = 'offline';
    if (bot.state === 'online') statusClass = 'online';
    else if (bot.state === 'connecting') statusClass = 'connecting';
    
    // Coordinates or status label
    let statusText = bot.state.toUpperCase();
    if (bot.state === 'online' && bot.coords) {
      statusText = `X: ${Math.round(bot.coords.x)}, Y: ${Math.round(bot.coords.y)}, Z: ${Math.round(bot.coords.z)}`;
    }
    
    botItem.innerHTML = `
      <div class="bot-info">
        <span class="status-dot ${statusClass}" title="${bot.state.toUpperCase()}"></span>
        <div class="bot-details">
          <div class="bot-name" title="${name}">${name}</div>
          <div style="font-size: 11px; color: var(--text-muted); font-family: monospace;">${statusText}</div>
        </div>
      </div>
      <div class="bot-actions-mini">
        <button class="btn-mini btn-mini-start" data-bot="${name}" ${bot.state !== 'offline' ? 'disabled' : ''} title="Bật Bot">
          <i class="fa-solid fa-play"></i>
        </button>
        <button class="btn-mini btn-mini-stop" data-bot="${name}" ${bot.state === 'offline' ? 'disabled' : ''} title="Tắt Bot">
          <i class="fa-solid fa-stop"></i>
        </button>
        <button class="btn-mini btn-mini-delete" data-bot="${name}" ${bot.state !== 'offline' ? 'disabled' : ''} title="Xóa Bot">
          <i class="fa-solid fa-trash"></i>
        </button>
      </div>
    `;
    botsList.appendChild(botItem);
  });
  
  // Gắn sự kiện click cho các nút mini
  document.querySelectorAll('.btn-mini-start').forEach(btn => {
    btn.addEventListener('click', () => socket.emit('start-bot-instance', btn.dataset.bot));
  });
  
  document.querySelectorAll('.btn-mini-stop').forEach(btn => {
    btn.addEventListener('click', () => socket.emit('stop-bot-instance', btn.dataset.bot));
  });
  
  document.querySelectorAll('.btn-mini-delete').forEach(btn => {
    btn.addEventListener('click', () => {
      if (confirm(`Bạn có chắc muốn xóa bot '${btn.dataset.bot}' không?`)) {
        socket.emit('delete-bot', btn.dataset.bot);
      }
    });
  });
}

// Helper: Cập nhật chỉ số tóm tắt trên Header
function updateHeaderSummary(bots) {
  let online = 0, connecting = 0, offline = 0;
  
  Object.values(bots).forEach(bot => {
    if (bot.state === 'online') online++;
    else if (bot.state === 'connecting') connecting++;
    else offline++;
  });
  
  countOnline.textContent = online;
  countConnecting.textContent = connecting;
  countOffline.textContent = offline;
}

// Helper: Cập nhật danh sách lọc Console ở Card Console
function updateConsoleFilters(bots) {
  const currentVal = consoleFilter.value;
  consoleFilter.innerHTML = '<option value="all">Tất cả bot</option>';
  
  Object.keys(bots).forEach(name => {
    const opt = document.createElement('option');
    opt.value = name;
    opt.textContent = name;
    consoleFilter.appendChild(opt);
  });
  
  // Khôi phục lại bộ lọc cũ nếu bot đó vẫn còn tồn tại
  if (bots[currentVal]) {
    consoleFilter.value = currentVal;
  } else {
    consoleFilter.value = 'all';
  }
}

// Helper: Cập nhật danh sách gửi chat (chỉ hiện bot online)
function updateChatSenders(bots) {
  const currentVal = chatSender.value;
  chatSender.innerHTML = '';
  
  const onlineBots = Object.keys(bots).filter(name => bots[name].state === 'online');
  
  if (onlineBots.length === 0) {
    const opt = document.createElement('option');
    opt.value = '';
    opt.textContent = 'Không có bot online';
    chatSender.appendChild(opt);
    chatSender.disabled = true;
    chatInput.disabled = true;
    btnSendChat.disabled = true;
    return;
  }
  
  onlineBots.forEach(name => {
    const opt = document.createElement('option');
    opt.value = name;
    opt.textContent = name;
    chatSender.appendChild(opt);
  });
  
  chatSender.disabled = false;
  chatInput.disabled = false;
  btnSendChat.disabled = false;
  
  if (onlineBots.includes(currentVal)) {
    chatSender.value = currentVal;
  }
}

// 3. Nhận tin nhắn/logs từ server
socket.on('log', (data) => {
  // data: { text, type, botname }
  logHistory.push(data);
  if (logHistory.length > MAX_LOG_HISTORY) {
    logHistory.shift();
  }
  
  const filter = consoleFilter.value;
  if (filter === 'all' || filter === data.botname) {
    appendLog(data.text, data.type, data.botname);
  }
});

// Helper: Thêm log vào khung HTML
function appendLog(text, type = 'system', botname = '') {
  const line = document.createElement('div');
  line.classList.add('log-line');
  
  if (type === 'system') line.classList.add('system-line');
  else if (type === 'chat') line.classList.add('chat-line');
  else if (type === 'server') line.classList.add('server-line');
  else if (type === 'warning') line.classList.add('warning-line');
  else if (type === 'error') line.classList.add('error-line');
  
  const time = new Date().toLocaleTimeString();
  const prefix = botname ? `[${botname}] ` : '';
  line.textContent = `[${time}] ${prefix}${text}`;
  
  consoleOutput.appendChild(line);
  consoleOutput.parentElement.scrollTop = consoleOutput.parentElement.scrollHeight;
}

// Thay đổi bộ lọc Console
consoleFilter.addEventListener('change', () => {
  consoleOutput.innerHTML = '';
  const filter = consoleFilter.value;
  
  const filteredLogs = logHistory.filter(log => filter === 'all' || log.botname === filter);
  filteredLogs.forEach(log => {
    appendLog(log.text, log.type, log.botname);
  });
});

// 4. Submit Lưu cấu hình chung
configForm.addEventListener('submit', (e) => {
  e.preventDefault();
  
  const config = {
    server: {
      host: hostInput.value,
      port: parseInt(portInput.value, 10),
      version: versionSelect.value
    },
    global: {
      loginCommand: loginCommandInput.value,
      registerCommand: registerCommandInput.value,
      loginDelayMs: parseInt(loginDelayInput.value, 10),
      checkClockDelayMs: parseInt(checkDelayInput.value, 10),
      autoJoinSub: autoJoinSubCheckbox.checked,
      subGuiSlot: parseInt(subGuiSlotInput.value, 10)
    }
  };
  
  socket.emit('save-global-config', config, (response) => {
    if (response.success) {
      appendLog('[Hệ thống] Đã lưu cấu hình chung thành công!', 'system');
    } else {
      appendLog(`[Lỗi] Không thể lưu cấu hình: ${response.message}`, 'error');
    }
  });
});

// 5. Submit Thêm Bot mới
addBotForm.addEventListener('submit', (e) => {
  e.preventDefault();
  
  const username = newBotUsername.value.trim();
  const password = newBotPassword.value;
  
  if (!username || !password) return;
  
  socket.emit('add-bot', { username, password }, (response) => {
    if (response.success) {
      appendLog(`[Hệ thống] Đã thêm bot '${username}' thành công!`, 'system');
      newBotUsername.value = '';
      newBotPassword.value = '';
    } else {
      appendLog(`[Lỗi] Không thể thêm bot: ${response.message}`, 'error');
    }
  });
});

// 6. Gửi tin nhắn chat từ web
chatForm.addEventListener('submit', (e) => {
  e.preventDefault();
  
  const botname = chatSender.value;
  const message = chatInput.value.trim();
  
  if (!botname || !message) return;
  
  socket.emit('send-bot-chat', { botname, message });
  chatInput.value = '';
});

// Xóa console
btnClearConsole.addEventListener('click', () => {
  consoleOutput.innerHTML = '';
  logHistory = [];
  appendLog('[Hệ thống] Đã dọn dẹp màn hình console.', 'system');
});

// ==========================================
// 7. Giao diện Click GUI trực quan (Chest Menu)
// ==========================================
const guiCard = document.getElementById('gui-card');
const guiTitle = document.getElementById('gui-title');
const guiBotBadge = document.getElementById('gui-bot-badge');
const guiGrid = document.getElementById('gui-grid');
const manualGuiSlot = document.getElementById('manual-gui-slot');
const btnManualGuiClick = document.getElementById('btn-manual-gui-click');
const btnCloseGuiManually = document.getElementById('btn-close-gui-manually');

let currentActiveGuiBot = '';
let currentActiveGuiId = null;

// Nhận sự kiện mở GUI từ Server
socket.on('gui-open', (data) => {
  // data: { botname, title, id, slotsCount, items }
  currentActiveGuiBot = data.botname;
  currentActiveGuiId = data.id;
  
  guiTitle.textContent = data.title;
  guiBotBadge.textContent = data.botname;
  guiCard.style.display = 'block';
  
  renderGuiGrid(data.slotsCount, data.items);
});

// Nhận sự kiện cập nhật GUI (thay đổi slot vật phẩm)
socket.on('gui-update', (data) => {
  // data: { botname, id, slotIndex, item }
  if (currentActiveGuiBot !== data.botname || currentActiveGuiId !== data.id) return;
  
  const slotEl = guiGrid.querySelector(`.gui-slot[data-slot="${data.slotIndex}"]`);
  if (!slotEl) return;
  
  // Reset slot
  slotEl.className = 'gui-slot';
  slotEl.innerHTML = `<span class="slot-index">${data.slotIndex}</span>`;
  
  if (data.item) {
    slotEl.classList.add('gui-slot-filled');
    
    const nameEl = document.createElement('span');
    nameEl.className = 'slot-item-name';
    nameEl.textContent = data.item.name;
    slotEl.appendChild(nameEl);
    
    if (data.item.count > 1) {
      const countEl = document.createElement('span');
      countEl.className = 'slot-item-count';
      countEl.textContent = data.item.count;
      slotEl.appendChild(countEl);
    }
  }
});

// Nhận sự kiện đóng GUI từ Server
socket.on('gui-close', (data) => {
  // data: { botname, id }
  if (currentActiveGuiBot === data.botname) {
    guiCard.style.display = 'none';
    currentActiveGuiBot = '';
    currentActiveGuiId = null;
    guiGrid.innerHTML = '';
  }
});

// Hàm dựng lưới GUI ô rương
function renderGuiGrid(slotsCount, items) {
  guiGrid.innerHTML = '';
  
  for (let i = 0; i < slotsCount; i++) {
    const slotEl = document.createElement('div');
    slotEl.className = 'gui-slot';
    slotEl.setAttribute('data-slot', i);
    slotEl.innerHTML = `<span class="slot-index">${i}</span>`;
    
    // Tìm vật phẩm tương ứng ở slot này
    const item = items.find(it => it.slot === i);
    if (item) {
      slotEl.classList.add('gui-slot-filled');
      
      const nameEl = document.createElement('span');
      nameEl.className = 'slot-item-name';
      nameEl.textContent = item.name;
      slotEl.appendChild(nameEl);
      
      if (item.count > 1) {
        const countEl = document.createElement('span');
        countEl.className = 'slot-item-count';
        countEl.textContent = item.count;
        slotEl.appendChild(countEl);
      }
    }
    
    // Đăng ký sự kiện click chuột vào slot
    slotEl.addEventListener('click', () => {
      if (!currentActiveGuiBot) return;
      socket.emit('gui-click', { botname: currentActiveGuiBot, slotIndex: i });
      appendLog(`[Hệ thống] Đã click vào slot ${i} trong rương`, 'system', currentActiveGuiBot);
    });
    
    guiGrid.appendChild(slotEl);
  }
}

// Xử lý Click slot thủ công bằng nút bấm
btnManualGuiClick.addEventListener('click', () => {
  const slotIndex = parseInt(manualGuiSlot.value, 10);
  if (isNaN(slotIndex) || slotIndex < 0 || !currentActiveGuiBot) return;
  
  socket.emit('gui-click', { botname: currentActiveGuiBot, slotIndex });
  appendLog(`[Hệ thống] Đã click thủ công vào slot ${slotIndex}`, 'system', currentActiveGuiBot);
  manualGuiSlot.value = '';
});

// Cho phép bấm Enter trong ô nhập click thủ công
manualGuiSlot.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    btnManualGuiClick.click();
  }
});

// Đóng rương thủ công từ Dashboard
btnCloseGuiManually.addEventListener('click', () => {
  if (!currentActiveGuiBot) return;
  socket.emit('gui-close-request', { botname: currentActiveGuiBot });
  appendLog(`[Hệ thống] Đang gửi yêu cầu đóng GUI...`, 'system', currentActiveGuiBot);
});
