---
name: book-craft
description: 工业级电子书全流程创作、迭代与一键出书专家技能（Authoring, Iterating, and AI Web Reader Generator for Technical Books）。支持基于已有书籍/大纲增量续写、给定 GitHub 仓库/技术读物一键生成深度架构电子书、自动调用本地 aih-server 生成 8K 级概念插图与原生 SVG/HTML 双语流程图，并一键交付内置 AI Copilot 伴读的现代单页 Web 阅读器。
---

# book-craft — 工业级技术电子书创作与全流程出书专家

`book-craft` 是用于编写、迭代、插图、重构与发布【顶尖工业级/教科书级技术电子书】的全流程自动化技能。

无论是**基于现有书籍继续迭代编写**，还是**输入一个 GitHub 仓库链接 / 技术参考资料进行一键逆向出书**，本技能均可提供端到端确定性交付。

---

## 🎯 核心能力与适用场景

1. **增量续写模式 (Iterative Authoring)**：
   - 读取书籍索引 `README.md`，自动扫描未完成 `[待编写]` 章节；
   - 每次只聚焦深度编写一个小节，落盘到规范目录（如 `docs/<book-name>/01-part/01-01-title.md`）；
   - 自动生成专属 8K 概念艺术图、原生 SVG 矢量流程图与交互式状态机模拟器；
   - 自动更新主索引 `[x]` 并执行干净的 Git Commit，支持通过 `/loop 15m` 全自动无人值守交付。
2. **一键出书模式 (One-Click Book from Repo / Doc)**：
   - 输入一个 GitHub 仓库 URL 或参考读物，自动执行：
     `源码/文档深读 -> 核心壁垒萃取 -> 工业级全景目录设计 -> 分篇章教科书级撰写 -> AI 概念绘图 -> 交互仿真组件构建 -> 现代 Web 阅读器编译`。
3. **沉浸式 AI 伴读阅读器生成 (Interactive Web Reader)**：
   - 自动在 `docs/<book-name>/reader/` 生成基于 Linear 级现代暗黑/明亮设计语言的单页应用；
   - 内置全屏 Lightbox 放大镜、全键盘快捷键、阅读进度记忆；
   - 内置 **AI 伴读 Copilot**，支持划词即问、本地 `aih-server` 免密直连与自定义 BYOK 双模式。

---

## 🛠️ 标准出书工程规范与写作准则

编写技术章节时，**必须达到教科书/源码分析级深度**，杜绝泛泛而谈或概念堆砌：

### 1. 章节骨架结构标准
每个小节 Markdown 必须包含以下 7 大核心模块：
1. **章节导读与核心命题**：阐明无状态与具身运行时的范式转移，剖析核心技术痛点；
2. **核心专业术语权威中文释义表**：针对所有出现的专业英文名词给出精准中文定义与底层机制；
3. **架构机制与协议 Wire Payload 规范**：提供真实的 JSON / TypeScript / Rust / Go 数据结构；
4. **原生 SVG 矢量图 / Rich-HTML 流程图**：禁止使用生硬的 ASCII 字符画，一律使用现代 HTML/SVG 矢量芯片；
5. **核心源码级调用栈（Call Stack Trace）**：梳理真实调用链路；
6. **极端异常边界防御矩阵（Fault-Tolerance Matrix）**：针对死循环、429、崩溃提供确定性自愈策略；
7. **【对当前项目自主研发的落地指导与架构设计】**：针对宿主系统给出具体落地方案。

---

## 🎨 AI 概念插画与绘图标准

本技能已深度打通本地 `aih-server` 图像生成能力（基于 `gemini-3.1-flash-image`）：

### 1. 本地调用绘图脚本规范
```python
import urllib.request, json, base64, re, os

def generate_book_image(prompt, out_path):
    url = "http://127.0.0.1:9527/docs/harness-book/api/chat" # 或 /v1/chat/completions
    payload = {
        "model": "gemini-3.1-flash-image",
        "messages": [{"role": "user", "content": prompt}],
        "stream": False
    }
    req = urllib.request.Request(url, headers={"Content-Type": "application/json"}, data=json.dumps(payload).encode("utf-8"))
    with urllib.request.urlopen(req) as resp:
        data = json.loads(resp.read().decode("utf-8"))
        content = data["choices"][0]["message"]["content"]
        match = re.search(r"data:image\/[a-zA-Z]+;base64,([A-Za-z0-9+/=]+)", content)
        if match:
            img_data = base64.b64decode(match.group(1))
            os.makedirs(os.path.dirname(out_path), exist_ok=True)
            with open(out_path, "wb") as f:
                f.write(img_data)
            return True
    return False
```

### 2. 精品 Prompt 模板
> **Prompt 规范**：必须结合当前小节具体机制，要求 8K、暗黑深空底色（`#030712`）、极光蓝/紫流光、Octane Render 质感与中英双语标签。

---

## 🚀 常用执行工作流命令

### 场景 A：继续编写现有书籍未完成小节
```bash
/loop 15m /book-craft continue docs/harness-book/README.md
```
- 扫描 `README.md` 中第一个 `[待编写]` 章节；
- 编写小节落盘 -> 绘图 -> 打包 `book-data.js` -> 编译 WebUI -> Git 提交与推送。

### 场景 B：给定 GitHub 仓库一键出书
```bash
/book-craft generate --repo https://github.com/owner/repo --out docs/my-book/
```
1. 深度扫描仓库架构与核心源码模块；
2. 提炼出 5~6 个核心篇章，生成完整的 `README.md` 目录大纲；
3. 自动建立 `/loop` 任务逐章推进编写、AI 生图与 Web 阅读器交付。

### 场景 C：重新打包并编译 Web 阅读器
```bash
/book-craft build-reader docs/harness-book/
```
- 重新扫描所有 `.md` 章节，打包生成 `book-data.js`；
- 执行 `cd web && node ./node_modules/.bin/max build` 完成前端生产打包。

---

## 🛡️ 铁律与约束
1. **单次聚焦**：每次循环只编写一个完整小节，确保字数在 3,000~5,000 字且达到最高深度；
2. **严禁 ASCII 黑框**：架构图一律采用原生 Native Rich-HTML 芯片与 SVG 矢量图；
3. **双端免密**：生成的 Web 阅读器必须默认直连本地 `aih-server`（`/docs/.../api/chat`），确保读者开箱即用 AI 伴读。
