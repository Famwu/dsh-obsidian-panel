import { App, Modal, Notice, Plugin, PluginSettingTab } from "obsidian";

// ===== vault 路径推导（发布版：不写死任何本机路径）=====
// 约定：DSH 侧所有数据统一放在 <vault>/.dsh/ 下；插件在运行时从 Obsidian 自身推导 vault 根。
const DSH_DIR_NAME = ".dsh";
const INBOX_DIR_NAME = "inbox";
const NO_BASE_PATH_MESSAGE =
	"无法从 Obsidian 推导知识库根目录（移动端或受限环境不支持），请在「设置 → DSH Bridge」里手动填写收件箱目录。";

interface DSHBridgeSettings {
	dshInboxDir: string;
	workbenchUrl: string;
}

interface ResolvedInboxDir {
	path: string;
	source: "override" | "derived" | "none";
	vaultRoot: string;
	error: string;
}

/** 按路径自身风格选择分隔符：Windows 盘符 / UNC / 含反斜杠 → "\\"，否则 "/" */
function detectSeparator(p: unknown): string {
	const s = String(p == null ? "" : p);
	if (/^[A-Za-z]:[\\/]/.test(s) || /^\\\\/.test(s) || s.indexOf("\\") !== -1) return "\\";
	return "/";
}

/** 去掉尾部多余分隔符（保留盘符根与 POSIX 根） */
function stripTrailingSeparators(p: unknown): string {
	const s = String(p == null ? "" : p);
	if (!s) return "";
	if (/^[A-Za-z]:[\\/]*$/.test(s)) return s.slice(0, 2) + "\\";
	const out = s.replace(/[\\/]+$/, "");
	return out || "/";
}

/** 以 base 的风格拼接路径片段（自动去重分隔符，绝不产生 \\.dsh 这类双分隔符） */
function joinPath(base: unknown, ...parts: unknown[]): string {
	const sep = detectSeparator(base);
	let out = stripTrailingSeparators(base);
	for (const part of parts) {
		if (part == null) continue;
		const clean = String(part).replace(/^[\\/]+/, "").replace(/[\\/]+$/, "");
		if (!clean) continue;
		const seg = clean.split(/[\\/]+/).join(sep);
		if (!out || out === "/") out = out + seg;
		else if (/^[A-Za-z]:\\$/.test(out)) out = out + seg;
		else out = out + sep + seg;
	}
	return out;
}

/** 规范化 vault 根（去空白、去尾分隔符）；非字符串一律视为不可用 */
function normalizeVaultPath(p: unknown): string {
	if (typeof p !== "string") return "";
	const s = p.trim();
	if (!s) return "";
	return stripTrailingSeparators(s);
}

/** 运行时推导 vault 根目录；所有 API 形态都取不到时返回 ""（不抛异常） */
function getVaultBasePath(app: any): string {
	try {
		const vault = app && app.vault;
		const adapter = vault && vault.adapter;
		let raw: unknown = "";
		if (adapter) {
			if (typeof adapter.basePath === "string" && adapter.basePath) {
				raw = adapter.basePath;
			} else if (typeof adapter.getBasePath === "function") {
				raw = adapter.getBasePath();
			}
		}
		if (!raw && vault && typeof vault.getBasePath === "function") raw = vault.getBasePath();
		if (!raw && app && typeof app.getBasePath === "function") raw = app.getBasePath();
		return normalizeVaultPath(raw);
	} catch (e) {
		return "";
	}
}

/** 解析当前生效的收件箱目录（用户覆盖优先，否则从 vault 根推导） */
function resolveDshInboxDir(app: any, settings: Partial<DSHBridgeSettings> | null | undefined): ResolvedInboxDir {
	const override = settings && typeof settings.dshInboxDir === "string" ? settings.dshInboxDir.trim() : "";
	if (override) {
		return { path: override, source: "override", vaultRoot: "", error: "" };
	}
	const vaultRoot = getVaultBasePath(app);
	if (!vaultRoot) {
		return { path: "", source: "none", vaultRoot: "", error: NO_BASE_PATH_MESSAGE };
	}
	return {
		path: joinPath(vaultRoot, DSH_DIR_NAME, INBOX_DIR_NAME),
		source: "derived",
		vaultRoot,
		error: "",
	};
}

const DEFAULT_SETTINGS: DSHBridgeSettings = {
	// 留空 = 自动推导为 <vault>/.dsh/inbox；仅在需要放到别处时才填写（覆盖值）
	dshInboxDir: "",
	workbenchUrl: "http://127.0.0.1:8777/",
};

export default class DSHBridgePlugin extends Plugin {
	settings!: DSHBridgeSettings;

	async onload() {
		// 调试：onload 进入标记（在 loadSettings 之前）
		try {
			await this.app.vault.adapter.write(".dsh-bridge-debug", "onload-entered: " + new Date().toISOString());
		} catch (e) { /* ignore */ }
		await this.loadSettings();
		this.warnIfInboxPathUnavailable();

		// 加载心跳：写 ping 文件供外部（DSH）验证插件已运行
		try {
			const p = ".dsh-bridge-ping";
			if (!(await this.app.vault.adapter.exists(p))) {
				await this.app.vault.adapter.write(p, `loaded: ${new Date().toISOString()}\nversion: 0.1.0\n`);
			}
		} catch (e: any) {
			try { await this.app.vault.adapter.write(".dsh-bridge-debug", "ping-error: " + (e && e.message)); } catch {}
		}

		// 命令 1：把当前笔记送到 DSH 收件箱
		this.addCommand({
			id: "send-current-note-to-dsh",
			name: "把当前笔记送给 DSH 处理",
			callback: () => this.sendCurrentNote(),
		});

		// 命令 2：打开 Obsidian 工作台
		this.addCommand({
			id: "open-dsh-workbench",
			name: "打开 DSH Obsidian 工作台",
			callback: () => {
				window.open(this.settings.workbenchUrl, "_blank");
				new Notice("正在打开工作台…（若未响应，请先在 DSH 中启动工作台服务）");
			},
		});

		// 命令 3：知识库状态
		this.addCommand({
			id: "show-vault-stats",
			name: "查看知识库状态",
			callback: () => new VaultStatsModal(this.app).open(),
		});

		// 状态栏：笔记总数
		this.statusBarItem = this.addStatusBarItem();
		this.statusBarItem.setText("📚 " + this.app.vault.getMarkdownFiles().length + " 篇");

		// 设置
		this.addSettingTab(new DSHBridgeSettingTab(this) as unknown as PluginSettingTab);
	}

	onunload() {
		this.statusBarItem?.remove();
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}

	// 解析当前生效的收件箱目录（用户覆盖优先，否则从 vault 根推导）
	resolveInboxDir(): ResolvedInboxDir {
		return resolveDshInboxDir(this.app, this.settings);
	}

	// 推导失败时给出「可见」的错误提示，不静默失败
	warnIfInboxPathUnavailable(): ResolvedInboxDir {
		const r = this.resolveInboxDir();
		if (r.error) {
			new Notice("⚠️ DSH Bridge：" + r.error, 10000);
		}
		return r;
	}

	private async sendCurrentNote() {
		const view = this.app.workspace.getActiveFile();
		if (!view) {
			new Notice("没有打开的笔记");
			return;
		}
		const resolved = this.resolveInboxDir();
		if (!resolved.path) {
			new Notice("❌ " + resolved.error, 10000);
			return;
		}
		try {
			const content = await this.app.vault.read(view);
			const stamp = new Date().toISOString().replace(/[:.]/g, "-");
			const fileName = `${stamp}__${view.basename}.md`;
			const dir = resolved.path.replace(/\\/g, "/");
			// 桌面端直接用 Node fs 写任意路径（Obsidian 1.13 已移除 adapter.*Absolute / isDesktopPlatform API）
			const req = (window as any).require;
			if (typeof req !== "function") {
				new Notice("当前环境不支持 Node 模块（仅桌面端可用）");
				return;
			}
			const fs = req("fs").promises;
			await fs.mkdir(dir, { recursive: true });
			await fs.writeFile(
				dir + "/" + fileName,
				`---\nsource: "${view.path}"\nsent_at: "${new Date().toISOString()}"\n---\n\n${content}\n`
			);
			new Notice(`✅ 已送到 DSH 收件箱：${fileName}`);
		} catch (e: any) {
			new Notice(`❌ 发送失败：${e.message}`);
		}
	}

	statusBarItem: HTMLElement | null = null;
}

class VaultStatsModal extends Modal {
	constructor(app: App) {
		super(app);
	}
	onOpen() {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.createEl("h2", { text: "📚 知识库状态" });
		const files = this.app.vault.getMarkdownFiles();
		const now = Date.now();
		let totalChars = 0;
		for (const f of files) totalChars += f.stat.size;
		const recent7 = files.filter((f) => now - f.stat.mtime < 7 * 86400000).length;
		const lines = [
			`笔记总数：<b>${files.length}</b>`,
			`总字数（含标记）：<b>${Math.round(totalChars / 2).toLocaleString()}</b> 字符约`,
			`近 7 天更新：<b>${recent7}</b> 篇`,
			`最近修改：${[...files].sort((a, b) => b.stat.mtime - a.stat.mtime).slice(0, 5)
				.map((f) => `• ${f.path}（${new Date(f.stat.mtime).toLocaleString()}）`)
				.join("<br>")}`,
		];
		for (const l of lines) contentEl.createEl("p", { text: l, cls: "dsh-bridge-line" });
	}
	onClose() {
		this.contentEl.empty();
	}
}

// 注：此处刻意不 `extends PluginSettingTab`——Obsidian 设置面板只按鸭子类型调用 display()，
// 保持与已发布构建产物一致；此处用类型断言满足 tsc（若改为 extends，自检脚本的 obsidian mock
// 未提供 PluginSettingTab，会导致 main.js 加载即抛错）。
class DSHBridgeSettingTab {
	plugin: DSHBridgePlugin;
	constructor(plugin: DSHBridgePlugin) {
		this.plugin = plugin;
	}
	display(containerEl: HTMLElement) {
		containerEl.empty();
		const { Setting } = require("obsidian") as any;
		const resolved = resolveDshInboxDir(this.plugin.app, this.plugin.settings);
		const autoHint = resolved.source === "derived"
			? `留空 = 自动推导为：${resolved.path}`
			: resolved.error || "留空 = 自动推导为 <知识库>/.dsh/inbox";
		new Setting(containerEl)
			.setName("DSH 收件箱目录（可选覆盖）")
			.setDesc("「送给 DSH」命令把笔记复制到的目录。" + autoHint)
			.setPlaceholder(resolved.source === "override" ? "<知识库>/.dsh/inbox" : resolved.path || "<知识库>/.dsh/inbox")
			.setTextInput((v: any) =>
				v.setValue(this.plugin.settings.dshInboxDir).onChange(async (val: string) => {
					this.plugin.settings.dshInboxDir = val;
					await this.plugin.saveSettings();
				})
			);
		new Setting(containerEl)
			.setName("工作台地址")
			.setDesc("「打开工作台」命令访问的 URL")
			.setTextInput((v: any) =>
				v.setValue(this.plugin.settings.workbenchUrl).onChange(async (val: string) => {
					this.plugin.settings.workbenchUrl = val;
					await this.plugin.saveSettings();
				})
			);
	}
}

// 供自检脚本（tests/plugin-path-derivation.test.mjs）以纯函数方式调用；
// 不影响 Obsidian 加载（Obsidian 只读 .default）。
module.exports.__dshBridgePaths = {
	DSH_DIR_NAME,
	INBOX_DIR_NAME,
	NO_BASE_PATH_MESSAGE,
	DEFAULT_SETTINGS,
	detectSeparator,
	stripTrailingSeparators,
	joinPath,
	normalizeVaultPath,
	getVaultBasePath,
	resolveDshInboxDir,
};
