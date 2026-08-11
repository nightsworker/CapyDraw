# CapyDraw 公會抽籤與 LINE Bot

這個專案維持單一 `index.html` 的 Vanilla HTML/CSS/JavaScript 架構。抽籤資料仍存放在 Firebase Realtime Database 的 `guildDraw/main`；LINE 憑證、群組 ID、玩家綁定與發送動作則只由 Firebase Cloud Functions 處理。

## 新增的後端

Functions v2 部署在 `asia-southeast1`（新加坡），與目前 Realtime Database 位於同一區域：

- `lineWebhook`：驗證 LINE 原始 request body 的 HMAC-SHA256 簽章，只允許第一次成功綁定 claim 正式群組，並處理綁定指令。
- `sendDrawToLine`：驗證 Firebase ID Token 及 `ADMIN_UID`，依 `recordId` 從 RTDB 重讀抽籤紀錄，再用 LINE `textV2` 發送真正 mention。
- `getLineBindings`：供管理者讀取遮罩後的綁定狀態。
- `removeLineBinding`：供管理者解除指定綁定；前端不會直接寫入 `lineBindings`。
- `setDefaultLineGroup`：供 `ADMIN_UID` 管理者明確更換正式 LINE 群組；沒有前端 UI。

LINE 私有資料位於：

- `guildDraw/lineSettings`
- `guildDraw/lineBindings`

## 安裝工具與依賴

需要 Node.js 22、Firebase CLI，以及已啟用計費的 Firebase 專案（Functions v2、Secret Manager 與對外網路呼叫通常需要 Blaze 方案）。

```bash
npm install -g firebase-tools
firebase login
firebase use capydraw-7f7de
npm --prefix functions install
npm --prefix functions test
npm --prefix functions run lint
```

## Firebase Authentication

1. Firebase Console → Authentication → Sign-in method。
2. 啟用 **Google** provider。
3. Authentication → Settings → Authorized domains，加入實際網站網域，例如 `your-name.github.io`。
4. 用網站上方的「使用 Google 登入 LINE 管理」登入一次。
5. 到 Authentication → Users 複製該帳號的 UID，作為 `ADMIN_UID`。只有清單內的 UID 能發 LINE、查看或移除綁定。

原有 `AUTH_PASSWORD` 只保留為舊 UI 操作鎖；LINE 後端不信任它。

## Functions Secret 與非敏感參數

不要把 Channel Access Token 或 Channel Secret 寫入 repo。請在專案根目錄執行：

```bash
firebase functions:secrets:set LINE_CHANNEL_ACCESS_TOKEN
firebase functions:secrets:set LINE_CHANNEL_SECRET
```

CLI 會安全地提示輸入值，畫面不需要也不應把值貼進 `index.html`。

`ALLOWED_ORIGIN` 與 `ADMIN_UID` 使用 `defineString()`，不是 Secret。第一次部署時 Firebase CLI 會提示輸入並建立已被 `.gitignore` 排除的 `functions/.env.capydraw-7f7de`：

```dotenv
ALLOWED_ORIGIN=https://你的正式網站網域
ADMIN_UID=Firebase_Authentication_中的管理者_UID
```

注意：

- `ALLOWED_ORIGIN` 必須是瀏覽器實際送出的 Origin，只含 scheme、host、port，不含路徑與結尾 `/`。GitHub Pages 專案頁通常是 `https://帳號.github.io`，不是完整 repo 路徑。
- 多個 Origin 或管理 UID 可用逗號分隔。
- 不要設定 `*`。用 `file://` 直接開頁面時 Origin 不合法，LINE 管理操作會被後端拒絕；請從正式站或本機 HTTP server 測試，並將該 origin 加入設定。
- 修改 Secret 後，必須重新部署有引用該 Secret 的 Functions。

## 部署

先部署 Functions 與保護 LINE 私有節點的 RTDB rules：

```bash
firebase deploy --only functions
firebase deploy --only database
```

也可一起部署：

```bash
firebase deploy --only functions,database
```

`database.rules.json` 為了相容既有網站，保留 `guildDraw/main` 的公開讀寫行為；`lineBindings` 與 `lineSettings` 對 browser SDK 完全拒絕，只有 Admin SDK 可存取。部署 rules 前仍建議先在 Firebase Console 的 Rules Playground 檢查。

Functions 部署後可確認：

```bash
firebase functions:list
```

## LINE Developers Console

1. 建立或選擇 Messaging API channel。
2. 在 Messaging API 頁籤發行 Channel access token，使用前述 Secret 指令存入 Firebase。
3. 將 Basic settings 中的 Channel secret 以 Secret 指令存入 Firebase。
4. Webhook URL 填入：

   `https://asia-southeast1-capydraw-7f7de.cloudfunctions.net/lineWebhook`

5. 按 Verify，確認回應成功，再啟用 **Use webhook**。
6. 啟用「Allow bot to join group chats」，把官方帳號加入公會群組。
7. 建議關閉 LINE Official Account Manager 的自動回應訊息，避免和綁定回覆同時出現。

`lineWebhook` 不使用 browser CORS。一般群組文字不會設定或覆蓋 `defaultGroupId`；只有在尚未設定正式群組時，第一次實際可建立 binding 的 `綁定/bind` 指令才會用 RTDB transaction claim 該群組。正式群組建立後，其他群組的綁定、綁定狀態與解除綁定指令都會被拒絕。

### 管理員明確更換正式群組

若未來需要換群，先取得新群組的 LINE `groupId`，再由列在 `ADMIN_UID` 的已登入帳號呼叫：

```js
const idToken = await firebase.auth().currentUser.getIdToken();
await fetch("https://asia-southeast1-capydraw-7f7de.cloudfunctions.net/setDefaultLineGroup", {
  method: "POST",
  headers: {
    "Authorization": `Bearer ${idToken}`,
    "Content-Type": "application/json"
  },
  body: JSON.stringify({ groupId: "C0123456789abcdef0123456789abcdef" })
});
```

此 endpoint 同樣限制 `ALLOWED_ORIGIN` 並驗證 Firebase ID Token 與 `ADMIN_UID`。回應只包含 `hasDefaultGroup`，`getLineBindings` 也只回傳是否已有正式群組，兩者都不會向前端公開完整 groupId。換群後，舊群組建立的玩家 binding 不會用於新群組 mention；請在「LINE 設定」解除舊 binding，再讓玩家於新群重新綁定。

## 玩家綁定測試

`guildDraw/main/guildMembers` 的名稱格式是：

```text
LINE 名稱 - 遊戲 ID
```

例如 `Rain - 流鬼` 表示 LINE 名稱是 `Rain`、遊戲 ID 是 `流鬼`。系統只切第一個 ` - `，因此 `台東小米那裡民宿 - 林秉亮 - 大象騎士` 的遊戲 ID 是完整的 `林秉亮 - 大象騎士`。沒有分隔符的舊資料則將整個名稱同時視為 LINE 名稱及遊戲 ID。

玩家可在正式公會群使用：

- `綁定`：讀取本人 LINE group profile displayName，自動完全比對網站中的 LINE 名稱。
- `綁定 Rain` 或 `bind Rain`：手動完全比對 LINE 名稱。
- `綁定狀態`：顯示本人綁定的 LINE 名稱及所有遊戲 ID。
- `解除綁定`：解除本人在目前正式群組下的全部遊戲帳號 binding。
- `綁定清單`、`LINE清單`、`line list`：由後端列出完整綁定摘要。
- `未綁定清單`、`未綁定`：由後端列出尚未綁定的 LINE 名稱與遊戲 ID。

假設名單中有 `Rain - 流鬼`，Rain 可直接輸入 `綁定`，或輸入 `綁定 Rain`。成功回覆：

```text
✅ LINE 綁定完成

Rain
→ 流鬼
```

同一 LINE 名稱可對應多個遊戲 ID，例如 `Chia - 嘻嘻不嘻嘻` 與 `Chia - CC x CC`。一次 `綁定 Chia` 會用同一 LINE userId 建立兩個 canonical player binding。binding 的 Firebase key 仍由完整 `playerName` 產生，因此不會互相覆蓋。

舊 binding 不需 migration。後端會忽略舊 schema 中語意錯誤的 `alias/gameName`，每次都從 canonical `playerName` 重新解析 `lineName/gameId`。玩家重新綁定時，該筆資料會自然更新為新 schema。

## 發送與真正 @mention 測試

1. 至少讓本次船長、守護天使及船艙 4 的玩家都完成綁定，而且綁定與推送使用同一 LINE 群組。
2. 網站輸入原本管理密碼解鎖，並使用列在 `ADMIN_UID` 的 Google 帳號登入。
3. 照原流程抽籤，或從歷史紀錄按「查看」。
4. 按「發送到 LINE」。前端只傳 `recordId`；後端會重讀真正的 history record。
5. 在 LINE 中點擊被標記的名字，應出現該群組成員的 profile，這才是 `textV2` substitution mention，不是普通 `@名字`。

船長與守護天使會顯示「遊戲 ID + 真正 mention」，第四船艙只顯示真正 mention。未綁定玩家會以普通 `@LINE名稱` 顯示，但不會阻止整則訊息發送；網站同時列出 `unboundMembers`。成功後 record 會新增 `lineSentAt`、`lineSendCount` 與 `lastLineSendStatus`。再次發送同一筆紀錄時，前端會先要求確認，但允許補發。

LINE 的真正 mention 要求官方帳號、接收者與所有被 mention 的使用者都在同一群組；單一訊息最多 20 個 mention。本專案每次最多建立 7 個。
