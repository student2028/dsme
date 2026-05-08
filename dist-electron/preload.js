let electron = require("electron");
//#region electron/preload.ts
electron.contextBridge.exposeInMainWorld("electronAPI", {
	sendChatMessage: (message) => electron.ipcRenderer.send("chat-message", message),
	onChatReply: (callback) => {
		electron.ipcRenderer.on("chat-reply", (_event, value) => callback(value));
	},
	getFileTree: (dir) => electron.ipcRenderer.invoke("get-file-tree", dir),
	openWorkspace: () => electron.ipcRenderer.invoke("open-workspace"),
	readFile: (filepath) => electron.ipcRenderer.invoke("read-file", filepath),
	writeFile: (filepath, content) => electron.ipcRenderer.invoke("write-file", filepath, content),
	searchFiles: (query) => electron.ipcRenderer.invoke("search-files", query),
	getGitBranch: () => electron.ipcRenderer.invoke("get-git-branch"),
	onTerminalOutput: (callback) => {
		electron.ipcRenderer.on("terminal-output", (_event, data) => callback(data));
	},
	sendTerminalInput: (data) => electron.ipcRenderer.send("terminal-input", data),
	onFileChanged: (callback) => {
		electron.ipcRenderer.on("file-changed", (_event, filepath) => callback(filepath));
	},
	getConfig: () => electron.ipcRenderer.invoke("get-config"),
	saveConfig: (config) => electron.ipcRenderer.invoke("save-config", config)
});
//#endregion
