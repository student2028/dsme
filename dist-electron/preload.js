let electron = require("electron");
//#region electron/preload.ts
electron.contextBridge.exposeInMainWorld("electronAPI", {
	sendChatMessage: (message) => electron.ipcRenderer.send("chat-message", message),
	onChatReply: (callback) => {
		electron.ipcRenderer.on("chat-reply", (_e, v) => callback(v));
	},
	onChatStreamStart: (callback) => {
		electron.ipcRenderer.on("chat-stream-start", () => callback());
	},
	onChatStreamToken: (callback) => {
		electron.ipcRenderer.on("chat-stream-token", (_e, v) => callback(v));
	},
	onChatStreamEnd: (callback) => {
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
	onTerminalOutput: (callback) => {
		electron.ipcRenderer.on("terminal-output", (_e, d) => callback(d));
	},
	sendTerminalInput: (data) => electron.ipcRenderer.send("terminal-input", data),
	onFileChanged: (callback) => {
		electron.ipcRenderer.on("file-changed", (_e, fp) => callback(fp));
	},
	getConfig: () => electron.ipcRenderer.invoke("get-config"),
	saveConfig: (config) => electron.ipcRenderer.invoke("save-config", config)
});
//#endregion
