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
const subGuiConfigGroup = document.getElementById('sub-gui-config-group');
const subGuiStepCountSelect = document.getElementById('sub-gui-step-count');
const slot1Container = document.getElementById('slot-1-container');
const slot2Container = document.getElementById('slot-2-container');
const subGuiSlot1Input = document.getElementById('sub-gui-slot-1');
const subGuiSlot2Input = document.getElementById('sub-gui-slot-2');

// Chat Macro DOM Elements
const macroEnabledCheckbox = document.getElementById('macro-enabled');
const macroConfigGroup = document.getElementById('macro-config-group');
const macroKeywordInput = document.getElementById('macro-keyword');
const macroCommandInput = document.getElementById('macro-command');
const macroMoveEnabledCheckbox = document.getElementById('macro-move-enabled');
const macroMoveConfigGroup = document.getElementById('macro-move-config-group');
const macroMoveDelayInput = document.getElementById('macro-move-delay');
const macroMoveDirectionSelect = document.getElementById('macro-move-direction');
const macroMoveDurationInput = document.getElementById('macro-move-duration');

const configForm = document.getElementById('config-form');
const configTitle = document.getElementById('config-title');
const configDisabledMsg = document.getElementById('config-disabled-msg');

// DOM Elements - Tabs & Add Forms
const tabAddSingle = document.getElementById('tab-add-single');
const tabAddBulk = document.getElementById('tab-add-bulk');
const addBotForm = document.getElementById('add-bot-form');
const addBulkBotForm = document.getElementById('add-bulk-bot-form');

const newBotUsername = document.getElementById('new-bot-username');
const newBotPassword = document.getElementById('new-bot-password');

const bulkPrefix = document.getElementById('bulk-prefix');
const bulkCount = document.getElementById('bulk-count');
const bulkPassword = document.getElementById('bulk-password');

// DOM Elements - Bot List
const checkboxSelectAll = document.getElementById('checkbox-select-all');
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

// Client State
let logHistory = [];
const MAX_LOG_HISTORY = 1000;
let currentBotsData = {}; // Cache map: { username: { state, coords, health, food, config } }
const selectedBots = new Set(); // Set of usernames currently checked

// Tab Toggle Logic
tabAddSingle.addEventListener('click', () => {
  tabAddSingle.classList.add('active');
  tabAddBulk.classList.remove('active');
  addBotForm.style.display = 'flex';
  addBulkBotForm.style.display = 'none';
});

tabAddBulk.addEventListener('click', () => {
  tabAddBulk.classList.add('active');
  tabAddSingle.classList.remove('active');
  addBotForm.style.display = 'none';
  addBulkBotForm.style.display = 'flex';
});

// Show/Hide GUI Sub Config panel
autoJoinSubCheckbox.addEventListener('change', () => {
  if (autoJoinSubCheckbox.checked) {
    subGuiConfigGroup.style.display = 'block';
  } else {
    subGuiConfigGroup.style.display = 'none';
  }
});

// Toggle GUI Step Slot inputs
subGuiStepCountSelect.addEventListener('change', () => {
  const steps = parseInt(subGuiStepCountSelect.value, 10);
  if (steps === 2) {
    slot2Container.style.display = 'block';
  } else {
    slot2Container.style.display = 'none';
  }
});

// Toggle Chat Macro config panels
macroEnabledCheckbox.addEventListener('change', () => {
  macroConfigGroup.style.display = macroEnabledCheckbox.checked ? 'block' : 'none';
});

macroMoveEnabledCheckbox.addEventListener('change', () => {
  macroMoveConfigGroup.style.display = macroMoveEnabledCheckbox.checked ? 'block' : 'none';
});

// 1. Nhận cấu hình mặc định ban đầu (Optional, server gửi để giữ tính tương thích)
socket.on('current-config', (config) => {
  // Chỉ điền nếu chưa chọn bot nào để làm gợi ý mặc định
  if (selectedBots.size === 0) {
    const defaults = config.defaults || config.global || {};
    hostInput.value = config.server?.host || defaults.host || 'localhost';
    portInput.value = config.server?.port || defaults.port || 25565;
    versionSelect.value = config.server?.version || defaults.version || '1.20.4';
  }
});

// 2. Nhận danh sách bot và trạng thái cập nhật từ server
socket.on('bots-update', (bots) => {
  currentBotsData = bots;
  
  // Dọn các bot đã tích chọn nhưng đã bị xóa khỏi server
  const botNames = Object.keys(bots);
  selectedBots.forEach(name => {
    if (!bots[name]) selectedBots.delete(name);
  });
  
  renderBotsList(bots);
  updateHeaderSummary(bots);
  updateConsoleFilters(bots);
  updateChatSenders(bots);
  onSelectionChanged(); // Cập nhật lại trạng thái form cấu hình
});

// Render danh sách bot kèm Checkbox
function renderBotsList(bots) {
  botsList.innerHTML = '';
  const botNames = Object.keys(bots);
  
  if (botNames.length === 0) {
    botsList.innerHTML = '<div class="no-bots-msg">Chưa có bot nào được cấu hình.</div>';
    checkboxSelectAll.checked = false;
    checkboxSelectAll.indeterminate = false;
    return;
  }
  
  botNames.forEach(name => {
    const bot = bots[name];
    const botItem = document.createElement('div');
    botItem.className = 'bot-item';
    
    let statusClass = 'offline';
    if (bot.state === 'online') statusClass = 'online';
    else if (bot.state === 'connecting') statusClass = 'connecting';
    
    let statusText = bot.state.toUpperCase();
    if (bot.state === 'online' && bot.coords) {
      statusText = `X: ${Math.round(bot.coords.x)}, Y: ${Math.round(bot.coords.y)}, Z: ${Math.round(bot.coords.z)}`;
    }
    
    const isChecked = selectedBots.has(name) ? 'checked' : '';
    
    botItem.innerHTML = `
      <div class="bot-info">
        <input type="checkbox" class="bot-select-checkbox" data-bot="${name}" ${isChecked}>
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
  
  // Xử lý sự kiện click checkbox của từng bot
  document.querySelectorAll('.bot-select-checkbox').forEach(cb => {
    cb.addEventListener('change', () => {
      const name = cb.dataset.bot;
      if (cb.checked) {
        selectedBots.add(name);
      } else {
        selectedBots.delete(name);
      }
      onSelectionChanged();
    });
  });

  // Sự kiện nút Bật/Tắt/Xóa
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

// Xử lý sự kiện khi Checkbox "Chọn tất cả" thay đổi
checkboxSelectAll.addEventListener('change', () => {
  const allNames = Object.keys(currentBotsData);
  if (checkboxSelectAll.checked) {
    allNames.forEach(name => selectedBots.add(name));
  } else {
    selectedBots.clear();
  }
  
  // Cập nhật các Checkbox trong danh sách
  document.querySelectorAll('.bot-select-checkbox').forEach(cb => {
    cb.checked = checkboxSelectAll.checked;
  });
  
  onSelectionChanged();
});

// Xử lý thay đổi lựa chọn chọn bot
function onSelectionChanged() {
  const allBotsCount = Object.keys(currentBotsData).length;
  
  // Trạng thái nút Chọn Tất Cả
  if (selectedBots.size === 0) {
    checkboxSelectAll.checked = false;
    checkboxSelectAll.indeterminate = false;
    
    // Ẩn form cấu hình, hiện thông báo
    configForm.style.display = 'none';
    configDisabledMsg.style.display = 'block';
    configTitle.textContent = 'Cấu Hình Bot';
    return;
  }
  
  configForm.style.display = 'block';
  configDisabledMsg.style.display = 'none';
  
  if (selectedBots.size === allBotsCount && allBotsCount > 0) {
    checkboxSelectAll.checked = true;
    checkboxSelectAll.indeterminate = false;
  } else if (selectedBots.size > 0) {
    checkboxSelectAll.checked = false;
    checkboxSelectAll.indeterminate = true;
  }
  
  // Điền cấu hình lên Form
  if (selectedBots.size === 1) {
    // Chỉ chọn 1 bot -> hiển thị chính xác cấu hình bot đó
    const selectedBotName = Array.from(selectedBots)[0];
    configTitle.textContent = `Cấu hình bot: ${selectedBotName}`;
    
    const botConfig = currentBotsData[selectedBotName]?.config;
    if (botConfig) {
      hostInput.value = botConfig.host || '';
      portInput.value = botConfig.port || 25565;
      versionSelect.value = botConfig.version || '1.20.4';
      loginCommandInput.value = botConfig.loginCommand || '';
      registerCommandInput.value = botConfig.registerCommand || '';
      loginDelayInput.value = botConfig.loginDelayMs || 2000;
      checkDelayInput.value = botConfig.checkClockDelayMs || 5000;
      autoJoinSubCheckbox.checked = botConfig.autoJoinSub;
      subGuiStepCountSelect.value = botConfig.subGuiStepCount || 1;
      
      const slots = botConfig.subGuiSlots || [10, 12];
      subGuiSlot1Input.value = slots[0] !== undefined ? slots[0] : 10;
      subGuiSlot2Input.value = slots[1] !== undefined ? slots[1] : 12;

      // Điền cấu hình macro
      macroEnabledCheckbox.checked = botConfig.macroEnabled || false;
      macroKeywordInput.value = botConfig.macroKeyword || '';
      macroCommandInput.value = botConfig.macroCommand || '';
      macroMoveEnabledCheckbox.checked = botConfig.macroMoveEnabled || false;
      macroMoveDelayInput.value = botConfig.macroMoveDelayMs !== undefined ? botConfig.macroMoveDelayMs : 1000;
      macroMoveDirectionSelect.value = botConfig.macroMoveDirection || 'forward';
      macroMoveDurationInput.value = botConfig.macroMoveDurationMs !== undefined ? botConfig.macroMoveDurationMs : 2000;
    }
  } else {
    // Chọn nhiều bot -> cho phép điền đè cấu hình (sử dụng bot đầu tiên làm bản mẫu)
    configTitle.textContent = `Cấu hình cho ${selectedBots.size} bot đã chọn`;
    
    const firstBotName = Array.from(selectedBots)[0];
    const botConfig = currentBotsData[firstBotName]?.config;
    if (botConfig) {
      hostInput.value = botConfig.host || '';
      portInput.value = botConfig.port || 25565;
      versionSelect.value = botConfig.version || '1.20.4';
      loginCommandInput.value = botConfig.loginCommand || '';
      registerCommandInput.value = botConfig.registerCommand || '';
      loginDelayInput.value = botConfig.loginDelayMs || 2000;
      checkDelayInput.value = botConfig.checkClockDelayMs || 5000;
      autoJoinSubCheckbox.checked = botConfig.autoJoinSub;
      subGuiStepCountSelect.value = botConfig.subGuiStepCount || 1;
      
      const slots = botConfig.subGuiSlots || [10, 12];
      subGuiSlot1Input.value = slots[0] !== undefined ? slots[0] : 10;
      subGuiSlot2Input.value = slots[1] !== undefined ? slots[1] : 12;

      // Điền cấu hình macro
      macroEnabledCheckbox.checked = botConfig.macroEnabled || false;
      macroKeywordInput.value = botConfig.macroKeyword || '';
      macroCommandInput.value = botConfig.macroCommand || '';
      macroMoveEnabledCheckbox.checked = botConfig.macroMoveEnabled || false;
      macroMoveDelayInput.value = botConfig.macroMoveDelayMs !== undefined ? botConfig.macroMoveDelayMs : 1000;
      macroMoveDirectionSelect.value = botConfig.macroMoveDirection || 'forward';
      macroMoveDurationInput.value = botConfig.macroMoveDurationMs !== undefined ? botConfig.macroMoveDurationMs : 2000;
    }
  }
  
  // Kích hoạt các sự kiện thay đổi hiển thị
  autoJoinSubCheckbox.dispatchEvent(new Event('change'));
  subGuiStepCountSelect.dispatchEvent(new Event('change'));
  macroEnabledCheckbox.dispatchEvent(new Event('change'));
  macroMoveEnabledCheckbox.dispatchEvent(new Event('change'));
}

// Xử lý gửi Cấu hình cho các Bot được chọn
configForm.addEventListener('submit', (e) => {
  e.preventDefault();
  
  if (selectedBots.size === 0) return;
  
  const slots = [
    parseInt(subGuiSlot1Input.value, 10)
  ];
  
  const stepCount = parseInt(subGuiStepCountSelect.value, 10);
  if (stepCount === 2) {
    slots.push(parseInt(subGuiSlot2Input.value, 10));
  }
  
  const configPayload = {
    host: hostInput.value,
    port: parseInt(portInput.value, 10),
    version: versionSelect.value,
    loginCommand: loginCommandInput.value,
    registerCommand: registerCommandInput.value,
    loginDelayMs: parseInt(loginDelayInput.value, 10),
    checkClockDelayMs: parseInt(checkDelayInput.value, 10),
    autoJoinSub: autoJoinSubCheckbox.checked,
    subGuiStepCount: stepCount,
    subGuiSlots: slots,
    macroEnabled: macroEnabledCheckbox.checked,
    macroKeyword: macroKeywordInput.value,
    macroCommand: macroCommandInput.value,
    macroMoveEnabled: macroMoveEnabledCheckbox.checked,
    macroMoveDelayMs: parseInt(macroMoveDelayInput.value, 10) || 0,
    macroMoveDirection: macroMoveDirectionSelect.value,
    macroMoveDurationMs: parseInt(macroMoveDurationInput.value, 10) || 0
  };
  
  socket.emit('save-bots-config', {
    usernames: Array.from(selectedBots),
    config: configPayload
  }, (response) => {
    if (response.success) {
      appendLog(`[Hệ thống] Đã lưu cấu hình cho ${selectedBots.size} bot thành công!`, 'system');
    } else {
      appendLog(`[Lỗi] Không thể lưu cấu hình: ${response.message}`, 'error');
    }
  });
});

// Cập nhật Header thống kê
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

// Cập nhật bộ lọc console
function updateConsoleFilters(bots) {
  const currentVal = consoleFilter.value;
  consoleFilter.innerHTML = '<option value="all">Tất cả bot</option>';
  
  Object.keys(bots).forEach(name => {
    const opt = document.createElement('option');
    opt.value = name;
    opt.textContent = name;
    consoleFilter.appendChild(opt);
  });
  
  if (bots[currentVal]) consoleFilter.value = currentVal;
  else consoleFilter.value = 'all';
}

// Cập nhật người gửi tin nhắn chat
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

// Nhận log tin nhắn hệ thống/chat
socket.on('log', (data) => {
  logHistory.push(data);
  if (logHistory.length > MAX_LOG_HISTORY) logHistory.shift();
  
  const filter = consoleFilter.value;
  if (filter === 'all' || filter === data.botname) {
    appendLog(data.text, data.type, data.botname);
  }
});

// Ghi log HTML
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

// Thay đổi bộ lọc console
consoleFilter.addEventListener('change', () => {
  consoleOutput.innerHTML = '';
  const filter = consoleFilter.value;
  const filteredLogs = logHistory.filter(log => filter === 'all' || log.botname === filter);
  filteredLogs.forEach(log => appendLog(log.text, log.type, log.botname));
});

// Submit Form Thêm 1 Bot
addBotForm.addEventListener('submit', (e) => {
  e.preventDefault();
  
  const username = newBotUsername.value.trim();
  const password = newBotPassword.value.trim();
  
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

// Submit Form Thêm Nhiều Bot Hàng Loạt
addBulkBotForm.addEventListener('submit', (e) => {
  e.preventDefault();
  
  const prefix = bulkPrefix.value.trim();
  const count = parseInt(bulkCount.value, 10);
  const password = bulkPassword.value.trim();
  
  if (!prefix || isNaN(count) || count < 1 || !password) return;
  
  socket.emit('add-bulk-bots', { prefix, count, password }, (response) => {
    if (response.success) {
      appendLog(`[Hệ thống] Đã gửi yêu cầu thêm hàng loạt ${count} bot thành công!`, 'system');
      bulkPrefix.value = '';
      bulkCount.value = '';
      bulkPassword.value = '';
    } else {
      appendLog(`[Lỗi] Không thể thêm bot hàng loạt: ${response.message}`, 'error');
    }
  });
});

// Gửi tin nhắn chat từ web
chatForm.addEventListener('submit', (e) => {
  e.preventDefault();
  
  const botname = chatSender.value;
  const message = chatInput.value.trim();
  
  if (!botname || !message) return;
  
  socket.emit('send-bot-chat', { botname, message });
  chatInput.value = '';
});

// Xóa log console
btnClearConsole.addEventListener('click', () => {
  consoleOutput.innerHTML = '';
  logHistory = [];
  appendLog('[Hệ thống] Đã dọn dẹp màn hình console.', 'system');
});

// ==========================================
// Giao diện Click GUI trực quan (Chest Menu)
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

socket.on('gui-open', (data) => {
  currentActiveGuiBot = data.botname;
  currentActiveGuiId = data.id;
  guiTitle.textContent = data.title;
  guiBotBadge.textContent = data.botname;
  guiCard.style.display = 'block';
  renderGuiGrid(data.slotsCount, data.items);
});

socket.on('gui-update', (data) => {
  if (currentActiveGuiBot !== data.botname || currentActiveGuiId !== data.id) return;
  
  const slotEl = guiGrid.querySelector(`.gui-slot[data-slot="${data.slotIndex}"]`);
  if (!slotEl) return;
  
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

socket.on('gui-close', (data) => {
  if (currentActiveGuiBot === data.botname) {
    guiCard.style.display = 'none';
    currentActiveGuiBot = '';
    currentActiveGuiId = null;
    guiGrid.innerHTML = '';
  }
});

function renderGuiGrid(slotsCount, items) {
  guiGrid.innerHTML = '';
  for (let i = 0; i < slotsCount; i++) {
    const slotEl = document.createElement('div');
    slotEl.className = 'gui-slot';
    slotEl.setAttribute('data-slot', i);
    slotEl.innerHTML = `<span class="slot-index">${i}</span>`;
    
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
    
    slotEl.addEventListener('click', () => {
      if (!currentActiveGuiBot) return;
      socket.emit('gui-click', { botname: currentActiveGuiBot, slotIndex: i });
      appendLog(`[Hệ thống] Đã click vào slot ${i} trong rương`, 'system', currentActiveGuiBot);
    });
    guiGrid.appendChild(slotEl);
  }
}

btnManualGuiClick.addEventListener('click', () => {
  const slotIndex = parseInt(manualGuiSlot.value, 10);
  if (isNaN(slotIndex) || slotIndex < 0 || !currentActiveGuiBot) return;
  socket.emit('gui-click', { botname: currentActiveGuiBot, slotIndex });
  appendLog(`[Hệ thống] Đã click thủ công vào slot ${slotIndex}`, 'system', currentActiveGuiBot);
  manualGuiSlot.value = '';
});

manualGuiSlot.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    btnManualGuiClick.click();
  }
});

btnCloseGuiManually.addEventListener('click', () => {
  if (!currentActiveGuiBot) return;
  socket.emit('gui-close-request', { botname: currentActiveGuiBot });
  appendLog(`[Hệ thống] Đang gửi yêu cầu đóng GUI...`, 'system', currentActiveGuiBot);
});
