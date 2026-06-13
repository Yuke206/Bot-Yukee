require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');
const mineflayer = require('mineflayer');
const dns = require('dns');
dns.setServers(['1.1.1.1', '8.8.8.8']);

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;

// Path tới tệp cấu hình config.json
const configPath = path.join(__dirname, 'config.json');

// Mẫu cấu hình mặc định ban đầu
const defaultConfigTemplate = {
  host: 'localhost',
  port: 25565,
  version: '1.20.4',
  loginCommand: '/login {password}',
  registerCommand: '/register {password} {password}',
  loginDelayMs: 2000,
  checkClockDelayMs: 5000,
  autoJoinSub: true,
  subGuiStepCount: 1,
  subGuiSlots: [10, 12]
};

// Đọc cấu hình JSON
function readConfig() {
  if (!fs.existsSync(configPath)) {
    const initialConfig = {
      defaults: defaultConfigTemplate,
      bots: [
        {
          username: "AutoBot_1",
          password: "MatKhauBot123",
          ...defaultConfigTemplate
        }
      ]
    };
    fs.writeFileSync(configPath, JSON.stringify(initialConfig, null, 2), 'utf8');
    return initialConfig;
  }
  try {
    const cfg = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    if (!cfg.defaults) cfg.defaults = defaultConfigTemplate;
    if (!cfg.bots) cfg.bots = [];
    return cfg;
  } catch (e) {
    console.error('Lỗi đọc tệp config.json, khởi tạo lại mặc định:', e.message);
    return { defaults: defaultConfigTemplate, bots: [] };
  }
}

// Ghi cấu hình JSON
function writeConfig(config) {
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8');
}

// Lấy cấu hình của một bot cụ thể (nếu thiếu trường sẽ fallback về defaults)
function getBotConfig(config, username) {
  const b = config.bots.find(bot => bot.username === username) || {};
  const defaults = config.defaults || defaultConfigTemplate;
  
  return {
    host: b.host !== undefined ? b.host : defaults.host,
    port: b.port !== undefined ? b.port : defaults.port,
    version: b.version !== undefined ? b.version : defaults.version,
    loginCommand: b.loginCommand !== undefined ? b.loginCommand : defaults.loginCommand,
    registerCommand: b.registerCommand !== undefined ? b.registerCommand : defaults.registerCommand,
    loginDelayMs: b.loginDelayMs !== undefined ? b.loginDelayMs : defaults.loginDelayMs,
    checkClockDelayMs: b.checkClockDelayMs !== undefined ? b.checkClockDelayMs : defaults.checkClockDelayMs,
    autoJoinSub: b.autoJoinSub !== undefined ? b.autoJoinSub : defaults.autoJoinSub,
    subGuiStepCount: b.subGuiStepCount !== undefined ? b.subGuiStepCount : defaults.subGuiStepCount,
    subGuiSlots: b.subGuiSlots !== undefined ? b.subGuiSlots : defaults.subGuiSlots
  };
}

// Phục vụ giao diện web tĩnh
app.use(express.static(path.join(__dirname, 'public')));

// Quản lý các thực thể bot đang hoạt động
const activeBots = {};

// Khởi tạo trạng thái ban đầu của bot từ cấu hình
const config = readConfig();
config.bots.forEach(bot => {
  activeBots[bot.username] = {
    state: 'offline',
    bot: null,
    coords: null,
    health: null,
    food: null,
    reconnectTimeout: null,
    loginCheckTimeout: null,
    isAutoJoining: false,
    currentGuiStep: 0
  };
});

// Hàm log gửi lên Web UI theo bot cụ thể
function logToWeb(botname, text, type = 'system') {
  const formattedText = text.toString();
  console.log(`[${botname || 'Hệ thống'}] [${type.toUpperCase()}] ${formattedText}`);
  io.emit('log', { botname, text: formattedText, type });
}

// Helper: Làm sạch tiêu đề GUI Minecraft
function cleanWindowTitle(title) {
  if (!title) return 'GUI Menu';
  if (typeof title === 'object') {
    if (title.text !== undefined) return title.text;
    if (title.translate !== undefined) return title.translate;
    if (typeof title.toString === 'function') {
      const str = title.toString();
      if (str && str !== '[object Object]') return str;
    }
  }
  try {
    const parsed = JSON.parse(title);
    if (parsed && typeof parsed === 'object') {
      if (parsed.text !== undefined) return parsed.text;
      if (parsed.translate !== undefined) return parsed.translate;
    }
  } catch (e) {
    // Không phải JSON, giữ nguyên chuỗi
  }
  return title.toString();
}

// Xây dựng dữ liệu trạng thái bot gửi về client
function getBotsStatusData() {
  const statusData = {};
  const config = readConfig();
  
  // Dọn dẹp bot cũ không còn trong config
  Object.keys(activeBots).forEach(username => {
    const exists = config.bots.some(b => b.username === username);
    if (!exists) {
      const activeBot = activeBots[username];
      if (activeBot) {
        if (activeBot.reconnectTimeout) clearTimeout(activeBot.reconnectTimeout);
        if (activeBot.loginCheckTimeout) clearTimeout(activeBot.loginCheckTimeout);
        if (activeBot.bot) {
          try { activeBot.bot.quit(); } catch (e) {}
        }
      }
      delete activeBots[username];
    }
  });

  // Đảm bảo mọi bot trong config đều có trong activeBots
  config.bots.forEach(b => {
    if (!activeBots[b.username]) {
      activeBots[b.username] = {
        state: 'offline',
        bot: null,
        coords: null,
        health: null,
        food: null,
        isAutoJoining: false,
        currentGuiStep: 0
      };
    }
  });

  Object.keys(activeBots).forEach(username => {
    const b = activeBots[username];
    statusData[username] = {
      state: b.state,
      coords: b.coords,
      health: b.health,
      food: b.food,
      config: getBotConfig(config, username) // Gửi cấu hình riêng biệt của từng bot
    };
  });
  return statusData;
}

// Đồng bộ danh sách bot về tất cả client
function emitBotsUpdate() {
  io.emit('bots-update', getBotsStatusData());
}

// Đồng bộ danh sách bot về riêng 1 socket
function sendBotsUpdateToSocket(socket) {
  socket.emit('bots-update', getBotsStatusData());
}

// Hàm thực hiện chuỗi đăng nhập, đăng ký và tự chọn cụm
function performLoginSequence(username, password, checkAttempt = 1) {
  const activeBot = activeBots[username];
  if (!activeBot || !activeBot.bot || activeBot.state !== 'online') return;

  const botConfig = getBotConfig(readConfig(), username);

  // Ở lần chạy đầu tiên (checkAttempt === 1), thực hiện gửi lệnh đăng nhập
  if (checkAttempt === 1) {
    const loginCmd = botConfig.loginCommand.replace(/{password}/g, password);
    const maskedLoginCmd = botConfig.loginCommand.replace(/{password}/g, '********');
    logToWeb(username, `Đang gửi lệnh đăng nhập: ${maskedLoginCmd}`, 'system');
    activeBot.bot.chat(loginCmd);
  }

  // Thiết lập kiểm tra đồng hồ và tự đăng ký sau thời gian cấu hình
  if (activeBot.loginCheckTimeout) clearTimeout(activeBot.loginCheckTimeout);
  activeBot.loginCheckTimeout = setTimeout(() => {
    if (!activeBot.bot || activeBot.state !== 'online') return;

    logToWeb(username, `Đang kiểm tra đồng hồ ở hotbar (Lần quét: ${checkAttempt})...`, 'system');

    // Đọc vật phẩm ở hotbar an toàn qua bot.inventory
    let items = [];
    try {
      if (activeBot.bot.inventory) {
        items = activeBot.bot.inventory.items().filter(item => item && item.slot >= 36 && item.slot <= 44);
      } else {
        logToWeb(username, `Inventory của bot chưa sẵn sàng`, 'warning');
      }
    } catch (e) {
      logToWeb(username, `Không thể đọc hotbar: ${e.message}`, 'error');
    }

    const itemNames = items.filter(Boolean).map(i => `${i.name}x${i.count}`);
    logToWeb(username, `Danh sách vật phẩm trong hotbar: [${itemNames.join(', ') || 'Trống'}]`, 'system');

    const hasClock = items.some(item => item && item.name === 'clock');

    if (hasClock) {
      logToWeb(username, `Đăng nhập thành công! Phát hiện đồng hồ (clock) trong hotbar.`, 'system');

      // Xử lý Tự động chọn cụm qua GUI
      if (botConfig.autoJoinSub) {
        logToWeb(username, `Chế độ tự động vào cụm đang bật. Đang tiến hành cầm đồng hồ...`, 'system');
        const clockItem = items.find(item => item && item.name === 'clock');
        
        if (clockItem) {
          const quickbarSlot = clockItem.slot - 36;
          logToWeb(username, `Đồng hồ nằm ở slot hotbar số ${quickbarSlot + 1}. Đang chuyển tay cầm về slot này...`, 'system');
          
          try {
            activeBot.bot.setQuickBarSlot(quickbarSlot);
          } catch (slotErr) {
            logToWeb(username, `Lỗi khi chuyển slot hotbar: ${slotErr.message}`, 'error');
          }

          // Chờ 200ms để server ghi nhận đổi slot trước khi kích hoạt
          setTimeout(() => {
            if (!activeBot.bot || activeBot.state !== 'online') return;

            logToWeb(username, `Đã chuyển sang cầm đồng hồ. Kích hoạt trạng thái tự động chọn cụm...`, 'system');
            
            // Kích hoạt trạng thái tự động chọn cụm
            activeBot.isAutoJoining = true;
            activeBot.currentGuiStep = 0;

            // Kích hoạt vật phẩm trên tay (chuột phải)
            try {
              activeBot.bot.activateItem();
            } catch (activateErr) {
              logToWeb(username, `Lỗi kích hoạt vật phẩm: ${activateErr.message}`, 'error');
              activeBot.isAutoJoining = false;
            }
          }, 200);

        } else {
          logToWeb(username, `Không thể tìm thấy đồng hồ trong hotbar để cầm.`, 'error');
        }
      }

    } else {
      // Không thấy đồng hồ
      if (checkAttempt === 1) {
        logToWeb(username, `Không tìm thấy đồng hồ ở hotbar sau 5 giây! Đang tiến hành đăng ký...`, 'warning');
        
        const registerCmd = botConfig.registerCommand.replace(/{password}/g, password);
        const maskedRegisterCmd = botConfig.registerCommand.replace(/{password}/g, '********');

        logToWeb(username, `Đang gửi lệnh đăng ký: ${maskedRegisterCmd}`, 'system');
        activeBot.bot.chat(registerCmd);

        // Đợi 2 giây gửi lại lệnh đăng nhập
        setTimeout(() => {
          if (!activeBot.bot || activeBot.state !== 'online') return;
          const loginCmd = botConfig.loginCommand.replace(/{password}/g, password);
          const maskedLoginCmd = botConfig.loginCommand.replace(/{password}/g, '********');
          logToWeb(username, `Gửi lại lệnh đăng nhập sau khi đăng ký: ${maskedLoginCmd}`, 'system');
          activeBot.bot.chat(loginCmd);

          // Kích hoạt quét hotbar lần 2 sau 5 giây nữa
          performLoginSequence(username, password, 2);
        }, 2000);
      } else if (checkAttempt === 2) {
        logToWeb(username, `Lần 2 vẫn không thấy đồng hồ. Đang chờ thêm 5s để quét lần cuối (Lần 3)...`, 'warning');
        performLoginSequence(username, password, 3);
      } else {
        logToWeb(username, `Đã kiểm tra 3 lần vẫn không thấy đồng hồ ở hotbar. Dừng chu kỳ kiểm tra đăng nhập.`, 'error');
      }
    }
  }, botConfig.checkClockDelayMs);
}

// Helper: Phân giải bản ghi SRV để lấy IP/Port thực tế của Minecraft server (như game client)
function resolveMinecraftServer(host, port, callback) {
  const isIP = /^(?:[0-9]{1,3}\.){3}[0-9]{1,3}$/.test(host);
  if (port !== 25565 || isIP || host === 'localhost' || host === '127.0.0.1') {
    return callback(host, port);
  }

  dns.resolveSrv(`_minecraft._tcp.${host}`, (err, addresses) => {
    if (!err && addresses && addresses.length > 0) {
      const sorted = addresses.sort((a, b) => a.priority - b.priority || b.weight - a.weight);
      const srv = sorted[0];
      console.log(`[DNS] Đã phân giải SRV cho ${host} -> ${srv.name}:${srv.port}`);
      return callback(srv.name, srv.port);
    }
    // Fallback nếu không có SRV
    callback(host, port);
  });
}

// Hàm khởi chạy bot
function startBotInstance(username, password) {
  const config = readConfig();
  const botConfig = getBotConfig(config, username);
  
  // Đảm bảo bot được định nghĩa trong map activeBots
  if (!activeBots[username]) {
    activeBots[username] = {
      state: 'offline',
      bot: null,
      coords: null,
      health: null,
      food: null,
      isAutoJoining: false,
      currentGuiStep: 0
    };
  }

  const activeBot = activeBots[username];

  // Nếu đang chạy dở, dừng bot cũ trước
  if (activeBot.state !== 'offline' && activeBot.bot) {
    stopBotInstance(username);
  }

  activeBot.state = 'connecting';
  activeBot.isAutoJoining = false;
  activeBot.currentGuiStep = 0;
  
  emitBotsUpdate();
  
  // Thực hiện phân giải SRV trước khi kết nối
  resolveMinecraftServer(botConfig.host, botConfig.port, (resolvedHost, resolvedPort) => {
    // Đảm bảo người dùng không ấn Tắt bot trong lúc DNS đang phân giải
    if (activeBot.state !== 'connecting') return;
    
    logToWeb(username, `Đang kết nối tới ${resolvedHost}:${resolvedPort}...`, 'system');

    try {
      const bot = mineflayer.createBot({
        host: resolvedHost,
        port: resolvedPort,
        username: username,
        version: botConfig.version === 'false' ? false : botConfig.version
      });

      activeBot.bot = bot;

      // Đăng ký các sự kiện tương tác GUI Window cho bot
      bot.on('windowOpen', (window) => {
        if (window.id === 0) return; // Bỏ qua hòm đồ cá nhân

        const titleText = cleanWindowTitle(window.title);
        logToWeb(username, `Giao diện GUI '${titleText}' được mở (ID: ${window.id}, Slots: ${window.slots.length})`, 'system');

        // Tạo mảng danh sách vật phẩm gửi lên client
        const items = window.slots.map((item, index) => {
          if (!item) return null;
          return {
            slot: index,
            name: item.name,
            count: item.count
          };
        }).filter(Boolean);

        io.emit('gui-open', {
          botname: username,
          title: titleText,
          id: window.id,
          slotsCount: window.slots.length,
          items: items
        });

        // Lắng nghe sự kiện cập nhật vật phẩm trong GUI
        window.on('updateSlot', (slotIndex, oldItem, newItem) => {
          io.emit('gui-update', {
            botname: username,
            id: window.id,
            slotIndex: slotIndex,
            item: newItem ? { name: newItem.name, count: newItem.count } : null
          });
        });

        // Logic Tự động click GUI theo bước rương
        if (activeBot.isAutoJoining) {
          const freshConfig = getBotConfig(readConfig(), username);
          const slots = freshConfig.subGuiSlots || [10, 12];
          const stepCount = freshConfig.subGuiStepCount || 1;

          if (activeBot.currentGuiStep === 0) {
            const targetSlot = slots[0] !== undefined ? slots[0] : 10;
            logToWeb(username, `[Auto-Join] Phát hiện rương thứ nhất. Đang click vào ô: ${targetSlot}`, 'system');
            
            // Chuyển bước ngay lập tức để tránh cuộc đua gói tin khi rương thứ hai được mở rất nhanh
            if (stepCount >= 2) {
              activeBot.currentGuiStep = 1;
            } else {
              activeBot.isAutoJoining = false;
              activeBot.currentGuiStep = 0;
            }

            setTimeout(() => {
              if (!activeBot.bot || activeBot.state !== 'online') return;
              activeBot.bot.clickWindow(targetSlot, 0, 0, (clickErr) => {
                if (clickErr) {
                  logToWeb(username, `[Auto-Join] Lỗi click rương 1: ${clickErr.message}`, 'error');
                  // Hoàn tác trạng thái nếu click thất bại
                  activeBot.isAutoJoining = false;
                  activeBot.currentGuiStep = 0;
                } else {
                  logToWeb(username, `[Auto-Join] Đã click rương 1 thành công.`, 'system');
                }
              });
            }, 500);
          } else if (activeBot.currentGuiStep === 1) {
            const targetSlot = slots[1] !== undefined ? slots[1] : 12;
            logToWeb(username, `[Auto-Join] Phát hiện rương thứ hai. Đang click vào ô: ${targetSlot}`, 'system');

            // Reset trạng thái tự động click ngay lập tức
            activeBot.isAutoJoining = false;
            activeBot.currentGuiStep = 0;

            setTimeout(() => {
              if (!activeBot.bot || activeBot.state !== 'online') return;
              activeBot.bot.clickWindow(targetSlot, 0, 0, (clickErr) => {
                if (clickErr) {
                  logToWeb(username, `[Auto-Join] Lỗi click rương 2: ${clickErr.message}`, 'error');
                } else {
                  logToWeb(username, `[Auto-Join] Đã click rương 2 thành công. Tự động vào cụm hoàn tất.`, 'system');
                }
              });
            }, 500);
          }
        }
      });

      bot.on('windowClose', (window) => {
        if (window.id === 0) return;
        logToWeb(username, `Giao diện GUI (ID: ${window.id}) đã đóng.`, 'system');
        io.emit('gui-close', {
          botname: username,
          id: window.id
        });
      });

      // Khi bot spawn vào server
      bot.once('spawn', () => {
        activeBot.state = 'online';
        emitBotsUpdate();
        logToWeb(username, `Bot '${bot.username}' đã spawn vào server thành công!`, 'system');

        // Bắt đầu chuỗi đăng nhập và quét hotbar kiểm tra đồng hồ
        performLoginSequence(username, password, 1);
      });

      // Khi nhận chat
      bot.on('chat', (sender, message) => {
        if (sender === bot.username) return;
        logToWeb(username, `<${sender}> ${message}`, 'chat');
      });

      // Khi nhận tin nhắn hệ thống
      bot.on('message', (jsonMsg) => {
        const message = jsonMsg.toString().trim();
        if (!message) return;
        logToWeb(username, message, 'server');
      });

      // Khi bot bị kick
      bot.on('kicked', (reason) => {
        logToWeb(username, `Bot bị Kick khỏi server. Lý do: ${reason}`, 'warning');
      });

      // Khi gặp lỗi kết nối
      bot.on('error', (err) => {
        logToWeb(username, `Lỗi kết nối: ${err.message || err}`, 'error');
      });

      // Khi đóng kết nối
      bot.on('end', () => {
        logToWeb(username, `Bot đã ngắt kết nối.`, 'system');
        
        if (activeBot.loginCheckTimeout) clearTimeout(activeBot.loginCheckTimeout);
        activeBot.bot = null;

        // Nếu không phải tắt thủ công thì tự động kết nối lại
        if (activeBot.state !== 'offline') {
          activeBot.state = 'connecting';
          emitBotsUpdate();
          
          const reconnectDelay = parseInt(process.env.RECONNECT_DELAY_MS || '10000', 10);
          logToWeb(username, `Sẽ tự động kết nối lại sau ${reconnectDelay / 1000} giây...`, 'system');
          
          if (activeBot.reconnectTimeout) clearTimeout(activeBot.reconnectTimeout);
          activeBot.reconnectTimeout = setTimeout(() => {
            startBotInstance(username, password);
          }, reconnectDelay);
        } else {
          emitBotsUpdate();
        }
      });

    } catch (err) {
      logToWeb(username, `Lỗi khởi tạo bot: ${err.message}`, 'error');
      activeBot.state = 'offline';
      emitBotsUpdate();
    }
  });
}

// Hàm tắt bot
function stopBotInstance(username) {
  const activeBot = activeBots[username];
  if (!activeBot) return;

  logToWeb(username, `Đang chủ động tắt bot...`, 'system');
  activeBot.state = 'offline';
  activeBot.isAutoJoining = false;
  activeBot.currentGuiStep = 0;

  if (activeBot.reconnectTimeout) clearTimeout(activeBot.reconnectTimeout);
  if (activeBot.loginCheckTimeout) clearTimeout(activeBot.loginCheckTimeout);

  if (activeBot.bot) {
    try {
      activeBot.bot.quit();
    } catch (e) {}
    activeBot.bot = null;
  }

  activeBot.coords = null;
  activeBot.health = null;
  activeBot.food = null;

  emitBotsUpdate();
  logToWeb(username, `Bot đã được tắt hoàn toàn.`, 'system');
}

// Chu kỳ cập nhật tọa độ, lượng máu, độ đói mỗi 1 giây
setInterval(() => {
  let changed = false;
  Object.keys(activeBots).forEach(name => {
    const activeBot = activeBots[name];
    if (activeBot.bot && activeBot.bot.entity && activeBot.state === 'online') {
      activeBot.coords = activeBot.bot.entity.position;
      activeBot.health = activeBot.bot.health;
      activeBot.food = activeBot.bot.food;
      changed = true;
    }
  });
  if (changed) {
    emitBotsUpdate();
  }
}, 1000);

// Xử lý sự kiện Socket.io
io.on('connection', (socket) => {
  console.log(`[Socket] Kết nối mới từ Client Web.`);
  
  // Gửi cấu hình và trạng thái hiện tại ngay khi kết nối
  socket.emit('current-config', readConfig());
  sendBotsUpdateToSocket(socket);

  // Lưu cấu hình riêng cho từng bot hoặc chỉnh sửa hàng loạt các bot được chọn
  socket.on('save-bots-config', (data, callback) => {
    try {
      const { usernames, config: newConfig } = data;
      if (!usernames || usernames.length === 0) {
        callback({ success: false, message: 'Không có bot nào được chọn để lưu cấu hình!' });
        return;
      }
      
      const config = readConfig();
      usernames.forEach(name => {
        const bot = config.bots.find(b => b.username === name);
        if (bot) {
          bot.host = newConfig.host;
          bot.port = newConfig.port;
          bot.version = newConfig.version;
          bot.loginCommand = newConfig.loginCommand;
          bot.registerCommand = newConfig.registerCommand;
          bot.loginDelayMs = newConfig.loginDelayMs;
          bot.checkClockDelayMs = newConfig.checkClockDelayMs;
          bot.autoJoinSub = newConfig.autoJoinSub;
          bot.subGuiStepCount = newConfig.subGuiStepCount;
          bot.subGuiSlots = newConfig.subGuiSlots;
        }
      });
      
      writeConfig(config);
      callback({ success: true });
      logToWeb('', `Đã cập nhật cấu hình thành công cho ${usernames.length} bot.`, 'system');
      emitBotsUpdate();
    } catch (err) {
      callback({ success: false, message: err.message });
      logToWeb('', `Lỗi khi lưu cấu hình: ${err.message}`, 'error');
    }
  });

  // Thêm 1 Bot mới
  socket.on('add-bot', (botData, callback) => {
    try {
      const config = readConfig();
      const exists = config.bots.some(b => b.username === botData.username);
      if (exists) {
        callback({ success: false, message: 'Bot với tên này đã tồn tại!' });
        return;
      }
      
      // Khởi tạo bot mới với các giá trị cấu hình mặc định (defaults)
      const defaults = config.defaults || defaultConfigTemplate;
      const newBot = {
        username: botData.username,
        password: botData.password,
        ...defaults
      };
      
      config.bots.push(newBot);
      writeConfig(config);
      
      activeBots[botData.username] = {
        state: 'offline',
        bot: null,
        coords: null,
        health: null,
        food: null,
        reconnectTimeout: null,
        loginCheckTimeout: null,
        isAutoJoining: false,
        currentGuiStep: 0
      };

      callback({ success: true });
      emitBotsUpdate();
      logToWeb(botData.username, `Đã được thêm vào hệ thống quản lý.`, 'system');
    } catch (err) {
      callback({ success: false, message: err.message });
    }
  });

  // Thêm nhiều Bot hàng loạt cùng 1 lúc
  socket.on('add-bulk-bots', (data, callback) => {
    try {
      const { prefix, count, password } = data;
      const config = readConfig();
      const defaults = config.defaults || defaultConfigTemplate;
      
      let addedCount = 0;
      for (let i = 0; i < count; i++) {
        const username = `${prefix}_${i}`;
        const exists = config.bots.some(b => b.username === username);
        if (!exists) {
          config.bots.push({
            username,
            password,
            ...defaults
          });
          
          activeBots[username] = {
            state: 'offline',
            bot: null,
            coords: null,
            health: null,
            food: null,
            reconnectTimeout: null,
            loginCheckTimeout: null,
            isAutoJoining: false,
            currentGuiStep: 0
          };
          addedCount++;
        }
      }
      
      if (addedCount > 0) {
        writeConfig(config);
        callback({ success: true });
        emitBotsUpdate();
        logToWeb('', `Đã thêm thành công hàng loạt ${addedCount} bot (tiền tố: ${prefix}).`, 'system');
      } else {
        callback({ success: false, message: 'Tất cả các bot này đã tồn tại sẵn trong hệ thống!' });
      }
    } catch (err) {
      callback({ success: false, message: err.message });
    }
  });

  // Xóa bot
  socket.on('delete-bot', (username) => {
    try {
      const config = readConfig();
      config.bots = config.bots.filter(b => b.username !== username);
      writeConfig(config);

      stopBotInstance(username);
      delete activeBots[username];

      emitBotsUpdate();
      logToWeb(username, `Đã bị xóa khỏi cấu hình hệ thống.`, 'system');
    } catch (err) {
      console.error(err);
    }
  });

  // Bật một bot cụ thể
  socket.on('start-bot-instance', (username) => {
    const config = readConfig();
    const botConf = config.bots.find(b => b.username === username);
    if (botConf) {
      startBotInstance(username, botConf.password);
    }
  });

  // Tắt một bot cụ thể
  socket.on('stop-bot-instance', (username) => {
    stopBotInstance(username);
  });

  // Gửi tin nhắn từ một bot cụ thể
  socket.on('send-bot-chat', (data) => {
    const { botname, message } = data;
    const activeBot = activeBots[botname];
    if (activeBot && activeBot.state === 'online' && activeBot.bot) {
      logToWeb(botname, `[Gửi từ Web] ${message}`, 'system');
      activeBot.bot.chat(message);
    }
  });

  // Sự kiện Click ô GUI từ giao diện Web
  socket.on('gui-click', (data) => {
    const { botname, slotIndex } = data;
    const activeBot = activeBots[botname];
    if (activeBot && activeBot.state === 'online' && activeBot.bot) {
      const window = activeBot.bot.currentWindow;
      if (window) {
        activeBot.bot.clickWindow(slotIndex, 0, 0, (err) => {
          if (err) {
            logToWeb(botname, `Lỗi click slot GUI ${slotIndex}: ${err.message}`, 'error');
          }
        });
      } else {
        logToWeb(botname, `Không có giao diện GUI nào đang mở để click!`, 'warning');
      }
    }
  });

  // Sự kiện yêu cầu đóng GUI từ Web
  socket.on('gui-close-request', (data) => {
    const { botname } = data;
    const activeBot = activeBots[botname];
    if (activeBot && activeBot.state === 'online' && activeBot.bot) {
      const window = activeBot.bot.currentWindow;
      if (window) {
        try {
          activeBot.bot.closeWindow(window);
        } catch (e) {
          logToWeb(botname, `Lỗi đóng rương: ${e.message}`, 'error');
        }
      }
    }
  });

  socket.on('disconnect', () => {
    console.log(`[Socket] Ngắt kết nối từ Client Web.`);
  });
});

// Khởi chạy server
server.listen(PORT, () => {
  console.log(`========================================================`);
  console.log(`[Web Server] Dashboard dang chay tai: http://localhost:${PORT}`);
  console.log(`========================================================`);
});
