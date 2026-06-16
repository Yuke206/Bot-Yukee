#!/data/data/com.termux/files/usr/bin/bash

# ============================================================
#   Script cài đặt tự động Bot Minecraft trên Termux/Android
# ============================================================

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

echo ""
echo -e "${GREEN}=================================================${NC}"
echo -e "${GREEN}   Bot Minecraft - Cai dat tu dong tren Termux  ${NC}"
echo -e "${GREEN}=================================================${NC}"
echo ""

# Bước 1: Cập nhật packages
echo -e "${YELLOW}[1/5] Dang cap nhat package list...${NC}"
pkg update -y && pkg upgrade -y
echo -e "${GREEN}OK - Cap nhat xong${NC}"
echo ""

# Bước 2: Cài Node.js
echo -e "${YELLOW}[2/5] Dang cai Node.js...${NC}"
pkg install nodejs -y
node --version
npm --version
echo -e "${GREEN}OK - Node.js da cai xong${NC}"
echo ""

# Bước 3: Cấp quyền truy cập bộ nhớ
echo -e "${YELLOW}[3/5] Cap quyen truy cap bo nho trong...${NC}"
termux-setup-storage 2>/dev/null || true
echo -e "${GREEN}OK${NC}"
echo ""

# Bước 4: Copy project từ bộ nhớ điện thoại vào Termux home
echo -e "${YELLOW}[4/5] Copy project bot vao Termux...${NC}"
BOT_SRC="/sdcard/bot"
BOT_DEST="$HOME/bot"

if [ -d "$BOT_SRC" ]; then
    echo "Tim thay thu muc bot tai $BOT_SRC"
    cp -r "$BOT_SRC" "$BOT_DEST"
    echo -e "${GREEN}OK - Da copy xong vao $BOT_DEST${NC}"
else
    echo -e "${RED}KHONG tim thay thu muc bot tai $BOT_SRC${NC}"
    echo -e "  -> Hay copy thu muc 'bot' vao bo nho trong dien thoai (Internal Storage/bot)"
    echo -e "  -> Sau do chay lai script nay"
    exit 1
fi
echo ""

# Bước 5: Cài dependencies
echo -e "${YELLOW}[5/5] Dang cai npm packages (mineflayer, express, socket.io...)${NC}"
cd "$BOT_DEST"
# Xóa node_modules cũ (build từ Windows không tương thích ARM)
rm -rf node_modules package-lock.json
npm install
echo -e "${GREEN}OK - Cai xong toan bo dependencies${NC}"
echo ""

echo -e "${GREEN}=================================================${NC}"
echo -e "${GREEN}   Cai dat hoan tat!${NC}"
echo -e "${GREEN}=================================================${NC}"
echo ""
echo -e "De chay bot:"
echo -e "  ${YELLOW}cd ~/bot && node index.js${NC}"
echo ""
echo -e "Mo trinh duyet vao:"
echo -e "  ${YELLOW}http://localhost:3000${NC}"
echo ""
