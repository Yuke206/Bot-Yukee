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
  subGuiSlots: [10, 12],
  macroEnabled: false,
  macroKeyword: '',
  macroCommand: '',
  macroMoveEnabled: false,
  macroMoveDelayMs: 1000,
  macroMoveDirection: 'forward',
  macroMoveDurationMs: 2000
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
    subGuiSlots: b.subGuiSlots !== undefined ? b.subGuiSlots : defaults.subGuiSlots,
    macroEnabled: b.macroEnabled !== undefined ? b.macroEnabled : defaults.macroEnabled,
    macroKeyword: b.macroKeyword !== undefined ? b.macroKeyword : defaults.macroKeyword,
    macroCommand: b.macroCommand !== undefined ? b.macroCommand : defaults.macroCommand,
    macroMoveEnabled: b.macroMoveEnabled !== undefined ? b.macroMoveEnabled : defaults.macroMoveEnabled,
    macroMoveDelayMs: b.macroMoveDelayMs !== undefined ? b.macroMoveDelayMs : defaults.macroMoveDelayMs,
    macroMoveDirection: b.macroMoveDirection !== undefined ? b.macroMoveDirection : defaults.macroMoveDirection,
    macroMoveDurationMs: b.macroMoveDurationMs !== undefined ? b.macroMoveDurationMs : defaults.macroMoveDurationMs
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
    money: null,
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

// Quản lý hàng đợi kết nối lại tuần tự (Avoid concurrent reconnects spam)
let reconnectQueue = [];
let activeConnectingBot = null;
let activeConnectingTimeout = null;

function addToReconnectQueue(username, password) {
  const exists = reconnectQueue.some(item => item.username === username);
  if (!exists) {
    reconnectQueue.push({ username, password });
    logToWeb(username, `[Reconnect Queue] Đã xếp hàng chờ kết nối lại (Vị trí hàng đợi: ${reconnectQueue.length})`, 'system');
  }
  processReconnectQueue();
}

function removeFromReconnectQueue(username) {
  const initialLength = reconnectQueue.length;
  reconnectQueue = reconnectQueue.filter(item => item.username !== username);
  
  if (activeConnectingBot === username) {
    logToWeb(username, `[Reconnect Queue] Bot đang kết nối bị hủy thủ công. Chuyển sang bot tiếp theo...`, 'system');
    if (activeConnectingTimeout) {
      clearTimeout(activeConnectingTimeout);
      activeConnectingTimeout = null;
    }
    activeConnectingBot = null;
    processReconnectQueue();
  }
}

function onBotEnteredCluster(username) {
  if (activeConnectingBot === username) {
    logToWeb(username, `[Reconnect Queue] Bot đã chọn cụm xong. Chờ 2 giây kiểm tra trạng thái kick...`, 'system');
    if (activeConnectingTimeout) {
      clearTimeout(activeConnectingTimeout);
      activeConnectingTimeout = null;
    }
    
    // Đợi 2 giây xem acc có bị kick không trước khi tiếp tục hàng đợi
    activeConnectingTimeout = setTimeout(() => {
      activeConnectingTimeout = null;
      const activeBot = activeBots[username];
      if (activeBot && activeBot.bot && activeBot.state === 'online') {
        logToWeb(username, `[Reconnect Queue] Không bị kick sau 2s. Tiến hành kết nối acc tiếp theo...`, 'system');
        activeConnectingBot = null;
        processReconnectQueue();
      } else {
        logToWeb(username, `[Reconnect Queue] Bot đã ngắt kết nối hoặc bị kick trong vòng 2s. Tiến hành chạy acc tiếp theo...`, 'warning');
        activeConnectingBot = null;
        processReconnectQueue();
      }
    }, 2000);
  }
}

function processReconnectQueue() {
  if (activeConnectingBot) {
    // Có bot đang trong tiến trình kết nối và chưa vào cụm, đợi bot này hoàn tất hoặc hết thời gian chờ
    return;
  }
  
  if (reconnectQueue.length === 0) {
    return;
  }
  
  const nextBot = reconnectQueue.shift();
  const { username, password } = nextBot;
  
  // Kiểm tra nếu bot đã bị tắt thủ công hoặc chuyển sang offline
  const activeBot = activeBots[username];
  if (!activeBot || activeBot.state === 'offline') {
    processReconnectQueue();
    return;
  }
  
  logToWeb(username, `[Reconnect Queue] Đến lượt kết nối trong hàng đợi. Bắt đầu kết nối...`, 'system');
  activeConnectingBot = username;
  
  // Đặt giới hạn thời gian chờ an toàn (Safety timeout) là 30 giây
  if (activeConnectingTimeout) clearTimeout(activeConnectingTimeout);
  activeConnectingTimeout = setTimeout(() => {
    logToWeb(username, `[Reconnect Queue] Quá thời gian chờ vào cụm (30s). Tiến hành chuyển sang kết nối acc tiếp theo...`, 'warning');
    activeConnectingTimeout = null;
    activeConnectingBot = null;
    processReconnectQueue();
  }, 30000);
  
  startBotInstance(username, password);
}

// Helper: Trích xuất chuỗi từ cấu trúc NBT Chat Component (Hỗ trợ đệ quy sâu)
function extractTextFromNbt(val) {
  if (val === null || val === undefined) return '';
  
  if (typeof val === 'string') {
    let trimmed = val.trim();
    if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
      try {
        return extractTextFromNbt(JSON.parse(trimmed));
      } catch (e) {}
    }
    return val;
  }
  
  if (typeof val === 'number' || typeof val === 'boolean') return String(val);
  
  if (typeof val === 'object') {
    // Nếu là NBT tag có type và value
    if (val.type !== undefined && val.value !== undefined) {
      return extractTextFromNbt(val.value);
    }
    
    // Nếu là ChatMessage (đối tượng Mineflayer)
    if (typeof val.toString === 'function' && val.constructor && val.constructor.name === 'ChatMessage') {
      const str = val.toString();
      if (str && str !== '[object Object]' && !str.includes('[object Object]')) {
        return str;
      }
    }
    
    // Nếu là mảng
    if (Array.isArray(val)) {
      return val.map(item => extractTextFromNbt(item)).join('');
    }
    
    // Nếu là NBT compound hoặc Chat JSON
    let result = '';
    const isContainerTranslate = typeof val.translate === 'string' && val.translate.startsWith('container.');
    
    if (val.text !== undefined) result += extractTextFromNbt(val.text);
    
    // Bỏ qua dịch container template nếu có 'with' đi kèm để tránh lặp container.chest
    if (val.translate !== undefined && !(isContainerTranslate && val.with !== undefined)) {
      result += extractTextFromNbt(val.translate);
    }
    
    if (val.with !== undefined) result += extractTextFromNbt(val.with);
    if (val.extra !== undefined) result += extractTextFromNbt(val.extra);
    if (val.keybind !== undefined) result += extractTextFromNbt(val.keybind);
    if (val.selector !== undefined) result += extractTextFromNbt(val.selector);
    
    if (result) return result;
    
    // Fallback: toString() nếu chuỗi thu được không chứa [object Object]
    if (typeof val.toString === 'function') {
      const str = val.toString();
      if (str && str !== '[object Object]' && !str.includes('[object Object]')) {
        return str;
      }
    }
  }
  return '';
}

// Helper: Loại bỏ các ký tự mã màu Minecraft (ví dụ: §c, §l)
function stripMinecraftCodes(str) {
  if (typeof str !== 'string') return String(str);
  return str.replace(/§[0-9a-fk-or]/gi, '');
}

// Helper: Làm sạch tin nhắn chat/kick/GUI của Minecraft để hiển thị chuỗi thuần túy
function cleanMinecraftChat(chat) {
  if (!chat) return '';
  return stripMinecraftCodes(extractTextFromNbt(chat));
}

// Helper: Dọn dẹp chuỗi [object Object] lỗi do Mineflayer/server serialize
function removeObjectObject(str) {
  if (!str) return '';
  return str
    .replace(/\[object Object\]/gi, '')
    .replace(/\(\s*\)/g, '')
    .replace(/\{\s*\}/g, '')
    .replace(/\[\s*\]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// Helper: Làm sạch tiêu đề GUI Minecraft
function cleanWindowTitle(title) {
  if (!title) return 'GUI Menu';
  
  let rawText = '';
  if (typeof title === 'string') {
    let trimmed = title.trim();
    if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
      try {
        const parsed = JSON.parse(trimmed);
        rawText = extractTextFromNbt(parsed);
      } catch (e) {
        rawText = title;
      }
    } else {
      rawText = title;
    }
  } else {
    rawText = extractTextFromNbt(title);
  }
  
  return removeObjectObject(cleanMinecraftChat(rawText)) || 'GUI Menu';
}

// Helper tìm display.Name đệ quy từ NBT
function getCustomNameFromNbt(nbt) {
  if (!nbt) return null;
  
  // 1. Dạng raw NBT của prismarine-nbt
  if (nbt.value && typeof nbt.value === 'object') {
    const displayTag = nbt.value.display;
    if (displayTag && displayTag.value && typeof displayTag.value === 'object') {
      const nameTag = displayTag.value.Name || displayTag.value.name;
      if (nameTag && nameTag.value !== undefined) {
        return nameTag.value;
      }
    }
  }
  
  // 2. Dạng simplified NBT
  if (nbt.display && typeof nbt.display === 'object') {
    const nameVal = nbt.display.Name || nbt.display.name;
    if (nameVal !== undefined) {
      if (nameVal && typeof nameVal === 'object' && nameVal.value !== undefined) {
        return nameVal.value;
      }
      return nameVal;
    }
  }
  
  // 3. Fallback đệ quy
  return findDisplayCustomName(nbt);
}

function findDisplayCustomName(obj) {
  if (!obj || typeof obj !== 'object') return null;
  
  const display = obj.display || obj.Display;
  if (display !== undefined) {
    if (display && typeof display === 'object') {
      const displayVal = (display.type && display.value !== undefined) ? display.value : display;
      if (displayVal && typeof displayVal === 'object') {
        const nameObj = displayVal.Name || displayVal.name;
        if (nameObj !== undefined) {
          if (nameObj && typeof nameObj === 'object' && nameObj.value !== undefined) {
            return nameObj.value;
          }
          return nameObj;
        }
      }
    }
  }
  
  if (Array.isArray(obj)) {
    for (const item of obj) {
      const res = findDisplayCustomName(item);
      if (res) return res;
    }
  } else {
    for (const key in obj) {
      if (obj[key] && typeof obj[key] === 'object') {
        const res = findDisplayCustomName(obj[key]);
        if (res) return res;
      }
    }
  }
  return null;
}

// Helper: Trích xuất mảng Lore (mô tả) từ NBT của vật phẩm
function getItemLoreFromNbt(nbt) {
  if (!nbt) return [];

  let loreList = null;

  // 1. Dạng raw NBT của prismarine-nbt
  if (nbt.value && typeof nbt.value === 'object') {
    const displayTag = nbt.value.display || nbt.value.Display;
    if (displayTag && displayTag.value && typeof displayTag.value === 'object') {
      const loreTag = displayTag.value.Lore || displayTag.value.lore;
      if (loreTag && loreTag.value && loreTag.value.value) {
        loreList = loreTag.value.value;
      } else if (loreTag && Array.isArray(loreTag.value)) {
        loreList = loreTag.value;
      }
    }
  }

  // 2. Dạng simplified NBT
  if (!loreList) {
    const displayObj = nbt.display || nbt.Display;
    if (displayObj && typeof displayObj === 'object') {
      const loreTag = displayObj.Lore || displayObj.lore;
      if (Array.isArray(loreTag)) {
        loreList = loreTag;
      }
    }
  }

  // 3. Fallback đệ quy
  if (!loreList) {
    loreList = findLoreInObj(nbt);
  }

  if (!Array.isArray(loreList)) return [];

  return loreList.map(line => {
    let rawLine = line;
    if (line && typeof line === 'object') {
      rawLine = line.value !== undefined ? line.value : JSON.stringify(line);
    }
    const extracted = extractTextFromNbt(rawLine);
    return cleanMinecraftChat(extracted);
  }).filter(Boolean);
}

function findLoreInObj(obj) {
  if (!obj || typeof obj !== 'object') return null;

  const display = obj.display || obj.Display;
  if (display !== undefined) {
    if (display && typeof display === 'object') {
      const displayVal = (display.type && display.value !== undefined) ? display.value : display;
      if (displayVal && typeof displayVal === 'object') {
        const lore = displayVal.Lore || displayVal.lore;
        if (lore !== undefined) {
          if (lore && typeof lore === 'object' && lore.value !== undefined) {
            return lore.value.value || lore.value;
          }
          return lore;
        }
      }
    }
  }

  if (Array.isArray(obj)) {
    for (const item of obj) {
      const res = findLoreInObj(item);
      if (res) return res;
    }
  } else {
    for (const key in obj) {
      if (obj[key] && typeof obj[key] === 'object') {
        const res = findLoreInObj(obj[key]);
        if (res) return res;
      }
    }
  }
  return null;
}

const MC_COLORS = {
  'black': '#000000',
  'dark_blue': '#0000aa',
  'dark_green': '#00aa00',
  'dark_aqua': '#00aaaa',
  'dark_red': '#aa0000',
  'dark_purple': '#aa00aa',
  'gold': '#ffaa00',
  'gray': '#aaaaaa',
  'dark_gray': '#555555',
  'blue': '#5555ff',
  'green': '#55ff55',
  'aqua': '#55ffff',
  'red': '#ff5555',
  'light_purple': '#ff55ff',
  'yellow': '#ffff55',
  'white': '#ffffff'
};

const MC_CODE_TO_COLOR = {
  '0': 'black',
  '1': 'dark_blue',
  '2': 'dark_green',
  '3': 'dark_aqua',
  '4': 'dark_red',
  '5': 'dark_purple',
  '6': 'gold',
  '7': 'gray',
  '8': 'dark_gray',
  '9': 'blue',
  'a': 'green',
  'b': 'aqua',
  'c': 'red',
  'd': 'light_purple',
  'e': 'yellow',
  'f': 'white'
};

function parseMcCodes(text, initialStyle = {}) {
  if (typeof text !== 'string') return [{ text: String(text), style: initialStyle }];

  const segments = [];
  let currentStyle = { ...initialStyle };
  let activeText = '';

  function commitSegment() {
    if (activeText) {
      segments.push({ text: activeText, style: { ...currentStyle } });
      activeText = '';
    }
  }

  for (let i = 0; i < text.length; i++) {
    if (text[i] === '§' && i + 1 < text.length) {
      const code = text[i + 1].toLowerCase();
      commitSegment();
      
      if (MC_CODE_TO_COLOR[code] !== undefined) {
        currentStyle.color = MC_CODE_TO_COLOR[code];
        currentStyle.bold = false;
        currentStyle.italic = false;
        currentStyle.underlined = false;
        currentStyle.strikethrough = false;
        currentStyle.obfuscated = false;
      } else if (code === 'k') {
        currentStyle.obfuscated = true;
      } else if (code === 'l') {
        currentStyle.bold = true;
      } else if (code === 'm') {
        currentStyle.strikethrough = true;
      } else if (code === 'n') {
        currentStyle.underlined = true;
      } else if (code === 'o') {
        currentStyle.italic = true;
      } else if (code === 'r') {
        currentStyle = {
          color: initialStyle.color || null,
          bold: initialStyle.bold || false,
          italic: initialStyle.italic || false,
          underlined: initialStyle.underlined || false,
          strikethrough: initialStyle.strikethrough || false,
          obfuscated: initialStyle.obfuscated || false
        };
      } else {
        activeText += '§' + text[i + 1];
      }
      i++;
    } else {
      activeText += text[i];
    }
  }
  commitSegment();
  return segments;
}

function segmentsToHtml(segments) {
  return segments.map(seg => {
    if (!seg.text) return '';
    let styles = [];
    let classes = [];
    
    if (seg.style.color) {
      const hex = MC_COLORS[seg.style.color] || (seg.style.color.startsWith('#') ? seg.style.color : null);
      if (hex) {
        styles.push(`color: ${hex}`);
      }
    }
    
    if (seg.style.bold) styles.push('font-weight: bold');
    if (seg.style.italic) styles.push('font-style: italic');
    
    let textDec = [];
    if (seg.style.underlined) textDec.push('underline');
    if (seg.style.strikethrough) textDec.push('line-through');
    if (textDec.length > 0) styles.push(`text-decoration: ${textDec.join(' ')}`);
    
    if (seg.style.obfuscated) {
      classes.push('mc-obfuscated');
    }
    
    const styleAttr = styles.length > 0 ? ` style="${styles.join('; ')}"` : '';
    const classAttr = classes.length > 0 ? ` class="${classes.join(' ')}"` : '';
    
    const escapedText = seg.text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
      
    if (styleAttr || classAttr) {
      return `<span${classAttr}${styleAttr}>${escapedText}</span>`;
    }
    return escapedText;
  }).join('');
}

function parseMcComponent(component, parentStyle = {}) {
  if (component === null || component === undefined) return [];

  if (typeof component === 'string' || typeof component === 'number' || typeof component === 'boolean') {
    if (typeof component === 'string') {
      const trimmed = component.trim();
      if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
        try {
          return parseMcComponent(JSON.parse(trimmed), parentStyle);
        } catch (e) {}
      }
    }
    return parseMcCodes(String(component), parentStyle);
  }

  if (typeof component === 'object' && component.type !== undefined && component.value !== undefined) {
    return parseMcComponent(component.value, parentStyle);
  }

  if (Array.isArray(component)) {
    let result = [];
    for (const sub of component) {
      result = result.concat(parseMcComponent(sub, parentStyle));
    }
    return result;
  }

  if (typeof component === 'object') {
    const currentStyle = {
      color: component.color !== undefined ? component.color : parentStyle.color,
      bold: component.bold !== undefined ? !!component.bold : parentStyle.bold,
      italic: component.italic !== undefined ? !!component.italic : parentStyle.italic,
      underlined: component.underlined !== undefined ? !!component.underlined : parentStyle.underlined,
      strikethrough: component.strikethrough !== undefined ? !!component.strikethrough : parentStyle.strikethrough,
      obfuscated: component.obfuscated !== undefined ? !!component.obfuscated : parentStyle.obfuscated
    };

    let result = [];

    if (component.text !== undefined) {
      result = result.concat(parseMcComponent(component.text, currentStyle));
    }
    if (component.translate !== undefined) {
      result = result.concat(parseMcComponent(component.translate, currentStyle));
    }
    if (component.with !== undefined) {
      result = result.concat(parseMcComponent(component.with, currentStyle));
    }
    if (component.extra !== undefined) {
      result = result.concat(parseMcComponent(component.extra, currentStyle));
    }

    return result;
  }

  return [];
}

function mcComponentToHtml(component) {
  const segments = parseMcComponent(component);
  return segmentsToHtml(segments);
}

function getItemDisplayNameHtml(item) {
  if (!item) return '';

  const customNameRaw = getCustomNameFromNbt(item.nbt);
  if (customNameRaw) {
    const html = mcComponentToHtml(customNameRaw);
    if (html && !html.includes('[object Object]')) {
      return html;
    }
  }

  if (item.displayName) {
    return mcComponentToHtml(item.displayName);
  }

  if (item.name) {
    const formatted = item.name
      .split('_')
      .map(word => word.charAt(0).toUpperCase() + word.slice(1))
      .join(' ');
    return mcComponentToHtml(formatted);
  }

  return 'unknown';
}

function getItemLoreHtmlFromNbt(nbt) {
  if (!nbt) return [];

  let loreList = null;

  if (nbt.value && typeof nbt.value === 'object') {
    const displayTag = nbt.value.display || nbt.value.Display;
    if (displayTag && displayTag.value && typeof displayTag.value === 'object') {
      const loreTag = displayTag.value.Lore || displayTag.value.lore;
      if (loreTag && loreTag.value && loreTag.value.value) {
        loreList = loreTag.value.value;
      } else if (loreTag && Array.isArray(loreTag.value)) {
        loreList = loreTag.value;
      }
    }
  }

  if (!loreList) {
    const displayObj = nbt.display || nbt.Display;
    if (displayObj && typeof displayObj === 'object') {
      const loreTag = displayObj.Lore || displayObj.lore;
      if (Array.isArray(loreTag)) {
        loreList = loreTag;
      }
    }
  }

  if (!loreList) {
    loreList = findLoreInObj(nbt);
  }

  if (!Array.isArray(loreList)) return [];

  return loreList.map(line => {
    let rawLine = line;
    if (line && typeof line === 'object') {
      rawLine = line.value !== undefined ? line.value : line;
    }
    return mcComponentToHtml(rawLine);
  });
}

// Helper: Trích xuất tên hiển thị thân thiện/Custom Name của vật phẩm
function getItemDisplayName(item) {
  if (!item) return '';

  // 1. Sử dụng getter customName có sẵn của prismarine-item (phương thức chuẩn)
  if (item.customName) {
    const extracted = extractTextFromNbt(item.customName);
    if (extracted && !extracted.includes('[object Object]')) {
      return cleanMinecraftChat(extracted);
    }
  }

  // 2. Dự phòng tìm display.Name đệ quy từ NBT tag
  const customNameRaw = getCustomNameFromNbt(item.nbt);
  if (customNameRaw) {
    const extracted = extractTextFromNbt(customNameRaw);
    if (extracted && !extracted.includes('[object Object]')) {
      return cleanMinecraftChat(extracted);
    }
  }

  // 3. Fallback sang displayName (tên hiển thị thân thiện mặc định, ví dụ "Diamond Sword")
  if (item.displayName) {
    return cleanMinecraftChat(item.displayName);
  }

  // 4. Fallback cuối cùng sang tên format đẹp (ví dụ "diamond_sword" -> "Diamond Sword")
  if (item.name) {
    return item.name
      .split('_')
      .map(word => word.charAt(0).toUpperCase() + word.slice(1))
      .join(' ');
  }

  return 'unknown';
}

// Biến lưu mốc thời gian ghi log debug scoreboard tránh spam console
let lastScoreboardLogTime = {};

// Helper: Chuyển đổi các ký tự unicode dạng Small Caps (chữ viết hoa nhỏ) về chữ thường chuẩn ASCII
function normalizeSmallCaps(str) {
  if (!str) return '';
  const map = {
    'ᴀ': 'a', 'ʙ': 'b', 'ᴄ': 'c', '─': '-', 'ᴅ': 'd', 'ᴇ': 'e', 'ꜰ': 'f', 'ɢ': 'g', 'ʜ': 'h', 'ɪ': 'i', 'ᴊ': 'j', 'ᴋ': 'k', 'ʟ': 'l', 'ᴍ': 'm', 'ɴ': 'n', 'ᴏ': 'o', 'ᴘ': 'p', 'ǫ': 'q', 'ʀ': 'r', 'ꜱ': 's', 'ᴛ': 't', 'ᴜ': 'u', 'ᴠ': 'v', 'ᴡ': 'w', 'x': 'x', 'ʏ': 'y', 'ᴢ': 'z'
  };
  return str.split('').map(char => map[char] || char).join('');
}

// Helper: Trích xuất số tiền từ bảng điểm Scoreboard của bot
function getBotMoneyFromScoreboard(bot) {
  if (!bot || !bot.customScoreboard) return null;

  // Từ khóa mở rộng để nhận diện dòng tiền tệ trong bảng điểm
  const keywords = ['money', 'xu', 'tiền', 'coins', 'coin', 'bal', 'balance', 'sodu', 'số dư', 'tài sản', 'purse', 'point', 'points', 'gem', 'gems', 'đang có', '$', '💵', '💰', '₫', 'vnd'];

  const custom = bot.customScoreboard;

  // Duyệt qua các objective trong custom scoreboard nhận từ packet
  for (const objName in custom.objectives) {
    const objective = custom.objectives[objName];
    if (objective && objective.scores) {
      for (const itemName in objective.scores) {
        let lineText = '';
        const teamName = custom.playerToTeam[itemName];
        if (teamName && custom.teams[teamName]) {
          const team = custom.teams[teamName];
          lineText = team.prefix + itemName + team.suffix;
        } else {
          lineText = itemName;
        }

        // Làm sạch và chuẩn hóa chữ hoa nhỏ (Small Caps) thành chữ thường ASCII chuẩn
        const cleanLine = lineText.replace(/§[0-9a-fk-or]/gi, '').trim();
        const normalizedLine = normalizeSmallCaps(cleanLine.toLowerCase());

        const hasKeyword = keywords.some(kw => normalizedLine.includes(kw));
        if (hasKeyword) {
          // Trích xuất số (ví dụ: "15,000", "15000", "150.000")
          const matches = cleanLine.match(/(?:[0-9]{1,3}(?:[,.][0-9]{3})+|[0-9]+)/);
          if (matches && matches[0]) {
            return matches[0].trim();
          }
        }
      }
    }
  }

  // 3. Ghi log debug chi tiết ra tệp tin khi không tìm thấy số tiền (10 giây/lần mỗi bot để tránh spam)
  const now = Date.now();
  if (bot.username && (!lastScoreboardLogTime[bot.username] || now - lastScoreboardLogTime[bot.username] > 10000)) {
    lastScoreboardLogTime[bot.username] = now;
    
    try {
      let debugText = `================ CUSTOM SCOREBOARD DEBUG FOR ${bot.username} AT ${new Date().toLocaleString()} ================\n`;
      debugText += `Objectives: ${JSON.stringify(Object.keys(custom.objectives))}\n`;
      debugText += `Teams count: ${Object.keys(custom.teams).length}\n\n`;

      for (const objName in custom.objectives) {
        const obj = custom.objectives[objName];
        debugText += `--- Objective: "${objName}" | Title: "${obj.title}" ---\n`;
        const scoresSorted = Object.entries(obj.scores).sort((a, b) => b[1] - a[1]);
        debugText += `Scores count: ${scoresSorted.length}\n`;
        
        for (const [itemName, scoreValue] of scoresSorted) {
          const teamName = custom.playerToTeam[itemName];
          let prefix = '';
          let suffix = '';
          if (teamName && custom.teams[teamName]) {
            prefix = custom.teams[teamName].prefix;
            suffix = custom.teams[teamName].suffix;
          }
          const fullLine = prefix + itemName + suffix;
          const cleanLine = fullLine.replace(/§[0-9a-fk-or]/gi, '');
          const normalizedLine = normalizeSmallCaps(cleanLine.toLowerCase());
          debugText += `  * Key: "${itemName}" | Score Value: ${scoreValue} | Team: "${teamName || 'none'}"\n`;
          debugText += `    - Full Line: "${fullLine}"\n`;
          debugText += `    - Clean Line: "${cleanLine}"\n`;
          debugText += `    - Normalized Line: "${normalizedLine}"\n`;
        }
        debugText += `--------------------------------------------------\n\n`;
      }

      fs.writeFileSync('scoreboard_debug.txt', debugText);
      logToWeb(bot.username, `[Debug Bảng Điểm] Chưa đọc được tiền của bot. Đã ghi thông tin bảng điểm chi tiết vào tệp scoreboard_debug.txt trong thư mục bot!`, 'warning');
    } catch (err) {
      console.error(`[Scoreboard Debug File Error]`, err);
    }
  }

  return null;
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
        money: null,
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
      money: b.money,
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

  // Ở lần chạy đầu tiên (checkAttempt === 1), thực hiện gửi lệnh đăng nhập sau thời gian trễ (loginDelayMs)
  if (checkAttempt === 1) {
    const loginCmd = botConfig.loginCommand.replace(/{password}/g, password);
    const maskedLoginCmd = botConfig.loginCommand.replace(/{password}/g, '********');
    const delay = botConfig.loginDelayMs !== undefined ? botConfig.loginDelayMs : 2000;
    
    logToWeb(username, `Đang chờ ${delay}ms trước khi gửi lệnh đăng nhập...`, 'system');
    
    setTimeout(() => {
      if (!activeBot.bot || activeBot.state !== 'online') return;
      logToWeb(username, `Đang gửi lệnh đăng nhập: ${maskedLoginCmd}`, 'system');
      activeBot.bot.chat(loginCmd);

      // Bắt đầu đếm ngược kiểm tra đồng hồ/đăng ký sau khi đã gửi lệnh đăng nhập
      scheduleCheckClock(username, password, 1);
    }, delay);
  } else {
    scheduleCheckClock(username, password, checkAttempt);
  }
}

// Hàm phụ để kiểm tra đồng hồ và tự đăng ký sau khoảng trễ (checkClockDelayMs)
function scheduleCheckClock(username, password, checkAttempt) {
  const activeBot = activeBots[username];
  if (!activeBot || !activeBot.bot || activeBot.state !== 'online') return;

  const botConfig = getBotConfig(readConfig(), username);

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
          onBotEnteredCluster(username);
        }
      } else {
        logToWeb(username, `Chế độ tự động vào cụm đang tắt. Bot kết nối hoàn tất.`, 'system');
        onBotEnteredCluster(username);
      }

    } else {
      // Không thấy đồng hồ
      if (checkAttempt === 1) {
        logToWeb(username, `Không tìm thấy đồng hồ ở hotbar sau ${botConfig.checkClockDelayMs}ms! Đang tiến hành đăng ký...`, 'warning');
        
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

          // Kích hoạt quét hotbar lần 2 sau checkClockDelayMs nữa
          performLoginSequence(username, password, 2);
        }, 2000);
      } else if (checkAttempt === 2) {
        logToWeb(username, `Lần 2 vẫn không thấy đồng hồ. Đang chờ thêm ${botConfig.checkClockDelayMs}ms để quét lần cuối (Lần 3)...`, 'warning');
        performLoginSequence(username, password, 3);
      } else {
        logToWeb(username, `Đã kiểm tra 3 lần vẫn không thấy đồng hồ ở hotbar. Dừng chu kỳ kiểm tra đăng nhập.`, 'error');
        onBotEnteredCluster(username);
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

// Helper: Thực hiện việc nhấn giữ phím di chuyển tự động cho bot
function executeAutoMove(username, activeBot, botConfig) {
  const delay = botConfig.macroMoveDelayMs !== undefined ? botConfig.macroMoveDelayMs : 1000;
  const direction = botConfig.macroMoveDirection || 'forward';
  const duration = botConfig.macroMoveDurationMs !== undefined ? botConfig.macroMoveDurationMs : 2000;

  logToWeb(username, `[Macro] Lên lịch di chuyển: chờ ${delay}ms -> đi hướng [${direction}] trong ${duration}ms`, 'system');

  setTimeout(() => {
    if (!activeBot.bot || activeBot.state !== 'online') return;
    
    logToWeb(username, `[Macro] Bắt đầu di chuyển hướng: [${direction}]`, 'system');
    try {
      activeBot.bot.setControlState(direction, true);
    } catch (err) {
      logToWeb(username, `[Macro] Lỗi bắt đầu di chuyển: ${err.message}`, 'error');
    }

    setTimeout(() => {
      if (!activeBot.bot) return;
      logToWeb(username, `[Macro] Dừng di chuyển hướng: [${direction}]`, 'system');
      try {
        activeBot.bot.setControlState(direction, false);
      } catch (err) {
        logToWeb(username, `[Macro] Lỗi dừng di chuyển: ${err.message}`, 'error');
      }
    }, duration);

  }, delay);
}

// Helper: Kiểm tra và kích hoạt Macro khi có từ khóa xuất hiện trong chat/system message
function checkMacroTrigger(username, message) {
  const activeBot = activeBots[username];
  if (!activeBot || !activeBot.bot || activeBot.state !== 'online') return;

  const botConfig = getBotConfig(readConfig(), username);
  if (!botConfig.macroEnabled) return;

  const messageLower = message.toLowerCase();

  // 1. Kiểm tra nếu đang trong trạng thái chờ từ khóa di chuyển
  if (activeBot.waitingForMoveKeyword && botConfig.macroMoveEnabled && botConfig.macroMoveTriggerType === 'keyword') {
    const triggerKeyword = (botConfig.macroMoveTriggerKeyword || '').toLowerCase();
    if (triggerKeyword && messageLower.includes(triggerKeyword)) {
      activeBot.waitingForMoveKeyword = false;
      if (activeBot.macroMoveTimeout) clearTimeout(activeBot.macroMoveTimeout);
      logToWeb(username, `[Macro] Phát hiện từ khóa kích hoạt di chuyển: "${botConfig.macroMoveTriggerKeyword}"`, 'system');
      executeAutoMove(username, activeBot, botConfig);
      return; // Dừng tại đây, không kiểm tra tiếp macro chính
    }
  }

  // 2. Kiểm tra từ khóa kích hoạt macro chính
  if (!botConfig.macroKeyword) return;
  const keyword = botConfig.macroKeyword.toLowerCase();
  if (messageLower.includes(keyword)) {
    logToWeb(username, `[Macro] Phát hiện từ khóa kích hoạt: "${botConfig.macroKeyword}"`, 'system');

    // Gửi lệnh phản hồi
    if (botConfig.macroCommand) {
      const password = readConfig().bots.find(b => b.username === username)?.password || '';
      const command = botConfig.macroCommand.replace(/{password}/g, password);
      const maskedCommand = botConfig.macroCommand.replace(/{password}/g, '********');
      logToWeb(username, `[Macro] Gửi lệnh phản hồi: ${maskedCommand}`, 'system');
      activeBot.bot.chat(command);
    }

    // Lên lịch di chuyển tự động
    if (botConfig.macroMoveEnabled) {
      const triggerType = botConfig.macroMoveTriggerType || 'delay';
      if (triggerType === 'keyword' && botConfig.macroMoveTriggerKeyword) {
        logToWeb(username, `[Macro] Đang chờ từ khóa di chuyển: "${botConfig.macroMoveTriggerKeyword}" xuất hiện trong chat...`, 'system');
        activeBot.waitingForMoveKeyword = true;

        // Đặt timeout 1 phút để tránh treo trạng thái chờ vô thời hạn
        if (activeBot.macroMoveTimeout) clearTimeout(activeBot.macroMoveTimeout);
        activeBot.macroMoveTimeout = setTimeout(() => {
          if (activeBot.waitingForMoveKeyword) {
            activeBot.waitingForMoveKeyword = false;
            logToWeb(username, `[Macro] Đã quá thời gian chờ từ khóa di chuyển (60s). Hủy di chuyển.`, 'warning');
          }
        }, 60000);
      } else {
        // Mặc định chạy theo thời gian chờ (delay) sau lệnh
        executeAutoMove(username, activeBot, botConfig);
      }
    }
  }
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

      // Khởi tạo bảng điểm tùy biến để khắc phục lỗi tương thích 1.20.4 của Mineflayer
      bot.customScoreboard = {
        objectives: {},
        teams: {},
        playerToTeam: {}
      };

      // Đăng ký lắng nghe gói tin ngay lập tức để không bỏ lỡ các gói tin trước spawn
      bot._client.on('packet', (data, metadata) => {
        const name = metadata.name;
        
        // 1. Nhận objective
        if (name === 'scoreboard_objective') {
          const { name: objName, action, displayText } = data;
          if (action === 0) { // Create
            bot.customScoreboard.objectives[objName] = {
              title: extractTextFromNbt(displayText) || objName,
              scores: {}
            };
          } else if (action === 1) { // Remove
            delete bot.customScoreboard.objectives[objName];
          } else if (action === 2) { // Update title
            if (bot.customScoreboard.objectives[objName]) {
              bot.customScoreboard.objectives[objName].title = extractTextFromNbt(displayText) || objName;
            }
          }
        }
        
        // 2. Nhận điểm số (Score)
        else if (name === 'scoreboard_score') {
          const { itemName, scoreName, value, action } = data;
          const isSet = action === 0 || action === undefined;
          const isRemove = action === 1;
          
          if (isSet) {
            if (bot.customScoreboard.objectives[scoreName]) {
              bot.customScoreboard.objectives[scoreName].scores[itemName] = value;
            }
          } else if (isRemove) {
            if (bot.customScoreboard.objectives[scoreName]) {
              delete bot.customScoreboard.objectives[scoreName].scores[itemName];
            }
          }
        }
        
        // 3. Reset điểm số (Minecraft 1.20.3+)
        else if (name === 'reset_score') {
          const { itemName, objectiveName } = data;
          if (objectiveName) {
            if (bot.customScoreboard.objectives[objectiveName]) {
              delete bot.customScoreboard.objectives[objectiveName].scores[itemName];
            }
          } else {
            for (const objName in bot.customScoreboard.objectives) {
              delete bot.customScoreboard.objectives[objName].scores[itemName];
            }
          }
        }
        
        // 4. Nhận thông tin Teams
        else if (name === 'teams' || name === 'scoreboard_team') {
          const { team: teamName, mode, prefix, suffix, players } = data;
          
          if (mode === 0) { // Create team
            bot.customScoreboard.teams[teamName] = {
              prefix: extractTextFromNbt(prefix) || '',
              suffix: extractTextFromNbt(suffix) || '',
              players: players || []
            };
            if (players) {
              players.forEach(p => { bot.customScoreboard.playerToTeam[p] = teamName; });
            }
          } else if (mode === 1) { // Remove team
            const team = bot.customScoreboard.teams[teamName];
            if (team && team.players) {
              team.players.forEach(p => { delete bot.customScoreboard.playerToTeam[p]; });
            }
            delete bot.customScoreboard.teams[teamName];
          } else if (mode === 2 || mode === 4) { // Update info
            if (bot.customScoreboard.teams[teamName]) {
              if (prefix !== undefined) bot.customScoreboard.teams[teamName].prefix = extractTextFromNbt(prefix) || '';
              if (suffix !== undefined) bot.customScoreboard.teams[teamName].suffix = extractTextFromNbt(suffix) || '';
            }
          } else if (mode === 3) { // Add players
            if (bot.customScoreboard.teams[teamName]) {
              (players || []).forEach(p => {
                if (!bot.customScoreboard.teams[teamName].players.includes(p)) {
                  bot.customScoreboard.teams[teamName].players.push(p);
                }
                bot.customScoreboard.playerToTeam[p] = teamName;
              });
            }
          } else if (mode === 4) { // Remove players
            if (bot.customScoreboard.teams[teamName]) {
              bot.customScoreboard.teams[teamName].players = bot.customScoreboard.teams[teamName].players.filter(p => !players.includes(p));
              (players || []).forEach(p => { delete bot.customScoreboard.playerToTeam[p]; });
            }
          }
        }
      }); // end bot._client.on('packet', ...)

      // Đăng ký các sự kiện tương tác GUI Window cho bot
      bot.on('windowOpen', (window) => {
        if (!window || window.id === 0) return; // Bỏ qua hòm đồ cá nhân

        const titleText = cleanWindowTitle(window.title);
        logToWeb(username, `Giao diện GUI '${titleText}' được mở (ID: ${window.id}, Slots: ${window.slots.length})`, 'system');

        // Dump slots NBT debug
        try {
          const debugSlots = window.slots.map((item, index) => {
            if (!item) return null;
            return {
              slot: index,
              name: item.name,
              displayName: item.displayName,
              nbt: item.nbt
            };
          }).filter(Boolean);
          fs.writeFileSync('gui_items_debug.json', JSON.stringify(debugSlots, null, 2), 'utf8');
        } catch (e) {
          console.error("Lỗi ghi file debug GUI:", e);
        }

        // Tạo mảng danh sách vật phẩm gửi lên client
        const items = window.slots.map((item, index) => {
          if (!item) return null;
          return {
            slot: index,
            name: item.name,
            displayName: getItemDisplayName(item),
            displayNameHtml: getItemDisplayNameHtml(item),
            count: item.count,
            lore: getItemLoreFromNbt(item.nbt),
            loreHtml: getItemLoreHtmlFromNbt(item.nbt),
            nbt: item.nbt
          };
        }).filter(Boolean);

        console.log(`[DEBUG GUI ITEMS] Bot ${username} opened GUI. First 5 items:`, JSON.stringify(items.slice(0, 5), null, 2));

        io.emit('gui-open', {
          botname: username,
          title: titleText,
          id: window.id,
          slotsCount: window.slots.length,
          items: items
        });

        // Lắng nghe sự kiện cập nhật vật phẩm trong GUI
        window.on('updateSlot', (slotIndex, oldItem, newItem) => {
          if (newItem) {
            console.log(`[DEBUG SLOT UPDATE] Bot ${username} Slot ${slotIndex}: name="${newItem.name}" -> displayName="${getItemDisplayName(newItem)}"`);
          }
          io.emit('gui-update', {
            botname: username,
            id: window.id,
            slotIndex: slotIndex,
            item: newItem ? { 
              name: newItem.name, 
              displayName: getItemDisplayName(newItem), 
              displayNameHtml: getItemDisplayNameHtml(newItem),
              count: newItem.count,
              lore: getItemLoreFromNbt(newItem.nbt),
              loreHtml: getItemLoreHtmlFromNbt(newItem.nbt),
              nbt: newItem.nbt
            } : null
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
              
              if (stepCount < 2) {
                logToWeb(username, `[Auto-Join] Đang gửi click chọn cụm (rương 1).`, 'system');
                onBotEnteredCluster(username);
              }
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
                  logToWeb(username, `[Auto-Join] Đã click rương 2 thành công.`, 'system');
                }
              });
              
              logToWeb(username, `[Auto-Join] Đang gửi click chọn cụm (rương 2).`, 'system');
              onBotEnteredCluster(username);
            }, 500);
          }
        }
      });

      bot.on('windowClose', (window) => {
        if (!window || window.id === 0) return;
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

        // Bỏ qua debugger packet thô vì customScoreboard đã hoạt động tốt

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
        checkMacroTrigger(username, message);
      });

      // Khi bot bị kick
      bot.on('kicked', (reason) => {
        const cleanReason = cleanWindowTitle(reason);
        logToWeb(username, `Bot bị Kick khỏi server. Lý do: ${cleanReason}`, 'warning');
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

        // Nếu bot đang kết nối bị ngắt, giải phóng hàng đợi để các acc tiếp theo kết nối
        if (activeConnectingBot === username) {
          if (activeConnectingTimeout) {
            clearTimeout(activeConnectingTimeout);
            activeConnectingTimeout = null;
          }
          activeConnectingBot = null;
          // Kích hoạt tiến trình hàng đợi ngay lập tức
          processReconnectQueue();
        }

        // Nếu không phải tắt thủ công thì tự động kết nối lại
        if (activeBot.state !== 'offline') {
          activeBot.state = 'connecting';
          emitBotsUpdate();
          
          const reconnectDelay = parseInt(process.env.RECONNECT_DELAY_MS || '10000', 10);
          logToWeb(username, `Sẽ xếp hàng tự động kết nối lại sau ${reconnectDelay / 1000} giây...`, 'system');
          
          if (activeBot.reconnectTimeout) clearTimeout(activeBot.reconnectTimeout);
          activeBot.reconnectTimeout = setTimeout(() => {
            addToReconnectQueue(username, password);
          }, reconnectDelay);
        } else {
          // Đảm bảo xóa khỏi hàng đợi kết nối lại nếu tắt thủ công
          removeFromReconnectQueue(username);
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

  // Đảm bảo xóa khỏi hàng đợi kết nối lại tuần tự
  removeFromReconnectQueue(username);

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
    if (activeBot.bot && activeBot.state === 'online') {
      if (activeBot.bot.entity) {
        activeBot.coords = activeBot.bot.entity.position;
      }
      activeBot.health = activeBot.bot.health;
      activeBot.food = activeBot.bot.food;

      // Cập nhật số tiền từ bảng điểm
      const money = getBotMoneyFromScoreboard(activeBot.bot);
      if (money !== null && money !== activeBot.money) {
        activeBot.money = money;
      }
      
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
          
          bot.macroEnabled = newConfig.macroEnabled;
          bot.macroKeyword = newConfig.macroKeyword;
          bot.macroCommand = newConfig.macroCommand;
          bot.macroMoveEnabled = newConfig.macroMoveEnabled;
          bot.macroMoveDelayMs = newConfig.macroMoveDelayMs;
          bot.macroMoveDirection = newConfig.macroMoveDirection;
          bot.macroMoveDurationMs = newConfig.macroMoveDurationMs;
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
