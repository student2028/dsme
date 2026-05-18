let electron = require("electron");
//#region electron/preload.ts
try {
	if (typeof document !== "undefined" && process.platform === "darwin") document.documentElement.classList.add("platform-darwin");
} catch {}
function createMultiSubscriberChannel(channel) {
	const subs = /* @__PURE__ */ new Set();
	let listening = false;
	return (callback) => {
		subs.add(callback);
		if (!listening) {
			listening = true;
			electron.ipcRenderer.on(channel, (_e, ...args) => subs.forEach((cb) => cb(...args)));
		}
		return () => {
			subs.delete(callback);
		};
	};
}
function createSingleListenerChannel(channel) {
	return (callback) => {
		const handler = (_e, ...args) => callback(...args);
		electron.ipcRenderer.on(channel, handler);
		return () => {
			electron.ipcRenderer.removeListener(channel, handler);
		};
	};
}
/** One live handler per channel; new subscribe clears previous (fixes stacked chat-stream under Strict Mode / HMR). */
function createExclusiveListenerChannel(channel) {
	return (callback) => {
		electron.ipcRenderer.removeAllListeners(channel);
		const handler = (_e, ...args) => callback(...args);
		electron.ipcRenderer.on(channel, handler);
		return () => {
			electron.ipcRenderer.removeListener(channel, handler);
		};
	};
}
electron.contextBridge.exposeInMainWorld("electronAPI", {
	sendChatMessage: (message) => electron.ipcRenderer.send("chat-message", message),
	sendChatMessageWithImages: (message, imageDataUrls) => electron.ipcRenderer.send("chat-message-images", message, imageDataUrls),
	onChatStreamStart: createMultiSubscriberChannel("chat-stream-start"),
	onChatStreamToken: createMultiSubscriberChannel("chat-stream-token"),
	onChatStreamEnd: createMultiSubscriberChannel("chat-stream-end"),
	onChatStatus: createMultiSubscriberChannel("chat-status"),
	getFileTree: (dir) => electron.ipcRenderer.invoke("get-file-tree", dir),
	openWorkspace: () => electron.ipcRenderer.invoke("open-workspace"),
	readFile: (filepath) => electron.ipcRenderer.invoke("read-file", filepath),
	writeFile: (filepath, content) => electron.ipcRenderer.invoke("write-file", filepath, content),
	renameFile: (oldPath, newPath) => electron.ipcRenderer.invoke("rename-file", oldPath, newPath),
	searchFiles: (query) => electron.ipcRenderer.invoke("search-files", query),
	searchCodebase: (query) => electron.ipcRenderer.invoke("search-codebase", query),
	getGitBranch: () => electron.ipcRenderer.invoke("get-git-branch"),
	getGitStatus: () => electron.ipcRenderer.invoke("get-git-status"),
	gitCommit: (msg) => electron.ipcRenderer.invoke("git-commit", msg),
	moveWindowBy: (dx, dy) => electron.ipcRenderer.send("move-window-by", dx, dy),
	onTerminalOutput: createSingleListenerChannel("terminal-output"),
	sendTerminalInput: (data) => electron.ipcRenderer.send("terminal-input", data),
	updateTitle: (title) => electron.ipcRenderer.send("update-title", title),
	onMenuAction: createSingleListenerChannel("menu-action"),
	showContextMenu: (path, isDir) => electron.ipcRenderer.send("show-context-menu", path, isDir),
	onContextMenuAction: createMultiSubscriberChannel("context-menu-action"),
	onFileChanged: createMultiSubscriberChannel("file-changed"),
	onDiffPreview: createSingleListenerChannel("diff-preview"),
	acceptDiff: (changeId) => electron.ipcRenderer.send("diff-accept", changeId),
	rejectDiff: (changeId) => electron.ipcRenderer.send("diff-reject", changeId),
	getConfig: () => electron.ipcRenderer.invoke("get-config"),
	saveConfig: (config) => electron.ipcRenderer.invoke("save-config", config),
	relaunchApp: () => electron.ipcRenderer.send("relaunch-app"),
	cancelChatRequest: () => electron.ipcRenderer.send("cancel-chat-request"),
	resetConversation: () => electron.ipcRenderer.send("reset-conversation"),
	saveConversations: (data) => electron.ipcRenderer.invoke("save-conversations", data),
	loadConversations: () => electron.ipcRenderer.invoke("load-conversations"),
	syncHistory: (messages) => electron.ipcRenderer.send("sync-history", messages),
	onRagStatus: createSingleListenerChannel("rag-status"),
	switchKernel: (kernel) => electron.ipcRenderer.send("switch-kernel", kernel),
	onKernelChanged: createExclusiveListenerChannel("kernel-changed"),
	onWebSearchExecute: (_cb) => () => {},
	sendWebSearchResults: (_results) => {},
	onBrowserCommand: (_cb) => () => {},
	sendBrowserResult: (_id, _result) => {},
	syncBrowserBounds: (bounds) => {
		electron.ipcRenderer.send("browser-view-bounds", bounds);
	},
	showBrowserView: (bounds) => {
		electron.ipcRenderer.send("browser-view-show", bounds);
	},
	hideBrowserView: () => {
		electron.ipcRenderer.send("browser-view-hide");
	},
	onBrowserViewNavigated: createMultiSubscriberChannel("browser-view-navigated"),
	onBrowserStep: createMultiSubscriberChannel("browser-step"),
	onBrowserPanelOpen: createMultiSubscriberChannel("browser-panel-open"),
	captureWindow: () => electron.ipcRenderer.invoke("capture-window"),
	getChromeProfiles: () => electron.ipcRenderer.invoke("get-chrome-profiles"),
	syncChromeCookies: (profileDirName) => electron.ipcRenderer.invoke("sync-chrome-cookies", profileDirName),
	browserGoBack: () => electron.ipcRenderer.invoke("browser-go-back"),
	browserGoForward: () => electron.ipcRenderer.invoke("browser-go-forward")
});
//#endregion
