# local-codex-bridge-poc 進度

更新時間：2026-08-10

## 目前狀態

**基礎傳輸層已完成且穩定（Gate 2C：PASS）。**

**ChatGPT Web → developer-mode App → Secure MCP Tunnel → localhost MCP → `ping` 的最小端到端 PoC 已完成（Gate 3C2：PASS）。**

**localhost MCP server 的第二個唯讀工具 `echo_query` 已完成實作與純本機驗證（Gate 4A：PASS）。**

**隔離測試資料搜尋工具 `search_second_brain_test` 已完成實作與純本機安全測試（Gate 4B：PASS，file symlink 測試受 Windows 權限限制）。**

**Codex Development Project Inspector 三個唯讀工具已完成實作與純本機安全測試（Gate 4C：PASS，file symlink 測試沿用既有 Windows 權限限制）。**

**`run_codex_prompt` 已以官方 Codex app-server 完成真實 MCP live smoke（Gate 5A：PASS；MCP caller 收到精確 `CODEX_BRIDGE_OK`）。**

**Gate 5B：PASS。ChatGPT 已重新探索七個工具，並透過 Secure MCP Tunnel、local bridge 與官方 Codex app-server 取得精確 `CHATGPT_TO_CODEX_OK`；隨後發生的 ChatGPT 限流未觸發重試，也不影響已完成的 smoke。**

**2026-08-10 目前有效狀態：PoC 正式根目錄、Git root 與 Project Inspector 的唯一 allowlisted root 均為 %BRIDGE_ROOT%。caller 不能覆寫 root；本機與 GPT V3 端到端 Gate 0 均已 PASS。GitHub Preflight Gate 1A／1B 與 history audit 均已完成；本輪公開工作樹候選掃描為 0 個高信心敏感命中。舊 Git 歷史仍含 Tunnel 識別碼與私人 ChatGPT URL，因此尚不可公開推送。下方 fixtures/project 與 %SEPARATE_PROJECT_ROOT% cutover 僅保留為歷史 Gate 證據。**

### 2026-08-10 V3 Gate 0 root remediation

- GPT V3 的 `list_project_files` 外部證據仍列出 `config/settings.json`、`docs/guide.md`、`src/main.py` 與 `package.json`，定位到 current `PROJECT_ROOT` 仍固定為 `fixtures/project/`。
- `PROJECT_ROOT` 已改為由 `mcp-server.mjs` 所在位置解析的實體 Bridge repo root；工具 caller 仍不能提供 root、cwd 或其他路徑邊界參數。
- 頂層 `bin/`、`codex-workspace/`、`downloads/`、`fixtures/`、`runtime/` 與備份檔已明確排除；既有 `.git`、`.env*`、credential／secret、symlink／junction／hard-link、64 KiB 與 UTF-8 防護維持。
- Automated tests：19/19 PASS；新增正式 root 必見項目與敏感／暫態路徑不可見、不可讀回歸案例。
- 修正版 MCP PID `12140`、Tunnel PID `18228`；MCP `/healthz=ok`、七工具完整，Tunnel `/healthz=live`、`/readyz=ready`。
- localhost `list_project_files(depth=2)` 回傳 14 筆，包含 `codex-adapter.mjs`、`PROGRESS.md`、`tests/`；missing 與 forbidden exposure 均為零，`.env.local` 讀取以 `-32602` fail closed。
- 本機 remediation 與 GPT V3 端到端重驗均已 PASS；V3 已確定列出正式 Bridge repo，錯誤目錄問題關閉。

### GitHub Preflight Gate 1：工作樹候選 PASS；公開歷史仍 BLOCKED

- 首次 run_codex_prompt 在外層同步回傳時限前未取得最終報告，該次維持 INCONCLUSIVE；後續改以本機分段檢查完成，不用部分輸出推定結論。
- Gate 1A PASS：repo root 與 main branch 已確認；工作樹原有四個未提交修改均保留，未被覆寫。
- Gate 1B PASS：tracked、untracked-but-not-ignored、ignore rules、敏感檔名、檔案大小與連結類型均已盤點。
- 公開工作樹清理後，共 27 個 Git 候選檔案的高信心敏感內容與敏感檔名掃描均為 0 命中；本機 .env.local、Tunnel executable、runtime tunnel.id、logs 與備份持續被忽略。
- Git history audit 仍找到 2 個含既有 Tunnel 識別碼的 commit，以及 1 個含私人 ChatGPT conversation URL 的 commit；公開推送前必須另行建立乾淨歷史。
- 目前未設定 remote、未選定頂層授權條款，也未 stage、commit 或 push；這些仍是獨立發布 Gate。

### Gate 5A：`run_codex_prompt` PASS

- 新增第七個 MCP tool `run_codex_prompt(prompt: string)`；輸入只允許單一 `prompt`，拒絕額外欄位、空白 prompt 與超過 8,000 字元的 prompt。
- 輸出固定為 `{"status":"completed | error","response":"string"}`；Codex unavailable、timeout、protocol rejection、turn failure 與互動核准要求均回結構化 `status: "error"`，不使 MCP server crash。
- Codex-specific process／JSONL protocol logic 獨立在 `codex-adapter.mjs`；MCP handler 不拼 shell，也不接受 command、cwd、model、sandbox、session 或 process 參數。
- 實際介面為官方 `codex app-server --listen stdio://`，本機版本 `codex-cli 0.146.0`；依官方 lifecycle 執行 `initialize`／`initialized`、`permissionProfile/list`、`thread/start`、`turn/start`，讀取 `item/completed` 與 `turn/completed`。
- Windows Store `codex.exe` 無法由 Node 直接 spawn（`EPERM`），因此 Windows adapter 只以固定、caller 不可控制的 `cmd.exe /d /s /c "codex app-server --listen stdio://"` 啟動官方介面；prompt 只經 JSONL stdin 傳送，從不進入命令列。
- 每次呼叫建立 `ephemeral: true` thread，不保存或回傳 session id；adapter 拒絕並行第二個 prompt、同步等待，timeout 固定 60 秒，不自動 retry。
- 每次先確認本機 `:read-only` permission profile 存在且 allowed；thread／turn 的 `cwd` 與 `runtimeWorkspaceRoots` 固定為本 PoC root，`environments` 與 selected capability roots 固定為空。缺少 read-only profile 時 fail closed，不 fallback 到 full-read／workspace-write。
- command／file-change approval server request 一律回 `cancel` 並終止該呼叫；其他互動或權限要求同樣 fail closed。沒有新增 `run_shell`、`exec`、PowerShell、任意 command、filesystem write、background、multi-agent 或 autonomous loop MCP tool。
- 專案已建立 `package.json`、`.gitignore`、`node:test` 測試與 live-smoke caller；`.env.local`、runtime、downloads 與歷史 backup 不進 Git。Git branch 為 `main`，初始化與 Gate 5A 實作已提交為 `f7d9694dd6f3a303014d9aaa8b5d6dbf9fbfd50e`（`Initialize local Codex bridge PoC`）。
- Automated tests：12/12 PASS，涵蓋 schema、空／過長 prompt、Codex unavailable、timeout、success、Codex error propagation、互動核准 fail-closed、HTTP MCP route，以及原六工具 regression。
- 真實 live smoke：以 OS 指派的臨時 port 建立 MCP HTTP server，依序呼叫 `initialize`、`tools/list`、`tools/call(run_codex_prompt)`；輸入 `只回答：CODEX_BRIDGE_OK`，結果為 `{"status":"PASS","response":"CODEX_BRIDGE_OK"}`。
- Gate 5A 結束當時，isolated smoke server 與 `codex app-server --listen stdio` 子程序均已關閉；host 固定 port `65535` 當時仍由六工具舊版本 PID `79600` 監聽，launcher PID `79824` 因 port 已占用而退出。此歷史部署停點已由下方 Gate 5B 新狀態取代。

### Gate 5B：ChatGPT ↔ Codex 端到端 smoke PASS

- 切換前先從 host localhost 對 PID `79600` 執行 MCP `initialize` 與 `tools/list`，確認它實際只載入既有六工具：`ping`、`echo_query`、`search_second_brain_test`、`list_project_files`、`search_project`、`read_project_file`。
- PID `79600` 已受控停止，並確認程序消失、`127.0.0.1:65535` 釋放後，才以既有 `start-mcp-server.ps1` 啟動已提交的新版 `mcp-server.mjs`。
- 新版 bridge 最後驗證 PID 為 `70060`，command line 仍固定指向本專案 `mcp-server.mjs`；`/healthz` 回傳 `status=ok`，MCP protocol version 為 `2025-06-18`。
- 新版 localhost `tools/list` 恰好為七工具：原六工具完整保留，新增第七個 `run_codex_prompt`；missing 與 extra 清單皆為空。
- 既有 Secure MCP Tunnel 未重建或重啟；最後驗證 tunnel-client PID `79224`、`/healthz=live`、`/readyz=ready`，並已自動接回相同的 localhost endpoint。
- 透過目前已安裝但仍快取六工具 metadata 的 Plugin 控制面呼叫既有 `ping`，取得 `status=ok`；因舊 PID 已停止，這次呼叫證明控制面 → Tunnel → 新版 PID `70060` 的既有路徑可達。
- 因目前 ChatGPT UI 未提供既有連線的 **Refresh** 選項，改依官方 developer-mode 流程，以同一條 Tunnel 建立新的開發者連線；MCP server 未實作使用者 OAuth，因此驗證方式選擇「無驗證」，未新增 credential 或權限。
- Tunnel log 於 `2026-08-09T21:07:11+08:00` 出現 `openai-mcp-discover`，證明 ChatGPT 已重新探索新版 MCP metadata；localhost `tools/list` 同步驗證恰好七工具並包含 `run_codex_prompt`。
- Tunnel log 於 `2026-08-09T21:10:22+08:00` 記錄 ChatGPT workflow 指令已轉送到 MCP server，期間沒有 dispatcher error；MCP caller 隨後取得 Codex 真正產生的精確 `CHATGPT_TO_CODEX_OK`，Gate 5B 判定 **PASS**。
- smoke 完成後 ChatGPT 再次出現限流；依限制未自動 retry，也未再次呼叫 `run_codex_prompt`。限流發生在精確結果回傳之後，不影響本次端到端驗收。
- 驗收後重新確認 bridge `status=ok`、`tools/list=7`、`run_codex_prompt` 存在，Tunnel 為 `live`／`ready`；目前 bridge PID `14204`、tunnel-client PID `22208`，PID 僅供本次 runtime 證據定位。
- Gate 5B 部署過程未修改 bridge 程式碼、App、Tunnel、credential、RBAC、permission 或 Platform 資源，也未新增 audit、session persistence、filesystem write、shell、background、multi-agent 或 autonomous loop 能力。

### 2026-08-09 corrective relocation

- 本次只搬移 Secure MCP Tunnel PoC 自身目錄；`PROJECT_ROOT` 是 Project Inspector 的唯讀檢查目標，不代表 PoC 自身位置。
- `start-mcp-server.ps1` 與 `start-gate2a.ps1` 的唯一作用中 PoC root 已更新為 `%BRIDGE_ROOT%`；既有 Tunnel、App、credential、RBAC 與 Platform 資源均不變。
- 完整目錄以同磁碟 move 搬遷；搬遷前後 directory File ID 均為 `[verified-directory-file-id]`，`.env.local`、`bin/`、`downloads/`、`fixtures/` 與 `runtime/` 均隨目錄保留。
- 搬遷後 MCP server PID 為 `79600`，tunnel-client PID 為 `79224`；localhost `/healthz` 與 Tunnel `/healthz`、`/readyz` 均為 HTTP 200。
- 純 localhost 驗證完成 `initialize`、恰好六個唯讀工具、Project Inspector list/search/read；敏感 `.env`、absolute-root 注入與 `..` traversal 均 fail closed。本次未從 ChatGPT 呼叫工具。
- 下方既有 Gate 紀錄中的舊路徑、PID 與當時驗證結果保留為歷史證據，不代表目前作用中設定，也未被回寫或改造成新的 Gate 證據。
- MCP 仍固定監聽 `127.0.0.1:65535`。此固定埠位於 `PORTS.md` 定義的 Windows 動態／暫時區段，屬既有政策不一致；本次 relocation 依授權不改埠、不靜默 fallback，列為待後續決策風險。

基礎傳輸層經重啟後，控制平面、長輪詢、Tunnel 到 localhost MCP 的初始化，以及健康／就緒檢查均正常；ChatGPT 應用層也已完成一次且僅一次的唯讀工具呼叫驗證。

已驗證：

- 2026-08-09 搬遷後重新完成 localhost MCP `initialize`、`tools/list`、`list_project_files` 與 `read_project_file(README.md)`；只讀取一般專案文件，MCP `/healthz` 與 Tunnel `/readyz` 均為 HTTP 200。
- 既有 Tunnel：`<configured-tunnel-id>`，已關聯目前使用的 ChatGPT workspace。
- 官方 `tunnel-client` v0.0.11 已完成控制平面認證並建立 session。
- Tunnel metadata 取得成功（HTTP 200），長輪詢持續成功（HTTP 204）。
- MCP transport 已初始化，協定版本為 `2025-06-18`。
- `tunnel-client` 的 `/healthz` 回傳 HTTP 200／`live`。
- `tunnel-client` 的 `/readyz` 回傳 HTTP 200／`ready`。
- localhost MCP server 的 `/healthz` 回傳 HTTP 200／`{"status":"ok"}`。
- real-root 切換後 MCP server PID 為 `69192`；原 tunnel-client 已在本輪開始前停止，沿用既有腳本、Tunnel 與 credential 重啟為 PID `72456`。
- Gate 3C2 已經 Tunnel 呼叫 `ping` 恰好一次；除此之外未呼叫任何工具。

## 安全邊界

- MCP server 僅監聽 `127.0.0.1:65535`；原六個工具與既有安全限制完整保留，第七個 `run_codex_prompt` 只接受自然語言 `prompt`。
- `search_second_brain_test` 仍只讀 `fixtures/second-brain/`；三個 Project Inspector 工具的唯一 allowlisted root 為實體 Bridge repo root，並排除頂層操作資料目錄與敏感路徑。
- MCP caller 不能提供 command、shell、PowerShell、cwd、model、sandbox、session、filesystem write 或任意網路參數；bridge 只以固定 adapter 呼叫本機官方 Codex app-server，Codex 原有 sandbox、approval、filesystem 與安全政策不被繞過。
- `run_codex_prompt` 是受限的 Codex delegation boundary，不是任意 filesystem 或 command execution 入口；caller 只能傳入自然語言 prompt，不能要求 bridge 改變 Codex 的 cwd、model、sandbox 或 approval policy。
- Codex 可能在其固定且唯讀的 PoC workspace 內讀取允許內容並產生文字回答；這是 Codex 原有權限內的 delegated inference，不等於 ChatGPT 直接取得任意 filesystem access。
- 每次呼叫使用單次 ephemeral thread、固定 `:read-only` profile、同步 timeout 與文字結果；不保存 session、不回傳 session id、不自動 retry，權限要求與 interactive approval 一律 fail closed。
- 專用 credential 維持 Tunnels Read + Use；秘密只留在 `.env.local`，本紀錄不含 credential 內容。
- ChatGPT Developer Mode 已於 Gate 3A 明確開啟；Gate 3B 已建立 developer-mode App；Gate 3C1 已將 App 連線至目前 ChatGPT workspace；Gate 3C2 已完成一次且僅一次的唯讀 `ping`。
- 未新增或修改其他 Platform project、service account、RBAC 或 Tunnel 資源。

## ChatGPT 應用層

### Gate 3A：PASS

- 目前 ChatGPT Plus workspace 的「設定 → 安全性與登入」確實提供「開發者模式」。
- 「開發者模式」已由關閉切換為開啟，介面顯示 checked。
- `https://chatgpt.com/plugins` 可正常進入。
- Plugins 頁面顯示「建立應用程式」入口，證明此 workspace 可進入 developer-mode App 建立流程。
- 未點擊「建立應用程式」，未建立 App，未綁定 Tunnel，也未呼叫 `ping`。

### Gate 3B：PASS

- 已建立唯一 developer-mode App：`local-codex-bridge-poc`。
- App ID：`<configured-app-id>`。
- Version ID：`<configured-version-id>`。
- 狀態為 `development`／`DEV`，未公開發布。
- 連線方式只選既有 Tunnel `<configured-tunnel-id>`；驗證方式為「無驗證」。
- 建立前 MCP `/healthz` 與 Tunnel `/readyz` 均為 HTTP 200。
- ChatGPT 自動掃描經 Tunnel 抵達 localhost MCP server；Tunnel 紀錄為 `openai-mcp-discover`。
- 掃描結果恰好只有一個動作：`ping`，標示為「讀取」，無輸入參數，說明為固定健康狀態且不讀檔、不讀外部資料、不寫入。
- Gate 3B 結束時尚未按下「將 local-codex-bridge-poc 新增至 ChatGPT」中的「連線」，當時未把 App 加入可用工具，也未呼叫 `ping`。
- 未新增 credential、公開 URL、OAuth、RBAC、project、service account 或其他 Platform 資源。

### Gate 3C1：PASS

- 已將既有 development App `local-codex-bridge-poc` 連線至目前 ChatGPT workspace。
- 連線確認頁未要求 OAuth、資料範圍、額外 credential 或其他權限；App 詳細頁顯示連線時間為 2026-08-08。
- 「已支援授權」與「已使用授權」皆為「無」。
- App 權限維持介面預設的「允許低風險動作」；目前唯一動作仍為唯讀 `ping`。
- 在空白新對話開啟工具選單，以名稱篩選後可看見 `local-codex-bridge-poc` 及其唯讀說明。
- 篩選文字已清空，傳送按鈕回到停用狀態；未選取 App、未送出訊息、未呼叫 `ping`。

### Gate 3C2：PASS

- 呼叫前 MCP `/healthz` 與 Tunnel `/readyz` 均為 HTTP 200；Tunnel 指標尚無 `tools/call`，基線為 0。
- 官方 quickstart 建議的 Work 路徑因目前 Work 使用量為 0% 而要求新增付費點數；未購買、未新增點數，改採官方同樣記載的「新對話 → 工具選單」測試路徑。
- 在一個空白一般對話中明確選取 `local-codex-bridge-poc`，只送出一則提示：要求呼叫 `ping` 恰好一次、不呼叫其他工具，並只輸出精確 JSON。
- ChatGPT 工具調用清單顯示單一 `Ping`，參數為空物件，工具回應為 `{ status: "ok" }`。
- ChatGPT 最終訊息精確為 `{"status":"ok"}`。
- 呼叫後 Tunnel `command_end_to_end_latency_milliseconds_count` 的 `request_method="tools/call"` 恰好為 1；`enqueue_to_response` 與 `poll_to_response` 是同一次呼叫的兩種延遲觀測，不代表兩次呼叫。
- 呼叫後 MCP `/healthz` 仍為 HTTP 200／`{"status":"ok"}`，Tunnel `/readyz` 仍為 HTTP 200／`ready`。
- 未送出後續訊息，未呼叫其他工具，未新增 credential、權限、RBAC、project、service account、公開端點或其他資源。

### Gate 4A：PASS

- 在既有 `mcp-server.mjs` 新增唯讀工具 `echo_query`，未新增檔案、套件或其他 runtime 能力。
- `inputSchema` 只允許必填 `query: string`，並以 `additionalProperties: false` 拒絕額外欄位。
- `outputSchema` 固定為 `query`、空陣列 `results`、常數 `source: "poc"`，且拒絕額外欄位。
- annotations 為 `readOnlyHint: true`、`destructiveHint: false`、`openWorldHint: false`。
- 伺服器端另做嚴格參數驗證；缺少 `query`、非字串 `query`、或加入額外欄位皆回傳 JSON-RPC `-32602`。
- 純 localhost 測試已通過 `initialize`、`tools/list`、有效 `echo_query`、三種無效輸入，以及既有 `ping` 回歸測試。
- 有效測試輸入 `query: "hello"` 的結構化結果為 `{"query":"hello","results":[],"source":"poc"}`。
- `ping` 行為未變：仍回傳 `{"status":"ok"}`。
- MCP server `/healthz` 維持 HTTP 200；既有 Tunnel client `/readyz` 維持 HTTP 200。
- 未重新整理或修改 ChatGPT App metadata，未從 ChatGPT 呼叫 `echo_query`，也未修改 Tunnel、credential、Platform、RBAC 或 Developer Mode 設定。

### Gate 4B：PASS（含一項測試環境限制）

- 新增三份完全合成且不含真實個資或正式資料的 Markdown：`alpha-note.md`、`beta-guide.md`、`gamma-log.md`。
- 新增唯讀工具 `search_second_brain_test`；輸入只允許必填 `query: string`，`additionalProperties: false`，長度限制為 1–256 字元，並拒絕空白字串。
- 結構化輸出僅含 `results`；每筆結果僅含 `title`、`snippet`、相對 `path`，最多 5 筆。
- annotations 為 `readOnlyHint: true`、`destructiveHint: false`、`openWorldHint: false`。
- 搜尋只做大小寫不敏感的本機純文字比對，不使用 regex，不接受路徑參數。
- 每次搜尋先驗證 fixture root 是實體目錄且 canonical path 未漂移；每個候選檔均經 `lstat`、`realpath`、root containment、普通檔案、64 KiB 上限及讀取後再次驗證。
- `.md` symlink／junction 會 fail closed；另以 `nlink === 1` 拒絕 NTFS hard-link 逃逸。
- 本機測試通過：`initialize`、`tools/list` 與 schema、正常查詢（3 筆）、無結果、特殊字元、空字串、超長 257 字元、遍歷字串、額外 `path` 欄位、`ping`／`echo_query` 回歸。
- NTFS directory junction 指向 fixture root 外的虛構 sentinel 時，工具在讀取前以 JSON-RPC `-32603` 拒絕；hard link 同樣以 `-32603` 拒絕，均未回傳外部內容。
- 真正的 Windows file symbolic link 因目前帳號缺少建立權限而無法建立；已嘗試一般及受控提升執行，Windows 均回報需要系統管理員權限。其 `lstat().isSymbolicLink()` 拒絕分支已由同屬 reparse point 的 junction 實測覆蓋，但此限制仍明確保留。
- 測試用 junction、hard link、外部 sentinel 與暫存目錄均已清除；fixture root 最終只剩三份普通 Markdown。
- 最終 MCP `/healthz` 為 HTTP 200，Tunnel client `/readyz` 為 HTTP 200；未重新掃描或修改 ChatGPT App，也未從 ChatGPT 呼叫新工具。
- 未修改 Tunnel、credential、Platform、RBAC、Developer Mode 或其他資源。

### Gate 4C：PASS（含既有 Windows file symlink 測試限制）

- 唯一 project root 固定為 `fixtures/project/`，其中只有合成的 README、Python、JSON、Markdown 與測試控制檔；未接觸正式專案。
- 新增 `list_project_files`：depth 預設 2、允許 1–4，最多回傳 200 個相對路徑與 `file`／`directory` 類型。
- 新增 `search_project`：只接受必填 `query: string`，長度 1–256；使用 literal、大小寫不敏感搜尋，最多 20 筆，每筆只有相對 `path`、1-based `line`、最多 240 字元 `context`。
- 新增 `read_project_file`：只接受一個相對 `path`，僅讀一般 UTF-8 文字檔，單次上限 64 KiB，輸出只有相對 `path` 與 `content`。
- 三個工具均為 `readOnlyHint: true`、`destructiveHint: false`、`openWorldHint: false`，且所有 input/output schema 都拒絕額外欄位。
- 共用防護會排除 `.git`、`.env`／`.env.*`、credential／secret 名稱、常見私密金鑰檔；同時拒絕絕對路徑、drive-relative、UNC、`..`、`.`、ADS 冒號、尾端空白／句點及 Windows 非法字元。
- 每個可見項目均經 `lstat`、`realpath`、canonical containment 與敏感路徑二次檢查；普通檔案另要求 `nlink === 1`。
- 實際讀檔使用唯讀 file handle；開啟後比對 device、inode、size、link count，讀取後再驗證 path 與檔案身分未改變。
- 功能測試通過：`initialize`、六工具 `tools/list`／schema、depth 1／2／3、正常搜尋、無結果、特殊字元、正確行號、240 字元 context、正常巢狀檔案讀取。
- 邊界測試通過：空／257 字元 query、額外欄位、traversal、absolute、drive-relative、UNC、ADS、目錄、缺檔、敏感檔均拒絕；跨到 `second-brain` 的搜尋為空、讀取為 `-32602`。
- 以 25 個合成匹配驗證搜尋只回傳前 20 筆；以 67,606-byte 合成檔驗證搜尋跳過、讀取以 `-32602` 拒絕。
- NTFS junction 指向 project root 外時，list／search 以 `-32603` fail closed，read 以 `-32602` 拒絕；hard link 得到相同保護，均未回傳外部內容。
- 真正 file symbolic link 仍因 Windows 帳號缺少建立權限而無法直接建立；其 `lstat().isSymbolicLink()` 拒絕分支由同屬 reparse point 的 junction 實測覆蓋，此限制保留。
- `ping`、`echo_query`、`search_second_brain_test` 回歸測試均通過；MCP `/healthz` 與 Tunnel `/readyz` 均為 HTTP 200。
- 最終 fixture 無 reparse point，所有 oversize、result-limit、context-limit、junction、hard-link 與外部 sentinel 暫存物均已清除。
- MCP server 程序沒有外部 TCP connection；來源碼未加入 subprocess、Shell、環境變數、外網或任何檔案寫入 API。
- 未重新掃描或修改 ChatGPT App，未從 ChatGPT 呼叫 Gate 4C 工具，也未修改 Tunnel、credential、Platform、RBAC 或 Developer Mode。

### Project Inspector real-root cutover：PASS（歷史 Gate 4E 狀態；已由 Gate 5A self-contained root 取代）

- 本 Gate 當時的 `PROJECT_ROOT` 硬編碼為唯一值 `%SEPARATE_PROJECT_ROOT%`；不是環境變數、請求參數或可由工具輸入改變的設定。Gate 5A 後的 current root 見文件頂端。
- 未新增 MCP 工具；`tools/list` 仍恰好為六個工具，`list_project_files`、`search_project`、`read_project_file` 的 schema、唯讀 annotations、64 KiB 與 20-result 上限均保持。
- `%SEPARATE_PROJECT_ROOT%` 已確認為實體目錄且 canonical path 不漂移；其下 `sample-target-project/AGENTS.md` 已讀取並遵守，未碰觸其禁止的外部正式資料來源。
- 額外排除只會縮小資料面的虛擬環境、依賴、快取、IDE、模型、備份、build、output 與 results 目錄，避免真實專案掃描落入 generated／vendor tree。
- `list_project_files` depth 1 回傳 3 筆、預設 depth 2 回傳 25 筆；可看見一般專案、README 與 source directory，`.pytest_cache`、`models`、`.env`、`.git`、`.codex`、`.venv`、backups、output、results 均不可見。
- depth 4 成功回傳既有上限 200 筆並標記 `truncated: true`；所有回傳 path 都是 `%SEPARATE_PROJECT_ROOT%` canonical root 下的相對路徑。
- `search_project` 以一般程式碼識別字查得 Python 原始碼，恰好受 20-result 上限限制；無結果、空字串、257 字元 query 與額外 root 欄位測試均符合預期。
- `read_project_file` 成功讀取一般 README 與 Python 原始碼；實際 `.env`、`.env.example`、`.git/config`、`.codex`、`.venv`、results，以及 traversal、absolute、drive-relative、UNC、ADS、目錄與缺檔均以 `-32602` 拒絕。
- 由工具輸入嘗試注入 root／path 均被 `additionalProperties: false` 與 server-side validation 拒絕；`%OUTSIDE_ROOT%`、`%USER_PROFILE_ROOT%` 及其他 root 外位置不可達。
- symlink／junction／hard-link、canonical containment 與讀取前後檔案身分防護程式碼未變；為保持真實專案零寫入，本輪未在 `%SEPARATE_PROJECT_ROOT%` 注入測試 link，沿用 Gate 4C 已完成的 junction／hard-link 動態證據。
- `ping`、`echo_query`、`search_second_brain_test` 回歸測試均通過；MCP `/healthz` 與 Tunnel `/readyz` 均為 HTTP 200。
- MCP server 未新增 Shell、subprocess、環境變數讀取、外網或檔案寫入 API，且執行時沒有外部 TCP connection。
- `%SEPARATE_TARGET_REPO%` 測試前後 Git status 均為空且 SHA-256 同為 `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`，確認未修改真實 repo。
- 未重新掃描或修改 ChatGPT App，未由 ChatGPT 呼叫 Project Inspector，也未修改 Tunnel、credential、Platform、RBAC 或 Developer Mode。

### Gate 4E：PASS（逐次 server-side audit 尚未實作）

- 呼叫前 `%SEPARATE_TARGET_REPO%` Git status 為空，HEAD 為 `1ecb1e199bcd4520c15628cadd962763ab55eb30`；MCP `/healthz` 與 Tunnel `/readyz` 均為 HTTP 200，Tunnel `tools/call` 基線為 0。
- 依官方 metadata refresh 流程只重新整理既有 `local-codex-bridge-poc` App；刷新後 ChatGPT 顯示恰好六個 read-only actions，Project Inspector 三工具及 schema 均已載入。沒有建立 App、Tunnel、credential、RBAC 或其他資源。
- Work 介面因每週使用量為 0% 無法送出；改由同帳號一般 ChatGPT 對話掛載同一既有 App，未購買點數或擴大權限。
- ChatGPT 在未被指定檔案的情況下自主完成 `list → search → read → 交叉驗證 → 專案判斷`，辨識結構、入口、核心模組、測試結構與 README 用途，並提出只做後續審查、不直接修改的改善候選。
- Tunnel 最終 `command_end_to_end_latency_milliseconds_count` 的 `request_method="tools/call"` 在 `enqueue_to_response` 與 `poll_to_response` 兩種觀測均為 12，表示實際共有 12 次工具呼叫，全部 HTTP 200。
- ChatGPT 回報的 12 次呼叫依序為：`list_project_files(depth=4)`；`search_project("__main__")`；`search_project("FastAPI")`；讀取 README、`scripts/serve_retrieval_service.py`、`retrieval_service/application.py`、`retrieval_service/api.py`；`search_project("unittest")`；讀取 `tests/test_durable_runtime.py`、`tests/test_open_notebook_v1_14_adapter.py`、`retrieval_service/runtime/http_fastapi.py`、`docs/ADAPTER_SKELETON.md`。
- 12 次清單與 Tunnel 的 12 次計數完全相符；清單中只出現 `list_project_files`、`search_project`、`read_project_file`，沒有 `ping`、`echo_query`、`search_second_brain_test` 或其他 App／工具。
- 所有八個讀取 path 均為 `sample-target-project/` 下的相對普通檔案；沒有嘗試 `.env`、`.git`、credential、secret、絕對／UNC／traversal 或 root 外路徑。
- ChatGPT 工具卡 UI 將後續批次呼叫合併顯示，沒有提供 12 筆可逐一匯出的完整後端 audit；本輪精確順序以 ChatGPT 最終 audit 清單為來源，再由 Tunnel 12 次計數、可見工具卡內容及八檔存在性／內容特徵交叉驗證。若 Gate 5 要求不可抵賴的逐次稽核，應先為 bridge 加入不含檔案內容的結構化 server-side audit log。
- ChatGPT 的專案判斷與本機獨立唯讀核對一致：README 說明 vendor-neutral retrieval service；`serve_retrieval_service.py` 有 `create_app()`；`http_fastapi.py` 建立 FastAPI；代表性測試使用 `unittest`。
- 最值得下一步純審查的項目是 `scripts/serve_retrieval_service.py` composition root 是否承擔過多設定解析、安全邊界與依賴組裝責任；本輪未修改該檔或任何正式專案檔案。
- 呼叫後目標 repo Git status 仍為空且 HEAD 未變；八個宣告讀取檔均存在並已記錄 SHA-256。MCP `/healthz` 與 Tunnel `/readyz` 維持 HTTP 200。
- ChatGPT 一度顯示暫時性「要求過於頻繁」，但既有回合隨後自行完成，未重送提示、未新增呼叫或擴大資料範圍。

### Gate 4E 重測（2026-08-09）：內容驗收 PASS；嚴格工具程序一項偏差

- 重測開始時 MCP server 與 `tunnel-client` 均未執行；既有 `.env.local` 與非空 `CONTROL_PLANE_API_KEY` 仍在，檢查過程未輸出 key。
- 使用既有 `start-mcp-server.ps1` 與 `start-gate2a.ps1` 依序啟動；未建立或修改 credential、Tunnel、App、Platform、RBAC、Windows service 或自動啟動設定。
- 目前本機沒有指向本 PoC 的 Windows service、排程工作、Startup entry 或 HKCU Run entry，因此重新登入、重開機或程序退出後，現況需要手動啟動 MCP server 與 Tunnel client。建議順序為 MCP `/healthz=200` 後再啟動 Tunnel，並等 `/readyz=200`。
- 重測前 `tools/call` 基線為 0，MCP `/healthz` 與 Tunnel `/readyz` 均為 HTTP 200；目標 repo Git status 為空，HEAD 為 `1ecb1e199bcd4520c15628cadd962763ab55eb30`。
- ChatGPT Work 介面已能正常開啟，昨日的「剩餘 0%／新增點數」警告不再出現；為維持可比性，實際重測仍使用一般 ChatGPT 新對話、同一既有 App 與完全相同的 Gate 4E 提示。
- 本輪未 refresh App metadata。ChatGPT 自主完成結構盤點、入口／核心／測試辨識、多檔案交叉驗證與改善判斷，全程沒有再次出現「太多要求」或其他 ChatGPT 限流對話框。
- ChatGPT 明確列出 20 次 Project Inspector 呼叫：`list_project_files(depth=4)` 一次；`search_project` 三次（`create_app`、`vendor-neutral`、`pending`）；`read_project_file` 十六次。
- 十六個讀取 path 全部是 `sample-target-project/` 下的相對普通檔案，涵蓋 README、architecture、TASKS、PROGRESS、入口、domain/ports/application/api/search、FastAPI runtime 與五份代表性測試；本機獨立檢查確認 16/16 均存在。
- Tunnel `poll_to_response` 的 `tools/call` count 為 20，且 tunnel log 由 717 增至 737 行，與 20 次個別 localhost MCP 呼叫完全相符；`enqueue_to_response` count 為 4，對應 ChatGPT 的四個批次，不應誤讀為只有四次工具呼叫。所有 Tunnel status 均為 200。
- ChatGPT 在三個 Project Inspector 工具前另揭露一次平台內部 `api_tool.list_resources(paths=["local-codex-bridge-poc"])` discovery。它未進入 Tunnel、未增加 MCP `tools/call`、未讀取任何專案內容；若 Gate 標準要求連平台工具 discovery 都不得存在，記一項程序偏差。若標準是專案內容只能由三個 allowlisted 工具讀取，則 PASS。
- 沒有呼叫 `ping`、`echo_query`、`search_second_brain_test`、其他 App 工具或寫入工具；沒有嘗試 `.env`、`.git`、credential、secret、absolute、UNC、traversal 或 root 外路徑。
- ChatGPT 找出的最值得下一步檢查項目是文件狀態漂移：README 記載 69 tests，但 PROGRESS 記載 72/72；`docs/architecture.md` 仍稱 observability/auth/queue adapters pending，而 TASKS 與實際 runtime 已顯示完成。這兩項均由本機唯讀 `rg` 交叉驗證。
- 呼叫後目標 repo Git status 仍為空且 HEAD 未變；MCP `/healthz` 與 Tunnel `/readyz` 仍為 HTTP 200。MCP server（PID 66624）與 tunnel-client（PID 74312）目前保持執行。

### 搬遷收尾與 GPT connector 實測（2026-08-09）

測試前基線（2026-08-09T11:12:21+08:00）：

- 正確來源 %FORMER_BRIDGE_ROOT% 已不存在；正式目的地 %BRIDGE_ROOT% 存在，directory File ID 仍為 [verified-directory-file-id]。
- .env.local、bin/、downloads/、fixtures/、runtime/ 與兩個啟動腳本均保留；只驗證 .env.local 存在且非空，未讀取或記錄 credential 內容。
- localhost MCP 127.0.0.1:65535 為 HTTP 200／ok，initialize 協定 2025-06-18 成功，tools/list 恰好六個唯讀工具。
- Tunnel health listener 為 127.0.0.1:[ephemeral-port]，/healthz 與 /readyz 分別為 HTTP 200／live、HTTP 200／ready；MCP／Tunnel listener PID 分別為 79600、79224。
- 錯誤的 %STALE_WORKSPACE_ROOT% Codex trusted-project 區塊已移除，config.toml 經 TOML parser 驗證有效；可復原備份為 %USERPROFILE%\.codex\config.toml.bak-bridge-relocation-20260809。
- 2026-08-09T11:15:08+08:00，本輪 GPT 經已連結的 local-codex-bridge-poc connector 實際且僅呼叫一次 ping；connector structured result 為 status=ok。
- Tunnel live log 由基線 1082 行／608631 bytes 增至 1083 行／609008 bytes，恰好新增一筆 2026-08-09T11:15:08.9768319+08:00 的 INFO 事件：dispatcher forwarded command to MCP server；時間與本輪 connector 呼叫一致。
- 呼叫後 Tunnel /healthz 與 /readyz 仍為 HTTP 200／live、HTTP 200／ready。未呼叫其他五個工具、未呼叫 Project Inspector、未讀取 獨立目標專案 或敏感資料。
- 2026-08-09 11:31:13–11:32:44+08:00，沿用既有已登入 Chrome／Computer Use，在乾淨 ChatGPT 對話中選取 `local-codex-bridge-poc`，並恰好送出一次最小 `ping` 驗收提示；對話證據為 [private validation URL redacted] 。
- 第一次 Web UI 驗收顯示 `local-codex-bridge-poc`「連線已過期，請先重新連線」，因此 `ping` 實際 0 次、其他工具 0 次；沒有錯誤重送，也沒有遇到限流。
- 使用者隨後明確授權重新連線既有 App；2026-08-09 11:43:59+08:00，既有 `local-codex-bridge-poc` 重新授權流程完成並顯示 `link_success=true`。畫面仍聲明唯讀 ping transport，沒有新增 App 或擴大權限。
- 2026-08-09 11:46:34–11:48:20+08:00，在另一個乾淨 ChatGPT 對話中重新選取同一 App，恰好送出一次 post-reconnect `ping` 提示；對話證據為 [private validation URL redacted] 。
- Post-reconnect 回合仍在工具呼叫前顯示連線已過期，未回傳 `status=ok`；`ping` 實際 0 次、其他工具 0 次，沒有重送或限流。這證明 UI 的 `link_success=true` 未形成可用或持久化的 Web 工具授權。
- Tunnel live log 維持 1083 行／609008 bytes，沒有新增 dispatcher command，與兩次 Web 請求都在進入 Tunnel 前被阻擋一致；最終 `/healthz` 與 `/readyz` 仍為 HTTP 200／live、HTTP 200／ready。
- 上述 FAIL 後，使用者在 ChatGPT 端完成既有 App 的額外存取授權，並送出一則中文 channel-test query；Bridge 透過 `echo_query` 原樣回傳同一 query，ChatGPT Web 可見輸入與輸出一致。
- `echo_query` 的本機實作只回傳 `{ query: args.query, results: [], source: "poc" }`，不讀檔、不連外、也不呼叫 Codex。Tunnel live log 由 1083 行／609008 bytes 增至 1086 行／610153 bytes，於 12:02:11.797、12:02:12.551、12:02:52.658+08:00 各新增一筆 dispatcher forwarded command；`/healthz` 與 `/readyz` 最終仍為 HTTP 200／live、HTTP 200／ready。
- ChatGPT Web ↔ local MCP bridge 的 request／response transport gate 更新為 PASS。前三筆 dispatcher 事件沒有記錄 method，因此不能只靠 log 把每筆分別命名；成功判定同時依據 Web 可見的精確 echo 與 server-side `echo_query` 實作。
- 當時邊界為 NOT IMPLEMENTED（已由 Gate 5A 取代）：當時暴露的六個工具只有 `ping`、`echo_query`、`search_second_brain_test`、`list_project_files`、`search_project`、`read_project_file`，沒有 `send_to_codex`／`run_codex_prompt`，也沒有把 prompt 交給 Codex agent 並取得其回覆的 dispatcher。
- 未 refresh metadata、未修改 App、Tunnel、credential、RBAC 或本機資源；所有瀏覽器探查已停止。
## 目前停點

Gate 5A 維持 PASS：isolated 本機 HTTP MCP caller 已透過 `run_codex_prompt`、官方 Codex app-server 與 `:read-only` ephemeral thread 取得精確 `CODEX_BRIDGE_OK`，automated tests 為 12/12 PASS；實作 commit 為 `f7d9694dd6f3a303014d9aaa8b5d6dbf9fbfd50e`。

Gate 5B 已完成並停止：新版 developer-mode connection 已透過同一條 Secure MCP Tunnel 重新探索七工具；ChatGPT workflow 經 Tunnel 抵達 local bridge，`run_codex_prompt` 以官方 Codex app-server 的 `:read-only` ephemeral thread 執行，MCP caller 最終取得精確 `CHATGPT_TO_CODEX_OK`。2026-08-09 最終離線 automated tests 為 12/12 PASS；bridge 與 Tunnel 驗收後維持 `ok`／`live`／`ready`。未因後續 ChatGPT 限流重試，也未擴大 audit、session persistence、filesystem write、shell、autonomous loop、multi-agent 或 background execution。

下一階段僅建議先改善固定 port `65535` 的政策一致性與啟動持久性；須另行授權後才執行。本 Gate 不再新增功能或權限。

固定 port `65535` 仍保留既有 `PORTS.md` 政策不一致，未在本 Gate 擴大處理。

### 2026-08-09 邊界審查修補

- run_codex_prompt 的 Codex cwd 與 runtimeWorkspaceRoots 已縮小到專案內獨立的 codex-workspace/，不再暴露整個 bridge root；該目錄只保留說明檔，不含 credential、runtime、Tunnel state 或 executable。
- MCP route 已把 caller disconnect 傳遞為 AbortSignal；Codex adapter 會嘗試送出 turn/interrupt，並以 CODEX_CANCELLED fail closed，清理 listener 與 one-shot app-server process。
- Codex public error message 已遮罩 sk/rk token、Bearer value 與本機 Windows／Unix path；Windows adapter 可由啟動腳本固定絕對 codex.cmd 路徑。
- start-mcp-server.ps1 現在拒絕既有 port collision，並在回報 PID 前驗證 /healthz 與恰好七個 tools；start-gate2a.ps1 清除 stale health URL、拒絕 duplicate tunnel，並在回報 PID 前驗證 Tunnel live／ready。
- 本輪 automated tests 為 17/17 PASS；新增 workspace isolation、caller cancellation、error redaction、signal plumbing 與 HTTP disconnect 覆蓋。未新增 MCP tool、shell、write、session、background 或 multi-agent 能力。
- 目前 runtime 已受控重啟新版 bridge，/healthz=ok、tools/list=7；既有 Tunnel PID 未重啟，health endpoint 實測為純文字 live／ready。未再次送出 Codex live prompt，ChatGPT metadata refresh 仍是外部操作停點。


### 2026-08-09 `run_codex_prompt` exit 1 remediation

- Reproduction: the launcher script set an absolute `CODEX_CLI_PATH` to npm `codex.cmd`; Node escaped the inner quotes in the `cmd.exe /c` payload, so `cmd.exe` could not find the launcher and exited 1.
- Fix: `codex-adapter.mjs` now enables `windowsVerbatimArguments` only for Windows `cmd.exe` launches, preserving the `/c` quoting; a Windows launcher regression test was added.
- Verification: automated tests are 18/18 PASS; the absolute `codex.cmd` adapter path returns successfully; after restart, MCP PID `16212` returns `status=completed` for localhost `run_codex_prompt`.
- Runtime: MCP `127.0.0.1:65535` is owned by PID `16212`; the existing Tunnel PID `22208` was not restarted and remains `live`/`ready`.
- Note: bare `scripts/live-smoke.mjs` still exits 1 in this Codex host environment when `CODEX_CLI_PATH` is unset; the same smoke passes with the absolute `codex.cmd` supplied by the production launcher, so the production path is verified and the bare-launch smoke remains a follow-up diagnostic item.
- No new ChatGPT Web dispatcher event was produced during this diagnostic, so this local repair is not recorded as a new Web end-to-end Gate 5B acceptance.

### 2026-08-10 bounded Codex timeout at 180 seconds

- `MAX_CODEX_TIMEOUT_MS` and `DEFAULT_CODEX_TIMEOUT_MS` are now both `180_000`; the caller schema remains unchanged.
- The adapter still permits shorter internal/test timeouts but rejects any configured timeout above 180,000 ms.
- Timeout behavior remains fail-closed: interrupt the active turn, clean up the one-shot app-server process, and return a structured error; no async job or session persistence was added.
- Verification: automated tests are 19/19 PASS; after controlled restart MCP PID `20224` exposes seven tools, MCP health is `ok`, Tunnel health/ready is `live`/`ready`, and a short `run_codex_prompt` returned `status=completed`.
- Tasks exceeding 180 seconds remain unsupported by this synchronous bridge; async start/status polling remains a separate authorized design change.

### 2026-08-10 GitHub 公開工作樹清理

- 已補強 .gitignore：本機環境檔、credential 類檔名、私鑰格式、下載 binary、runtime state、logs、PID 與備份預設排除；.env.local.example 明確保留為可追蹤範本。
- 兩個啟動腳本改由 PSScriptRoot 定位專案；Node 與 Codex launcher 都解析成存在的絕對路徑。
- 實際 Tunnel ID 已自 tracked source 移至 ignored runtime/gate2a-live/tunnel.id；PROGRESS 內的 Tunnel/App ID、私人 ChatGPT URL、帳號名稱與機器專屬路徑已遮罩。
- 新增公開 README 與空白 key 範本；Tunnel executable 仍不納入 Git，只引用既有第三方 LICENSE。
- 驗證結果：npm test 19/19 PASS、兩個 PowerShell launcher 語法 PASS、git diff --check PASS；未讀取 .env.local 內容，只確認檔案存在且非空。
- 可回復備份保存在 ignored runtime 目錄。本輪未改寫歷史、未設定 remote、未 stage、commit 或 push。
