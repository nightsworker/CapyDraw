# CapyDraw 公會抽籤與 LINE Bot

這個專案維持單一 `index.html` 的 Vanilla HTML/CSS/JavaScript 架構。抽籤資料仍存放在 Firebase Realtime Database 的 `guildDraw/main`；LINE 憑證、群組 ID、玩家綁定與發送動作則只由 Firebase Cloud Functions 處理。

## 新增的後端

Functions v2 部署在 `asia-southeast1`（新加坡），與目前 Realtime Database 位於同一區域：

- `lineWebhook`：驗證 LINE 原始 request body 的 HMAC-SHA256 簽章；join event 會登記 Bot 已知群組並回覆自我介紹，一般群組事件只更新該群的 `lastSeenAt`，再依優先順序處理 `!` 指令與喵餅人格互動。
- `sendDrawToLine`：驗證 Firebase ID Token 及 `ADMIN_UID`，依 `recordId` 從 RTDB 重讀抽籤紀錄，再用 LINE `textV2` 發送真正 mention。
- `getLineBindings`：供管理者讀取遮罩後的綁定狀態。
- `removeLineBinding`：供管理者解除指定綁定；前端不會直接寫入 `lineBindings`。
- `getLineGroups`：供 `ADMIN_UID` 管理者讀取 Bot 已知群組，只回傳 opaque group key 與遮罩後的 groupId。
- `setDefaultLineGroup`：供 `ADMIN_UID` 管理者從網站明確更換正式 LINE 群組，並安全嘗試搬移可在新群驗證的既有 binding。
- `setLineBotAdmin`：供 `ADMIN_UID` 管理者在網站「LINE 設定」頁，以既有 binding 明確授予或移除 LINE Bot 管理權限。

LINE 私有資料位於：

- `guildDraw/lineSettings`
- `guildDraw/lineBindings`
- `guildDraw/lineObservedMembers`
- `guildDraw/lineGroups`
- `guildDraw/linePersonality`

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
ADMIN_UID=UID_A,UID_B
```

`ADMIN_UID` 支援以逗號分隔多個 Firebase Authentication UID，例如
`ADMIN_UID=UID_A,UID_B`。只有列在 `ADMIN_UID` allowlist 裡的 Google/Firebase 使用者可以執行 LINE 管理功能；只設定單一 UID 時的行為與原本相同。

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

`database.rules.json` 為了相容既有網站，保留 `guildDraw/main` 的公開讀寫行為；`lineBindings`、`lineSettings`、`lineObservedMembers`、`lineGroups` 與 `linePersonality` 對 browser SDK 完全拒絕，只有 Admin SDK 可存取。部署 rules 前仍建議先在 Firebase Console 的 Rules Playground 檢查。

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

`lineWebhook` 不使用 browser CORS。Bot 收到 group join event 時會呼叫 LINE group summary API，將 `groupId`、`groupName`、`pictureUrl`、`joinedAt`、`lastSeenAt` 寫入 server-side `guildDraw/lineGroups/{hashedGroupKey}`；summary 失敗時使用「LINE 群組」作為安全名稱並繼續自我介紹。join 絕不修改 `defaultGroupId`。一般群組 webhook 只更新該群的 `lastSeenAt`，不會每則訊息重新呼叫 summary API。

一般群組文字不會設定或覆蓋 `defaultGroupId`。只有在完全尚未設定正式群組時，第一次實際可建立 binding 的 `!綁定` 指令仍可用 RTDB transaction claim 該群組；正式換群則應使用網站「LINE 設定 → LINE 群組管理」。正式群組建立後，其他群組的 binding/admin 指令都會被拒絕，但既有人格仍維持每群獨立運作。

### 管理員明確更換正式群組

先將 Bot 邀請進候選群組。join webhook 登記成功後，以 `ADMIN_UID` allowlist 中的 Google/Firebase 帳號登入網站，開啟「LINE 設定 → LINE 群組管理」，按「設為正式公會群」。前端只將 `getLineGroups` 回傳的 opaque `groupKey` 傳給既有 `setDefaultLineGroup`，不要求管理員複製或輸入 raw groupId。

兩個 endpoint 都限制 `ALLOWED_ORIGIN`，並驗證 Firebase ID Token 與 `ADMIN_UID`。切換時保存前一個正式群、切換時間與 Firebase 管理員 UID，但不清除舊群資料、binding、observed members、personality state 或 `adminLineUserIds`。

系統會以舊群 binding 的真正 lineUserId 呼叫新群 member profile API。只有新群確實存在該 userId、displayName 與 canonical LINE 名稱完全相同、guild member 仍存在且新群沒有 conflict 時，才以 group-scoped key 新增新群 binding。系統不做 fuzzy、contains、case-insensitive 或移除 `@` 後猜測，也不覆蓋 conflict；舊 binding 永遠保留。

`lineObservedMembers` 與 `linePersonality` 不會從測試群複製。新群 observed members 重新累積；personality `enabled` 未設定時預設為 `true`，cooldown 也使用新群自己的 path。成功搬移 canonical binding 後，LINE Bot admin user-level 權限保持不變，OWNER／GUILD_LEADER 則由新群 binding 自動恢復。

## 玩家綁定測試

`guildDraw/main/guildMembers` 的名稱格式是：

```text
LINE 名稱 - 遊戲 ID
```

例如 `Rain - 流鬼` 表示 LINE 名稱是 `Rain`、遊戲 ID 是 `流鬼`。系統只切第一個 ` - `，因此 `台東小米那裡民宿 - 林秉亮 - 大象騎士` 的遊戲 ID 是完整的 `林秉亮 - 大象騎士`。沒有分隔符的舊資料則將整個名稱同時視為 LINE 名稱及遊戲 ID。

玩家可在正式公會群使用：

- `!綁定`：讀取本人 LINE group profile displayName，自動完全比對網站中的 LINE 名稱。
- `!綁定 Rain`：手動指定 LINE 名稱並完全比對。
- `!狀態`：顯示本人綁定的 LINE 名稱及所有遊戲 ID。
- `!清單`：由後端列出完整綁定摘要。
- `!未綁定`：由後端列出尚未綁定的 LINE 名稱與遊戲 ID。
- `!解除`：只解除本人在目前正式群組下的全部遊戲帳號 binding。
- `!同步`：由 LINE Bot 管理員同步目前正式群組的成員。
- `!說明`：顯示以上正式指令。

LINE Bot 管理員另外可使用：

- `!鎖定`：停止一般會員自行使用 `!綁定`、`!解除`。
- `!解除鎖定`：重新開放會員自行修改綁定。
- `!幫綁 <LINE名稱> [名單名稱]`：以真正 LINE identity 替指定公會名單名稱建立綁定；兩個名稱相同時可省略第二個參數。
- `!幫解除 <LINE名稱>`：只解除指定 LINE 名稱在正式群組中的 binding。

`!` prefix 用來避免一般聊天誤觸 Bot。輸入前後可以有空白；只有以上述 `!` 開頭的正式指令才會進入 command handler。`綁定`、`bind Rain`、`綁定狀態`、`line list`、`解除綁定` 等舊版無 prefix 指令都只視為一般聊天，再依人格、彩蛋與 ambient 規則決定回覆或保持沉默。

綁定採安全的 exact match：LINE profile 的 `displayName` 必須和 `parseMemberName(row).lineName` 完全相同，保留大小寫及 `@`。系統不做 fuzzy、contains、startsWith、大小寫轉換或自動忽略 `@`；例如 `@Hank` 不會配對 `Hank`，`Rain` 也不會配對 `rain`。

假設名單中有 `Rain - 流鬼`，Rain 可直接輸入 `!綁定`，或輸入 `!綁定 Rain`。成功回覆：

```text
✅ LINE 綁定完成

LINE：Rain
遊戲 ID：
• 流鬼
```

同一 LINE 名稱可對應多個遊戲 ID，例如 `Chia - 嘻嘻不嘻嘻` 與 `Chia - CC x CC`。一次 `!綁定 Chia` 會用同一 LINE userId 建立兩個 canonical player binding。binding 的 Firebase key 仍由完整 `playerName` 產生，因此不會互相覆蓋。

舊 binding 不需 migration。後端會忽略舊 schema 中語意錯誤的 `alias/gameName`，每次都從 canonical `playerName` 重新解析 `lineName/gameId`。玩家重新綁定時，該筆資料會自然更新為新 schema。

## 綁定鎖定與管理員代操作

鎖定狀態位於：

```text
guildDraw/lineSettings/bindingLocked
```

只有值嚴格為 `true` 時才視為鎖定；欄位不存在時預設為 `false`，與舊資料相容。鎖定時另外保存 server-side 的 `bindingLockedAt` 與 `bindingLockedBy`，但不會透過管理 API 或 Bot 回覆公開完整 LINE userId。

鎖定只限制一般會員的自助寫入操作。鎖定期間 `!綁定`、`!綁定 <LINE名稱>`、`!解除` 會被拒絕；`!狀態`、`!清單`、`!未綁定`、`!說明` 仍可使用。LINE Bot 管理員仍可執行 `!同步`、`!鎖定`、`!解除鎖定`、`!幫綁` 與 `!幫解除`。管理員自己的 `!綁定`、`!解除` 仍遵守相同鎖定規則，避免操作意圖不明。

所有管理員修改指令都必須在 `defaultGroupId` 執行，並沿用 `guildDraw/lineSettings/adminLineUserIds`，不會拿 Firebase `ADMIN_UID` 和 LINE userId 比較。`!清單` 會顯示目前是「已鎖定」或「開放中」；`!說明` 會依鎖定狀態顯示提示，且只有 LINE Bot 管理員會看到管理員指令區塊。

`!幫綁 <LINE名稱> [名單名稱]` 會將來源 LINE identity 與目標公會名單分開處理。單參數 `!幫綁 Rain` 等價於 `!幫綁 Rain Rain`；雙參數 `!幫綁 Rain Rian` 則以 displayName `Rain` 的真正 LINE userId，綁定所有 canonical `Rian - <遊戲 ID>`。目標名單名稱維持大小寫與 `@` 都敏感的 exact match，不做 fuzzy、contains、case folding、移除 `@` 或 typo 猜測。

管理員也可真正 mention 對方後輸入 `!幫綁 @對方 名單名稱`。此時後端優先採用 `message.mention.mentionees` 中該成員的 userId，並從目前正式群組重新取得 profile，不依文字 displayName 猜 userId。沒有 true mention 時才掃描 LINE 完整群組成員；若帳號權限無法取得完整清單，沿用 `lineObservedMembers` cache。來源名稱找不到或對應多個不同 userId 時一律拒絕，並要求管理員改用 true mention。若任何目標遊戲帳號已綁到其他 userId，也只回報 conflict，不會部分寫入或覆蓋。

`!幫解除 <LINE名稱>` 同樣採 exact match，只刪除目前正式群組中該 `lineName` 的實際 binding，不會解除其他名稱。一般及管理員的綁定、解除成功訊息都會列出 LINE 名稱、每個遊戲 ID 及實際處理數量。

## 群組成員同步與 observed cache

`!同步` 只能由目前 `defaultGroupId` 群組中的 LINE Bot 管理員執行。後端先呼叫 LINE 官方的 [`GET /v2/bot/group/{groupId}/members/ids`](https://developers.line.biz/en/reference/messaging-api/#get-group-member-user-ids)，依 response 的 `next` token 持續傳入 `start`，因此不會假設群組最多 100 人。取得 userId 後，再逐一以 group member profile API 取得最新 `displayName` 並做 exact match。非公會成員會略過，不視為錯誤。

完整群組 member IDs API 只開放 verified 或 premium LINE Official Account。若此 API 回 403，後端只在此情況改用：

```text
guildDraw/lineObservedMembers/{groupId}/{lineUserId}
```

verified webhook 只要帶有 groupId 與 userId，Bot 就會嘗試取得 profile，保存 `lineUserId`、`displayName`、`groupId`、可選的 `pictureUrl`、`firstSeenAt` 與 `lastSeenAt`。不保存訊息本文，也不建立聊天紀錄。fallback 只能同步 Bot 加入後曾產生 webhook、且 profile 仍可取得的成員，所以回覆會明確提示名單可能不完整。404 會回報群組不存在或 Bot 不在群組；429 會要求稍後重試；5xx 或網路錯誤不會誤用 fallback。

同步只會新增 exact match binding，或更新同一 LINE identity 的 metadata。它不會刪除 binding、清空 `lineBindings`，也不會覆蓋已綁到其他 lineUserId 的玩家；這些情況會列入 conflicts 供人工處理。

### 設定 LINE Bot 管理員

Firebase `ADMIN_UID` 與 LINE userId 是不同身份，不能互相比較。先讓目標 LINE 使用者在正式群組完成綁定，再以 `ADMIN_UID` allowlist 中的 Google/Firebase 帳號登入網站，開啟「LINE 設定」。已綁定列會顯示「Bot 管理員」狀態，可直接按「設為管理員」或「解除管理員」；操作前會再次確認，完成後重新讀取整份綁定狀態。同一 LINE userId 對應多個遊戲 ID 時，所有列會顯示相同管理員狀態。未綁定成員不會出現管理員操作按鈕。

前端只把 `getLineBindings` 回傳的 `bindingId` 與目標 `enabled` 狀態傳給既有 `setLineBotAdmin`。後端仍驗證 Firebase ID Token 與 `ADMIN_UID` allowlist，再從 binding 取得 lineUserId，並只在 server-side 更新 `guildDraw/lineSettings/adminLineUserIds/{lineUserId}`；browser 不能直接寫 RTDB。`getLineBindings` 只回傳 `isLineBotAdmin` 與遮罩後的 userId，不會公開完整 lineUserId。不要把完整 lineUserId、Channel Access Token、Channel Secret 或 Authorization header 寫入 repo、前端或 log。

## Miaobing AI

`lineWebhook` 使用官方 `openai` npm package 與 OpenAI Responses API，預設模型為 `gpt-5-mini`。只有群組文字以「喵餅」明確開頭，或 LINE webhook 提供可靠的 Bot true mention metadata 時才會呼叫 AI；一般群聊、圖片、貼圖與既有 `!` command 都不會產生 OpenAI request。正式 command 永遠優先，人格睡覺／喚醒控制也維持既有 routing。

API key 必須使用 Firebase Functions v2 Secret `OPENAI_API_KEY`，只綁定到需要 AI 的 `lineWebhook`。不要把 key 寫入 source、`.env`、README、瀏覽器或 log。Responses request 使用 `store: false`、單輪 input 與 output token 上限，不使用 web search、tools、conversation history 或公會 Firebase 資料注入。

成本保護由 server-side `guildDraw/aiUsage` 管理，browser rules 明確禁止讀寫。系統以雜湊後的 LINE user key 執行每人 10 秒 cooldown、每 60 秒最多 5 次，並用同一個 RTDB transaction 原子保留全 Bot 每個 Asia/Taipei 日最多 500 次的額度。限流、缺少 Secret 或 OpenAI timeout／429／5xx 等錯誤都只回固定安全短訊息，不會把問題全文、API key、Authorization header 或完整 OpenAI error 寫入 usage storage 或 log。

人格 instructions、可注入測試的 mood pool 與 canonical 公會梗分別位於 `functions/lib/miaobingPersona.js` 和 `functions/lib/miaobingJokes.js`。梗可改語氣，但 immutable meaning 不可改；模型不知道的公會事實必須承認不知道，不可捏造成員、規則、歷史或數值。

## 喵餅人格系統

喵餅是住在公會船上的「公會會貓」：嘴上嫌麻煩，實際會把名冊、綁定與管理工作處理好；核心台詞是「會長管人，本喵管會長」。人格內容集中在 `functions/lib/miaobing-personality.js`，`lineWebhook` 只負責依優先順序 routing，不會把 response pools 散落在 webhook。

訊息處理順序固定為：正式 `!command`、人格控制句、`enabled` 檢查、真正 @喵餅、主人／會長 identity、文字包含「喵餅」、strong easter egg、contextual ambient、保持安靜。Command 永遠只進既有 command handler，不會同時觸發聊天回覆；image、sticker、video、audio 與 file 都不做人格回覆。未知 `!` 指令仍由 command handler 回覆並提示 `!說明`。

真正 mention 優先依 LINE webhook 的 `message.mention.mentionees[].isSelf === true` 判斷；若 payload 只有舊式 mention metadata，才以 webhook `destination` 與 mentionee userId 相符作 fallback，不硬編碼 Bot userId。非 true mention 的文字只要包含「喵餅」也視為直接對話。直接互動必定產生候選回覆，但同一使用者有 4 秒防洗版 cooldown，不受 ambient cooldown 影響。

世界觀集中在 `MIAOBING_LORE`：主人為 `Chia - 嘻嘻不嘻嘻 / CC x CC`，現任會長為 `@Hank - 挖系小嗨`，盤子彩蛋目標為 `貳零陸 - 九章伏藏`。特殊人物一律從目前群組的 canonical `lineBindings` 解析，不依 displayName 猜測，也不硬編 LINE userId；同一人物若解析到衝突的多個 userId，就不建立 mention。主人／會長／盤子的身份回答在 binding 可唯一解析時使用 LINE `textV2` true mention，否則只用安全文字或不 mention。

每則已啟用的人格文字都會由 binding 判定 `OWNER`、`GUILD_LEADER` 或 `MEMBER` sender role。主人與會長有各自的 direct、部分 easter egg 與 command flavor pool，缺少特殊 variant 時 fallback 到一般 pool。這只是人格分層，不是授權：`OWNER` 與 `GUILD_LEADER` 不會自動取得 `!同步`、`!鎖定`、`!幫綁` 等權限，管理功能仍只看 `adminLineUserIds`。唯一額外能力是已驗證的主人可和 LINE Bot admin 一樣控制人格總開關。

Ambient 不會對所有聊天隨機插嘴。`罐罐`、`肉泥`、`汪`、`狗狗比較可愛` 等 strong trigger 的候選機率為 100%；疲累、上班、情緒低落、會長、船票、船長與短句中的「貓」為 contextual trigger，候選機率為 20%。主人 alias 短訊息為 30%、長訊息為 10%，`挖系小嗨` 為 28%，含至少兩個平假名／片假名且不超過 50 字的 Japanese candidate 為 8%。Contextual 訊息超過 40 個字元時不觸發。一般 strong/contextual 與上述 ambient 都共用每群 3 分鐘 cooldown。

`盤子`／`小盤子` 合理短句會解析 `貳零陸 - 九章伏藏` 並以真正 textV2 mention 通知；同群真正通知另有 60 秒 cooldown，binding 不存在時只回安全提示且不建立假 mention。`CC` 使用 standalone Unicode token boundary，URL、email、程式宣告與 `ACCC`／`CCCCC` 不會命中。

人格總開關位於 `guildDraw/linePersonality/{groupId}/enabled`，欄位不存在時預設 `true`。只有現有 LINE Bot admin 或 binding 驗證為 Chia 的主人能以「喵餅真的閉嘴」關閉，或以「喵餅我想你了／妳了」喚醒；中間空白與常用標點可忽略。關閉後不執行一般 intent、RNG 或 ambient cooldown 寫入，所有聊天與彩蛋沉默，但正式 command 及其 command flavor 保持可用。未授權者不能改 state；人格已關閉時，未授權喚醒句也不回覆。

Cooldown 只保存 server-side metadata：

```text
guildDraw/linePersonality/{groupId}/lastAmbientReplyAt
guildDraw/linePersonality/{groupId}/lastMentionReplyAt/{hashedUserKey}
guildDraw/linePersonality/{groupId}/lastPlateMentionAt
guildDraw/linePersonality/{groupId}/enabled
```

前三個 cooldown 欄位只存 timestamp；使用者 scope 是 LINE userId 的 SHA-256 截短 key，不保存原始 userId。系統不保存訊息全文、聊天記錄或觸發文字，production log 也只記錄 `kind`、`intent` 或 control 類型，不記錄 message、groupId 或 userId。`database.rules.json` 禁止 browser 讀寫整個 `linePersonality` path。

第一版完全使用 ordered keyword rules、集中 response pools 與可注入 RNG，沒有串接 AI／LLM、沒有外部模型 dependency，也沒有新增 Secret。Intent 判定會先處理情緒低落、狗比貓可愛、被嫌吵等高優先規則，避免被較一般的「謝謝」或「可愛」誤判。Asia/Taipei 01:00–05:59 只有在原本已決定回覆後，才有 30% 機率採用夜間台詞，不會因時間到主動發訊息。

Command 的原始結構化結果不變，再以 80% 機率加入簡短 opening，少數綁定成功訊息另有 closing。成功時先依 binding-based sender role 選主人／會長 command pool，再 fallback 一般 pool；錯誤仍使用原本的 failure/not-found/locked pool。人格 role 不參與 command authorization。測試可以注入固定 RNG，因此不依賴 `Math.random()` 的結果。

要擴充人格時，在 `MIAOBING_RESPONSES` 增加集中管理的 phrase pool，並在 ordered `INTENT_RULES` 加入 intent/keyword；需要 ambient 的 intent 再加入 `STRONG_INTENTS` 或 `CONTEXTUAL_INTENTS`。Contextual 機率由 `AMBIENT_CONTEXTUAL_PROBABILITY` 調整，cooldown 由 `AMBIENT_COOLDOWN_MS` 與 `DIRECT_MENTION_COOLDOWN_MS` 調整。未來若改接 AI，可以保留 routing 與 cooldown，只替換 `generateDirectMentionReply(context)`。

## 發送與真正 @mention 測試

1. 至少讓本次船長、守護天使及船艙 4 的玩家都完成綁定，而且綁定與推送使用同一 LINE 群組。
2. 網站輸入原本管理密碼解鎖，並使用列在 `ADMIN_UID` 的 Google 帳號登入。
3. 照原流程抽籤，或從歷史紀錄按「查看」。
4. 按「發送到 LINE」。前端只傳 `recordId`；後端會重讀真正的 history record。
5. 在 LINE 中點擊被標記的名字，應出現該群組成員的 profile，這才是 `textV2` substitution mention，不是普通 `@名字`。

船長與守護天使會顯示「遊戲 ID + 真正 mention」，第四船艙只顯示真正 mention。未綁定玩家會以普通 `@LINE名稱` 顯示，但不會阻止整則訊息發送；網站同時列出 `unboundMembers`。成功後 record 會新增 `lineSentAt`、`lineSendCount` 與 `lastLineSendStatus`。再次發送同一筆紀錄時，前端會先要求確認，但允許補發。

LINE 的真正 mention 要求官方帳號、接收者與所有被 mention 的使用者都在同一群組；單一訊息最多 20 個 mention。本專案每次最多建立 7 個。
