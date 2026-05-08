import { contextBridge, ipcRenderer } from "electron";
//#region electron/preload.ts
contextBridge.exposeInMainWorld("electronAPI", {
	sendChatMessage: (message) => ipcRenderer.send("chat-message", message),
	onChatReply: (callback) => {
		ipcRenderer.on("chat-reply", (_event, value) => callback(value));
	},
	getFileTree: () => ipcRenderer.invoke("get-file-tree"),
	openWorkspace: () => ipcRenderer.invoke("open-workspace"),
	readFile: (filepath) => ipcRenderer.invoke("read-file", filepath),
	writeFile: (filepath, content) => ipcRenderer.invoke("write-file", filepath, content),
	onTerminalOutput: (callback) => {
		ipcRenderer.on("terminal-output", (_event, data) => callback(data));
	},
	sendTerminalInput: (data) => {
		ipcRenderer.send("terminal-input", data);
	},
	onFileChanged: (callback) => {
		ipcRenderer.on("file-changed", (_event, filepath) => callback(filepath));
	}
});
//#endregion
