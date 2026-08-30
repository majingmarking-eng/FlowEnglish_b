# FlowEnglish

B 站英文课程学习助手（Chrome / Edge 扩展，Manifest V3）。

在 B 站视频播放器下方新增一个 **flowenglish** 按钮。**手动点击才激活全部学习功能，不会自动运行**。

## 核心原则

1. **缓存优先**：以 `BV 号 + 分 P` 为 key 查询浏览器本地缓存，命中即直接进入学习模式，不发起任何网络请求。
2. **原生字幕优先**：优先读取 B 站原生英文字幕（含官方 CC 与 AI 字幕），有英文字幕就完全不需要 ASR。
3. **按需 ASR**：只有「无原生英文字幕 + 用户手动确认」时，才采集页面播放音频、调用**你自己配置的** ASR 接口生成带时间戳字幕。生成结果永久缓存，下次打开同一视频不再消耗 API。
4. **数据全本地**：所有密钥、字幕、生词、笔记、练习记录只保存在浏览器 `chrome.storage.local`，插件不对外提供任何服务、不收集任何数据。
5. **无上传入口**：没有手动上传音频文件的表单，只处理 B 站正在播放的网页视频。

> **关于 host 权限**：插件声明了对 `bytedance.com` / `volces.com`（火山 ASR、LLM）、`api.openai.com`、`api.deepseek.com`（可选供应商预设）的访问权限，用途是让 background 代理转发你配置的 ASR/翻译/LLM 请求（否则浏览器会以 CORS 拦截这些跨域调用）。插件自身没有任何服务器，所有请求都指向你在配置页填的地址。

## 安装

1. Chrome 打开 `chrome://extensions/`，开启右上角「开发者模式」。
2. 点「加载已解压的扩展程序」，选择本目录（包含 `manifest.json`）。
3. 打开任意 B 站视频页（`bilibili.com/video/BV...`），播放器下方会出现 **flowenglish** 按钮（首页、列表页不显示）。

## 使用流程

```
点击 flowenglish 按钮
  │
  ├─ 命中本地缓存 ──────────→ 直接加载字幕/生词/笔记，进入学习模式
  │
  ├─ 有 B 站原生英文字幕 ────→ 拉取字幕存缓存，渲染双语面板（有中文 CC 则直接双语）
  │
  └─ 无英文字幕 ────────────→ 弹窗确认「是否调用你配置的 ASR 接口」
        ├─ 确认 → 采集页面播放音频（分片）→ ASR → 带时间戳字幕 → 缓存 → 学习模式
        └─ 取消 → 回到普通 B 站播放，什么都不发生
```

> ASR 未配置时，弹窗会引导你到「API 配置」页填写接口地址与 Token，不会发起空请求。

## 面板能力

- **双语字幕**：英文主字幕 + 中文翻译开关（有原生中文 CC 直接用，否则可配 LLM 批量翻译）。**ASR 生成英文字幕完成后会自动生成中文并默认展示双语**（需配置 LLM）。
- **片段循环**：每句可单独循环；快捷键 `Alt+X` 重播当前句、`Alt+C` 循环/取消当前句、`Alt+Z` 开关面板。
- **划词生词**：在字幕里用鼠标划选英文单词，点「＋ 加入生词」；配 LLM 后可一键 AI 释义。
- **填空练习**：基于当前视频字幕本地生成 5 道挖空题（不消耗 API），自动判分并记录历史。
- **笔记**：手动笔记 + 插入当前时间点；「标记时间点」按钮可直接把时间标记（可带备注）记入笔记；配 LLM 后有「✨ AI 生成笔记」。
- **ASR 续传**：停止并保存后可随时继续——再点 flowenglish，选择「从停止处继续」或「从当前播放位置继续」，已转写的字幕自动合并，不重复消耗。
- **侧边入口**：全局生词本、导出（SRT / 双语 SRT / Markdown / 生词 CSV）、API 配置、缓存管理、全量 JSON 备份导入。

## API 配置（扩展设置页）

| 配置 | 用途 | 说明 |
| --- | --- | --- |
| ASR | 无英文字幕时生成字幕 | OpenAI Whisper 兼容 / 通用 multipart / JSON base64 三种协议；上传格式可选 WAV 16k 单声道（推荐）或 WebM/Opus |
| LLM | AI 释义、AI 笔记、翻译兜底 | OpenAI Chat Completions 兼容（OpenAI / DeepSeek / 通义 / Kimi / Ollama 等） |
| 翻译 | 中文字幕开关 | 留空则复用 LLM 配置 |

所有请求由 background service worker 代理转发（解决跨域），密钥只存在本地。

### 火山方舟（推荐：ASR + LLM 一套 API Key 全搞定）

配置页的「供应商预设」下拉选 **火山方舟**，地址和模型自动填好：

| 模块 | 预设自动填写 | 你需要做的 |
| --- | --- | --- |
| ASR | 地址 `https://ark.cn-beijing.volces.com/api/v3/audio/transcriptions`、模型 `doubao-seed-asr-1-0` | Token 填**方舟 API Key** |
| LLM | 地址 `.../api/v3/chat/completions`、模型 `doubao-seed-2-1-pro-260628` | Token 填**同一个方舟 API Key**，模型可换 Model ID 或推理接入点 `ep-xxx` |
| 翻译 | 全部留空 → 自动复用 LLM（方舟） | 什么都不用填 |

1. 开通：火山引擎控制台 → **火山方舟** → 开通服务，创建 API Key（控制台 → API Key 管理）。
2. ASR 模型：方舟里开通「豆包种子语音识别」（Seed-ASR），模型 ID 以你控制台实际显示为准（不一定是 `doubao-seed-asr-1-0`）。
3. LLM 模型：填 Model ID（如 `doubao-seed-2-1-pro-260628`）或你创建的推理接入点 ID（`ep-xxxx`）。
4. 方舟 ASR 按 OpenAI 兼容 multipart 调用；未返回时间戳时插件会按句拆分时间轴（仍可正常学习）。

### 火山语音平台 · 豆包语音识别（可选，无需方舟也可用）

插件同样支持 **录音文件识别极速版**（`recognize/flash`，一次请求即返回结果，支持 base64 直传本地音频）：

1. 控制台开通：登录 [console.volcengine.com/speech](https://console.volcengine.com/speech)，开通「录音文件识别极速版」（资源 `volc.bigasr.auc_turbo`）。
2. 配置页「供应商预设」选 **火山语音平台 · 豆包语音识别极速版**，地址自动填好。
3. 鉴权二选一：新版控制台填 API Key（`X-Api-Key`）；旧版填 App ID + Access Token（`X-Api-App-Key` / `X-Api-Access-Key`）。
4. Resource ID 保持默认 `volc.bigasr.auc_turbo`；语言填 `en-US`；插件强制 WAV 16kHz 单声道。

> 豆包语音 2.0 **标准版**（`volc.seedasr.auc`，submit/query 异步接口）要求**公网音频 URL**，插件本地音频无法直接提交，故走极速版通道。极速版限制：单文件 ≤ 2 小时、≤ 100MB（插件按 60 秒切片，远低于限制）。

## 已知边界

- ASR 是**实时采集**：需要本页持续播放，采集时长 ≈ 视频时长；可随时「停止并保存」，下次重新点击可从头再来（停止时会标记字幕不完整）。
- 采集请保持标签页在前台，后台标签页 MediaRecorder 可能被浏览器节流。
- B 站播放器 DOM 会动态重渲染：按钮做了防抖监听 + 定时兜底自愈（被 B 站重建清掉后会自动重新挂载，并恢复此前的学习状态），无需手动刷新。
- 需要 Chrome 111+（依赖 `world: "MAIN"` content script 与 `captureStream`）。

### 音频采集失败排查（Failed to execute 'start' on 'MediaRecorder'）

插件已内置防护：视频静音时临时解静音（音量保持 0，不出声）、编码格式多级回退、录制前校验音频轨道、每切片校验轨道存活。仍失败时按顺序排查：

1. **先点播放再开始**：视频必须已加载；暂停在开头也可能导致录制器启动失败。
2. **刷新页面重试**：B 站播放器切换清晰度 / 分 P 会结束旧音频轨道，重新点一次 flowenglish。
3. **确认不是无声视频**：视频本身没有音轨时会提示「没有可采集的音频轨道」。
4. **升级浏览器**：用较新版本的 Chrome/Edge；Safari 对 `captureStream` 支持不完整。
5. **保持标签页在前台**：后台标签页的录音会被浏览器节流甚至中断。

## 目录结构

```
manifest.json                 MV3 清单（storage / unlimitedStorage + bilibili host 权限）
icons/                        扩展图标
src/
  lib/
    core.js                   命名空间、常量、工具（含零依赖 md5，用于 wbi 签名）
    storage.js                本地缓存层（配置 / 索引 / 单视频记录 / 全局生词 / 备份导入导出）
    subtitle.js               字幕归一化、SRT、双语对齐、出题（纯函数）
    exporter.js               SRT / Markdown / CSV / JSON 导出
  content/
    page-probe.js             MAIN world：读 B 站 __INITIAL_STATE__，广播页面状态
    capture.js                音频切片采集（captureStream + MediaRecorder，可转 WAV 16k）
    panel.js                  悬浮学习面板 UI
    index.js                  主编排：缓存 → 原生字幕 → 按需 ASR
    styles.css                面板样式
  background/
    service-worker.js         网络代理：wbi 签名拉字幕 / ASR / LLM 转发
  options/                    设置页（API 配置 / 缓存管理 / 全局生词本 / 备份）
  popup/                      工具栏弹窗（状态速览）
```
