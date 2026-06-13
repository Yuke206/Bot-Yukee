require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');
const mineflayer = require('mineflayer');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;

// Path tới tệp cấu hình config.json
const configPath = path.join(__dirname, 'config.json');

// Đọc cấu hình JSON
function readConfig() {
  if (!fs.existsSync(configPath)) {
    const defaultConfig = {
      server: { host: 'localhost', port: 25565, version: '1.20.4' },
      global: {
        loginCommand: '/login {password}',
        registerCommand: '/register {password} {password}',
        loginDelayMs: 2000,
        checkClockDelayMs: 5000,
        autoJoinSub: true,
        subGuiSlot: 10
      },
      bots: []
    };
    fs.writeFileSync(configPath, JSON.stringify(defaultConfig, null, 2), 'utf8');
    return defaultConfig;
  }
  try {
    return JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch (e) {
    console.error('Lỗi đọc tệp config.json, khởi tạo lại mặc định:', e.message);
    return { server: { host: 'localhost', port: 25565, version: '1.20.4' }, global: {}, bots: [] };
  }
}

// Ghi cấu hình JSON
function writeConfig(config) {
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8');
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
    loginCheckTimeout: null
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
        food: null
      };
    }
  });

  Object.keys(activeBots).forEach(username => {
    const b = activeBots[username];
    statusData[username] = {
      state: b.state,
      coords: b.coords,
      health: b.health,
      food: b.food
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

  const config = readConfig();

  // Ở lần chạy đầu tiên (checkAttempt === 1), thực hiện gửi lệnh đăng nhập
  if (checkAttempt === 1) {
    const loginCmd = config.global.loginCommand.replace(/{password}/g, password);
    const maskedLoginCmd = config.global.loginCommand.replace(/{password}/g, '********');
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
      if (config.global.autoJoinSub) {
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

            logToWeb(username, `Đã chuyển sang cầm đồng hồ. Đang kích hoạt sử dụng (chuột phải)...`, 'system');

            // Đăng ký bắt sự kiện mở giao diện GUI
            activeBot.bot.once('windowOpen', (window) => {
              const slot = config.global.subGuiSlot !== undefined ? config.global.subGuiSlot : 10;
              logToWeb(username, `Giao diện chọn cụm đã mở (Window ID: ${window.id}). Đang click vào ô: ${slot}`, 'system');

              // Đợi 1 giây để server load đầy đủ vật phẩm rồi click
              setTimeout(() => {
                if (!activeBot.bot || activeBot.state !== 'online') return;
                activeBot.bot.clickWindow(slot, 0, 0, (clickErr) => {
                  if (clickErr) {
                    logToWeb(username, `Lỗi khi click vào ô ${slot}: ${clickErr.message}`, 'error');
                  } else {
                    logToWeb(username, `Đã click thành công vào ô ${slot} để chọn cụm!`, 'system');
                    try {
                      activeBot.bot.closeWindow(window);
                    } catch (e) {}
                  }
                });
              }, 1000);
            });

            // Kích hoạt vật phẩm trên tay (chuột phải)
            try {
              activeBot.bot.activateItem();
            } catch (activateErr) {
              logToWeb(username, `Lỗi kích hoạt vật phẩm: ${activateErr.message}`, 'error');
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
        
        const registerCmd = config.global.registerCommand.replace(/{password}/g, password);
        const maskedRegisterCmd = config.global.registerCommand.replace(/{password}/g, '********');

        logToWeb(username, `Đang gửi lệnh đăng ký: ${maskedRegisterCmd}`, 'system');
        activeBot.bot.chat(registerCmd);

        // Đợi 2 giây gửi lại lệnh đăng nhập
        setTimeout(() => {
          if (!activeBot.bot || activeBot.state !== 'online') return;
          const loginCmd = config.global.loginCommand.replace(/{password}/g, password);
          const maskedLoginCmd = config.global.loginCommand.replace(/{password}/g, '********');
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
  }, config.global.checkClockDelayMs);
}

// Hàm khởi chạy bot
function startBotInstance(username, password) {
  const config = readConfig();
  
  // Đảm bảo bot được định nghĩa trong map activeBots
  if (!activeBots[username]) {
    activeBots[username] = {
      state: 'offline',
      bot: null,
      coords: null,
      health: null,
      food: null
    };
  }

  const activeBot = activeBots[username];

  // Nếu đang chạy dở, dừng bot cũ trước
  if (activeBot.state !== 'offline' && activeBot.bot) {
    stopBotInstance(username);
  }

  activeBot.state = 'connecting';
  emitBotsUpdate();
  logToWeb(username, `Đang kết nối tới ${config.server.host}:${config.server.port}...`, 'system');

  try {
    const bot = mineflayer.createBot({
      host: config.server.host,
      port: config.server.port,
      username: username,
      version: config.server.version === 'false' ? false : config.server.version
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
}

// Hàm tắt bot
function stopBotInstance(username) {
  const activeBot = activeBots[username];
  if (!activeBot) return;

  logToWeb(username, `Đang chủ động tắt bot...`, 'system');
  activeBot.state = 'offline';

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

  // Lưu cấu hình chung
  socket.on('save-global-config', (newConfig, callback) => {
    try {
      const currentConfig = readConfig();
      currentConfig.server = newConfig.server;
      currentConfig.global = newConfig.global;
      writeConfig(currentConfig);
      
      callback({ success: true });
      logToWeb('', `Đã lưu cấu hình chung mới thành công!`, 'system');
    } catch (err) {
      callback({ success: false, message: err.message });
      logToWeb('', `Lỗi lưu cấu hình: ${err.message}`, 'error');
    }
  });

  // Thêm Bot mới
  socket.on('add-bot', (botData, callback) => {
    try {
      const config = readConfig();
      const exists = config.bots.some(b => b.username === botData.username);
      if (exists) {
        callback({ success: false, message: 'Bot với tên này đã tồn tại!' });
        return;
      }
      
      config.bots.push(botData);
      writeConfig(config);
      
      activeBots[botData.username] = {
        state: 'offline',
        bot: null,
        coords: null,
        health: null,
        food: null,
        reconnectTimeout: null,
        loginCheckTimeout: null
      };

      callback({ success: true });
      emitBotsUpdate();
      logToWeb(botData.username, `Đã được thêm vào hệ thống quản lý.`, 'system');
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
