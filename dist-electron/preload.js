let electron = require("electron");
//#region electron/preload.ts
electron.contextBridge.exposeInMainWorld("electronAPI", {
	sendChatMessage: (message) => electron.ipcRenderer.send("chat-message", message),
	sendChatMessageWithImages: (message, imageDataUrls) => electron.ipcRenderer.send("chat-message-images", message, imageDataUrls),
	onChatStreamStart: (callback) => {
		electron.ipcRenderer.removeAllListeners("chat-stream-start");
		electron.ipcRenderer.on("chat-stream-start", () => callback());
	},
	onChatStreamToken: (callback) => {
		electron.ipcRenderer.removeAllListeners("chat-stream-token");
		electron.ipcRenderer.on("chat-stream-token", (_e, v) => callback(v));
	},
	onChatStreamEnd: (callback) => {
		electron.ipcRenderer.removeAllListeners("chat-stream-end");
		electron.ipcRenderer.on("chat-stream-end", () => callback());
	},
	onChatStatus: (callback) => {
		electron.ipcRenderer.on("chat-status", (_e, v) => callback(v));
	},
	getFileTree: (dir) => electron.ipcRenderer.invoke("get-file-tree", dir),
	openWorkspace: () => electron.ipcRenderer.invoke("open-workspace"),
	readFile: (filepath) => electron.ipcRenderer.invoke("read-file", filepath),
	writeFile: (filepath, content) => electron.ipcRenderer.invoke("write-file", filepath, content),
	searchFiles: (query) => electron.ipcRenderer.invoke("search-files", query),
	searchCodebase: (query) => electron.ipcRenderer.invoke("search-codebase", query),
	getGitBranch: () => electron.ipcRenderer.invoke("get-git-branch"),
	getGitStatus: () => electron.ipcRenderer.invoke("get-git-status"),
	gitCommit: (msg) => electron.ipcRenderer.invoke("git-commit", msg),
	onTerminalOutput: (callback) => {
		electron.ipcRenderer.on("terminal-output", (_e, d) => callback(d));
	},
	sendTerminalInput: (data) => electron.ipcRenderer.send("terminal-input", data),
	updateTitle: (title) => electron.ipcRenderer.send("update-title", title),
	onMenuAction: (callback) => {
		electron.ipcRenderer.on("menu-action", (_e, action) => callback(action));
	},
	onFileChanged: (callback) => {
		electron.ipcRenderer.on("file-changed", (_e, fp) => callback(fp));
	},
	onDiffPreview: (callback) => {
		electron.ipcRenderer.on("diff-preview", (_e, change) => callback(change));
	},
	acceptDiff: (changeId) => electron.ipcRenderer.send("diff-accept", changeId),
	rejectDiff: (changeId) => electron.ipcRenderer.send("diff-reject", changeId),
	getConfig: () => electron.ipcRenderer.invoke("get-config"),
	saveConfig: (config) => electron.ipcRenderer.invoke("save-config", config),
	relaunchApp: () => electron.ipcRenderer.send("relaunch-app"),
	cancelChatRequest: () => electron.ipcRenderer.send("cancel-chat-request"),
	resetConversation: () => electron.ipcRenderer.send("reset-conversation"),
	saveConversations: (data) => electron.ipcRenderer.invoke("save-conversations", data),
	loadConversations: () => electron.ipcRenderer.invoke("load-conversations")
});
//#endregion
