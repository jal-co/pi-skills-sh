/**
 * skills-sh - Browse, install, and manage skills.sh skills from inside pi
 *
 * Commands:
 *   /skills           - Interactive search & install (modal UI)
 *   /skills find      - Search skills by keyword
 *   /skills add       - Add a skill package (owner/repo)
 *   /skills list      - List installed skills
 *   /skills remove    - Remove installed skills
 *   /skills update    - Update all installed skills
 *
 * Uses the `npx skills` CLI under the hood, targeting the `pi` agent.
 */

import type { ExtensionAPI, ExtensionCommandContext, Theme } from "@mariozechner/pi-coding-agent";
import { BorderedLoader } from "@mariozechner/pi-coding-agent";
import {
	type SelectItem,
	SelectList,
	Input,
	type TUI,
	matchesKey,
	Key,
	truncateToWidth,
	visibleWidth,
	type Focusable,
} from "@mariozechner/pi-tui";

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Strip ANSI escape codes from CLI output */
function stripAnsi(str: string): string {
	return str.replace(/\x1B\[[0-9;]*[a-zA-Z]|\x1B\].*?\x07|\x1B\[.*?[A-Za-z]|\[(\?25[hl]|999D|J)]/g, "");
}

/** Run `npx skills ...` and return { stdout, stderr, code } */
async function runSkills(
	pi: ExtensionAPI,
	args: string[],
	signal?: AbortSignal,
): Promise<{ stdout: string; stderr: string; code: number }> {
	const result = await pi.exec("npx", ["skills", ...args], {
		signal,
		timeout: 60_000,
		env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0" },
	});
	return {
		stdout: stripAnsi(result.stdout ?? ""),
		stderr: stripAnsi(result.stderr ?? ""),
		code: result.code ?? 1,
	};
}

// ── Parsers ──────────────────────────────────────────────────────────────────

interface SearchResult {
	id: string; // owner/repo@skill
	name: string;
	installs: string;
	url: string;
}

function parseSearchResults(output: string): SearchResult[] {
	const results: SearchResult[] = [];
	const lines = output.split("\n").filter((l) => l.trim());

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i].trim();
		const match = line.match(/^(\S+\/\S+@\S+)\s+([\d.]+K?\s*installs?)$/i);
		if (match) {
			const id = match[1];
			const installs = match[2];
			const name = id.split("@").pop() ?? id;
			const url = lines[i + 1]?.trim().replace(/^└\s*/, "") ?? "";
			results.push({ id, name, installs, url });
		}
	}
	return results;
}

interface InstalledSkill {
	name: string;
	path: string;
	scope: "Global" | "Project";
}

function parseListOutput(output: string): InstalledSkill[] {
	const skills: InstalledSkill[] = [];
	const lines = output.split("\n").filter((l) => l.trim());

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i].trim();
		const match = line.match(/^(\S+)\s+(~?\/.+)$/);
		if (match) {
			skills.push({
				name: match[1],
				path: match[2],
				scope: "Global",
			});
		}
	}
	return skills;
}

interface RepoSkill {
	name: string;
	description: string;
}

function parseRepoSkills(output: string): RepoSkill[] {
	const skills: RepoSkill[] = [];
	const lines = output.split("\n");

	let currentName: string | null = null;
	for (const line of lines) {
		const trimmed = line.trim();
		if (
			trimmed &&
			!trimmed.startsWith("─") &&
			!trimmed.startsWith("│") &&
			!trimmed.startsWith("└") &&
			!trimmed.startsWith("◇") &&
			!trimmed.startsWith("◆") &&
			!trimmed.startsWith("skills") &&
			!trimmed.startsWith("Tip:") &&
			!trimmed.startsWith("Source:") &&
			!trimmed.startsWith("Use --") &&
			!trimmed.startsWith("Found") &&
			!trimmed.startsWith("Repository") &&
			!trimmed.startsWith("Available") &&
			!trimmed.startsWith("Cloning") &&
			!trimmed.includes("███")
		) {
			if (currentName === null) {
				if (trimmed.length < 80 && !trimmed.includes("  ")) {
					currentName = trimmed;
				}
			} else {
				skills.push({ name: currentName, description: trimmed });
				currentName = null;
			}
		} else {
			currentName = null;
		}
	}
	return skills;
}

// ── Modal UI Components ─────────────────────────────────────────────────────

/**
 * Main skills hub modal — the landing page for /skills.
 * Shows tabs for Search, Installed, and actions.
 */
type HubTab = "search" | "installed";
type HubAction =
	| { type: "install"; id: string }
	| { type: "remove"; skill: InstalledSkill }
	| { type: "update" }
	| { type: "view"; skill: InstalledSkill }
	| null;

class SkillsHubModal implements Focusable {
	private activeTab: HubTab = "search";
	private searchInput: Input;
	private searchResults: SearchResult[] = [];
	private installedSkills: InstalledSkill[] = [];
	private searchList: SelectList | null = null;
	private installedList: SelectList | null = null;
	private isSearching = false;
	private searchQuery = "";
	private searchError = "";
	private hasSearched = false;
	private searchAbort: AbortController | null = null;
	private spinFrame = 0;
	private spinInterval: ReturnType<typeof setInterval> | null = null;

	// Focusable
	private _focused = false;
	get focused(): boolean {
		return this._focused;
	}
	set focused(value: boolean) {
		this._focused = value;
		this.searchInput.focused = value && this.activeTab === "search" && !this.hasSearched && !this.isSearching;
	}

	constructor(
		private pi: ExtensionAPI,
		private tui: TUI,
		private theme: Theme,
		private done: (action: HubAction) => void,
		initialInstalled: InstalledSkill[],
	) {
		this.installedSkills = initialInstalled;
		this.searchInput = new Input();
		this.rebuildInstalledList();
	}

	private selectListTheme() {
		const th = this.theme;
		return {
			selectedPrefix: (t: string) => th.fg("accent", t),
			selectedText: (t: string) => th.fg("accent", t),
			description: (t: string) => th.fg("muted", t),
			scrollInfo: (t: string) => th.fg("dim", t),
			noMatch: (t: string) => th.fg("warning", t),
		};
	}

	private rebuildSearchList() {
		const items: SelectItem[] = this.searchResults.map((r) => ({
			value: r.id,
			label: `${r.name}  ${r.installs}`,
			description: r.id,
		}));
		this.searchList = new SelectList(items, Math.min(items.length, 10), this.selectListTheme());
		this.searchList.onSelect = (item) => {
			this.done({ type: "install", id: item.value });
		};
		this.searchList.onCancel = () => {
			// Go back to search input
			this.hasSearched = false;
			this.searchResults = [];
			this.searchList = null;
			this.searchError = "";
			this.focused = this._focused;
			this.tui.requestRender();
		};
	}

	private rebuildInstalledList() {
		if (this.installedSkills.length === 0) {
			this.installedList = null;
			return;
		}
		const items: SelectItem[] = this.installedSkills.map((s) => ({
			value: s.name,
			label: `${s.name}  [${s.scope}]`,
			description: s.path,
		}));
		this.installedList = new SelectList(items, Math.min(items.length, 10), this.selectListTheme());
		this.installedList.onSelect = (item) => {
			const skill = this.installedSkills.find((s) => s.name === item.value);
			if (skill) this.done({ type: "view", skill });
		};
		this.installedList.onCancel = () => {
			this.done(null);
		};
	}

	/** Run search inline within the modal */
	private doSearch(query: string) {
		this.isSearching = true;
		this.searchQuery = query;
		this.searchError = "";
		this.focused = this._focused;

		// Start spinner animation
		this.spinInterval = setInterval(() => {
			this.spinFrame++;
			this.tui.requestRender();
		}, 150);

		this.searchAbort = new AbortController();
		runSkills(this.pi, ["find", query], this.searchAbort.signal)
			.then((result) => {
				if (this.searchAbort?.signal.aborted) return;
				this.stopSpinner();
				this.isSearching = false;
				const parsed = parseSearchResults(result.stdout);
				if (parsed.length === 0) {
					this.searchError = `No skills found for "${query}"`;
					this.hasSearched = true;
				} else {
					this.searchResults = parsed;
					this.hasSearched = true;
					this.rebuildSearchList();
				}
				this.focused = this._focused;
				this.tui.requestRender();
			})
			.catch(() => {
				if (this.searchAbort?.signal.aborted) return;
				this.stopSpinner();
				this.isSearching = false;
				this.searchError = "Search failed";
				this.hasSearched = true;
				this.tui.requestRender();
			});

		this.tui.requestRender();
	}

	private stopSpinner() {
		if (this.spinInterval) {
			clearInterval(this.spinInterval);
			this.spinInterval = null;
		}
	}

	dispose() {
		this.stopSpinner();
		this.searchAbort?.abort();
	}

	handleInput(data: string): void {
		// While searching, only allow escape to cancel
		if (this.isSearching) {
			if (matchesKey(data, Key.escape)) {
				this.searchAbort?.abort();
				this.stopSpinner();
				this.isSearching = false;
				this.searchError = "";
				this.focused = this._focused;
				this.tui.requestRender();
			}
			return;
		}

		// Tab switches panels (intercept before delegating to lists)
		if (matchesKey(data, Key.tab)) {
			this.activeTab = this.activeTab === "search" ? "installed" : "search";
			this.focused = this._focused;
			this.tui.requestRender();
			return;
		}

		// Search tab - input mode
		if (this.activeTab === "search" && !this.hasSearched) {
			if (matchesKey(data, Key.escape)) {
				this.done(null);
				return;
			}
			if (matchesKey(data, Key.enter)) {
				const query = this.searchInput.getValue().trim();
				if (query) {
					this.doSearch(query);
				}
				return;
			}
			this.searchInput.handleInput?.(data);
			this.tui.requestRender();
			return;
		}

		// Search error or no results — esc goes back to input
		if (this.activeTab === "search" && this.hasSearched && !this.searchList) {
			if (matchesKey(data, Key.escape)) {
				this.hasSearched = false;
				this.searchError = "";
				this.focused = this._focused;
				this.tui.requestRender();
			}
			return;
		}

		// Search results — delegate to SelectList
		if (this.activeTab === "search" && this.searchList) {
			this.searchList.handleInput(data);
			this.tui.requestRender();
			return;
		}

		// Installed tab
		if (this.activeTab === "installed") {
			if (matchesKey(data, "u")) {
				this.done({ type: "update" });
				return;
			}
			if (matchesKey(data, Key.escape)) {
				this.done(null);
				return;
			}
			if (this.installedList) {
				this.installedList.handleInput(data);
				this.tui.requestRender();
			}
			return;
		}
	}

	setInstalledSkills(skills: InstalledSkill[]) {
		this.installedSkills = skills;
		this.rebuildInstalledList();
		this.tui.requestRender();
	}

	render(width: number): string[] {
		const th = this.theme;
		const innerW = Math.max(1, width - 2);
		const lines: string[] = [];

		// ── Top border ──
		const title = " skills.sh ";
		const titleW = visibleWidth(title);
		const leftPad = Math.floor((innerW - titleW) / 2);
		const rightPad = Math.max(0, innerW - titleW - leftPad);
		lines.push(
			th.fg("border", "╭" + "─".repeat(leftPad)) +
				th.fg("accent", th.bold(title)) +
				th.fg("border", "─".repeat(rightPad) + "╮"),
		);

		// ── Tab bar ──
		const searchTab =
			this.activeTab === "search"
				? th.bg("selectedBg", th.fg("accent", " ⌕ Search "))
				: th.fg("muted", " ⌕ Search ");
		const installedTab =
			this.activeTab === "installed"
				? th.bg("selectedBg", th.fg("accent", " ▣ Installed "))
				: th.fg("muted", " ▣ Installed ");
		const tabLine = ` ${searchTab}  ${installedTab}`;
		lines.push(this.padLine(tabLine, width, th));

		// Separator
		lines.push(th.fg("border", "├" + "─".repeat(innerW) + "┤"));

		if (this.activeTab === "search") {
			if (this.isSearching) {
				// Inline loading
				lines.push(this.padLine("", width, th));
				const spinChars = ["◐", "◓", "◑", "◒"];
				const spin = spinChars[this.spinFrame % spinChars.length];
				lines.push(this.padLine(
					` ${th.fg("accent", spin!)} ${th.fg("muted", `Searching "${this.searchQuery}"...`)}`,
					width, th,
				));
				lines.push(this.padLine("", width, th));
			} else if (!this.hasSearched) {
				// Search input
				lines.push(this.padLine("", width, th));
				lines.push(this.padLine(` ${th.fg("muted", "Search for skills:")}`, width, th));
				lines.push(this.padLine("", width, th));
				const inputLines = this.searchInput.render(innerW - 2);
				for (const il of inputLines) {
					lines.push(this.padLine(` ${il}`, width, th));
				}
				lines.push(this.padLine("", width, th));
			} else if (this.searchError) {
				// Error / no results
				lines.push(this.padLine("", width, th));
				lines.push(this.padLine(` ${th.fg("warning", this.searchError)}`, width, th));
				lines.push(this.padLine("", width, th));
			} else if (this.searchList) {
				// Search results via SelectList
				lines.push(this.padLine(
					` ${th.fg("dim", `${this.searchResults.length} result${this.searchResults.length === 1 ? "" : "s"} for "${this.searchQuery}"`)}`,
					width, th,
				));
				const listLines = this.searchList.render(innerW);
				for (const ll of listLines) {
					lines.push(this.padLine(ll, width, th));
				}
			}
		} else {
			// Installed tab
			if (this.installedList) {
				lines.push(this.padLine(
					` ${th.fg("dim", `${this.installedSkills.length} skill${this.installedSkills.length === 1 ? "" : "s"} installed`)}`,
					width, th,
				));
				const listLines = this.installedList.render(innerW);
				for (const ll of listLines) {
					lines.push(this.padLine(ll, width, th));
				}
			} else {
				lines.push(this.padLine("", width, th));
				lines.push(this.padLine(` ${th.fg("muted", "No skills installed.")}`, width, th));
				lines.push(this.padLine(` ${th.fg("dim", "Switch to Search tab to find skills.")}`, width, th));
				lines.push(this.padLine("", width, th));
			}
		}

		// ── Footer help ──
		lines.push(th.fg("border", "├" + "─".repeat(innerW) + "┤"));

		if (this.isSearching) {
			lines.push(this.padLine(` ${th.fg("dim", "esc cancel")}`, width, th));
		} else if (this.activeTab === "search" && !this.hasSearched) {
			lines.push(this.padLine(` ${th.fg("dim", "enter search • tab switch • esc close")}`, width, th));
		} else if (this.activeTab === "search" && this.searchError) {
			lines.push(this.padLine(` ${th.fg("dim", "esc back to search")}`, width, th));
		} else if (this.activeTab === "search") {
			lines.push(this.padLine(` ${th.fg("dim", "↑↓ navigate • enter install • esc back • tab switch")}`, width, th));
		} else {
			lines.push(this.padLine(` ${th.fg("dim", "↑↓ navigate • enter view • u update • tab switch • esc close")}`, width, th));
		}

		// ── Bottom border ──
		lines.push(th.fg("border", "╰" + "─".repeat(innerW) + "╯"));

		return lines;
	}

	private padLine(content: string, width: number, th: Theme): string {
		return th.fg("border", "│") + truncateToWidth(content, width - 2, "…", true) + th.fg("border", "│");
	}

	invalidate(): void {
		this.searchList?.invalidate();
		this.installedList?.invalidate();
		this.searchInput.invalidate();
	}
}

// ── Skill Detail Modal ──────────────────────────────────────────────────────

type DetailAction = "install" | "remove" | "back" | null;

class SkillDetailModal {
	private selectedIndex = 0;
	private actions: { label: string; action: DetailAction }[] = [];

	constructor(
		private tui: TUI,
		private theme: Theme,
		private done: (action: DetailAction) => void,
		private skill: { name: string; id?: string; installs?: string; path?: string; scope?: string },
		private mode: "search" | "installed",
	) {
		if (mode === "search") {
			this.actions = [
				{ label: "Install", action: "install" },
				{ label: "Back", action: "back" },
			];
		} else {
			this.actions = [
				{ label: "Remove", action: "remove" },
				{ label: "Back", action: "back" },
			];
		}
	}

	handleInput(data: string): void {
		if (matchesKey(data, Key.escape)) {
			this.done("back");
		} else if (matchesKey(data, Key.up) && this.selectedIndex > 0) {
			this.selectedIndex--;
			this.tui.requestRender();
		} else if (matchesKey(data, Key.down) && this.selectedIndex < this.actions.length - 1) {
			this.selectedIndex++;
			this.tui.requestRender();
		} else if (matchesKey(data, Key.enter)) {
			this.done(this.actions[this.selectedIndex].action);
		}
	}

	render(width: number): string[] {
		const th = this.theme;
		const lines: string[] = [];

		// Title
		const title = ` ${this.skill.name} `;
		const titleW = visibleWidth(title);
		const leftPad = Math.floor((width - 2 - titleW) / 2);
		const rightPad = Math.max(0, width - 2 - titleW - leftPad);
		lines.push(
			th.fg("border", "╭" + "─".repeat(leftPad)) +
				th.fg("accent", th.bold(title)) +
				th.fg("border", "─".repeat(rightPad) + "╮"),
		);

		lines.push(this.pad("", width, th));

		if (this.skill.id) {
			lines.push(this.pad(` ${th.fg("muted", "Package:")} ${th.fg("text", this.skill.id)}`, width, th));
		}
		if (this.skill.installs) {
			lines.push(
				this.pad(` ${th.fg("muted", "Installs:")} ${th.fg("text", this.skill.installs)}`, width, th),
			);
		}
		if (this.skill.path) {
			lines.push(this.pad(` ${th.fg("muted", "Path:")} ${th.fg("text", this.skill.path)}`, width, th));
		}
		if (this.skill.scope) {
			lines.push(this.pad(` ${th.fg("muted", "Scope:")} ${th.fg("text", this.skill.scope)}`, width, th));
		}

		lines.push(this.pad("", width, th));
		lines.push(th.fg("border", "├" + "─".repeat(width - 2) + "┤"));
		lines.push(this.pad("", width, th));

		for (let i = 0; i < this.actions.length; i++) {
			const a = this.actions[i];
			const selected = i === this.selectedIndex;
			const prefix = selected ? th.fg("accent", "▸ ") : "  ";
			const label = selected ? th.fg("accent", th.bold(a.label)) : th.fg("text", a.label);
			lines.push(this.pad(` ${prefix}${label}`, width, th));
		}

		lines.push(this.pad("", width, th));
		lines.push(th.fg("border", "╰" + "─".repeat(width - 2) + "╯"));

		return lines;
	}

	private pad(content: string, width: number, th: Theme): string {
		return th.fg("border", "│") + truncateToWidth(content, width - 2, "…", true) + th.fg("border", "│");
	}

	invalidate(): void {}
}

// ── Scope Selector Modal ────────────────────────────────────────────────────

type ScopeChoice = "global" | "project" | null;

class ScopeSelectorModal {
	private selectedIndex = 0;
	private items = [
		{ label: "Global", desc: "Available in all projects (~/.pi/agent/skills/)", value: "global" as const },
		{ label: "Project", desc: "Local to this project (.pi/skills/)", value: "project" as const },
	];

	constructor(
		private tui: TUI,
		private theme: Theme,
		private done: (choice: ScopeChoice) => void,
		private skillName: string,
	) {}

	handleInput(data: string): void {
		if (matchesKey(data, Key.escape)) {
			this.done(null);
		} else if (matchesKey(data, Key.up) && this.selectedIndex > 0) {
			this.selectedIndex--;
			this.tui.requestRender();
		} else if (matchesKey(data, Key.down) && this.selectedIndex < this.items.length - 1) {
			this.selectedIndex++;
			this.tui.requestRender();
		} else if (matchesKey(data, Key.enter)) {
			this.done(this.items[this.selectedIndex].value);
		}
	}

	render(width: number): string[] {
		const th = this.theme;
		const lines: string[] = [];

		const title = ` Install ${this.skillName} `;
		const titleW = visibleWidth(title);
		const leftPad = Math.floor((width - 2 - titleW) / 2);
		const rightPad = Math.max(0, width - 2 - titleW - leftPad);
		lines.push(
			th.fg("border", "╭" + "─".repeat(leftPad)) +
				th.fg("accent", th.bold(title)) +
				th.fg("border", "─".repeat(rightPad) + "╮"),
		);

		lines.push(this.pad("", width, th));
		lines.push(this.pad(` ${th.fg("muted", "Choose install scope:")}`, width, th));
		lines.push(this.pad("", width, th));

		for (let i = 0; i < this.items.length; i++) {
			const item = this.items[i];
			const selected = i === this.selectedIndex;
			const prefix = selected ? th.fg("accent", "▸ ") : "  ";
			const label = selected ? th.fg("accent", th.bold(item.label)) : th.fg("text", item.label);
			lines.push(this.pad(` ${prefix}${label}`, width, th));
			lines.push(this.pad(`   ${th.fg("dim", item.desc)}`, width, th));
		}

		lines.push(this.pad("", width, th));
		lines.push(
			this.pad(` ${th.fg("dim", "↑↓ navigate • enter select • esc cancel")}`, width, th),
		);
		lines.push(th.fg("border", "╰" + "─".repeat(width - 2) + "╯"));

		return lines;
	}

	private pad(content: string, width: number, th: Theme): string {
		return th.fg("border", "│") + truncateToWidth(content, width - 2, "…", true) + th.fg("border", "│");
	}

	invalidate(): void {}
}

// ── Bordered SelectList Overlay Helper ────────────────────────────────────────

/**
 * Show a bordered select overlay with proper box-drawing borders.
 * Returns the selected item value, or null if cancelled.
 */
async function borderedSelectOverlay<T extends string>(
	ctx: ExtensionCommandContext,
	title: string,
	items: SelectItem[],
	helpText: string,
): Promise<T | null> {
	return ctx.ui.custom<T | null>(
		(tui, theme, _kb, done) => {
			const selectList = new SelectList(items, Math.min(items.length, 10), {
				selectedPrefix: (t: string) => theme.fg("accent", t),
				selectedText: (t: string) => theme.fg("accent", t),
				description: (t: string) => theme.fg("muted", t),
				scrollInfo: (t: string) => theme.fg("dim", t),
				noMatch: (t: string) => theme.fg("warning", t),
			});
			selectList.onSelect = (item) => done(item.value as T);
			selectList.onCancel = () => done(null);

			const pad = (content: string, width: number) =>
				theme.fg("border", "│") + truncateToWidth(content, width - 2, "…", true) + theme.fg("border", "│");

			return {
				render(width: number): string[] {
					const th = theme;
					const innerW = Math.max(1, width - 2);
					const lines: string[] = [];

					// Top border with title
					const titleStr = ` ${title} `;
					const titleW = visibleWidth(titleStr);
					const leftPad = Math.floor((innerW - titleW) / 2);
					const rightPad = Math.max(0, innerW - titleW - leftPad);
					lines.push(
						th.fg("border", "╭" + "─".repeat(leftPad)) +
							th.fg("accent", th.bold(titleStr)) +
							th.fg("border", "─".repeat(rightPad) + "╮"),
					);

					// SelectList content
					const listLines = selectList.render(innerW);
					for (const ll of listLines) {
						lines.push(pad(ll, width));
					}

					// Footer
					lines.push(th.fg("border", "├" + "─".repeat(innerW) + "┤"));
					lines.push(pad(` ${th.fg("dim", helpText)}`, width));
					lines.push(th.fg("border", "╰" + "─".repeat(innerW) + "╯"));

					return lines;
				},
				invalidate() {
					selectList.invalidate();
				},
				handleInput(data: string) {
					selectList.handleInput(data);
					tui.requestRender();
				},
			};
		},
		{
			overlay: true,
			overlayOptions: {
				anchor: "center",
				width: "60%",
				minWidth: 50,
				maxHeight: "80%",
			},
		},
	);
}

// ── Subcommands ──────────────────────────────────────────────────────────────

/** Fetch installed skills from both scopes */
async function fetchInstalled(
	pi: ExtensionAPI,
	signal?: AbortSignal,
): Promise<InstalledSkill[]> {
	const [globalResult, projectResult] = await Promise.all([
		runSkills(pi, ["list", "-g", "-a", "pi"], signal),
		runSkills(pi, ["list", "-a", "pi"], signal),
	]);

	const globalSkills = parseListOutput(globalResult.stdout).map((s) => ({ ...s, scope: "Global" as const }));
	const projectSkills = parseListOutput(projectResult.stdout).map((s) => ({ ...s, scope: "Project" as const }));
	return [...globalSkills, ...projectSkills];
}

/** Interactive hub - the main /skills experience */
async function skillsHub(pi: ExtensionAPI, ctx: ExtensionCommandContext) {
	// Load installed skills first
	const installed = await ctx.ui.custom<InstalledSkill[] | null>((tui, theme, _kb, done) => {
		const loader = new BorderedLoader(tui, theme, "Loading skills...");
		loader.onAbort = () => done(null);
		fetchInstalled(pi, loader.signal).then((r) => done(r)).catch(() => done([]));
		return loader;
	});

	if (installed === null) return;

	let currentInstalled = installed;

	// Main hub loop — re-shows modal after each action
	while (true) {
		const action = await ctx.ui.custom<HubAction>(
			(tui, theme, _kb, done) => {
				const modal = new SkillsHubModal(pi, tui, theme, done, currentInstalled);
				const wrapper = {
					render: (w: number) => modal.render(w),
					invalidate: () => modal.invalidate(),
					handleInput: (data: string) => modal.handleInput(data),
					get focused() {
						return modal.focused;
					},
					set focused(v: boolean) {
						modal.focused = v;
					},
					dispose() {
						modal.dispose();
					},
				};
				return wrapper;
			},
			{
				overlay: true,
				overlayOptions: {
					anchor: "center",
					width: "60%",
					minWidth: 50,
					maxHeight: "80%",
				},
			},
		);

		if (!action) break; // esc — exit

		if (action.type === "install") {
			const name = action.id.split("@").pop() ?? action.id;
			const didInstall = await installSkillFlow(pi, action.id, name, ctx);
			if (didInstall) {
				const refreshed = await fetchInstalledQuietly(pi);
				if (refreshed) currentInstalled = refreshed;
			}
			continue;
		}

		if (action.type === "remove") {
			const didRemove = await removeSkillFlow(pi, action.skill, ctx);
			if (didRemove) {
				const refreshed = await fetchInstalledQuietly(pi);
				if (refreshed) currentInstalled = refreshed;
			}
			continue;
		}

		if (action.type === "update") {
			await updateSkillsFlow(pi, ctx);
			const refreshed = await fetchInstalledQuietly(pi);
			if (refreshed) currentInstalled = refreshed;
			continue;
		}

		if (action.type === "view") {
			const detailAction = await ctx.ui.custom<DetailAction>(
				(tui, theme, _kb, done) => {
					const detail = new SkillDetailModal(
						tui,
						theme,
						done,
						{
							name: action.skill.name,
							path: action.skill.path,
							scope: action.skill.scope,
						},
						"installed",
					);
					return {
						render: (w: number) => detail.render(w),
						invalidate: () => detail.invalidate(),
						handleInput: (data: string) => detail.handleInput(data),
					};
				},
				{
					overlay: true,
					overlayOptions: {
						anchor: "center",
						width: "50%",
						minWidth: 40,
						maxHeight: "60%",
					},
				},
			);

			if (detailAction === "remove") {
				const didRemove = await removeSkillFlow(pi, action.skill, ctx);
				if (didRemove) {
					const refreshed = await fetchInstalledQuietly(pi);
					if (refreshed) currentInstalled = refreshed;
				}
			}
			continue;
		}
	}
}

/** Install skill flow with scope selector overlay */
async function installSkillFlow(
	pi: ExtensionAPI,
	source: string,
	displayName: string,
	ctx: ExtensionCommandContext,
): Promise<boolean> {
	// Pick scope via overlay
	const scope = await ctx.ui.custom<ScopeChoice>(
		(tui, theme, _kb, done) => {
			const modal = new ScopeSelectorModal(tui, theme, done, displayName);
			return {
				render: (w: number) => modal.render(w),
				invalidate: () => modal.invalidate(),
				handleInput: (data: string) => modal.handleInput(data),
			};
		},
		{
			overlay: true,
			overlayOptions: {
				anchor: "center",
				width: "50%",
				minWidth: 40,
				maxHeight: "50%",
			},
		},
	);

	if (!scope) return false;

	const isGlobal = scope === "global";
	const flagArgs = ["-a", "pi", "-y"];
	if (isGlobal) flagArgs.push("-g");
	else flagArgs.push("--copy");

	// If source contains @, it's owner/repo@skill — install directly
	// Otherwise it's owner/repo — install all
	const installResult = await ctx.ui.custom<{ ok: boolean; output: string } | null>(
		(tui, theme, _kb, done) => {
			const loader = new BorderedLoader(tui, theme, `Installing ${displayName}...`);
			loader.onAbort = () => done(null);

			runSkills(pi, ["add", source, ...flagArgs], loader.signal)
				.then((result) => {
					if (loader.signal.aborted) return;
					done({ ok: result.code === 0, output: result.stdout + result.stderr });
				})
				.catch((err) => done({ ok: false, output: String(err) }));

			return loader;
		},
	);

	if (!installResult) {
		ctx.ui.notify("Installation cancelled", "info");
		return false;
	}

	if (installResult.ok) {
		ctx.ui.notify(`✓ Installed ${displayName} (${isGlobal ? "global" : "project"})`, "info");
		const reload = await ctx.ui.confirm("Reload?", "Reload pi to activate the new skill?");
		if (reload) {
			await ctx.reload();
		}
		return true;
	} else {
		ctx.ui.notify(`✗ Failed to install ${displayName}`, "error");
		const lines = installResult.output
			.split("\n")
			.filter((l) => l.trim())
			.slice(0, 5);
		for (const line of lines) {
			ctx.ui.notify(line, "error");
		}
		return false;
	}
}

/** Remove skill flow */
async function removeSkillFlow(
	pi: ExtensionAPI,
	skill: InstalledSkill,
	ctx: ExtensionCommandContext,
): Promise<boolean> {
	const ok = await ctx.ui.confirm(
		"Remove skill?",
		`Remove ${skill.name} from ${skill.scope.toLowerCase()} scope?`,
	);
	if (!ok) return false;

	const isGlobal = skill.scope === "Global";
	const removeArgs = [skill.name, "-a", "pi", "-y"];
	if (isGlobal) removeArgs.push("-g");

	const result = await ctx.ui.custom<{ ok: boolean; output: string } | null>((tui, theme, _kb, done) => {
		const loader = new BorderedLoader(tui, theme, `Removing ${skill.name}...`);
		loader.onAbort = () => done(null);

		runSkills(pi, ["remove", ...removeArgs], loader.signal)
			.then((r) => {
				if (loader.signal.aborted) return;
				done({ ok: r.code === 0, output: r.stdout + r.stderr });
			})
			.catch((err) => done({ ok: false, output: String(err) }));

		return loader;
	});

	if (!result) return false;

	if (result.ok) {
		ctx.ui.notify(`✓ Removed ${skill.name}`, "info");
		const reload = await ctx.ui.confirm("Reload?", "Reload pi to update available skills?");
		if (reload) {
			await ctx.reload();
		}
		return true;
	} else {
		ctx.ui.notify(`✗ Failed to remove ${skill.name}`, "error");
		return false;
	}
}

/** Update all skills flow */
async function updateSkillsFlow(pi: ExtensionAPI, ctx: ExtensionCommandContext): Promise<void> {
	const result = await ctx.ui.custom<{ ok: boolean; output: string } | null>((tui, theme, _kb, done) => {
		const loader = new BorderedLoader(tui, theme, "Updating all installed skills...");
		loader.onAbort = () => done(null);

		runSkills(pi, ["update"], loader.signal)
			.then((r) => {
				if (loader.signal.aborted) return;
				done({ ok: r.code === 0, output: r.stdout + r.stderr });
			})
			.catch((err) => done({ ok: false, output: String(err) }));

		return loader;
	});

	if (!result) {
		ctx.ui.notify("Update cancelled", "info");
		return;
	}

	if (result.ok) {
		ctx.ui.notify("✓ Skills updated", "info");
		const reload = await ctx.ui.confirm("Reload?", "Reload pi to apply updates?");
		if (reload) {
			await ctx.reload();
		}
	} else {
		ctx.ui.notify("✗ Update failed", "error");
		const lines = result.output
			.split("\n")
			.filter((l) => l.trim())
			.slice(0, 5);
		for (const line of lines) {
			ctx.ui.notify(line, "error");
		}
	}
}

/** Quietly fetch installed skills (no loader UI) */
async function fetchInstalledQuietly(pi: ExtensionAPI): Promise<InstalledSkill[] | null> {
	try {
		return await fetchInstalled(pi);
	} catch {
		return null;
	}
}

// ── Direct subcommands (for /skills find, /skills add, etc.) ─────────────────

async function skillsFind(pi: ExtensionAPI, args: string, ctx: ExtensionCommandContext) {
	const query = args.trim();
	if (!query) {
		ctx.ui.notify("Usage: /skills find <query>", "warning");
		return;
	}

	const searchResult = await ctx.ui.custom<SearchResult[] | null>((tui, theme, _kb, done) => {
		const loader = new BorderedLoader(tui, theme, `Searching skills.sh for "${query}"...`);
		loader.onAbort = () => done(null);
		runSkills(pi, ["find", query], loader.signal)
			.then((result) => {
				if (loader.signal.aborted) return;
				done(parseSearchResults(result.stdout));
			})
			.catch(() => done(null));
		return loader;
	});

	if (!searchResult) {
		ctx.ui.notify("Search cancelled", "info");
		return;
	}

	if (searchResult.length === 0) {
		ctx.ui.notify(`No skills found for "${query}"`, "info");
		return;
	}

	// Show results in bordered overlay
	const findItems: SelectItem[] = searchResult.map((r) => ({
		value: r.id,
		label: `${r.name}  ${r.installs}`,
		description: r.id,
	}));

	const selectedId = await borderedSelectOverlay<string>(
		ctx,
		`${searchResult.length} results for "${query}"`,
		findItems,
		"↑↓ navigate • enter install • esc cancel",
	);

	if (!selectedId) return;
	const selectedSkill = searchResult.find((r) => r.id === selectedId);
	if (!selectedSkill) return;

	await installSkillFlow(pi, selectedSkill.id, selectedSkill.name, ctx);
}

async function skillsAdd(pi: ExtensionAPI, args: string, ctx: ExtensionCommandContext) {
	const source = args.trim();
	if (!source) {
		ctx.ui.notify("Usage: /skills add <owner/repo>  or  /skills add <owner/repo@skill>", "warning");
		return;
	}

	if (source.includes("@")) {
		const name = source.split("@").pop() ?? source;
		await installSkillFlow(pi, source, name, ctx);
		return;
	}

	// List available skills in the repo
	const repoSkills = await ctx.ui.custom<RepoSkill[] | null>((tui, theme, _kb, done) => {
		const loader = new BorderedLoader(tui, theme, `Listing skills in ${source}...`);
		loader.onAbort = () => done(null);
		runSkills(pi, ["add", source, "--list"], loader.signal)
			.then((result) => {
				if (loader.signal.aborted) return;
				done(parseRepoSkills(result.stdout));
			})
			.catch(() => done(null));
		return loader;
	});

	if (!repoSkills) {
		ctx.ui.notify("Cancelled", "info");
		return;
	}

	if (repoSkills.length === 0) {
		const ok = await ctx.ui.confirm("No individual skills found", `Install all from ${source}?`);
		if (ok) await installSkillFlow(pi, source, source, ctx);
		return;
	}

	// Let user pick skills via bordered overlay
	const repoItems: SelectItem[] = [
		{ value: "__all__", label: "★ Install ALL skills", description: `All ${repoSkills.length} skills from ${source}` },
		...repoSkills.map((s) => ({
			value: s.name,
			label: s.name,
			description: s.description.slice(0, 80),
		})),
	];

	const selected = await borderedSelectOverlay<string>(
		ctx,
		`Skills in ${source}`,
		repoItems,
		"↑↓ navigate • enter select • esc cancel",
	);

	if (!selected) return;

	if (selected === "__all__") {
		await installSkillFlow(pi, source, `${source} (all)`, ctx);
	} else {
		await installSkillFlow(pi, source, selected, ctx);
	}
}

async function skillsList(pi: ExtensionAPI, _args: string, ctx: ExtensionCommandContext) {
	const installed = await ctx.ui.custom<InstalledSkill[] | null>((tui, theme, _kb, done) => {
		const loader = new BorderedLoader(tui, theme, "Loading installed skills...");
		loader.onAbort = () => done(null);
		fetchInstalled(pi, loader.signal).then((r) => done(r)).catch(() => done(null));
		return loader;
	});

	if (!installed) {
		ctx.ui.notify("Cancelled", "info");
		return;
	}

	if (installed.length === 0) {
		ctx.ui.notify("No pi skills installed. Use /skills find <query> to discover skills.", "info");
		return;
	}

	const listItems: SelectItem[] = installed.map((s) => ({
		value: s.name,
		label: `${s.name}  [${s.scope}]`,
		description: s.path,
	}));

	const selected = await borderedSelectOverlay<string>(
		ctx,
		`Installed Skills (${installed.length})`,
		listItems,
		"↑↓ navigate • enter view • esc close",
	);

	if (!selected) return;

	const skill = installed.find((s) => s.name === selected);
	if (!skill) return;

	// Show detail overlay
	const detailAction = await ctx.ui.custom<DetailAction>(
		(tui, theme, _kb, done) => {
			const detail = new SkillDetailModal(
				tui,
				theme,
				done,
				{ name: skill.name, path: skill.path, scope: skill.scope },
				"installed",
			);
			return {
				render: (w: number) => detail.render(w),
				invalidate: () => detail.invalidate(),
				handleInput: (data: string) => detail.handleInput(data),
			};
		},
		{
			overlay: true,
			overlayOptions: {
				anchor: "center",
				width: "50%",
				minWidth: 40,
				maxHeight: "60%",
			},
		},
	);

	if (detailAction === "remove") {
		await removeSkillFlow(pi, skill, ctx);
	}
}

async function skillsRemove(pi: ExtensionAPI, args: string, ctx: ExtensionCommandContext) {
	const skillName = args.trim();

	if (skillName) {
		// Direct removal — ask scope
		const scope = await ctx.ui.custom<ScopeChoice>(
			(tui, theme, _kb, done) => {
				const modal = new ScopeSelectorModal(tui, theme, (choice) => {
					done(choice);
				}, skillName);
				return {
					render: (w: number) => modal.render(w),
					invalidate: () => modal.invalidate(),
					handleInput: (data: string) => modal.handleInput(data),
				};
			},
			{
				overlay: true,
				overlayOptions: { anchor: "center", width: "50%", minWidth: 40, maxHeight: "50%" },
			},
		);
		if (!scope) return;

		await removeSkillFlow(
			pi,
			{ name: skillName, path: "", scope: scope === "global" ? "Global" : "Project" },
			ctx,
		);
		return;
	}

	// Interactive: list then pick
	const installed = await ctx.ui.custom<InstalledSkill[] | null>((tui, theme, _kb, done) => {
		const loader = new BorderedLoader(tui, theme, "Loading installed skills...");
		loader.onAbort = () => done(null);
		fetchInstalled(pi, loader.signal).then((r) => done(r)).catch(() => done(null));
		return loader;
	});

	if (!installed || installed.length === 0) {
		ctx.ui.notify("No skills to remove", "info");
		return;
	}

	const removeItems: SelectItem[] = installed.map((s) => ({
		value: s.name,
		label: `${s.name}  [${s.scope}]`,
		description: s.path,
	}));

	const selected = await borderedSelectOverlay<string>(
		ctx,
		"Select skill to remove",
		removeItems,
		"↑↓ navigate • enter remove • esc cancel",
	);

	if (!selected) return;

	const skill = installed.find((s) => s.name === selected);
	if (skill) {
		await removeSkillFlow(pi, skill, ctx);
	}
}

async function skillsUpdate(pi: ExtensionAPI, _args: string, ctx: ExtensionCommandContext) {
	await updateSkillsFlow(pi, ctx);
}

// ── Main Extension ───────────────────────────────────────────────────────────

export default function skillsShExtension(pi: ExtensionAPI) {
	pi.registerCommand("skills", {
		description: "Browse, install & manage skills.sh skills",
		getArgumentCompletions: (prefix) => {
			const subcommands = [
				{ value: "find ", label: "find", description: "Search skills by keyword" },
				{ value: "add ", label: "add", description: "Add a skill (owner/repo)" },
				{ value: "list", label: "list", description: "List installed skills" },
				{ value: "remove ", label: "remove", description: "Remove a skill" },
				{ value: "update", label: "update", description: "Update all skills" },
			];
			const filtered = subcommands.filter((s) => s.value.startsWith(prefix));
			return filtered.length > 0 ? filtered : null;
		},
		handler: async (args, ctx) => {
			if (!ctx.hasUI) {
				ctx.ui.notify("skills-sh requires interactive mode", "error");
				return;
			}

			const trimmed = args.trim();

			if (trimmed.startsWith("find ") || trimmed === "find") {
				await skillsFind(pi, trimmed.slice(5), ctx);
			} else if (trimmed.startsWith("add ") || trimmed === "add") {
				await skillsAdd(pi, trimmed.slice(4), ctx);
			} else if (trimmed.startsWith("list") || trimmed === "ls") {
				await skillsList(pi, trimmed.slice(4), ctx);
			} else if (trimmed.startsWith("remove ") || trimmed === "remove" || trimmed === "rm") {
				const removeArgs = trimmed.startsWith("remove ")
					? trimmed.slice(7)
					: trimmed === "rm"
						? ""
						: trimmed.slice(6);
				await skillsRemove(pi, removeArgs, ctx);
			} else if (trimmed === "update") {
				await skillsUpdate(pi, "", ctx);
			} else if (trimmed === "") {
				// Default: open the hub modal
				await skillsHub(pi, ctx);
			} else {
				// Assume it's a search query
				await skillsFind(pi, trimmed, ctx);
			}
		},
	});
}
